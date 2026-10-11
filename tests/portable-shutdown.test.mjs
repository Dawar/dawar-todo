import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { RuntimeMaintenance } from '../bot-bridge/runtime-maintenance.mjs';
import { combinedShutdown } from '../portable/combined-shutdown.mjs';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'portable-shutdown-')),store=new Store(join(directory,'control.sqlite'));
  store.put('primaryInbox',{id:'retained-input',botId:'bot',state:'accepted'});
  store.put('pending',{id:'retained-notice',botId:'bot'});
  let time=1000, fresh=true, reads=0;
  const native={status:'idle',goal:null,queue:[],calls:[],duringRead:null};
  const runtime={store,epoch:'instance',codex:{pending:new Map(),async call(method,params){
    native.calls.push(method);native.duringRead?.(method);
    if(method==='thread/loaded/list')return {data:['thread'],nextCursor:null};
    if(method==='thread/read')return {thread:{id:params.threadId,status:{type:native.status}}};
    if(method==='thread/goal/get')return {goal:native.goal};
    if(method==='thread/queue/list')return {data:native.queue,nextCursor:null};
    throw Error('Unexpected native mutation');
  }}};
  const terminalProof={snapshot:()=>({fingerprint:'unchanged-originals',input:{accepted:[{}],questions:[{}]}}),
    async read(){reads++;fresh=true;return {terminalInputs:[{}],passiveQuestions:[{}]};},matches:()=>true,fresh:()=>fresh};
  const maintenance=new RuntimeMaintenance(runtime,{clock:()=>time,monotonic:()=>time,source:()=>{},invocation:'invocation',terminalProof});
  const spec={operationId:'test-original-shutdown',commit:'a'.repeat(40),version:'0.162.1',instanceId:'instance',invocationId:'invocation',unitId:'test-original.service',waitSeconds:900};
  t.after(()=>{maintenance.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,maintenance,native,terminalProof,advance:n=>{time+=n;},invalidate:()=>{fresh=false;},reads:()=>reads,
    async claim(){maintenance.begin(spec);assert.equal((await maintenance.control({...spec,action:'observe'})).safe,true);await maintenance.control({...spec,action:'seal'});await maintenance.control({...spec,action:'claim'});}};
}

test('delayed claimed shutdown refreshes exact retained proof and all native idle checks',async t=>{
  const f=fixture(t);await f.claim();const row=f.store.get('runtimeMaintenance','test-original-shutdown');
  const originals=JSON.stringify([f.store.list('pending'),f.store.list('primaryInbox')]);
  f.advance(6000);f.invalidate();assert.equal(f.maintenance.counts().pendingInput,1);
  const reads=f.reads();f.native.calls.length=0;
  assert.equal((await f.maintenance.prepareShutdown()).safe,true);assert.ok(f.reads()>reads);
  assert.deepEqual(f.native.calls,['thread/loaded/list','thread/read','thread/goal/get','thread/queue/list']);
  assert.deepEqual(f.store.get('runtimeMaintenance',row.id),row);
  assert.equal(JSON.stringify([f.store.list('pending'),f.store.list('primaryInbox')]),originals);
});

for(const [name,change] of [
  ['active native turn',f=>{f.native.status='active';}],
  ['active native Goal',f=>{f.native.goal={threadId:'thread',status:'active'};}],
  ['accepted native queue',f=>{f.native.queue=[{id:'queued'}];}],
  ['new pending input',f=>{f.store.put('pending',{id:'new-notice',botId:'bot'});}],
  ['changed retained identity',f=>{f.terminalProof.snapshot=()=>null;}],
  ['concurrent native notification',f=>{f.native.duringRead=()=>{f.maintenance.generation++;};}],
  ['expired original lease',f=>{f.advance(900001);}],
]) test(`shutdown refuses ${name}`,async t=>{
  const f=fixture(t);await f.claim();f.advance(6000);change(f);
  await assert.rejects(f.maintenance.prepareShutdown());
});

test('an ordinary signal cannot manufacture a restart claim',async t=>{
  const f=fixture(t);await assert.rejects(f.maintenance.prepareShutdown(),/original restart claim/);
  assert.deepEqual(f.native.calls,[]);
});

function shutdownFixture() {
  const events=[],close=name=>()=>{events.push(name);};
  const maintenance={prepareShutdown:async()=>{events.push('proof');},counts:()=>({active:0}),close:close('maintenance')};
  const agent={runtime:{maintenance,usage:{stop:close('usage')},codex:{close:close('native')},desktops:{close:close('desktops')},store:{close:close('store')}},
    transport:{pending:new Map(),controlPending:new Map(),close:close('transport')},manager:{close:close('manager')},journal:{close:close('journal')}};
  const options={agent,gateway:{close:close('gateway')},health:{close:close('health')},stopping:close('stopping')};
  return {events,maintenance,agent,options};
}
test('concurrent shutdown requests share proof and close resources once',async()=>{
  const f=shutdownFixture();let release;
  f.maintenance.prepareShutdown=()=>new Promise(resolve=>{f.events.push('proof');release=resolve;});
  const close=combinedShutdown(f.options),first=close(),second=close();assert.equal(first,second);
  assert.deepEqual(f.events,['proof']);release();await first;
  assert.deepEqual(f.events,['proof','gateway','stopping','health','transport','usage','maintenance','native','desktops','manager','journal','store']);
});
test('failed proof or pending transport leaves every service resource running',async()=>{
  const f=shutdownFixture();f.maintenance.prepareShutdown=async()=>{throw Error('not idle');};
  const close=combinedShutdown(f.options);await assert.rejects(close(),/not idle/);assert.deepEqual(f.events,[]);
  f.maintenance.prepareShutdown=async()=>{};f.agent.transport.pending.set('original',{});
  await assert.rejects(close(),/idle proof/);assert.deepEqual(f.events,[]);
});
