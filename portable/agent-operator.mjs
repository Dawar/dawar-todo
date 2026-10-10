import {OperatorCalls} from '../bot-bridge/operator.mjs';
import {validateOperatorQuestion,selectedInputQuestions} from '../bot-bridge/operator-questions.mjs';
import {fingerprint,id} from './protocol.mjs';
import {operatorSource,validateOperatorSource} from './operator-source.mjs';

// A signed hub read supplies canonical call metadata, never a local path or
// native method. Native context and question authority remain on this node.
export class AgentOperator {
  constructor(transport){Object.assign(this,{transport,runtime:transport.runtime,journal:transport.journal});}
  current(botId,epoch){
    const bot=this.runtime.store.bot(botId),control=this.journal.currentControl({bot_id:botId,epoch});
    if(process.platform!=='linux'||!control||bot.archived||bot.archiving||bot.deletedAt)throw Error('Assigned Linux Operator context is unavailable.');
    return {bot,control};
  }
  capture(record,botId,threadId,nativeId=null){
    validateOperatorSource(record,botId,threadId,nativeId);
    const prior=this.runtime.store.get('operatorRequest',record.id);
    if(prior&&validateOperatorSource(prior,botId,threadId,nativeId)!==validateOperatorSource(record,botId,threadId,nativeId))throw Error('Original local Operator source changed.');
    if(!prior)this.runtime.store.put('operatorRequest',{...operatorSource(record),turnId:record.turnId??null});
  }
  async read(method,botId,params,epoch){
    const {bot,control}=this.current(botId,epoch),before=bot.threadId;
    let result;
    if(method==='portable.operatorQuestion'){
      const pending=this.runtime.store.get('pending',params.key);
      validateOperatorQuestion(bot,pending,params.binding,params.result);
      if(!pending.async&&pending.epoch!==this.runtime.epoch)throw Error('This blocking question expired at restart.');
      result={pending,answer:this.runtime.answers.get(bot,params.key),epoch:this.runtime.epoch};
    }else if(method==='portable.operatorContext'){
      const {call,segment,selectionRevision}=params;
      if(!id(call?.id)||call.segmentId!==segment?.id||segment?.callId!==call.id||segment.botId!==botId||!Number.isSafeInteger(selectionRevision)||selectionRevision<1)throw Error('Canonical selected call metadata is invalid.');
      const facade=Object.assign(Object.create(this.runtime),{store:Object.assign(Object.create(this.runtime.store),{
        get:(kind,key)=>kind==='operatorCall'&&key===call.id?call:kind==='operatorSegment'&&key===segment.id?segment:this.runtime.store.get(kind,key)
      }),operatorSelectionRevision:()=>selectionRevision});
      result=await new OperatorCalls(facade).context(call);
    }else if(method==='portable.operatorStatus'){
      const record=params.request;validateOperatorSource(record,botId,before);
      let updated=null;
      const facade=Object.assign(Object.create(this.runtime),{store:Object.assign(Object.create(this.runtime.store),{put:(kind,row)=>{
        if(kind!=='operatorRequest'||row.id!==record.id)throw Error('Operator history read cannot mutate local controls.');updated=row;return row;
      }})});
      result={status:await new OperatorCalls(facade).status(record),updated};
    }else throw Error('Unsupported assigned Operator read.');
    const after=this.current(botId,epoch);
    if(this.transport.socket?.readyState!==1||after.bot.threadId!==before||after.control.revision!==control.revision)throw Error('Assigned Operator scope changed during native read.');
    if(method==='portable.operatorQuestion')validateOperatorQuestion(after.bot,this.runtime.store.get('pending',params.key),params.binding,params.result);
    if(Buffer.byteLength(JSON.stringify(result))>192*1024)throw Error('Operator read exceeds its bounded context.');
    // Pending rows and RAM epoch never enter the durable hub read cache.
    return result;
  }
  verifyAction(command,payload){
    const {bot}=this.current(command.bot_id,command.epoch),r=payload.operatorSource;
    if(!r)return;
    validateOperatorSource(r,bot.id,bot.threadId,command.operation_id);
    if(r.nativeMethod!==payload.method||fingerprint(r.nativeParams)!==fingerprint(payload.params))throw Error('Original Operator action payload changed.');
    this.capture(r,bot.id,bot.threadId,command.operation_id);
  }
  inputCount(botId){return selectedInputQuestions(this.runtime,this.runtime.store.bot(botId)).length;}
}
