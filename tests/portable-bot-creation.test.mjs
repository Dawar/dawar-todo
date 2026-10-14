import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {cpSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HubStore,NodeJournal} from '../portable/control-store.mjs';
import {nodeKey,originalCreationProof} from '../portable/protocol.mjs';
import {RUNTIME_COMPANIONS} from '../portable/runtime-companions.mjs';
import {Store} from '../bot-bridge/store.mjs';
import {BotRuntime} from '../bot-bridge/runtime.mjs';
import {ProviderRouter} from '../bot-bridge/provider-router.mjs';
import {ClaudeBackend} from '../bot-bridge/claude.mjs';
import {fakeQuery,fakeMcp,text,result,MinimalCodex} from '../bot-bridge/claude-test-support.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const OWNER='owner-one',NODE='node-one';
const settle=()=>new Promise(r=>setTimeout(r,15));
const until=async(fn,label='condition')=>{for(let i=0;i<300&&!fn();i++)await settle();assert.ok(fn(),label);};

// Bundled exactly like the shipped agent/controls so companion paths resolve.
async function bundles(directory){
  for(const name of RUNTIME_COMPANIONS)cpSync(join(root,'bot-bridge',name),join(directory,name));
  await build({entryPoints:[join(root,'portable/hub-controls.mjs')],outfile:join(directory,'controls.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',logLevel:'error'});
  await build({entryPoints:[join(root,'portable/agent.mjs')],outfile:join(directory,'agent.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',logLevel:'error'});
  await build({entryPoints:[join(root,'portable/hub-rpc.mjs')],outfile:join(directory,'rpc.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',logLevel:'error'});
  return {...await import(pathToFileURL(join(directory,'controls.mjs')).href),...await import(pathToFileURL(join(directory,'agent.mjs')).href),
    ...await import(pathToFileURL(join(directory,'rpc.mjs')).href)};
}

/**
 * A hub and one execution node joined by an in-memory socket. The hub side
 * mirrors gateway.mjs: authenticate → sync, receipt → store/router/controls,
 * event → store/controls, rpc-result → router.
 */
async function harness(t,{claude=true,botCreation=true}={}){
  mkdirSync(join(root,'dist'),{recursive:true});
  const directory=mkdtempSync(join(root,'dist','bot-creation-test-'));
  const {HubControls,AgentTransport,HubRpc}=await bundles(directory);
  const hub=new HubStore(join(directory,'control.sqlite'));
  hub.db.exec(`INSERT INTO portable_nodes VALUES('${NODE}','${OWNER}','unused','node-fingerprint','{}',NULL,1); INSERT INTO portable_authority VALUES(1,'test-writer',1,0)`);
  const connections=new Map(),router=new HubRpc(hub,connections);
  const controls=new HubControls({path:join(directory,'control.sqlite'),hub,router,authority:{writerId:'test-writer',epoch:1}});router.controls=controls;
  const nodeStore=new Store(join(directory,'native-control.sqlite')),journal=new NodeJournal(join(directory,'node-journal.sqlite'));
  const codex=new MinimalCodex(),prompts=[];
  const backend=claude?new ClaudeBackend({store:nodeStore,credential:'test',configDir:join(directory,'claude'),mcp:fakeMcp,
    query:fakeQuery(async user=>{prompts.push(user.message.content.at(-1).text);return [text(`m-${user.uuid}`,'hello from claude'),result(user.uuid)];})}):null;
  const runtime=new BotRuntime({store:nodeStore,codex:new ProviderRouter({codex,claude:backend}),root:join(directory,'bots')});
  runtime.sources.owner={key:OWNER};
  await runtime.start({deferNativeRecovery:true});
  const hubSide={readyState:1,send:text=>queueMicrotask(()=>agentSide.listeners.message?.({data:text})),close(){this.readyState=3;}};
  const agentSide={readyState:1,listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},close(){this.readyState=3;},
    send:value=>queueMicrotask(()=>hubFrame(JSON.parse(value)))};
  const frames=[];
  function hubFrame(m){
    frames.push(m.type);
    try{
      if(m.type==='authenticate'){
        hubSide.portableHello={...m.hello,capabilities:{...m.hello.capabilities,botCreation:botCreation&&m.hello.capabilities.botCreation}};
        connections.set(NODE,hubSide);hubSide.send(JSON.stringify({type:'sync',...hub.sync(NODE,m.cursor??0)}));
      }else if(m.type==='sync')hubSide.send(JSON.stringify({type:'sync',...hub.sync(NODE,m.cursor??0)}));
      else if(m.type==='receipt'){const row=hub.receipt(NODE,m.operationId,m.fingerprint,m.state,m.receipt);router.receipt(row);controls.receipt(row);}
      else if(m.type==='event'){const before=hub.eventCursor(),sequence=hub.event(NODE,m.eventId,m.botId,m.epoch,m.event);
        if(sequence>before)controls.nativeEvent(m.event,NODE,m.epoch);hubSide.send(JSON.stringify({type:'event-ack',eventId:m.eventId,sequence}));}
      else if(m.type==='rpc-result')router.readResult(NODE,m);
    }catch(error){frames.push(`rejected:${m.type}:${error.message}`);}
  }
  const transport=new AgentTransport({config:{},runtime,journal,key:nodeKey(join(directory,'node-key.pem')),
    enrollment:{nodeId:NODE,owner:OWNER,hub:'https://hub.test/'},socketFactory:()=>agentSide});
  transport.connect();
  agentSide.listeners.message({data:JSON.stringify({type:'challenge',challenge:'c',connectionId:'k'})});
  await until(()=>connections.has(NODE)&&journal.online,'node connected');
  t.after(async()=>{transport.close();backend?.close();runtime.usage.stop();agentSide.listeners={};hubSide.send=()=>{};await settle();await settle();controls.close();hub.close();nodeStore.close();journal.close();rmSync(directory,{recursive:true,force:true});});
  const request=(method,params,operationId,botId)=>router.request(OWNER,{id:`r-${Math.random().toString(36).slice(2)}`,method,params,operationId,...(botId?{botId}:{})},'client-one');
  return {hub,controls,router,runtime,nodeStore,journal,transport,codex,prompts,frames,request};
}

test('owner creates a Claude bot through the hub: reserved, provisioned, adopted and usable',async t=>{
  const h=await harness(t);
  const op='create-claude-0001';
  const {result:bot}=await h.request('bots.create',{name:'  Sage ',purpose:'Research',provider:'claude'},op);
  assert.equal(bot.id,op);
  assert.match(bot.threadId,/^claude:/);
  assert.equal(bot.provider,'claude');
  assert.equal(bot.nodeId,NODE);
  // The hub record carries the native identity; the provisional marker is gone.
  const hubBot=h.controls.store.bot(op);
  assert.equal(hubBot.threadId,bot.threadId);
  assert.equal(hubBot.slug,'sage');
  assert.equal(hubBot.portableCreation,undefined);
  assert.equal(hubBot.name,'Sage');
  assert.deepEqual(h.hub.placement(OWNER,op).epoch,1);
  assert.equal(h.nodeStore.bot(op).threadId,bot.threadId);
  assert.ok(!h.frames.some(f=>f.startsWith('rejected:')),h.frames.filter(f=>f.startsWith('rejected:')).join('\n'));
  // A retry returns the original result; changed input under the same ID is refused.
  assert.deepEqual((await h.request('bots.create',{name:'  Sage ',purpose:'Research',provider:'claude'},op)).result,bot);
  await assert.rejects(h.request('bots.create',{name:'Other',provider:'claude'},op),e=>e.outcome==='rejected');
  assert.equal(h.nodeStore.bots().filter(b=>b.name==='Sage').length,1,'no second native bot');
  // The new bot appears in the hub snapshot with the creation capability.
  const {result:snapshot}=await h.request('snapshot',{},undefined);
  assert.ok(snapshot.bots.some(b=>b.id===op&&b.threadId===bot.threadId));
  assert.equal(snapshot.capabilities.botCreation,1);
  assert.equal(snapshot.capabilities.claudeBots,1);
  // And it works: an owner turn is delivered to the node and answered by Claude.
  await h.request('turn.send',{text:'hi'},'turn-send-0001',op);
  await until(()=>h.prompts.includes('hi'),'Claude received the turn');
});

test('a Codex bot is created on the node through the same path',async t=>{
  const h=await harness(t,{claude:false});
  const {result:bot}=await h.request('bots.create',{name:'Atlas'},'create-codex-0001');
  assert.equal(bot.threadId,'codex-thread-1');
  assert.equal(bot.provider,undefined);
  assert.equal(h.controls.store.bot('create-codex-0001').threadId,'codex-thread-1');
  assert.deepEqual(h.codex.calls.filter(c=>c.method==='thread/start').length,1);
});

test('a refused creation releases its reservation completely',async t=>{
  const h=await harness(t,{claude:false});
  const op='create-refused-001';
  // This node runs no Claude backend: native creation refuses before any effect.
  await assert.rejects(h.request('bots.create',{name:'Nope',provider:'claude'},op),e=>e.outcome==='rejected'&&/Claude/.test(e.message));
  assert.equal(h.hub.db.prepare('SELECT count(*) n FROM portable_placements WHERE bot_id=?').get(op).n,0);
  assert.equal(h.controls.store.bots({includeDeleted:true}).some(b=>b.id===op),false);
  assert.equal(h.controls.store.operation(op).status,'failed');
  assert.equal(h.nodeStore.bots({includeDeleted:true}).some(b=>b.id===op),false);
  // The original outcome is stable on retry, and nothing is resent.
  await assert.rejects(h.request('bots.create',{name:'Nope',provider:'claude'},op),e=>e.outcome==='rejected');
  assert.ok(!h.frames.some(f=>f.startsWith('rejected:')),h.frames.join('\n'));
});

test('creation is not sent without an eligible node or with bad input',async t=>{
  const h=await harness(t,{botCreation:false});
  await assert.rejects(h.request('bots.create',{name:'Late'},'create-noderr-001'),e=>e.outcome==='not-sent'&&/No connected execution machine/.test(e.message));
  assert.equal(h.controls.store.operation('create-noderr-001'),null,'nothing was reserved');
  const {result:snapshot}=await h.request('snapshot',{},undefined);
  assert.equal(snapshot.capabilities.botCreation,undefined);
  await assert.rejects(h.request('bots.create',{name:''},'create-badname-01'),e=>e.outcome==='rejected');
  await assert.rejects(h.request('bots.create',{name:'X',shell:'rm'},'create-badkey-001'),e=>e.outcome==='rejected');
  await assert.rejects(h.request('bots.create',{name:'X'},'short'),e=>e.outcome==='rejected');
  await assert.rejects(h.request('bots.create',{name:'X',nodeId:'node-two'},'create-badnode-01'),e=>e.outcome==='not-sent');
  assert.equal(h.hub.db.prepare('SELECT count(*) n FROM portable_mailbox').get().n,0);
});

test('an interrupted creation is settled only by proof of its own thread, never restarted',async t=>{
  const h=await harness(t,{claude:false});
  const op='create-crashed-001';
  // Simulate a node crash after the native thread started but before the bot
  // record learned its thread: the hub reservation and node command exist,
  // the runtime operation is dispatching and the bot has no threadId.
  h.transport.close();await settle();
  const owner=OWNER;
  h.controls.store.transaction(()=>h.controls.creation.reserve(owner,op,'binding',{name:'Crash'},{name:'Crash',purpose:''},{id:NODE},{kind:'owner'}));
  const row=h.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(op);
  h.journal.synchronize(h.hub.sync(NODE).controls);
  h.journal.receive(row);h.journal.prepare(op);
  h.nodeStore.saveOperation(op,'native-fingerprint','dispatching',{method:'bots.create',params:{name:'Crash'}});
  const cwd=join(h.runtime.root,'crash');
  h.nodeStore.saveBot({id:op,name:'Crash',slug:'crash',cwd,threadId:null,status:'provisioning',executionMode:'single-thread'});
  h.codex.threads.push({id:'codex-thread-orphan',cwd,status:{type:'idle'}});
  const startsBefore=h.codex.calls.filter(c=>c.method==='thread/start').length;
  const sent=[];h.transport.receipt=r=>sent.push(r);
  await h.transport.recoverCreation(JSON.parse(h.journal.db.prepare('SELECT command FROM node_commands WHERE operation_id=?').get(op).command),
    h.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(op));
  const settled=h.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(op);
  assert.equal(settled.state,'terminal');
  const receipt=JSON.parse(settled.receipt);
  assert.equal(receipt.threadId,'codex-thread-orphan');
  assert.ok(originalCreationProof(receipt,op,{method:'bots.create'}));
  assert.equal(h.codex.calls.filter(c=>c.method==='thread/start').length,startsBefore,'no new thread was started');
  // With two candidate threads the outcome stays unknown instead of guessing.
  const op2='create-crashed-002',cwd2=join(h.runtime.root,'twins');
  h.controls.store.transaction(()=>h.controls.creation.reserve(owner,op2,'binding-2',{name:'Twins'},{name:'Twins',purpose:''},{id:NODE},{kind:'owner'}));
  const row2=h.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(op2);
  h.journal.synchronize(h.hub.sync(NODE).controls);h.journal.receive(row2);h.journal.prepare(op2);
  h.nodeStore.saveOperation(op2,'native-fingerprint-2','dispatching',{method:'bots.create',params:{name:'Twins'}});
  h.nodeStore.saveBot({id:op2,name:'Twins',slug:'twins',cwd:cwd2,threadId:null,status:'provisioning',executionMode:'single-thread'});
  h.codex.threads.push({id:'twin-a',cwd:cwd2},{id:'twin-b',cwd:cwd2});
  await h.transport.recoverCreation(JSON.parse(h.journal.db.prepare('SELECT command FROM node_commands WHERE operation_id=?').get(op2).command),
    h.journal.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(op2));
  assert.equal(h.journal.db.prepare('SELECT state FROM node_commands WHERE operation_id=?').get(op2).state,'unknown');
});

test('the hub adopts a provisional bot thread from the first native event, once',async t=>{
  const h=await harness(t,{claude:false});
  const op='create-adopt-0001';
  h.controls.store.transaction(()=>h.controls.creation.reserve(OWNER,op,'binding',{name:'Ada'},{name:'Ada',purpose:''},{id:NODE},{kind:'owner'}));
  // A provisioning event (no thread yet) passes; the threaded event adopts.
  h.controls.nativeEvent({type:'bot',botId:op,data:{id:op,threadId:null,status:'provisioning'}},NODE,1);
  assert.equal(h.controls.store.bot(op).portableCreation.operationId,op);
  h.controls.nativeEvent({type:'bot',botId:op,data:{id:op,threadId:'codex-thread-9',slug:'ada',name:'Ada',status:'idle',cwd:'/bots/ada'}},NODE,1);
  const adopted=h.controls.store.bot(op);
  assert.equal(adopted.threadId,'codex-thread-9');
  assert.equal(adopted.slug,'ada');
  assert.equal(adopted.portableCreation,undefined);
  // After adoption the original identity rule applies again.
  assert.throws(()=>h.controls.nativeEvent({type:'bot',botId:op,data:{id:op,threadId:'other-thread'}},NODE,1),/original identity/);
  // A slug already used on the hub gets a suffix instead of failing.
  const op2='create-adopt-0002';
  h.controls.store.transaction(()=>h.controls.creation.reserve(OWNER,op2,'binding-2',{name:'Ada'},{name:'Ada',purpose:''},{id:NODE},{kind:'owner'}));
  h.controls.nativeEvent({type:'bot',botId:op2,data:{id:op2,threadId:'codex-thread-10',slug:'ada'}},NODE,1);
  assert.equal(h.controls.store.bot(op2).slug,'ada-create-a');
});
