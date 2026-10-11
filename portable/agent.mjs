import { join, isAbsolute } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { Store } from '../bot-bridge/store.mjs';
import { Codex } from '../bot-bridge/codex.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { CodexManager } from '../bot-bridge/manager.mjs';
import { NodeJournal } from './control-store.mjs';
import { nodeKey, signature, fingerprint,id,boundedFrame,PROTOCOL_VERSION, RUNTIME_VERSION } from './protocol.mjs';
import { AGENT_READS, AGENT_MUTATIONS } from './hub-rpc.mjs';
import { HUB_TOOLS,NODE_LOGICAL_COMMANDS,ROOM_NATIVE_READS } from './control-protocol.mjs';
import {AgentPeers} from './agent-peers.mjs';
import {AgentTaskRequests} from './agent-task-requests.mjs';
import {AgentOperator} from './agent-operator.mjs';
import {OPERATOR_NODE_READS} from './operator-source.mjs';
import { admitLogicalCommand } from './agent-admission.mjs';
import {settleAgentBurst} from './agent-bursts.mjs';
import { queueResumeReceipt } from './agent-queue-resume.mjs';
import { NodeStorageClient } from './agent-storage.mjs';
import { artifactInput } from './node-storage-contract.mjs';
import { AgentContextAdmission } from './context-admission.mjs';
import { BotDesktops } from '../bot-bridge/desktops.mjs';
import { SecureInputs } from '../bot-bridge/secure-input.mjs';
import { AgentDesktopTransport, DESKTOP_READS, DESKTOP_MUTATIONS } from './desktop-transport.mjs';
import {AgentStartup} from './agent-startup.mjs';
import {verifiedAgentRelease} from './runtime-release.mjs';
import {readPrivate} from './private-file.mjs';
import {AgentSecureTransport} from './secure-transport.mjs';
import {AgentCollaboration} from './agent-collaboration.mjs';
import {roomAnswerReceipt} from './room-answer.mjs';
import {foregroundSource} from './foreground-source.mjs';
import {validatePrimary} from './primary-source.mjs';
import {centralAgentCapabilities} from './agent-capabilities.mjs';
import {storedRuntimeDefaults} from './runtime-defaults.mjs';
import {agentConnectionURL,centralLoopback} from './central-loopback.mjs';
const fingerprintLegacy=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class AgentTransport {
  constructor({ config, runtime, journal, key, enrollment, startupReady=true, socketFactory=url=>new WebSocket(url) }) {
    Object.assign(this,{config,runtime,journal,key,enrollment,socketFactory,startupReady});
    this.socket=null;this.retry=0;this.closed=false;this.pending=new Map();this.controlPending=new Map();this.cursor=journal.cursor();
    this.terminalCandidates=new Map();
    this.desktops=new AgentDesktopTransport({runtime,journal,currentSocket:()=>this.socket});
    this.secure=new AgentSecureTransport({runtime,journal,owner:enrollment.owner,currentSocket:()=>this.socket,ready:()=>this.startupReady&&this.runtime.ready});
    this.startup=new AgentStartup(runtime,journal);
    const nativeGuard=runtime.codex.admissionGuard;
    const contexts=new AgentContextAdmission(runtime,journal);
    runtime.codex.admissionGuard=(method,params)=>{
      nativeGuard?.(method,params);
      contexts.guard(method,params);
    };
    this.collaboration=new AgentCollaboration(this);
    this.peers=new AgentPeers(this);
    this.taskRequests=new AgentTaskRequests(this);
    this.operator=new AgentOperator(this);
    runtime.on('event',event=>{
      if(!event.botId)return;
      const c=journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(event.botId);
      if(!c)return;
      const native=event.type==='codex'?event.data:event.type==='collaboration.native'&&event.data?.type==='codex'?event.data.data:null;
      if(native?.method==='turn/completed'){
        const p=native.params,turn=p?.turn;
        if(p?.threadId&&turn?.id&&['completed','failed','interrupted'].includes(turn.status)){
          this.terminalCandidates.set(turn.id,{threadId:p.threadId,turnId:turn.id,status:turn.status});
          // Native completion may precede its turn/start response. Retain a
          // bounded exact-ID observation until that original receipt arrives.
          while(this.terminalCandidates.size>256)this.terminalCandidates.delete(this.terminalCandidates.keys().next().value);
          for(const row of journal.db.prepare("SELECT * FROM node_commands WHERE state IN ('native-accepted','running')").all())this.terminal(row);
        }
      }
      const activity=event.type==='bot'&&runtime.store.get('botActivity',event.botId);
      const captured=activity?{...event,portableActivity:{agentEpoch:runtime.epoch,activity:foregroundSource(activity)}}:event;
      journal.recordEvent(`event:${randomUUID()}`,{botId:event.botId,epoch:c.epoch,event:captured});this.flushEvents();
    });
  }
  hello(){return {protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION,platform:process.platform,arch:process.arch,agentEpoch:this.runtime.epoch,
    // Paired consumers are selected explicitly for the reviewed Linux release;
    // unrelated/native-autonomous capabilities are not implied by this switch.
    capabilities:{text:true,localStdio:true,registeredArtifacts:true,profileReads:true,memoryCompaction:process.platform==='linux',pdfPreview:process.platform==='linux',desktop:process.platform==='linux'&&!!this.runtime.desktops,voice:false,secureTransfer:process.platform==='linux'&&!!this.runtime.secure,centralBursts:process.platform==='linux',...centralAgentCapabilities(this.config),autonomousGoals:false}};}
  send(value){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(value));}
  controlRequest(botId,tool,args){
    if(!HUB_TOOLS.has(tool))throw Error('Unsupported hub tool.');
    const read=tool==='bots_schedule_list'||tool==='bots_queue'&&['lists','read'].includes(args.operation);
    return this.requestHub(botId,'control',{tool,args},read);
  }
  artifactRequest(botId,action,input){
    return this.requestHub(botId,'artifact',{action,input:artifactInput(action,input)},['download','preview','taskQueueExport'].includes(action));
  }
  roomState(command){return this.requestHub(command.bot_id,'room',{operationId:command.operation_id,fingerprint:command.fingerprint},true);}
  roomTool(botId,frame,read){return this.requestHub(botId,'room-tool',frame,read);}
  peerTool(botId,frame,read){return this.requestHub(botId,'peer-tool',frame,read);}
  requestHub(botId,kind,payload,read){
    const c=this.journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(botId),control=c&&this.journal.currentControl({bot_id:botId,epoch:c.epoch});
    if(!control||this.socket?.readyState!==1)throw Object.assign(Error('Hub controls are offline or outside this assigned scope.'),{outcome:'not-sent'});
    if(this.controlPending.size>=32)throw Object.assign(Error('Bounded hub requests are busy.'),{outcome:'not-sent'});
    const requestId=`${kind}:${randomUUID()}`,ws=this.socket;
    return new Promise((resolve,reject)=>{
      const fail=error=>{clearTimeout(this.controlPending.get(requestId)?.timer);this.controlPending.delete(requestId);reject(Object.assign(error,{outcome:read?'not-sent':'uncertain'}));};
      const timer=setTimeout(()=>fail(Error('Hub acknowledgement is unconfirmed; retain its original identity.')),15000);
      this.controlPending.set(requestId,{ws,kind,botId,epoch:c.epoch,resolve,reject,fail,timer});
      try{const frame={type:`${kind}-request`,requestId,botId,epoch:c.epoch,...payload};boundedFrame(frame);ws.send(kind==='task-request'?JSON.stringify(frame):boundedFrame(frame));}catch(error){fail(error);}
    });
  }
  flushEvents(){for(const r of this.journal.pendingEvents()){const e=JSON.parse(r.event);this.send({type:'event',eventId:r.event_id,...e});}}
  receipt(row){this.send({type:'receipt',operationId:row.operation_id,fingerprint:row.fingerprint,state:row.state==='dispatching'?'unknown':row.state,
    receipt:row.receipt?JSON.parse(row.receipt):{operationId:row.operation_id}});}
  terminal(row){
    if(!['native-accepted','running'].includes(row.state))return;
    const receipt=row.receipt&&JSON.parse(row.receipt),p=receipt&&this.terminalCandidates.get(receipt.turnId);
    if(!p||p.threadId!==receipt.threadId)return;
    let result=receipt.result;const command=JSON.parse(row.command);
    if(command.payload&&JSON.parse(command.payload).method==='portable.roomDispatch'){
      // Original room completion events have their own context generation;
      // retain the latest proven local snapshot instead of pairing terminal
      // status with the older running snapshot from turn/start's ACK.
      try{result=this.collaboration.result(command);}catch{return;}
    }
    this.journal.settle(row.operation_id,'terminal',{...receipt,result,nativeStatus:p.status});
    this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(row.operation_id));
  }
  async recover(){
    if(this.recovering||this.closed||!this.startupReady||!this.runtime.ready)return;this.recovering=true;
    try{
      await this.startup.recover();
      if(this.runtime.storage?.taskRequest&&this.runtime.storage.features?.taskRequests!==false&&!this.runtime.maintenance.holding())await this.runtime.taskRequests.tick().catch(error=>this.runtime.emit('fault',error));
      let rows=this.journal.db.prepare("SELECT rowid AS rowNumber,* FROM node_commands WHERE rowid>? AND state IN ('received','dispatching','unknown','native-accepted','running') ORDER BY rowid LIMIT 2").all(this.recoveryCursor??0);
      if(!rows.length){this.recoveryCursor=0;return;}
      for(const row of rows){
        this.recoveryCursor=row.rowNumber;
        const command=JSON.parse(row.command),payload=JSON.parse(command.payload),bot=this.runtime.store.bot(command.bot_id);
        if(row.state==='received'){
          if(this.pending.has(row.operation_id))continue;
          const work=Promise.resolve().then(()=>this.execute(command,row));this.pending.set(row.operation_id,work);
          try{await work;}finally{this.pending.delete(row.operation_id);}continue;
        }
        if(this.runtime.locks.has(bot.id))continue;
        await this.runtime.lock(bot.id,()=>this.runtime.maintenance.track(async()=>{
          const op=this.runtime.store.operation(command.operation_id);
          if(row.state==='dispatching'&&!op){
            this.journal.settle(command.operation_id,'unknown',{operationId:command.operation_id,reason:'Restart interrupted command admission.'});
            this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));return;
          }
          if(payload.method==='portable.roomRespond'){
            let result;try{result=this.collaboration.recoverResponse(command);}catch{return;}
            const current=this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id);
            if(current?.fingerprint!==row.fingerprint||!['dispatching','unknown'].includes(current.state))return;
            this.journal.settle(command.operation_id,'terminal',roomAnswerReceipt(command,result));this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));return;
          }
          if(payload.method==='portable.roomDispatch'){
            if(!op||op.botId!==bot.id||op.method!=='collaboration.dispatch'||op.portableFingerprint!==command.fingerprint)return;
            let result;try{result=await this.collaboration.recover(command);}catch{return;}
            const current=this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id);
            if(current?.fingerprint!==row.fingerprint||!['dispatching','unknown','native-accepted','running'].includes(current.state))return;
            const status=result.nativeStatus,terminal=['completed','failed','interrupted'].includes(status);
            const receipt={operationId:command.operation_id,threadId:result.threadId,turnId:result.turnId,result,evidence:result.evidence,...(terminal?{nativeStatus:status}:{})};
            if(['dispatching','unknown'].includes(current.state)||terminal)this.journal.settle(command.operation_id,terminal?'terminal':'native-accepted',receipt);else return;
            this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));return;
          }
          if(!op||op.botId!==bot.id||!['turn.send','queue.send','queue.dispatch','schedule.dispatch','queue.resume'].includes(op.method))return;
          const binding=NODE_LOGICAL_COMMANDS.has(payload.method)?op.portableFingerprint===command.fingerprint:
            op.fingerprint===fingerprintLegacy({method:payload.method,botId:bot.id,params:payload.params??{}});
          if(!binding)return;
          const primary=payload.method==='portable.primaryDispatch',intake=primary&&this.runtime.store.get('primaryInbox',command.operation_id);
          if(primary&&(!intake||op.intakeId!==command.operation_id||validatePrimary(intake,bot.id,bot.threadId,command.operation_id)!==validatePrimary(payload.params.intake,bot.id,bot.threadId,command.operation_id)))return;
          if(payload.method==='portable.queueResume'){
            if(op.status!=='done'||op.method!=='queue.resume'||op.controlRevision!==payload.params.controlRevision)return;
            const receipt=queueResumeReceipt(command,op.result),current=this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(op.id);
            if(current?.fingerprint!==row.fingerprint||!['received','dispatching','unknown'].includes(current.state))return;
            this.journal.settle(op.id,'terminal',receipt);this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(op.id));return;
          }
          const before={threadId:bot.threadId,method:op.method,botId:op.botId,fingerprint:op.fingerprint,portableFingerprint:op.portableFingerprint??null};
          const result=op.status==='done'?op.result:await this.runtime.reconcileOperation(op),after=this.runtime.store.operation(op.id);
          if(!result||!after||fingerprint(before)!==fingerprint({threadId:this.runtime.store.bot(bot.id).threadId,method:after.method,botId:after.botId,fingerprint:after.fingerprint,portableFingerprint:after.portableFingerprint??null}))return;
          if(primary&&fingerprint(this.runtime.store.get('primaryInbox',op.id))!==fingerprint(intake))return;
          const turnId=result.turn?.id??result.turnId;if(!turnId)return;
          if(primary)this.runtime.store.put('primaryInbox',{...intake,state:'accepted',turnId,acceptedAt:new Date().toISOString(),error:null});
          const current=this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(op.id);
          if(current?.fingerprint!==row.fingerprint||!['received','dispatching','unknown','native-accepted','running'].includes(current.state))return;
          if(payload.method==='portable.burstDispatch')settleAgentBurst(this.runtime,command,result);
          const terminal=this.runtime.store.get('planTurnEvidence',turnId),status=['completed','failed','interrupted'].includes(result.turn?.status)?result.turn.status:
            terminal?.botId===bot.id&&['completed','failed','interrupted'].includes(terminal.status)?terminal.status:null;
          const receipt={operationId:op.id,threadId:bot.threadId,turnId,result,evidence:{kind:'original-native-client',operationId:op.id,threadId:bot.threadId,turnId},...(status?{nativeStatus:status}:{})};
          if(['received','dispatching','unknown'].includes(current.state))this.journal.settle(op.id,status?'terminal':'native-accepted',receipt);
          else if(status)this.journal.settle(op.id,'terminal',receipt);else return;
          this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(op.id));
        }));
      }
    }finally{this.recovering=false;}
  }
  connect(){
    if(this.closed)return;
    const url=agentConnectionURL(this.config,this.enrollment.hub);
    const ws=this.socketFactory(url);this.socket=ws;
    let authentication=false,frames=Promise.resolve();
    const sendHere=value=>{if(this.socket===ws&&ws.readyState===1)ws.send(JSON.stringify(value));};
    ws.addEventListener('message',event=>{
      frames=frames.then(()=>{
        if(this.socket!==ws)return;
        const m=JSON.parse(event.data);
        if(m.type==='challenge'){
          const hello=this.hello(),bound={nodeId:this.enrollment.nodeId,challenge:m.challenge,connectionId:m.connectionId,hello};
          sendHere({type:'authenticate',...bound,proof:signature(this.key.privateKey,bound),cursor:this.cursor});return;
        }
        if(m.type==='sync'){
          if(m.controls.some(c=>c.node_id!==this.enrollment.nodeId||c.owner!==this.enrollment.owner))throw Error('Foreign control snapshot.');
          this.journal.synchronize(m.controls);void this.desktops.reconcile();authentication=true;this.retry=0;this.runtime.relayOnline=true;
          // This synchronized fence blocks new admission. User queuePaused,
          // Goal and current-turn state are not rewritten to infer Stop ACK.
          for(const command of m.commands){
            if(command.node_id!==this.enrollment.nodeId||command.owner!==this.enrollment.owner)throw Error('Foreign node command.');
            const row=this.journal.receive(command);this.journal.observe(command.sequence);this.cursor=this.journal.cursor();
            if(!this.pending.has(row.operation_id)){
              // Admission runs independently of frame processing: a slow
              // native request must not delay a newer Stop/control snapshot.
              const work=Promise.resolve().then(()=>this.execute(command,row)).catch(()=>ws.close(1008,'Command scope could not be confirmed')).finally(()=>this.pending.delete(row.operation_id));this.pending.set(row.operation_id,work);
            }
          }
          this.flushEvents();
        } else if(authentication && m.type==='desktop-request'){
          if(!this.startupReady||!this.runtime.ready)throw Error('Agent startup has not completed.');
          void this.desktops.message(ws,m)?.catch(()=>ws.close(1008,'Desktop scope changed'));
        } else if(authentication && m.type==='secure-request'){
          void this.secure.message(ws,m).catch(()=>sendHere({type:'secure-response',transportId:m.transportId,botId:m.frame?.botId,epoch:m.epoch,error:'Private form scope is unavailable.'}));
        } else if(authentication && m.type==='rpc'){
          const control=this.journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(m.botId);
          if(!AGENT_READS.has(m.method)||control?.epoch!==m.epoch)throw Error('Read is outside assigned scope.');
          void (async()=>{try{
            if(!this.startupReady||!this.runtime.ready)throw Error('Agent startup is still recovering; no input was admitted.');
            if(DESKTOP_READS.has(m.method)&&!this.runtime.desktops)throw Error('Linux desktops are not configured.');
            if(DESKTOP_READS.has(m.method)&&!this.journal.currentControl({bot_id:m.botId,epoch:m.epoch}))throw Error('Desktop controls are not synchronized.');
            if(m.method==='desktop.open'&&(!id(m.clientId)||!m.clientId.startsWith('browser:')))throw Error('A live authenticated parent browser is required.');
            const roomRead=ROOM_NATIVE_READS.has(m.method)||m.method==='portable.roomQuestion'||m.method==='execution.config'&&m.params?.contextId;
            const work=()=>roomRead?this.collaboration.readOwner(m.method,m.botId,m.params,m.roomScope):OPERATOR_NODE_READS.has(m.method)?this.operator.read(m.method,m.botId,m.params,m.epoch):this.runtime.handle({method:m.method,botId:m.botId,params:m.params,clientId:m.method==='desktop.open'?m.clientId:`hub:${this.enrollment.nodeId}`});
            const result=m.method==='desktop.open'?await this.runtime.maintenance.admit(work):await work();
            const after=this.journal.currentControl({bot_id:m.botId,epoch:m.epoch});
            if(!after||this.socket!==ws)return;
            const frame={type:'rpc-result',rpcId:m.rpcId,botId:m.botId,epoch:m.epoch,result,...(roomRead?{roomScope:m.roomScope}:{})};
            if(Buffer.byteLength(JSON.stringify(frame))>900*1024)throw Error('Read exceeds its bounded transport; use a smaller history page.');sendHere(frame);
          }catch(e){sendHere({type:'rpc-result',rpcId:m.rpcId,botId:m.botId,epoch:m.epoch,error:e.message});}})();
        } else if(authentication && ['control-result','artifact-result','room-result','room-tool-result','peer-tool-result','task-request-result'].includes(m.type)){
          const pending=this.controlPending.get(m.requestId);if(!pending)return;
          const current=this.journal.currentControl({bot_id:pending.botId,epoch:pending.epoch});
          if(m.type!==`${pending.kind}-result`||pending.ws!==ws||m.botId!==pending.botId||m.epoch!==pending.epoch||!current)throw Error('Hub tool response scope changed.');
          clearTimeout(pending.timer);this.controlPending.delete(m.requestId);
          if(m.error)pending.reject(Object.assign(Error(m.error),{outcome:m.outcome==='rejected'?'rejected':m.outcome==='not-sent'?'not-sent':'uncertain',...(Number.isInteger(m.formStatus)?{formStatus:m.formStatus}:{})}));else pending.resolve(m.result);
        } else if(authentication && m.type==='event-ack')this.journal.acknowledgeEvent(m.eventId);
      }).catch(()=>ws.close(1008,'Protocol could not be confirmed'));
    });
    ws.addEventListener('close',()=>{
      if(this.socket!==ws)return;this.journal.disconnect();this.runtime.relayOnline=false;clearInterval(this.heartbeat);
      void this.desktops.disconnect(ws);
      this.secure.disconnect(ws);
      for(const request of [...this.controlPending.values()])if(request.ws===ws)request.fail(Error('Connection ended before hub tool confirmation; retain the original operation.'));
      if(!this.closed)this.retryTimer=setTimeout(()=>this.connect(),Math.min(30000,1000*2**Math.min(this.retry++,5)));
    });
    ws.addEventListener('error',()=>ws.close());
    this.heartbeat=setInterval(()=>{if(authentication){this.runtime.relayOnline=true;this.send({type:'sync',cursor:this.cursor});this.flushEvents();}},5000);
  }
  async execute(command,row){
    if(!this.startupReady||!this.runtime.ready)return;
    if(row.state==='terminal'||row.state==='unknown'||row.state==='native-accepted'||row.state==='running'){this.receipt(row);return;}
    const payload=JSON.parse(command.payload);
    if(!AGENT_MUTATIONS.has(payload.method)&&!NODE_LOGICAL_COMMANDS.has(payload.method))throw Error('Unsupported assigned command.');
    if(DESKTOP_MUTATIONS.has(payload.method)&&!this.runtime.desktops){
      this.journal.settle(command.operation_id,'terminal',{operationId:command.operation_id,outcome:'rejected',error:'Linux desktops are not configured.'});this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));return;
    }
    // Stop itself remains admissible while the synchronized Stop fence blocks
    // new turns. Offline/foreign/stale controls never grant interruption.
    if(['turn.interrupt','portable.queueResume','portable.queueSend'].includes(payload.method)||DESKTOP_MUTATIONS.has(payload.method)?!this.journal.currentControl(command):!this.journal.canAdmit(command))return;
    const bot=this.runtime.store.bot(command.bot_id);if(!bot || bot.archived || bot.deletedAt)throw Error('Assigned native bot is absent or archived.');
    const request={method:payload.method,botId:command.bot_id,operationId:command.operation_id,params:payload.params,clientId:`hub:${this.enrollment.nodeId}`};
    if(row.state==='dispatching' && !this.runtime.store.operation(command.operation_id)) {
      // The process could have died before or after an unobserved native write.
      // An absent local operation is not authorization to resubmit.
      this.journal.settle(command.operation_id,'unknown',{operationId:command.operation_id,reason:'Restart interrupted command admission.'});
      this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));return;
    }
    if(NODE_LOGICAL_COMMANDS.has(payload.method)&&this.runtime.maintenance.holding())return;
    if(row.state==='received'){this.receipt(row);if(!NODE_LOGICAL_COMMANDS.has(payload.method))this.journal.prepare(command.operation_id);}
    try {
      this.operator.verifyAction(command,payload);
      const run=()=>this.runtime.handle(request);
      const result=NODE_LOGICAL_COMMANDS.has(payload.method)?await admitLogicalCommand(this,command,payload):
        DESKTOP_MUTATIONS.has(payload.method)?await this.runtime.maintenance.admit(run):await run(), turnId=result?.turn?.id??result?.turnId;
      const status=result?.turn?.status??result?.nativeStatus,terminalStatus=['completed','failed','interrupted'].includes(status)?status:null;
      const receipt=payload.method==='portable.roomRespond'?roomAnswerReceipt(command,result):payload.method==='portable.queueResume'?queueResumeReceipt(command,result):{operationId:command.operation_id,threadId:payload.method==='portable.roomDispatch'?result?.threadId:bot.threadId,...(turnId?{turnId}:{}),...(terminalStatus?{nativeStatus:terminalStatus}:{}),...(result?.evidence?{evidence:result.evidence}:{}),...(payload.operatorSource?{operatorInputCount:this.operator.inputCount(bot.id)}:{}),result};
      this.journal.settle(command.operation_id,['portable.queueResume','portable.roomRespond'].includes(payload.method)?'terminal':turnId?(terminalStatus?'terminal':'native-accepted'):payload.method==='turn.send'||NODE_LOGICAL_COMMANDS.has(payload.method)?'unknown':'terminal',receipt);
    } catch(error){
      if(error.deferred&&this.journal.db.prepare('SELECT state FROM node_commands WHERE operation_id=?').get(command.operation_id)?.state==='received'&&!(payload.method==='portable.roomRespond'&&this.runtime.store.operation(command.operation_id)))return;
      this.journal.settle(command.operation_id,error.outcome==='rejected'?'terminal':'unknown',{operationId:command.operation_id,outcome:error.outcome??'uncertain',error:error.message});
    }
    this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));
    this.terminal(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));
  }
  close(){this.closed=true;clearInterval(this.recoveryTimer);clearInterval(this.heartbeat);clearTimeout(this.retryTimer);for(const request of [...this.controlPending.values()])request.fail(Error('Agent control connection closed; retain the original operation.'));this.journal.disconnect();void this.desktops.disconnect(this.socket);this.secure.disconnect(this.socket);this.socket?.close();}
}

