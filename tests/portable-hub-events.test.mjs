import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {cpSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HubStore} from '../portable/control-store.mjs';
import {boundedFrame} from '../portable/protocol.mjs';
import {RUNTIME_COMPANIONS} from '../portable/runtime-companions.mjs';

test('a human send commits with migrated burst history and preserves its original receipt',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  mkdirSync(join(root,'dist'),{recursive:true});
  const directory=mkdtempSync(join(root,'dist','hub-events-test-'));
  let hub,controls;
  try{
    const bundle=join(directory,'controls.mjs');
    for(const name of RUNTIME_COMPANIONS)cpSync(join(root,'bot-bridge',name),join(directory,name));
    await build({entryPoints:[join(root,'portable/hub-controls.mjs')],outfile:bundle,bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});
    const {HubControls}=await import(pathToFileURL(bundle).href);
    const path=join(directory,'control.sqlite'),events=[];
    hub=new HubStore(path);
    hub.db.exec("INSERT INTO portable_nodes VALUES('node-one','owner-one','unused','node-fingerprint','{}',NULL,1); INSERT INTO portable_placements VALUES('bot-one','owner-one','node-one',1,1,0); INSERT INTO portable_authority VALUES(1,'test-writer',1,0)");
    controls=new HubControls({path,hub,router:{connection:()=>null},authority:{writerId:'test-writer',epoch:1},broadcast:(owner,event)=>events.push({owner,event})});
    const bot=controls.store.saveBot({id:'bot-one',slug:'one',threadId:'thread-one',executionMode:'single-thread',burstQuietSeconds:3});
    const old={id:'old-sent-burst',botId:bot.id,threadId:bot.threadId,state:'sent',messageIds:[],dueAt:null,turnId:'old-turn',sequence:1};
    controls.store.put('messageBurst',old);
    const request={method:'bursts.submit',botId:bot.id,operationId:'human-send-one',params:{text:'New human message',attachments:[]}};
    const result=await controls.request('owner-one',request);
    assert.equal(result.message.id,request.operationId);
    assert.equal(result.message.state,'pending');
    assert.equal(controls.store.operation(request.operationId).status,'done');
    assert.deepEqual(controls.store.get('messageBurst',old.id),old);
    assert.equal(events.length,1);
    const stored=JSON.parse(hub.db.prepare('SELECT event FROM portable_events').get().event);
    const projected=stored.data.batches.find(batch=>batch.id===old.id);
    assert.equal(Object.hasOwn(projected,'revision'),false);
    assert.equal(projected.turnId,old.turnId);
    assert.doesNotThrow(()=>boundedFrame(events[0].event));
    assert.deepEqual(events[0].event.data,stored.data);
    assert.deepEqual(await controls.request('owner-one',request),result);
    assert.equal(controls.store.list('burstMessage',bot.id).length,1);
    await assert.rejects(controls.request('owner-one',{...request,params:{...request.params,text:'Different message'}}),/operation changed/);
    assert.equal(hub.db.prepare('SELECT count(*) n FROM portable_mailbox').get().n,0);
    assert.throws(()=>boundedFrame({operationId:'command-one',result:undefined}),/Noncanonical/);
  }finally{controls?.close();hub?.close();rmSync(directory,{recursive:true,force:true});}
});
