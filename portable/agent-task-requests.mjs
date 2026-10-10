import {createHash} from 'node:crypto';
import {fingerprint} from './protocol.mjs';
import {validatePrimary} from './primary-source.mjs';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class AgentTaskRequests {
  constructor(transport){this.transport=transport;transport.runtime.acceptTaskRequest=(bot,d,text)=>this.accept(bot,d,text);}
  async accept(bot,d,text){
    const {runtime,journal}=this.transport,store=runtime.store,before=journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(bot.id);
    const control=before&&journal.currentControl({bot_id:bot.id,epoch:before.epoch});
    if(!control||control.stopped)throw Error('Original Task Request control is offline or stopped.');
    const prior=store.get('taskRequestDelivery',d.operationId),body={requestId:d.requestId,submissionId:d.submissionId,operationId:d.operationId,deliveryFingerprint:hash(d)};
    if(prior&&prior.fingerprint!==body.deliveryFingerprint)throw Error('Original Task Request delivery changed.');
    // A lost creation ACK becomes read-only reconciliation, never another
    // create or native submission. The original operation remains unchanged.
    const action=prior?.state==='hub-pending'?'intake-status':'intake';
    if(action==='intake')store.put('taskRequestDelivery',{id:d.operationId,botId:bot.id,threadId:bot.threadId,fingerprint:hash(d),state:'hub-pending'});
    const {intake}=await runtime.storage.taskRequest(action,body,bot.id);
    if(!intake)throw Error('Original hub intake is unconfirmed; retain its original operation.');
    const current=store.bot(bot.id),after=journal.currentControl({bot_id:bot.id,epoch:before.epoch});
    if(!after||current.threadId!==bot.threadId||current.archived||current.archiving||current.deletedAt)throw Error('Original Task Request scope changed during hub acceptance.');
    validatePrimary(intake,bot.id,bot.threadId,d.operationId);
    if(intake.kind!=='task-request'||intake.sourceId!==d.requestId||intake.text!==text||fingerprint(intake.attachmentIds)!==fingerprint(d.files.map(f=>f.id))||intake.state!=='queued')throw Error('Original hub Task Request receipt changed.');
    return intake;
  }
}
