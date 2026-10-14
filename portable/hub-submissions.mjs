import { createHash } from 'node:crypto';
import { SubmissionSources,registeredBotSource } from '../bot-bridge/submission-sources.mjs';
import { fingerprint,id } from './protocol.mjs';
import { messageDirectory, resolveRecipient } from '../bot-bridge/bot-directory.mjs';

const binding = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (value,keys) => value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k));

// A small acceptance adapter over the existing logical queue and operation
// ledger. It has no timers, native turn producer, rooms or thread copies.
export class HubSubmissions extends SubmissionSources {
  caller(owner,botId,caller){
    if(owner!==this.owner?.key||caller?.kind!=='authenticated-node-tool'||caller.botId!==botId)throw Error('An authenticated named sender is required.');
    const {p,b}=this.runtime.scope(owner,botId);
    if(p.node_id!==caller.nodeId||p.epoch!==caller.epoch||b.archived||b.archiving||b.deletedAt)throw Error('Sender placement or identity changed.');
    this.runtime.hub.node(caller.nodeId);
    return {p,b};
  }
  /** This owner's placed bots on the hub: the only bots a sender can reach. */
  messageable(owner){
    const placed=new Set(this.runtime.hub.db.prepare('SELECT bot_id FROM portable_placements WHERE owner=?').all(owner).map(p=>p.bot_id));
    return this.store.bots().filter(b=>placed.has(b.id));
  }
  tool(owner,botId,args,caller){
    if(!own(args,['operation','recipient','recipientBotId','text','operationId','submissionId','replyToSubmissionId']))throw Error('Sender identity and custom metadata are not tool arguments.');
    const sender=this.caller(owner,botId,caller);
    if(args.operation==='source'){
      if(!own(args,['operation','submissionId']))throw Error('Source reads accept only a submission ID.');
      return this.read(sender.b,{submissionId:args.submissionId});
    }
    if(args.operation==='directory'){
      if(!own(args,['operation']))throw Error('The directory takes no arguments.');
      return {bots:messageDirectory(this.messageable(owner),botId)};
    }
    if(args.operation!=='send'||!own(args,['operation','recipient','recipientBotId','text','operationId','replyToSubmissionId'])||!id(args.operationId)||args.operationId.length<10||typeof args.text!=='string'||!args.text.trim()||Buffer.byteLength(args.text)>16384||args.text.includes('\0'))throw Error('Provide a recipient, bounded text and one stable operationId.');
    // A general reference ("Claudia", "#21", a slug) resolves to one exact
    // bot here; the ID then binds the submission exactly as before.
    if(args.recipientBotId===undefined&&args.recipient===undefined)throw Error('Name the recipient bot, for example "Claudia" or "#21".');
    const resolved=args.recipient!==undefined?resolveRecipient(this.messageable(owner),args.recipient,botId).id:null;
    if(resolved&&args.recipientBotId!==undefined&&args.recipientBotId!==resolved)throw Error('recipient and recipientBotId name different bots.');
    args={...args,recipientBotId:args.recipientBotId??resolved};delete args.recipient;
    if(!id(args.recipientBotId))throw Error('Invalid recipient bot.');
    if(args.recipientBotId===botId)throw Error('Select another bot.');
    if(sender.p.stopped||sender.b.queuePaused)throw Error('Sender Stop is active.');
    const recipient=this.runtime.scope(owner,args.recipientBotId);
    if(recipient.b.archived||recipient.b.archiving||recipient.b.deletedAt)throw Error('Recipient is unavailable.');
    const replyToSubmissionId=args.replyToSubmissionId??null;
    if(replyToSubmissionId!==null){
      if(!id(replyToSubmissionId))throw Error('Invalid original reply submission ID.');
      const parent=this.row(sender.b.id,sender.b.threadId,replyToSubmissionId);
      if(!parent||parent.source.kind!=='bot'||parent.source.id!==recipient.b.id||!parent.native?.turnId)throw Error('Reply source must be a bot message received here from that recipient.');
    }
    const submissionId=`submission:${binding([owner,botId,args.operationId])}`;
    const original=this.store.get('submissionSource',submissionId);
    const source=original?.source.kind==='bot'&&original.source.id===sender.b.id?original.source:registeredBotSource(sender.b),hash=fingerprint({owner,senderBotId:botId,operationId:args.operationId,recipientBotId:recipient.b.id,text:args.text,source,replyToSubmissionId});
    return this.store.transaction(()=>{
      this.runtime.assertWriter();const fresh=this.caller(owner,botId,caller),target=this.runtime.scope(owner,recipient.b.id);
      if(fingerprint(fresh.p)!==fingerprint(sender.p)||fresh.p.stopped||fresh.b.queuePaused||fingerprint(target.p)!==fingerprint(recipient.p)||target.b.threadId!==recipient.b.threadId||target.b.archived||target.b.archiving)throw Error('Original sender or recipient scope changed.');
      const prior=this.store.operation(submissionId);
      if(prior){
        if(prior.fingerprint!==hash)throw Error('Original bot submission conflicts; it was not repeated.');
        if(prior.status!=='done')throw Object.assign(Error('Original local acceptance is unconfirmed.'),{outcome:'uncertain'});
        return this.receipt(target.b,submissionId);
      }
      if(replyToSubmissionId){const parent=this.row(fresh.b.id,fresh.b.threadId,replyToSubmissionId);if(!parent||parent.source.kind!=='bot'||parent.source.id!==target.b.id||!parent.native?.turnId)throw Error('Original reply source changed.');}
      // Source + queue + local receipt commit before tool ACK. This closure
      // cannot contact a model. Recipient Stop holds normal queue admission.
      this.capture(target.b,submissionId,source,args.text,{replyToSubmissionId});
      this.runtime.queueSubmission(target.b,{text:args.text},submissionId,[{type:'text',text:args.text,text_elements:[]}]);
      const queued=this.store.get('promptQueue',submissionId);
      if(!queued||queued.botId!==target.b.id)throw Error('Original queue acceptance is absent.');
      this.store.put('promptQueue',{...queued,sourceSubmissionId:submissionId});
      const result=this.receipt(target.b,submissionId);
      this.store.saveOperation(submissionId,hash,'done',{method:'submissions.send',botId:target.b.id,senderBotId:botId,originalOperationId:args.operationId,result,createdAt:new Date().toISOString()});
      return result;
    });
  }
  receipt(bot,id){
    const r=this.row(bot.id,bot.threadId,id),q=this.store.get('promptQueue',id);
    if(!r||!q||q.botId!==bot.id)throw Error('Original submission is unavailable.');
    const delivered=q.operationId&&this.row(bot.id,bot.threadId,this.clientId(bot,q.operationId));
    return {submissionId:id,source:r.source,recipientBotId:bot.id,state:q.state,replyToSubmissionId:r.replyToSubmissionId,native:delivered?.native??r.native};
  }
  reserveOwner(owner,request,placement,{operatorSource}={}){
    if(owner!==this.owner?.key||request.method!=='turn.send')throw Error('Original owner submission required.');
    if(!own(request.params??{},['text','attachments','reply']))throw Error('Unsupported submission parameters.');
    return this.store.transaction(()=>{
      this.runtime.assertWriter();const {p,b}=this.runtime.scope(owner,request.botId);
      if(fingerprint(p)!==fingerprint(placement))throw Error('Original owner placement changed.');
      const prior=this.runtime.hub.db?.prepare('SELECT payload FROM portable_mailbox WHERE operation_id=?').get(request.operationId),old=prior&&JSON.parse(prior.payload);
      // Reconcile old accepted mailboxes byte-for-byte; never retrofit a
      // source envelope into a retained uncertain native operation.
      if(prior&&!old.submission)return this.runtime.hub.enqueueOn(this.store.db,owner,b.id,request.operationId,{method:request.method,params:request.params??{},...(operatorSource?{operatorSource}:{})});
      const source=old?.submission?.source??(operatorSource?{kind:'unknown'}:this.ownerSource());
      const submission=this.delivery(b,request.operationId,this.capture(b,request.operationId,source,'',{attachments:request.params?.attachments??[]}));
      return this.runtime.hub.enqueueOn(this.store.db,owner,b.id,request.operationId,{method:request.method,params:request.params??{},submission,...(operatorSource?{operatorSource}:{})});
    });
  }
}
