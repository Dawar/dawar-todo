import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {fingerprint,id,originalNativeProof} from './protocol.mjs';
import {nativeAdmissionRefusal} from '../bot-bridge/native-admission-refusal.mjs';
import {roomDeliverySource} from './control-protocol.mjs';

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
    const local=runtime.store.get('collaborationRoom',delivery.roomId);
    if(local&&local.revision>current.room.revision)throw nativeAdmissionRefusal('An older room projection cannot replace the current owner choice.');
    if(local&&local.revision===current.room.revision&&fingerprint(local)!==fingerprint(current.room))throw nativeAdmissionRefusal('Original room revision has conflicting bytes.');
    runtime.store.put('collaborationRoom',current.room);
    return current;
  }
  validate(command,payload){
    const {room,post,delivery}=payload.params??{},bot=this.runtime.store.bot(command.bot_id);
    if(payload.method!=='portable.roomDispatch'||!room||!post||!delivery||delivery.id!==command.operation_id||
        delivery.botId!==bot.id||delivery.roomId!==room.id||delivery.postId!==post.id||post.roomId!==room.id||
        post.id!==`post:${hash(post.operationId)}`||delivery.id!==`room-input:${hash([post.id,bot.id])}`||
        delivery.contextId!==`context:${hash([room.id,bot.id])}`||delivery.clientId!==delivery.id||delivery.operationId!==post.operationId||
        !['task','question'].includes(post.kind)||typeof post.text!=='string'||!post.text.trim()||Buffer.byteLength(post.text)>16*1024||
        !Array.isArray(room.members)||room.members.length<2||room.members.length>12||new Set(room.members).size!==room.members.length||
        !room.members.includes(bot.id)||!Array.isArray(post.recipients)||!post.recipients.includes(bot.id)||
        delivery.state!=='queued'||!id(room.id)||!id(post.id)||!id(delivery.contextId)||!id(post.operationId))
      throw Object.assign(Error('Room delivery is outside its canonical original source.'),{outcome:'rejected'});
    return {command,delivery,post,room,prepared:false,nativeStarted:false};
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
