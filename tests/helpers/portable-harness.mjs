// One hub and one execution node joined by an in-memory socket, with a Codex
// fake that actually starts and completes turns. The hub side mirrors
// gateway.mjs frame handling; the agent is the shipped bundled AgentTransport.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {build} from 'esbuild';
import {cpSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HubStore,NodeJournal} from '../../portable/control-store.mjs';
import {nodeKey} from '../../portable/protocol.mjs';
import {RUNTIME_COMPANIONS} from '../../portable/runtime-companions.mjs';
import {Store} from '../../bot-bridge/store.mjs';
import {BotRuntime} from '../../bot-bridge/runtime.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export const OWNER='owner-one',NODE='node-one';
export const settle=()=>new Promise(r=>setTimeout(r,15));
export const until=async(fn,label='condition',limit=300)=>{for(let i=0;i<limit&&!fn();i++)await settle();assert.ok(fn(),label);};

/** Native turns are real records: started, listed, read and completed. */
export class TurnCodex extends EventEmitter {
  ready=true;calls=[];threads=[];turnCount=0;failNext=new Map();
  async start(){}
  thread(id){return this.threads.find(t=>t.id===id);}
  async call(method,params){
    this.calls.push({method,params});
    const failure=this.failNext.get(method);if(failure){this.failNext.delete(method);throw failure;}
    if(method==='account/read')return {account:{type:'chatgpt'}};
    if(method==='model/list')return {data:[{model:'gpt-6.1-sol',supportedReasoningEfforts:[{reasoningEffort:'medium'}],serviceTiers:[{id:'priority'}]},
      {model:'gpt-6-luna',supportedReasoningEfforts:[{reasoningEffort:'high'}],serviceTiers:[{id:'priority'}]}],nextCursor:null};
    if(method==='thread/start'){const thread={id:`codex-thread-${this.threads.length+1}`,cwd:params.cwd,status:{type:'idle'},turns:[]};this.threads.push(thread);return {thread:{...thread,turns:[]}};}
    if(method==='thread/resume')return {thread:{...this.thread(params.threadId),turns:[]}};
    if(method==='thread/read'){const t=this.thread(params.threadId);return {thread:{...t,status:t.turns.some(x=>x.status==='inProgress')?{type:'active',activeFlags:[]}:{type:'idle'},turns:params.includeTurns?t.turns:[]}};}
    if(method==='thread/turns/list'){const t=this.thread(params.threadId);return {data:[...t.turns].reverse().map(turn=>({...turn,itemsView:'full'})),nextCursor:null};}
    if(method==='thread/list')return {data:this.threads.filter(t=>!params?.cwd||t.cwd===params.cwd),nextCursor:null};
    if(method==='thread/loaded/list')return {data:[],nextCursor:null};
    if(method==='thread/queue/list')return {data:[],nextCursor:null};
    if(method==='thread/goal/get')return {goal:null};
    if(method==='turn/start'){
      const turn={id:`turn-${++this.turnCount}`,status:'inProgress',startedAt:Math.floor(Date.now()/1000),
        items:[{type:'userMessage',id:`user-${this.turnCount}`,clientId:params.clientUserMessageId,content:params.input}]};
      this.thread(params.threadId).turns.push(turn);
      queueMicrotask(()=>this.emit('notification',{method:'turn/started',params:{threadId:params.threadId,turn:{...turn,items:[]}}}));
      return {turn:{...turn}};
    }
    return {};
  }
  /** Finish a native turn; `notify:false` models a lost completion event. */
  complete(threadId,turnId,{notify=true,status='completed'}={}){
    const turn=this.thread(threadId).turns.find(t=>t.id===turnId);turn.status=status;turn.completedAt=Math.floor(Date.now()/1000);
    turn.items.push({type:'agentMessage',id:`answer-${turnId}`,text:`done ${turnId}`,phase:'final_answer'});
    if(notify)this.emit('notification',{method:'turn/completed',params:{threadId,turn:{...turn}}});
  }
  starts(){return this.calls.filter(c=>c.method==='turn/start');}
  respond(){} reject(){} close(){}
  async closeForShutdown(){}
}

