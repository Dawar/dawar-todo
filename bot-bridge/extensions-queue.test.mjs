import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from './store.mjs';import {prepareLocalQueueMutation,acceptLocalQueueOperation} from './local-queue-operation.mjs';
test('extensions start at 2, backfill all bots, survive stale updates/restart and are never reused',async t=>{
 const root=await mkdtemp(join(tmpdir(),'bot-extensions-')),path=join(root,'state.sqlite');let store=new Store(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 const a=store.saveBot({id:'a',slug:'a',threadId:'a'}),b=store.saveBot({id:'b',slug:'b',threadId:'b',archived:true});assert.equal(a.extension,2);assert.equal(b.extension,3);
 store.saveBot({...a,extension:99,deletedAt:new Date().toISOString()});assert.equal(store.bot('a').extension,2);
 store.db.prepare("UPDATE bots SET json=json_remove(json,'$.extension')").run();store.db.prepare("DELETE FROM meta WHERE key='next-bot-extension'").run();store.close();store=new Store(path);
 assert.equal(store.bot('a').extension,2);assert.equal(store.bot('b').extension,3);const second=new Store(path);
 assert.equal(second.saveBot({id:'c',slug:'c',threadId:'c'}).extension,4);assert.equal(store.saveBot({id:'d',slug:'d',threadId:'d'}).extension,5);second.close();
});
test('relative reorder moves one item, includes newly arriving items, and exact action receipt is atomic',async t=>{
 const root=await mkdtemp(join(tmpdir(),'queue-move-')),store=new Store(join(root,'s.sqlite'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 store.saveBot({id:'bot',slug:'bot',threadId:'thread'});
 for(const [position,id]of ['a','b','c','new'].entries())store.put('promptQueue',{id,botId:'bot',state:'queued',revision:1,position,createdAt:'2026-01-01'});
 const runtime={store,emitEvent(){},queueList:async()=>store.queuedPrompts('bot')};
 const result=await acceptLocalQueueOperation(runtime,{method:'queue.reorder',botId:'bot',operationId:'move-c',params:{id:'c',beforeId:'a',expectedRevision:1}},'fingerprint');assert.equal(result.handled,true);assert.equal(store.operation('move-c').status,'done');
 const order=()=>store.queuedPrompts('bot').sort((a,b)=>a.position-b.position).map(item=>item.id);assert.deepEqual(order(),['c','a','b','new']);
 const pendingMove=await prepareLocalQueueMutation(runtime,'queue.reorder','bot',{id:'new',beforeId:'c',expectedRevision:1},'late-arrival');store.put('promptQueue',{id:'late',botId:'bot',state:'queued',revision:1,position:99,createdAt:'2026-01-01'});pendingMove();assert.deepEqual(order(),['new','c','a','b','late']);
 await assert.rejects(prepareLocalQueueMutation(runtime,'queue.reorder','bot',{id:'c',beforeId:'a',expectedRevision:0},'bad'),/changed/);
 await assert.rejects(prepareLocalQueueMutation(runtime,'queue.reorder','bot',{id:'a',beforeId:'foreign',expectedRevision:1},'bad'),/destination/);
 store.put('promptQueue',{...store.get('promptQueue','b'),state:'dispatching'});await assert.rejects(prepareLocalQueueMutation(runtime,'queue.reorder','bot',{id:'a',beforeId:null,expectedRevision:1},'bad'),/starting/);
});
