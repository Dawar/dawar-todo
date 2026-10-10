import {TaskRequests} from '../db/task-requests.ts';
import {StorageError} from '../db/bot-storage.ts';
import {TaskRequestBridge,taskRequestText} from '../bot-bridge/task-requests.mjs';
import {createHash} from 'node:crypto';
import {fingerprint,boundedFrame} from './protocol.mjs';
import {validatePrimary} from './primary-source.mjs';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const keys={draft:['operationId','source','spec'],pending:['cursor'],delivery:['requestId'],
  'delivery-status':['requestId','submissionId','operationId','status','reason','nativeTurnId','nativeQueueId'],
  'secure-authorize':['requestId','revision','grantId','submissionId'],
  'private-receipt':['requestId','revision','grantId','submissionId','handle','expiresAt','modelRead'],
  intake:['requestId','submissionId','operationId','deliveryFingerprint'],
  'intake-status':['requestId','submissionId','operationId','deliveryFingerprint']};
const reads=new Set(['pending','delivery','secure-authorize','intake-status']);

// The node receives only its assigned original form data. It cannot publish,
// revoke, impersonate the owner, or obtain the machine-wide service secret.
export class HubTaskRequests {
  constructor({hub,controls,application,environment,owner}){Object.assign(this,{hub,controls,application,environment,owner});}
  forms(){return new TaskRequests({...this.environment,DB:this.application},this.owner);}
  scope(nodeId,botId,epoch){
    const n=this.hub.node(nodeId),{p,b}=this.controls.scope(n.owner,botId);
    if(n.owner!==this.owner||p.node_id!==nodeId||p.epoch!==epoch||b.archived||b.archiving||b.deletedAt)throw Error('Foreign, revoked or stale Task Request node scope.');
    return {p,b};
  }
  scopedSource(scope,source){if(source?.botId!==scope.b.id||source.threadId!==scope.b.threadId)throw Error('Task Request belongs to another original bot conversation.');}
  validated(value){return TaskRequestBridge.prototype.validate(structuredClone(value));}
  async request(nodeId,message){
    const {botId,epoch,action,input}=message,allowed=keys[action];
    if(!allowed||!input||Array.isArray(input)||Object.keys(input).some(k=>!allowed.includes(k))||Buffer.byteLength(boundedFrame(input))>192*1024)throw Error('Unsupported bounded Task Request service operation.');
    const before=this.scope(nodeId,botId,epoch),current=()=>{
      const s=this.scope(nodeId,botId,epoch);
      if(fingerprint(s.p)!==fingerprint(before.p)||s.b.threadId!==before.b.threadId)throw Error('Original Task Request placement changed.');
      if(!reads.has(action))this.controls.assertWriter();return s;
    };
    current();const forms=this.forms();await forms.initialize();current();let result;
    if(action==='pending'){
      const page=await forms.pending(input.cursor);current();
      result={...page,deliveries:page.deliveries.filter(d=>{
        try{const p=this.hub.placement(this.owner,d.source.botId);return p.node_id===nodeId&&this.controls.store.bot(d.source.botId).threadId===d.source.threadId;}catch{return false;}
      })};
    }else if(action==='draft'){
      this.scopedSource(before,input.source);result=await forms.draft(input);
    }else if(['secure-authorize','private-receipt'].includes(action)){
      const s=await forms.secureAuthorize(input);current();this.scopedSource(before,s.source);
      result=action==='secure-authorize'?s:await forms.privateReceipt(input);
    }else{
      const fresh=await forms.deliveryScope(input.requestId);current();const d=this.validated(fresh.delivery);this.scopedSource(before,d.source);
      if(action==='delivery')result=fresh;
      else if(action==='delivery-status'){
        result=await forms.deliveryStatus(input);current();
        if(['needs-review','private-unavailable'].includes(input.status))this.controls.store.transaction(()=>{
          const q=this.controls.store.get('primaryInbox',d.operationId);
          if(q?.kind==='task-request'&&q.botId===botId&&!q.turnId&&['queued','dispatching'].includes(q.state))this.controls.store.put('primaryInbox',{...q,state:'failed',error:result.delivery.reason??'Original Task Request needs owner review.'});
        });
      }else{
        if(input.submissionId!==d.submissionId||input.operationId!==d.operationId||input.deliveryFingerprint!==hash(d)||d.source.question)throw Error('Original Task Request intake identity changed.');
        const old=this.controls.store.get('taskRequestDelivery',d.operationId),q=this.controls.store.get('primaryInbox',d.operationId);
        if(action==='intake-status')result={intake:q??null};
        else{
          if(!fresh.scopeActive)throw new StorageError('Original published form expired or was revoked.',409,'scope');
          if(old&&old.fingerprint!==hash(d))throw Error('Original Task Request delivery changed.');
          const files=[];const storage=this.controls.nodeStorage;
          for(const file of d.files){
            const registered=await storage.request(nodeId,{botId,epoch,action:'download',input:{botId,id:file.id}});current();
            const a=registered.attachment;
            if(!a?.ready||a.botId!==botId||a.sha256!==file.sha256||a.size!==file.size)throw Error('Original Task Request registered file changed.');
            files.push({...a,received:a.size});
          }
          const checked=await forms.deliveryScope(d.requestId);current();
          if(!checked.scopeActive||hash(this.validated(checked.delivery))!==hash(d))throw Error('Original submission changed during registered-file lookup.');
          result=this.controls.store.transaction(()=>{
            current();for(const a of files)this.controls.store.put('attachment',a);
            const intake=this.controls.primary.accept(before.b,d.operationId,{kind:'task-request',sourceId:d.requestId,summary:`Task Request: ${d.spec.title}`,text:taskRequestText(d),attachments:d.files.map(f=>f.id)});
            validatePrimary(intake,botId,before.b.threadId,d.operationId);
            this.controls.store.put('taskRequestDelivery',{...old,id:d.operationId,botId,threadId:before.b.threadId,requestId:d.requestId,submissionId:d.submissionId,fingerprint:hash(d),state:'awaiting-bot'});
            return {intake};
          });
        }
        if(result.intake&&(result.intake.sourceId!==d.requestId||result.intake.text!==taskRequestText(d)||fingerprint(result.intake.attachmentIds)!==fingerprint(d.files.map(f=>f.id))))throw Error('Original canonical form intake changed.');
      }
    }
    current();if(Buffer.byteLength(boundedFrame(result))>800*1024)throw Error('Task Request result exceeds the original page bound.');return result;
  }
  eligible(intake){const d=this.controls.store.get('taskRequestDelivery',intake.id);return d?.botId===intake.botId&&d.threadId===intake.threadId&&d.requestId===intake.sourceId&&d.state==='awaiting-bot';}
  async preflight(intake){
    if(!this.eligible(intake))return false;const old=this.controls.store.get('taskRequestDelivery',intake.id),forms=this.forms();
    const fresh=await forms.deliveryScope(intake.sourceId),d=this.validated(fresh.delivery),current=this.controls.store.get('primaryInbox',intake.id);
    return fresh.scopeActive&&fresh.delivery.status==='awaiting-bot'&&fingerprint(current)===fingerprint(intake)&&hash(d)===old.fingerprint&&d.operationId===intake.id&&d.source.botId===intake.botId&&d.source.threadId===intake.threadId&&taskRequestText(d)===intake.text;
  }
}
