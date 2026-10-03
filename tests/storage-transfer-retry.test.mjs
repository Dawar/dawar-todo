import test from 'node:test';import assert from 'node:assert/strict';import {runtime} from './helpers/load-ts.mjs';
test('storage retries reuse the request body, stop on auth/integrity and honor abort',async()=>{
 const {replayableStorageFetch}=runtime().load('lib/storage-transfer.ts');const bodies=[];let attempt=0;
 const response=await replayableStorageFetch(async(url,init)=>{bodies.push(init.body);return new Response(null,{status:++attempt<3?503:200});},'https://synthetic.test',{method:'POST',body:'{"id":"same"}'});
 assert.equal(response.status,200);assert.deepEqual(bodies,Array(3).fill('{"id":"same"}'));
 let calls=0;assert.equal((await replayableStorageFetch(async()=>{calls++;return new Response(null,{status:403});},'https://synthetic.test')).status,403);assert.equal(calls,1);
 const controller=new AbortController();controller.abort();await assert.rejects(replayableStorageFetch(async()=>{assert.fail('aborted request sent');},'https://synthetic.test',{signal:controller.signal}));
});