export async function runAgent(config){
  // Staging cannot accidentally attach a second Codex process to production
  // workspaces. The migration's exact activation proof is required first.
  if(!config.agent?.activationReceipt || !isAbsolute(config.agent.codexBinary)||!isAbsolute(config.agent.workspaces))throw Error('Agent activation receipt, local Codex binary and workspaces are required.');
  const activation=JSON.parse(readPrivate(config.agent.activationReceipt,16384));
  const enrollment=JSON.parse(readPrivate(join(config.dataDirectory,'node-enrollment.json'),16384));
  if(activation.kind!=='portable-agent-activation'||activation.executionEnabled!==true||activation.nodeId!==enrollment.nodeId||activation.runtime!==RUNTIME_VERSION
    ||config.agent.nodeId&&enrollment.nodeId!==config.agent.nodeId)throw Error('Enrollment differs from reviewed agent activation.');
  const source=verifiedAgentRelease({activation,entrypoint:import.meta.url,codexBinary:config.agent.codexBinary,runtime:RUNTIME_VERSION});
  process.umask(0o077);
  const store=new Store(join(config.dataDirectory,'native-control.sqlite')),codex=new Codex(config.agent.codexBinary);
  const runtime=new BotRuntime({store,codex,root:config.agent.workspaces,defaultTimeZone:process.env.BOTS_TIME_ZONE??'UTC',
    adminLeadIds:JSON.parse(process.env.BOTS_ADMIN_LEAD_IDS??'[]')});
  const inherited=storedRuntimeDefaults(store);if(inherited!==undefined)runtime.defaults=inherited;
  runtime.maintenance.source=source;
  // Authentication captures hello before runtime.start. Construct the same
  // original volatile service first, so its capability is not permanently
  // advertised as absent. Startup/readiness still fences every form action.
  runtime.secure ??= new SecureInputs(runtime);
  if(process.platform==='linux'&&config.agent.desktops?.enabled===true)runtime.desktops=new BotDesktops({runtime,...config.agent.desktops});
  const journal=new NodeJournal(join(config.dataDirectory,'node-journal.sqlite'));
  const manager=new CodexManager({runtime,store,directory:join(config.dataDirectory,'manager')});runtime.manager=manager;
  manager.maintenanceCredential=process.env.BOTS_MACHINE_SECRET;
  const transport=new AgentTransport({config,runtime,journal,key:nodeKey(join(config.dataDirectory,'node-key.pem')),enrollment,startupReady:false});
  runtime.storage=new NodeStorageClient(runtime,transport,enrollment.hub,{loopback:centralLoopback(config)});
  runtime.relayBuffered=()=>transport.socket?.bufferedAmount??0;
  installHubToolRoutes(runtime,manager,transport);
  await manager.listen();transport.connect();
  try{
    await runtime.start({deferNativeRecovery:true});await manager.recover();await runtime.desktops?.recover();
    transport.startupReady=true;await transport.recover();
  }catch(error){transport.close();throw error;}
  transport.recoveryTimer=setInterval(()=>void transport.recover().catch(error=>runtime.emit('fault',error)),5000);
  // No runtime.tick: logical queue/schedule authority must live at the hub.
  // Existing admitted native work and tool responses still stream normally.
  return {runtime,transport,journal,manager};
}

