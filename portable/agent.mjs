import { join, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Store } from '../bot-bridge/store.mjs';
import { Codex } from '../bot-bridge/codex.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { CodexManager } from '../bot-bridge/manager.mjs';
import { NodeJournal } from './control-store.mjs';
import { nodeKey, signature, PROTOCOL_VERSION, RUNTIME_VERSION } from './protocol.mjs';

export class AgentTransport {
  constructor({ config, runtime, journal, key, enrollment, socketFactory=url=>new WebSocket(url) }) {
    Object.assign(this,{config,runtime,journal,key,enrollment,socketFactory});
    this.socket=null;this.retry=0;this.closed=false;this.pending=new Map();this.cursor=0;
    this.terminalCandidates=new Map();
    const nativeGuard=runtime.codex.admissionGuard;
    runtime.codex.admissionGuard=(method,params)=>{
      nativeGuard?.(method,params);
      if(['thread/start','thread/fork'].includes(method))throw Object.assign(Error('New native context provisioning awaits the hub placement adapter.'),{definite:true});
      if(!['turn/start','turn/steer','thread/queue/add','thread/queue/update','thread/goal/set'].includes(method))return;
      const bot=runtime.store.bots().find(b=>b.threadId===params.threadId);
      const control=bot && journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(bot.id);
      if(!bot || !journal.canAdmit({bot_id:bot.id,epoch:control?.epoch}))throw Object.assign(Error('Hub control is offline, stale or stopped; no native input was submitted.'),{definite:true});
      if(process.platform==='darwin' && method==='thread/goal/set')throw Object.assign(Error('Autonomous Goals are unavailable on the Mac pilot.'),{definite:true});
    };
    runtime.on('event',event=>{
      if(!event.botId)return;
      const c=journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(event.botId);
      if(!c)return;
      if(event.type==='codex'&&event.data?.method==='turn/completed'){
        const p=event.data.params,turn=p?.turn;
        if(p?.threadId&&turn?.id&&['completed','failed','interrupted'].includes(turn.status)){
          this.terminalCandidates.set(turn.id,{threadId:p.threadId,turnId:turn.id,status:turn.status});
          for(const row of journal.db.prepare("SELECT * FROM node_commands WHERE state IN ('native-accepted','running')").all())this.terminal(row);
        }
      }
      journal.recordEvent(`event:${randomUUID()}`,{botId:event.botId,epoch:c.epoch,event});this.flushEvents();
    });
  }
  hello(){return {protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION,platform:process.platform,arch:process.arch,
    capabilities:{text:true,localStdio:true,desktop:false,voice:false,secureTransfer:false,autonomousGoals:false}};}
  send(value){if(this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify(value));}
  flushEvents(){for(const r of this.journal.pendingEvents()){const e=JSON.parse(r.event);this.send({type:'event',eventId:r.event_id,...e});}}
  receipt(row){this.send({type:'receipt',operationId:row.operation_id,fingerprint:row.fingerprint,state:row.state==='dispatching'?'unknown':row.state,
    receipt:row.receipt?JSON.parse(row.receipt):{operationId:row.operation_id}});}
  terminal(row){
    const receipt=row.receipt&&JSON.parse(row.receipt),p=receipt&&this.terminalCandidates.get(receipt.turnId);
    if(!p||p.threadId!==receipt.threadId)return;
    this.journal.settle(row.operation_id,'terminal',{...receipt,nativeStatus:p.status});
    this.terminalCandidates.delete(p.turnId);
    this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(row.operation_id));
  }
  connect(){
    if(this.closed)return;
    const url=new URL('/nodes/connect',this.enrollment.hub);if(url.protocol!=='https:')throw Error('Agent connections require TLS.');url.protocol='wss:';
    const ws=this.socketFactory(url);this.socket=ws;
    let authentication=false;
    ws.addEventListener('message',event=>{
      void (async()=>{
        if(this.socket!==ws)return;
        const m=JSON.parse(event.data);
        if(m.type==='challenge'){
          const hello=this.hello(),bound={nodeId:this.enrollment.nodeId,challenge:m.challenge,connectionId:m.connectionId,hello};
          this.send({type:'authenticate',...bound,proof:signature(this.key.privateKey,bound),cursor:this.cursor});return;
        }
        if(m.type==='sync'){
          if(m.controls.some(c=>c.node_id!==this.enrollment.nodeId||c.owner!==this.enrollment.owner))throw Error('Foreign control snapshot.');
          this.journal.synchronize(m.controls);authentication=true;this.retry=0;
          // This synchronized fence blocks new admission. User queuePaused,
          // Goal and current-turn state are not rewritten to infer Stop ACK.
          for(const command of m.commands){
            if(command.node_id!==this.enrollment.nodeId||command.owner!==this.enrollment.owner)throw Error('Foreign node command.');
            this.cursor=Math.max(this.cursor,command.sequence);const row=this.journal.receive(command);
            if(!this.pending.has(row.operation_id)){
              const work=this.execute(command,row).finally(()=>this.pending.delete(row.operation_id));this.pending.set(row.operation_id,work);await work;
            }
          }
          this.flushEvents();
        } else if(authentication && m.type==='event-ack')this.journal.acknowledgeEvent(m.eventId);
      })().catch(()=>ws.close(1008,'Protocol could not be confirmed'));
    });
    ws.addEventListener('close',()=>{
      if(this.socket!==ws)return;this.journal.disconnect();this.runtime.relayOnline=false;clearInterval(this.heartbeat);
      if(!this.closed)this.retryTimer=setTimeout(()=>this.connect(),Math.min(30000,1000*2**Math.min(this.retry++,5)));
    });
    ws.addEventListener('error',()=>ws.close());
    this.heartbeat=setInterval(()=>{if(authentication){this.runtime.relayOnline=true;this.send({type:'sync',cursor:this.cursor});this.flushEvents();}},5000);
  }
  async execute(command,row){
    if(row.state==='terminal'||row.state==='unknown'||row.state==='native-accepted'||row.state==='running'){this.receipt(row);return;}
    if(!this.journal.canAdmit(command))return;
    const payload=JSON.parse(command.payload);
    if(payload.method!=='turn.send')throw Error('This staging agent currently admits only an explicit text turn; unsupported controls remain at the hub.');
    const bot=this.runtime.store.bot(command.bot_id);if(!bot || bot.archived || bot.deletedAt)throw Error('Assigned native bot is absent or archived.');
    const request={method:payload.method,botId:command.bot_id,operationId:command.operation_id,params:payload.params,clientId:`hub:${this.enrollment.nodeId}`};
    if(row.state==='dispatching' && !this.runtime.store.operation(command.operation_id)) {
      // The process could have died before or after an unobserved native write.
      // An absent local operation is not authorization to resubmit.
      this.journal.settle(command.operation_id,'unknown',{operationId:command.operation_id,reason:'Restart interrupted command admission.'});
      this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));return;
    }
    if(row.state==='received'){this.receipt(row);this.journal.prepare(command.operation_id);}
    try {
      const result=await this.runtime.handle(request), turnId=result?.turn?.id??result?.turnId;
      const receipt={operationId:command.operation_id,threadId:bot.threadId,turnId,result};
      this.journal.settle(command.operation_id,turnId?'native-accepted':'unknown',receipt);
    } catch(error){this.journal.settle(command.operation_id,error.outcome==='rejected'?'terminal':'unknown',{operationId:command.operation_id,outcome:error.outcome??'uncertain',error:error.message});}
    this.receipt(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));
    this.terminal(this.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id));
  }
  close(){this.closed=true;clearInterval(this.heartbeat);clearTimeout(this.retryTimer);this.journal.disconnect();this.socket?.close();}
}

