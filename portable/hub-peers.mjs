import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {PeerInbox} from '../bot-bridge/peer-inbox.mjs';
import {captureActivity} from '../bot-bridge/turn-state.mjs';
import {HUB_PEER_READS,HUB_PEER_MUTATIONS} from './control-protocol.mjs';
import {fingerprint,id} from './protocol.mjs';

// Reuse the original discussion/allowance/held-input closures. The hub has
// neither a native model nor filesystem authority over remote workspaces.
export class HubPeers extends PeerInbox {
  constructor(runtime){
    const owners=new AsyncLocalStorage();
    const facade=Object.assign(Object.create(runtime),{copyPeerAttachments:(sender,recipient,ids,exchangeId)=>{
      if(Array.isArray(ids)&&!ids.length)return Promise.resolve([]);
      const owner=owners.getStore();
      if(!owner||!runtime.nodeStorage)throw Error('Canonical registered peer files are unavailable.');
      return runtime.nodeStorage.peerCopies(owner,sender,recipient,ids,exchangeId);
    }});
    super(facade,{upgradeRoots:false});this.owners=owners;this.callers=new AsyncLocalStorage();
  }
  currentCaller(){
    const c=this.callers.getStore();if(!c)return;
    this.runtime.hub.node(c.nodeId);
    if(fingerprint(this.runtime.hub.placement(c.owner,c.p.bot_id))!==fingerprint(c.p)||this.runtime.router.connection(c.p)?.portableHello?.agentEpoch!==c.agentEpoch)throw Object.assign(Error('Original assigned peer control or lifetime changed.'),{outcome:'not-sent'});
  }
  assertReceiptCaller(...args){this.currentCaller();return super.assertReceiptCaller(...args);}
  assertOrigin(...args){this.currentCaller();return super.assertOrigin(...args);}
  ownedBot(botId){
    const owner=this.owners.getStore();if(!owner)throw Error('Authenticated peer scope required.');
    this.runtime.scope(owner,botId);return this.store.bot(botId);
  }
  owned(bot,requestId){
    this.ownedBot(bot.id);const request=super.owned(bot,requestId);
    this.ownedBot(request.senderBotId);this.ownedBot(request.recipientBotId);return request;
  }
  public(request,views){
    this.ownedBot(request.senderBotId);this.ownedBot(request.recipientBotId);return super.public(request,views);
  }
  directory(){
    const owner=this.owners.getStore();if(!owner)throw Error('Authenticated peer directory required.');
    return {bots:super.directory().bots.filter(b=>{
      try{this.runtime.scope(owner,b.id);return true;}catch{return false;}
    })};
  }
  publishRoot(root){
    // A root has no botId in the legacy producer; route its metadata through
    // one original participant, without native wakeups or peer fan-out.
    const row=this.store.db.prepare("SELECT bot_id FROM records WHERE kind='peerRequest' AND json_extract(json,'$.rootId')=? ORDER BY rowid LIMIT 1").get(root.id);
    if(row)this.runtime.emitEvent('peer-root',{root:this.publicRoot(root)},row.bot_id);
  }
  request(owner,request,origin=null){
    const {method,botId,params={},operationId}=request;
    return this.owners.run(owner,async()=>{
      const bot=this.ownedBot(botId);
      if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Invalid scoped peer parameters.');
      if(HUB_PEER_READS.has(method))return this[method.slice(6)](bot,params);
      if(!HUB_PEER_MUTATIONS.has(method)||typeof operationId!=='string'||!/^[a-zA-Z0-9:_-]{10,180}$/.test(operationId))throw Error('Original peer operation identity required.');
      this.runtime.assertWriter();
      const caller=origin??{authority:'owner',botId,threadId:null,turnId:null,callId:null};
      if(method==='peers.send')this.ownedBot(params.recipientBotId);
      const hash=createHash('sha256').update(JSON.stringify({method,botId,params})).digest('hex');
      return method==='peers.control'?super.control(bot,params,operationId,hash,caller):super.mutate(bot,method,params,operationId,hash,caller);
    });
  }
  async tool(owner,nodeId,botId,epoch,frame){
    const {p,b}=this.runtime.scope(owner,botId),{args,origin,confirmation,controlRevision}=frame;
    if(p.node_id!==nodeId||p.epoch!==epoch||p.control_revision!==controlRevision||p.stopped||b.archived||b.archiving||
        !args||typeof args!=='object'||Array.isArray(args)||!origin||origin.botId!==botId||
        !['native-tool','authenticated-bot-mcp'].includes(origin.authority)||
        Object.keys(origin).some(k=>!['authority','botId','threadId','turnId','callId'].includes(k))||
        !confirmation||confirmation.kind!=='assigned-peer-foreground'||!id(confirmation.agentEpoch))throw Object.assign(Error('Current assigned peer caller is unconfirmed.'),{outcome:'rejected'});
    const {operation,operationId,...params}=args,method=`peers.${operation}`;
    if(!HUB_PEER_READS.has(method)&&!['peers.send','peers.reply','peers.cancel'].includes(method))throw Object.assign(Error('Bots cannot control discussion grants or select another caller.'),{outcome:'rejected'});
    this.assertReceiptCaller(b,method,origin);
    this.runtime.assertWriter();
    return this.runtime.lock(`peer-tool:${botId}`,()=>{
      if(fingerprint(this.runtime.hub.placement(owner,botId))!==fingerprint(p)||
          !this.runtime.captureForeground(botId,nodeId,epoch,confirmation.agentEpoch,confirmation.activity))throw Object.assign(Error('Captured peer activity is late or superseded.'),{outcome:'not-sent'});
      this.store.saveBot({...this.store.bot(botId),activeTurnId:confirmation.activity.activeTurnId});
      const caller=Object.freeze({...origin,...captureActivity(this.runtime,botId)});
      return this.callers.run({owner,nodeId,p,agentEpoch:confirmation.agentEpoch},()=>this.request(owner,{method,botId,params,...(operationId===undefined?{}:{operationId})},caller));
    });
  }
  eligible(owner,intake){
    return this.owners.run(owner,()=>{
      if(intake.kind!=='peer')return false;
      const request=this.owned(this.ownedBot(intake.botId),intake.sourceId);
      const exchange=this.store.db.prepare("SELECT json FROM records WHERE kind='peerExchange' AND json_extract(json,'$.requestId')=? AND (id=? OR json_extract(json,'$.kind')='request' AND ?=?) ORDER BY rowid LIMIT 1").get(request.id,intake.id,intake.id,request.id);
      if(!exchange)return false;
      const e=JSON.parse(exchange.json),recipient=e.recipientBotId??(e.botId===request.senderBotId?request.recipientBotId:request.senderBotId);
      return recipient===intake.botId&&fingerprint(e.copiedAttachmentIds??[])===fingerprint(intake.attachmentIds??[])&&this.canDispatch(intake);
    });
  }
  receipt(owner,intake,turn){
    return this.owners.run(owner,()=>{
      this.owned(this.ownedBot(intake.botId),intake.sourceId);
      return turn?super.delivered(intake,turn):super.uncertain(intake);
    });
  }
}