export function installHubToolRoutes(runtime,manager,transport,platform=process.platform){
  const store=runtime.store,originalTool=manager.callTracked.bind(manager);
  manager.callTracked=(botId,name,args,origin)=>{
    if(HUB_TOOLS.has(name)){
      const bot=store.bot(botId);if(origin||bot.archived||bot.archiving||bot.deletedAt)throw Error('Hub controls belong to the authenticated assigned primary bot.');
      return transport.controlRequest(botId,name,args);
    }
    if(platform==='darwin' && /desktop|secure|operator/.test(name))throw Error('This Mac capability has not been validated.');
    return originalTool(botId,name,args,origin);
  };
  const nativeTool=runtime.dynamicToolTracked.bind(runtime);
  runtime.dynamicToolTracked=(bot,p,origin)=>{
    if(!HUB_TOOLS.has(p.tool))return nativeTool(bot,p,origin);
    const current=store.bot(bot.id);
    if(origin||current.archived||current.archiving||current.deletedAt||p.threadId!==current.threadId||p.turnId!==current.activeTurnId||runtime.activityUnresolved(bot.id))throw Error('Hub controls require this bot’s current native primary tool authority.');
    const args=typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments;
    if(['bots_schedule_save','bots_schedule_delete'].includes(p.tool)&&!id(p.callId))throw Error('Original native tool call identity is required.');
    const operationId=['bots_schedule_save','bots_schedule_delete'].includes(p.tool)?`tool:${p.callId}`:args.operationId;
    return transport.controlRequest(bot.id,p.tool,{...args,...(operationId?{operationId}:{})});
  };
}