export async function runAgent(config){
  // Staging cannot accidentally attach a second Codex process to production
  // workspaces. The migration's exact activation proof is required first.
  if(!config.agent?.activationReceipt || !isAbsolute(config.agent.codexBinary)||!isAbsolute(config.agent.workspaces))throw Error('Agent activation receipt, local Codex binary and workspaces are required.');
  const activation=JSON.parse(await readFile(config.agent.activationReceipt,'utf8'));
  if(activation.kind!=='portable-agent-activation'||activation.executionEnabled!==true||activation.nodeId!==config.agent.nodeId||activation.runtime!==RUNTIME_VERSION)
    throw Error('Reviewed agent activation is not confirmed.');
  const enrollment=JSON.parse(await readFile(join(config.dataDirectory,'node-enrollment.json'),'utf8'));
  if(enrollment.nodeId!==config.agent.nodeId)throw Error('Enrollment differs from activated node.');
  process.umask(0o077);
  const store=new Store(join(config.dataDirectory,'native-control.sqlite')),codex=new Codex(config.agent.codexBinary);
  const runtime=new BotRuntime({store,codex,root:config.agent.workspaces,defaultTimeZone:'America/Toronto'});
  const journal=new NodeJournal(join(config.dataDirectory,'node-journal.sqlite'));
  const manager=new CodexManager({runtime,store,directory:join(config.dataDirectory,'manager')});runtime.manager=manager;
  const originalTool=manager.callTracked.bind(manager);
  manager.callTracked=(botId,name,args,origin)=>{
    if(['bots_queue','bots_schedule_save','bots_schedule_delete','bots_schedule_list'].includes(name))throw Error('Global queue/schedule controls await the authorized hub adapter; no local duplicate scheduler is started.');
    if(process.platform==='darwin' && /desktop|secure|operator/.test(name))throw Error('This Mac capability has not been validated.');
    return originalTool(botId,name,args,origin);
  };
  const transport=new AgentTransport({config,runtime,journal,key:nodeKey(join(config.dataDirectory,'node-key.pem')),enrollment});
  await manager.listen();await runtime.start();transport.connect();
  // No runtime.tick: logical queue/schedule authority must live at the hub.
  // Existing admitted native work and tool responses still stream normally.
  return {runtime,transport,journal,manager};
}
