import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {fingerprint,id,originalNativeProof} from './protocol.mjs';
import {nativeAdmissionRefusal} from '../bot-bridge/native-admission-refusal.mjs';
import {roomDeliverySource,roomQuestionSource,HUB_ROOM_TOOL_METHODS,HUB_ROOM_READS,LOCAL_ROOM_TOOL_METHODS} from './control-protocol.mjs';

const now=()=>new Date().toISOString();
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const defer=message=>Object.assign(Error(message),{deferred:true,outcome:'not-sent'});
const unknown=message=>Object.assign(Error(message),{outcome:'uncertain'});

// The original registered-context producer remains the only native producer.
// A hub command cannot name an arbitrary native thread, copy a Goal or bypass
// its one-context-per-bot/eight-slot/Stop/resource/current-turn fences.
export class AgentCollaboration {
  constructor(transport){
    Object.assign(this,{transport,runtime:transport.runtime,journal:transport.journal});this.scope=new AsyncLocalStorage();
    const call=this.runtime.codex.call.bind(this.runtime.codex);
    this.runtime.codex.call=(method,params={},timeout)=>{
      const captured=this.scope.getStore();
      if(!captured||!['thread/start','thread/resume','turn/start','turn/steer'].includes(method))return call(method,params,timeout);
      return (async()=>{
        await this.refresh(captured);
        this.runtime.codex.admissionGuard?.(method,params);
        // Persist the original attempt before the first possible native write.
        // A crash after this boundary never repeats context creation or input.
        if(!captured.prepared){
          this.journal.prepare(captured.command.operation_id);
          this.runtime.store.saveOperation(captured.command.operation_id,captured.command.fingerprint,'dispatching',{
            method:'collaboration.dispatch',botId:captured.command.bot_id,portableFingerprint:captured.command.fingerprint,
            deliveryId:captured.delivery.id,contextId:captured.delivery.contextId,createdAt:now()});
          captured.prepared=true;
        }
        captured.nativeStarted=true;
        return call(method,params,timeout);
      })();
    };
    const handle=this.runtime.handle.bind(this.runtime);
    this.localHandle=handle;
    this.runtime.handle=(request,origin)=>{
      if(origin?.authority!=='native-tool'||!request.method?.startsWith('conversations.')&&!request.method?.startsWith('collaboration.')&&!(request.method==='execution.config'&&origin.contextId))return handle(request,origin);
      return this.tool(request,origin);
    };
  }
  confirmation(origin,deliveryId){
    const {store,collaboration}=this.runtime;
    collaboration.author(origin.botId,origin,false);
    if(!origin.contextId)throw defer('Foreground room tools await their central original-intake routing; no local shadow record was changed.');
    const deliveries=deliveryId?[store.get('collaborationDelivery',deliveryId)]:store.db.prepare("SELECT json FROM records WHERE kind='collaborationDelivery' AND bot_id=? AND json_extract(json,'$.contextId')=? AND json_extract(json,'$.turnId')=? ORDER BY rowid DESC LIMIT 2").all(origin.botId,origin.contextId,origin.turnId).map(r=>JSON.parse(r.json));
    for(const d of deliveries){
      if(!d||d.botId!==origin.botId||d.contextId!==origin.contextId||d.turnId!==origin.turnId||d.state!=='accepted'||d.terminalStatus)continue;
      const row=this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(d.id);
      if(!row||!['dispatching','unknown','native-accepted','running'].includes(row.state))continue;
      const command=JSON.parse(row.command);
      if(command.bot_id!==origin.botId||JSON.parse(command.payload).method!=='portable.roomDispatch')continue;
      const result=this.result(command);
      if(result.threadId!==origin.threadId||result.turnId!==origin.turnId||result.context.activeTurnId!==origin.turnId||result.context.status!=='running')continue;
      return {operationId:command.operation_id,fingerprint:command.fingerprint,receipt:{operationId:command.operation_id,threadId:result.threadId,turnId:result.turnId,evidence:result.evidence,result}};
    }
    throw defer('The actual active native tool lacks its original addressed room receipt. No replacement or replay was made.');
  }
  async tool(request,origin){
    if(!request.params||typeof request.params!=='object'||Array.isArray(request.params)||request.clientId)throw defer('Native room tool parameters cannot assert owner authority.');
    const local=LOCAL_ROOM_TOOL_METHODS.has(request.method);
    if(!local&&!HUB_ROOM_TOOL_METHODS.has(request.method))throw defer('This room operation awaits its central consumer; local conversation state was not changed.');
    const confirmation=this.confirmation(origin,request.method==='collaboration.result'?request.params.deliveryId:null);
    const before=this.journal.currentControl({bot_id:origin.botId,epoch:JSON.parse(this.journal.db.prepare('SELECT command FROM node_commands WHERE operation_id=?').get(confirmation.operationId).command).epoch});
    if(!before||before.stopped)throw defer('Current assigned controls are offline or stopped.');
    // Original read handlers carry an undefined operationId in JavaScript;
    // omit that optional field rather than sending a noncanonical frame.
    const centralRequest={method:request.method,botId:request.botId,params:request.params,...(request.operationId===undefined?{}:{operationId:request.operationId})};
    const framed={request:local?{method:'collaboration.authorize',botId:request.botId,params:{}}:centralRequest,origin,confirmation,controlRevision:before.revision};
    const result=await this.transport.roomTool(origin.botId,framed,local||HUB_ROOM_READS.has(request.method));
    const after=this.journal.currentControl({bot_id:origin.botId,epoch:before.epoch});
    if(!after||after.stopped||after.revision!==before.revision){
      throw Object.assign(Error('Control changed while the original room tool was awaiting confirmation. Its original ID was retained.'),{outcome:local||HUB_ROOM_READS.has(request.method)?'not-sent':'uncertain'});
    }
    this.runtime.collaboration.author(origin.botId,origin,false);
    if(!local)return result;
    if(result?.botId!==origin.botId||result.nodeId!==this.transport.enrollment.nodeId||result.epoch!==after.epoch||result.controlRevision!==after.revision||fingerprint(result.origin)!==fingerprint(origin))throw defer('Fresh room resource/body authorization is outside its captured caller.');
    const c=this.runtime.store.get('collaborationContext',origin.contextId),room=this.runtime.store.get('collaborationRoom',c.roomId);
    if(result.room?.id!==c.roomId||result.room.held||!result.room.members?.includes(origin.botId)||room?.revision>result.room.revision||room?.revision===result.room.revision&&fingerprint(room)!==fingerprint(result.room))throw defer('Canonical room membership/hold/revision changed before local work.');
    this.runtime.store.put('collaborationRoom',result.room);
    // Workspace/desktop/external leases and native history/config remain on the
    // actual machine. Reuse their original caller/effect/uncertainty closures.
    return this.localHandle(request,origin);
  }
  async readOwner(method,botId,params,scope){
    const {runtime,journal,transport}=this,c=runtime.store.get('collaborationContext',params?.contextId);
    if(!scope||scope.botId!==botId||scope.contextId!==params?.contextId||scope.nodeId!==transport.enrollment.nodeId||
        !journal.currentControl({bot_id:botId,epoch:scope.placementEpoch})||!c||c.botId!==botId||c.id!==scope.contextId||c.roomId!==scope.roomId||c.threadId!==scope.threadId||c.provisioning!=='bound')throw defer('Native room read lacks its original assigned context.');
    let result;
    if(method==='portable.roomQuestion'){
      if(Object.keys(params).some(k=>!['contextId','key'].includes(k))||typeof params.key!=='string'||params.key.length>1000)throw defer('Use the bounded original question key.');
      const pending=runtime.store.get('collaborationPending',params.key);
      if(pending&&(pending.botId!==botId||pending.contextId!==c.id||pending.threadId!==c.threadId))throw defer('Question belongs to another original context.');
      result={pending:pending??null};
    }else result=await this.localHandle({method,botId,params,clientId:`hub:${transport.enrollment.nodeId}`});
    const after=runtime.store.get('collaborationContext',c.id);
    if(after?.threadId!==scope.threadId||after.botId!==botId||!journal.currentControl({bot_id:botId,epoch:scope.placementEpoch}))throw defer('Original context or placement changed during native read.');
    return {...result,context:runtime.collaboration.publicContext(after),...(['portable.roomQuestion','conversations.requests'].includes(method)?{agentEpoch:runtime.epoch}:{})};
  }
  async refresh(captured){
    const {command,delivery,post}=captured,{runtime,journal,transport}=this;
    const before=journal.currentControl(command);
    if(!before||before.stopped)throw nativeAdmissionRefusal('Assigned control is offline or stopped; no room input was submitted.');
    let current;try{current=await transport.roomState(command);}
    catch{throw nativeAdmissionRefusal('Current canonical room confirmation is unavailable; no native input was submitted.');}
    const after=journal.currentControl(command);
    if(!after||after.stopped||after.revision!==before.revision||!current||current.operationId!==command.operation_id||
        current.fingerprint!==command.fingerprint||current.botId!==command.bot_id||current.epoch!==command.epoch||
        current.controlRevision!==after.revision||!current.canDispatch||
        fingerprint(roomDeliverySource(current.delivery))!==fingerprint(roomDeliverySource(delivery))||
        fingerprint(current.post)!==fingerprint(post))throw nativeAdmissionRefusal('Canonical room/control/source changed before native admission.');
    if(delivery.answerKey&&fingerprint(current.answer)!==fingerprint(captured.portableAnswer))throw nativeAdmissionRefusal('Original owner answer/question changed before native admission.');
    if(captured.answer){
      const pending=runtime.store.get('collaborationPending',delivery.answerKey)??runtime.store.get('collaborationAnswer',delivery.answerKey)?.pending;
      if(!pending||pending.unavailable||fingerprint(roomQuestionSource(pending))!==fingerprint(roomQuestionSource(captured.answer.pending)))throw nativeAdmissionRefusal('Original native question changed before answer admission.');
    }
    const local=runtime.store.get('collaborationRoom',delivery.roomId);
    if(local&&local.revision>current.room.revision)throw nativeAdmissionRefusal('An older room projection cannot replace the current owner choice.');
    if(local&&local.revision===current.room.revision&&fingerprint(local)!==fingerprint(current.room))throw nativeAdmissionRefusal('Original room revision has conflicting bytes.');
    runtime.store.put('collaborationRoom',current.room);
    return current;
  }
  validate(command,payload){
    const {room,post,delivery}=payload.params??{},bot=this.runtime.store.bot(command.bot_id);
    const answerKey=delivery?.answerKey;
    if(payload.method!=='portable.roomDispatch'||!room||!post||!delivery||delivery.id!==command.operation_id||
        delivery.botId!==bot.id||delivery.roomId!==room.id||delivery.postId!==post.id||post.roomId!==room.id||
        post.id!==(answerKey?`post:answer:${hash(answerKey)}`:`post:${hash(post.operationId)}`)||delivery.id!==(answerKey?`room-answer:${hash(answerKey)}`:`room-input:${hash([post.id,bot.id])}`)||
        delivery.contextId!==`context:${hash([room.id,bot.id])}`||delivery.clientId!==delivery.id||delivery.operationId!==post.operationId||
        !['task','question'].includes(post.kind)||typeof post.text!=='string'||!post.text.trim()||Buffer.byteLength(post.text)>16*1024||
        !Array.isArray(room.members)||room.members.length<2||room.members.length>12||new Set(room.members).size!==room.members.length||
        !room.members.includes(bot.id)||!Array.isArray(post.recipients)||!post.recipients.includes(bot.id)||
        delivery.state!=='queued'||!id(room.id)||!id(post.id)||!id(delivery.contextId)||!id(post.operationId))
      throw Object.assign(Error('Room delivery is outside its canonical original source.'),{outcome:'rejected'});
    let answer;
    if(answerKey){
      const portable=payload.params.answer,q=portable?.question,pending=this.runtime.store.get('collaborationPending',answerKey)??this.runtime.store.get('collaborationAnswer',answerKey)?.pending;
      if(!q||!pending||pending.unavailable||q.async!==true||q.key!==answerKey||q.contextId!==delivery.contextId||q.botId!==bot.id||q.roomId!==room.id||
          post.requestId!==answerKey||post.author?.kind!=='owner'||post.kind!=='question'||post.expectation!=='none'||post.recipients.length!==1||
          fingerprint(roomQuestionSource(q))!==fingerprint(roomQuestionSource(pending)))throw Object.assign(Error('Owner answer lacks its unchanged original public native question.'),{outcome:'rejected'});
      const result=this.runtime.collaboration.validate(q.request,portable.result),body=q.request.params.questions.map(q=>`${q.question}\n${result.answers[q.id].answers.join('\n')}`).join('\n\n');
      if(body!==post.text)throw Object.assign(Error('Owner answer bytes differ from their original checked question/result.'),{outcome:'rejected'});
      answer={id:answerKey,botId:bot.id,contextId:q.contextId,fingerprint:hash({key:answerKey,result}),pending,deliveryId:delivery.id,state:'queued',operationId:post.operationId};
      const old=this.runtime.store.get('collaborationAnswer',answerKey);
      if(old&&(old.operationId!==answer.operationId||old.fingerprint!==answer.fingerprint||old.deliveryId!==delivery.id))throw unknown('Another original answer receipt owns this question.');
    }else if(payload.params.answer)throw Object.assign(Error('An ordinary room input cannot borrow answer authority.'),{outcome:'rejected'});
    return {command,delivery,post,room,answer,portableAnswer:payload.params.answer,prepared:false,nativeStarted:false};
  }
  result(command){
    const {store}=this.runtime,d=store.get('collaborationDelivery',command.operation_id),c=d&&store.get('collaborationContext',d.contextId);
    if(!d||!c||c.botId!==command.bot_id||c.roomId!==d.roomId||c.provisioning!=='bound'||!id(c.threadId)||!id(d.turnId)||
        !['accepted','completed'].includes(d.state)||d.threadId!==c.threadId||!this.proven(command,d))throw unknown('Original registered room acceptance is unconfirmed.');
    return {threadId:c.threadId,turnId:d.turnId,deliveryId:d.id,context:this.runtime.collaboration.publicContext(c),
      delivery:this.runtime.collaboration.publicDelivery(d),configuration:this.runtime.executionConfig.turn(d.botId,c.threadId,d.turnId),
      ...(d.terminalStatus?{nativeStatus:d.terminalStatus}:{}),evidence:{kind:'original-native-client',operationId:command.operation_id,threadId:c.threadId,turnId:d.turnId}};
  }
  proven(command,delivery){
    if(['native-ack','exact-client-native-history','exact-live-client'].includes(delivery.evidence))return true;
    const result=this.runtime.store.operation(command.operation_id)?.result;
    return delivery.evidence==='native-terminal-event'&&result?.threadId===delivery.threadId&&result?.turnId===delivery.turnId&&
      originalNativeProof({operationId:command.operation_id,threadId:delivery.threadId,turnId:delivery.turnId,result,evidence:result?.evidence},command.operation_id);
  }
  async recover(command){
    const payload=JSON.parse(command.payload),captured=this.validate(command,payload),{store,collaboration}=this.runtime;
    const original=store.get('collaborationDelivery',captured.delivery.id),post=store.get('collaborationPost',captured.post.id),op=store.operation(command.operation_id);
    if(!original||fingerprint(roomDeliverySource(original))!==fingerprint(roomDeliverySource(captured.delivery))||
        fingerprint(post)!==fingerprint(captured.post)||op&&op.portableFingerprint!==command.fingerprint)throw unknown('Original room source or receipt changed; it was not replayed.');
    if(!original.turnId||!this.proven(command,original))await collaboration.reconcile(original);
    const result=this.result(command);
    store.saveOperation(command.operation_id,command.fingerprint,'done',{...op,method:'collaboration.dispatch',botId:command.bot_id,portableFingerprint:command.fingerprint,deliveryId:original.id,contextId:original.contextId,result});
    return result;
  }
  async admit(command,payload){
    const captured=this.validate(command,payload),{runtime,journal}=this,{store,collaboration}=runtime;
    return runtime.lock(`portable-room:${command.bot_id}`,()=>runtime.maintenance.admit(async()=>{
      if(store.operation(command.operation_id)||['dispatching','unknown'].includes(journal.db.prepare('SELECT state FROM node_commands WHERE operation_id=?').get(command.operation_id)?.state))return this.recover(command);
      try{await this.refresh(captured);}catch(error){throw defer(error.message);}
      const local=store.get('collaborationDelivery',captured.delivery.id),post=store.get('collaborationPost',captured.post.id);
      if(local&&fingerprint(roomDeliverySource(local))!==fingerprint(roomDeliverySource(captured.delivery))||post&&fingerprint(post)!==fingerprint(captured.post))throw unknown('Retained local room source differs; no replacement was made.');
      if(local&&local.state!=='queued')return this.recover(command);
      store.transaction(()=>{
        store.put('collaborationPost',captured.post);
        if(!local)store.put('collaborationDelivery',{...captured.delivery,portableFingerprint:command.fingerprint});
        if(captured.answer&&!store.get('collaborationAnswer',captured.answer.id))store.put('collaborationAnswer',captured.answer);
      });
      try{await this.scope.run(captured,()=>collaboration.submit(store.get('collaborationDelivery',captured.delivery.id)));}
      catch(error){if(!captured.prepared)throw defer(error.message);throw error;}
      const latest=store.get('collaborationDelivery',captured.delivery.id);
      if(!captured.prepared&&!latest.turnId){
        // Positive in-process no-input evidence, not an absence-based replay.
        // The journal is still received and no native context/input was written.
        if(latest.state==='uncertain')store.put('collaborationDelivery',{...latest,state:'queued'});
        throw defer(latest.error??'Registered context/current work is not ready; original room delivery remains received.');
      }
      const result=this.result(command),op=store.operation(command.operation_id);
      if(op?.portableFingerprint!==command.fingerprint)throw unknown('Original room attempt receipt changed.');
      store.saveOperation(command.operation_id,command.fingerprint,'done',{...op,result});
      return result;
    }));
  }
}
