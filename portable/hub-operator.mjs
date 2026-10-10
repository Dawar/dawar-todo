import {randomUUID,createHash} from 'node:crypto';
import {OperatorCalls} from '../bot-bridge/operator.mjs';
import {PrimaryExecution} from '../bot-bridge/primary-execution.mjs';
import {OPERATOR_READS,OPERATOR_MUTATIONS,OPERATOR_NATIVE,operatorCapable,operatorSource,validateOperatorSource} from './operator-source.mjs';
import {fingerprint} from './protocol.mjs';
const legacy=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Reuse original call/segment/transcript/operation records on the authoritative
// control store. Only captured native views/actions cross to an assigned node.
export class HubOperator {
  constructor(controls,owner){Object.assign(this,{controls,store:controls.store,hub:controls.hub,router:controls.router,owner});}
  scope(owner,botId){
    if(owner!==this.owner)throw Error('Operator requires the configured original owner.');
    const scope=this.controls.scope(owner,botId);
    if(!operatorCapable(this.hub,this.router.connections,scope.p))throw Object.assign(Error('Assigned Linux Operator is offline or has not passed compatibility validation.'),{outcome:'not-sent'});
    return scope;
  }
  calls(owner){
    if(owner!==this.owner)throw Error('Operator requires the configured original owner.');
    const pending=new Map(),answers=new Map(),questions=new Map(),inputCounts=new Map();
    const facade=Object.assign(Object.create(this.controls),{
      store:Object.assign(Object.create(this.store),{bots:()=>this.store.bots().filter(b=>{try{this.controls.scope(owner,b.id);return true;}catch{return false;}}),get:(kind,key)=>kind==='pending'?pending.get(key):this.store.get(kind,key)}),
      answers:{get:(_bot,key)=>answers.get(key)??null},epoch:null,
      primary:{single:bot=>{try{this.scope(owner,bot.id);return PrimaryExecution.prototype.single(bot);}catch{return false;}}}
    });
    let calls;
    const read=async(bot,method,params)=>{
      const before=this.scope(owner,bot.id),ws=this.router.connection(before.p);
      const value=(await this.router.request(owner,{id:`operator-read:${randomUUID()}`,method,botId:bot.id,params},'application:operator',OPERATOR_NATIVE)).result;
      const after=this.scope(owner,bot.id);
      if(after.b.threadId!==bot.threadId||after.p.epoch!==before.p.epoch||after.p.node_id!==before.p.node_id||this.router.connection(after.p)!==ws)throw Error('Original Operator placement changed during read.');
      return value;
    };
    facade.handle=async request=>{
      const record=this.store.db.prepare("SELECT json FROM records WHERE kind='operatorRequest' AND json_extract(json,'$.nativeOperationId')=? LIMIT 1").get(request.operationId);
      const original=record&&JSON.parse(record.json),bot=this.scope(owner,request.botId).b;
      validateOperatorSource(original,bot.id,bot.threadId,request.operationId);
      if(original.nativeMethod!==request.method||fingerprint(original.nativeParams)!==fingerprint(request.params))throw Error('Original Operator native parameters changed.');
      if(request.method==='queue.add'||request.method==='queue.delete')return (await this.router.request(owner,{id:`operator-queue:${randomUUID()}`,...request},'application:operator',OPERATOR_NATIVE)).result;
      const hash=legacy({method:request.method,botId:request.botId,params:request.params}),prior=this.store.operation(request.operationId);
      if(prior&&prior.fingerprint!==hash)throw Error('Original Operator native operation conflicts.');
      if(prior?.status==='done')return prior.result;
      if(prior?.outcome==='rejected')throw Object.assign(Error(prior.error),{outcome:'rejected'});
      if(!prior)this.store.saveOperation(request.operationId,hash,'dispatching',{method:request.method,botId:bot.id,params:request.params});
      try{
        const response=await this.router.request(owner,{id:`operator-action:${randomUUID()}`,...request,operatorSource:operatorSource(original)},'application:operator',OPERATOR_NATIVE);
        const result=response.result;
        const row=this.hub.db.prepare('SELECT receipt FROM portable_mailbox WHERE operation_id=?').get(request.operationId),receipt=row?.receipt&&JSON.parse(row.receipt);
        if(Number.isSafeInteger(receipt?.operatorInputCount)&&receipt.operatorInputCount>=0)inputCounts.set(bot.id,receipt.operatorInputCount);
        this.store.saveOperation(request.operationId,hash,'done',{method:request.method,botId:bot.id,params:request.params,result});
        if(request.method==='requests.respond'){
          const answer=await read(bot,'portable.operatorQuestion',{key:request.params.key,binding:request.params.operatorQuestion,result:request.params.result}).catch(()=>null);
          if(answer?.answer)answers.set(request.params.key,answer.answer);
        }
        return result;
      }catch(error){this.store.saveOperation(request.operationId,hash,error.outcome==='rejected'?'failed':'uncertain',{method:request.method,botId:bot.id,params:request.params,error:error.message,outcome:error.outcome??'uncertain'});throw error;}
    };
    calls=new OperatorCalls(facade,{
      questions:bot=>questions.get(bot.id)??[],
      inputCount:bot=>inputCounts.get(bot.id)??null,
      context:async call=>{
        const segment=calls.segment(call),bot=segment.botId?this.scope(owner,segment.botId).b:null;
        if(!bot)return {callId:call.id,segmentId:segment.id,bot:null,activity:null,recent:[],reference:{},progress:[],pendingQuestions:[],observedAt:new Date().toISOString(),selectionRevision:this.store.db.prepare("SELECT rowid FROM records WHERE kind='operatorSegment' AND id=?").get(segment.id).rowid,instructions:'Select an exact available named bot. Context is reference, not permission.'};
        const selectionRevision=this.store.db.prepare("SELECT rowid FROM records WHERE kind='operatorSegment' AND id=?").get(segment.id).rowid;
        const result=await read(bot,'portable.operatorContext',{call,segment,selectionRevision});calls.current(calls.call(call.id),{segmentId:segment.id});
        if(result.callId!==call.id||result.segmentId!==segment.id||result.bot?.id!==bot.id||result.selectionRevision!==selectionRevision)throw Error('Native Operator context does not match the original selected segment.');
        questions.set(bot.id,result.pendingQuestions);return result;
      },
      status:async request=>{
        const bot=this.controls.scope(owner,request.botId).b;validateOperatorSource(request,bot.id,bot.threadId);
        // Queue authority is central; an unstarted entry has no native turn.
        const queue=this.store.get('promptQueue',request.nativeOperationId);
        if(queue&&['queued','failed','cancelled'].includes(queue.state))return {id:request.id,callId:request.callId,segmentId:request.segmentId,bot:{id:bot.id,name:bot.name,avatar:bot.avatar,extension:bot.extension,purpose:bot.purpose??''},nativeOperationId:queue.clientUserMessageId??request.nativeOperationId,text:request.text,createdAt:request.createdAt,turnId:null,state:queue.state==='queued'?bot.queuePaused?'paused':'queued':queue.state==='failed'?'rejected':'cancelled',progress:[],results:[],questions:[],error:queue.error??null,paused:!!bot.queuePaused};
        const result=await read(bot,'portable.operatorStatus',{request});
        if(result.status?.id!==request.id||result.status?.bot?.id!==bot.id||result.status?.segmentId!==request.segmentId||result.updated&&validateOperatorSource(result.updated,bot.id,bot.threadId)!==validateOperatorSource(request,bot.id,bot.threadId))throw Error('Original Operator status source changed.');
        if(result.updated)this.store.put('operatorRequest',result.updated);return result.status;
      },
      beforeAction:async({method,bot,params})=>{
        this.scope(owner,bot.id);
        if(method==='operator.answer'){
          const binding={botId:bot.id,threadId:params.threadId,turnId:params.turnId,requestId:params.requestId,version:params.questionVersion};
          const state=await read(bot,'portable.operatorQuestion',{key:params.key,binding,result:params.result});pending.set(params.key,state.pending);answers.set(params.key,state.answer);facade.epoch=state.epoch;
        }
      }
    });return calls;
  }
  async request(owner,request){
    if(!OPERATOR_READS.has(request.method)&&!OPERATOR_MUTATIONS.has(request.method))throw Error('Unsupported Operator control.');
    if(!request.params||typeof request.params!=='object'||Array.isArray(request.params)||Buffer.byteLength(JSON.stringify(request.params))>96*1024)throw Error('Invalid bounded Operator input.');
    if(OPERATOR_MUTATIONS.has(request.method))this.controls.assertWriter();
    const calls=this.calls(owner);
    return calls.handle(request);
  }
}