async function bundles(directory){
  for(const name of RUNTIME_COMPANIONS)cpSync(join(root,'bot-bridge',name),join(directory,name));
  const one=(entry,out)=>build({entryPoints:[join(root,entry)],outfile:join(directory,out),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',logLevel:'error'});
  await Promise.all([one('portable/hub-controls.mjs','controls.mjs'),one('portable/agent.mjs','agent.mjs'),one('portable/hub-rpc.mjs','rpc.mjs')]);
  return {...await import(pathToFileURL(join(directory,'controls.mjs')).href),...await import(pathToFileURL(join(directory,'agent.mjs')).href),
    ...await import(pathToFileURL(join(directory,'rpc.mjs')).href)};
}

export async function portableHarness(t){
  mkdirSync(join(root,'dist'),{recursive:true});
  const directory=mkdtempSync(join(root,'dist','send-reliability-test-'));
  const {HubControls,AgentTransport,HubRpc,installHubToolRoutes}=await bundles(directory);
  const hub=new HubStore(join(directory,'control.sqlite'));
  hub.db.exec(`INSERT INTO portable_nodes VALUES('${NODE}','${OWNER}','unused','node-fingerprint','{"capabilities":{"centralBursts":true}}',NULL,1); INSERT INTO portable_authority VALUES(1,'test-writer',1,0)`);
  const connections=new Map(),router=new HubRpc(hub,connections);
  const controls=new HubControls({path:join(directory,'control.sqlite'),hub,router,owner:{key:OWNER},authority:{writerId:'test-writer',epoch:1}});router.controls=controls;
  const nodeStore=new Store(join(directory,'native-control.sqlite')),journal=new NodeJournal(join(directory,'node-journal.sqlite'));
  const codex=new TurnCodex();
  const runtime=new BotRuntime({store:nodeStore,codex,root:join(directory,'bots')});
  runtime.sources.owner={key:OWNER};
  await runtime.start({deferNativeRecovery:true});
  const frames=[],drop={receipt:false,control:false};
  let agentSide,hubSide,transport;
  const link=()=>{
    hubSide={readyState:1,send:text=>queueMicrotask(()=>agentSide.listeners.message?.({data:text})),close(){this.readyState=3;}};
    const mine=hubSide;
    agentSide={readyState:1,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},
      close(){if(this.readyState===3)return;this.readyState=3;if(connections.get(NODE)===mine)connections.delete(NODE);this.listeners.close?.();},
      send:value=>queueMicrotask(()=>hubFrame(JSON.parse(value),mine))};
    return agentSide;
  };
  function hubFrame(m,side){
    if(side.readyState!==1)return;
    frames.push(m.type);
    try{
      if(m.type==='authenticate'){
        side.portableHello=m.hello;connections.set(NODE,side);side.send(JSON.stringify({type:'sync',...hub.sync(NODE,m.cursor??0)}));
      }else if(m.type==='sync')side.send(JSON.stringify({type:'sync',...hub.sync(NODE,m.cursor??0)}));
      else if(m.type==='receipt'){
        if(drop.receipt){frames.push('dropped:receipt');return;}
        const row=hub.receipt(NODE,m.operationId,m.fingerprint,m.state,m.receipt);router.receipt(row);controls.receipt(row);
      }else if(m.type==='event'){const before=hub.eventCursor(),sequence=hub.event(NODE,m.eventId,m.botId,m.epoch,m.event);
        if(sequence>before)controls.nativeEvent(m.event,NODE,m.epoch);side.send(JSON.stringify({type:'event-ack',eventId:m.eventId,sequence}));}
      else if(m.type==='rpc-result')router.readResult(NODE,m);
      else if(m.type==='control-request'){
        if(drop.control){frames.push('dropped:control');return;}
        const answer=value=>side.send(JSON.stringify({type:'control-result',requestId:m.requestId,botId:m.botId,epoch:m.epoch,...value}));
        void controls.tool(OWNER,m.botId,m.tool,m.args,{kind:'authenticated-node-tool',botId:m.botId,nodeId:NODE,epoch:m.epoch}).then(result=>answer({result})).catch(error=>answer({error:error.message,outcome:error.outcome??'uncertain'}));
      }
    }catch(error){frames.push(`rejected:${m.type}:${error.message}`);}
  }
  transport=new AgentTransport({config:{},runtime,journal,key:nodeKey(join(directory,'node-key.pem')),
    enrollment:{nodeId:NODE,owner:OWNER,hub:'https://hub.test/'},socketFactory:()=>link()});
  installHubToolRoutes(runtime,{callTracked:()=>{}},transport);
  const handshake=async()=>{
    agentSide.listeners.message({data:JSON.stringify({type:'challenge',challenge:'c',connectionId:'k'})});
    await until(()=>connections.has(NODE)&&journal.online,'node connected');
  };
  transport.connect();await handshake();
  t.after(async()=>{transport.close();runtime.usage.stop();if(agentSide)agentSide.listeners={};hubSide.send=()=>{};await settle();await settle();controls.close();hub.close();nodeStore.close();journal.close();rmSync(directory,{recursive:true,force:true});});
  const request=(method,params,operationId,botId)=>router.request(OWNER,{id:`r-${Math.random().toString(36).slice(2)}`,method,params,operationId,...(botId?{botId}:{})},'client-one');
  /** Drop the node link the way a network loss would, then reconnect. */
  const disconnect=async()=>{const side=agentSide;clearTimeout(transport.retryTimer);side.close();await settle();clearTimeout(transport.retryTimer);};
  const reconnect=async()=>{clearTimeout(transport.retryTimer);transport.connect();await handshake();};
  const mailbox=operationId=>hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
  const mailboxes=botId=>hub.db.prepare('SELECT operation_id,state,json_extract(payload,\'$.method\') method FROM portable_mailbox WHERE bot_id=? ORDER BY sequence').all(botId);
  const node=operationId=>journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(operationId);
  const createBot=async(name='Atlas',op=`create-${name.toLowerCase()}-0001`)=>(await request('bots.create',{name},op)).result;
  return {hub,controls,router,runtime,nodeStore,journal,get transport(){return transport;},codex,frames,drop,request,disconnect,reconnect,mailbox,mailboxes,node,createBot,connections};
}
