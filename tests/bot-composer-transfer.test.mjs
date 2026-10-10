import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './helpers/load-ts.mjs';
function setup(){
 const data=new Map(),storage={getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value),get length(){return data.size;},key:i=>[...data.keys()][i]};
 const client={owner:'owner',online:false,storageAvailable:false,subscribe:()=>()=>{},rpc:async()=>({}),upload:async(botId,file,progress,id)=>({id,botId,name:file.name,size:file.size,mimeType:file.type,ready:true}),copyAttachment:async(file,botId,id)=>({...file,botId,id})};
 const env=runtime({localStorage:storage,Error,TypeError},{'./client':{botsClient:client}});
 const {BotDraftStore,draftFingerprint,PORTABLE_COMPOSER}=env.load('app/bots/draft-store.ts'),{ComposerService}=env.load('app/bots/composer-service.ts'),{BotComposer}=env.load('app/bots/composer-controller.ts');
 const service=new ComposerService(),store=new BotDraftStore(env.indexedDB,storage);
 return {env,store,service,client,draftFingerprint,PORTABLE_COMPOSER,data,create:(id,portable=false)=>new BotComposer('owner',id,store,client,undefined,undefined,portable)};
}
async function draft(service,id,text){await service.openComposer('owner',id);const c=service.get('owner',id);c.setText(text);await c.flush();return c;}
test('ordinary selection and controller reopening preserve independent persisted bot drafts',async()=>{
 const {service,env}=setup(),a=await draft(service,'A','Alpha'),b=await draft(service,'B','Beta');
 assert.notEqual(a,b);assert.equal(service.peek('owner','A').draft.text,'Alpha');assert.equal(service.peek('owner','B').draft.text,'Beta');
 const fresh=new (env.load('app/bots/composer-service.ts').ComposerService)();await fresh.openComposer('owner','A');await fresh.openComposer('owner','B');
 assert.equal(fresh.peek('owner','A').draft.text,'Alpha');assert.equal(fresh.peek('owner','B').draft.text,'Beta');
});
test('special copy captures a snapshot and paste replaces target while preserving source and displaced target',async()=>{
 const {service}=setup(),a=await draft(service,'A','Alpha'),b=await draft(service,'B','Beta');
 await service.copyComposer('owner','A');const clipboard=service.clipboard('owner');assert.equal(clipboard.type,'dawar-composer');
 a.setText('Alpha newer');await a.flush();const paste=await service.preparePaste('owner','B');assert.equal(paste.nonEmpty,true);
 await service.applyPaste(paste);assert.equal(a.draft.text,'Alpha newer');assert.equal(b.draft.text,'Alpha');assert.ok(b.recoveries.some(slot=>b.record.slots[slot].text==='Beta'));
 await service.applyPaste(paste);assert.equal(b.draft.text,'Alpha');
});
test('move commits destination and clears source atomically, with retained recovery and exact replay receipt',async()=>{
 const {service}=setup(),a=await draft(service,'A','Alpha'),b=await draft(service,'B','');
 const snapshot=await service.capture('owner','A'),paste=await service.preparePaste('owner','B',snapshot.botId,true);
 assert.equal(paste.nonEmpty,false);await service.applyPaste(paste);assert.equal(a.draft.text,'');assert.equal(b.draft.text,'Alpha');
 b.setText('edited target');await b.flush();await service.applyPaste(paste);assert.equal(b.draft.text,'edited target');assert.ok(a.recoveries.length);
});
test('changing destination after warning cannot silently overwrite its newer draft',async()=>{
 const {service}=setup();await draft(service,'A','Alpha');const b=await draft(service,'B','Beta');await service.copyComposer('owner','A');
 const paste=await service.preparePaste('owner','B');b.setText('new Beta');await b.flush();await assert.rejects(service.applyPaste(paste),/destination draft changed/);assert.equal(b.draft.text,'new Beta');
});
test('changing source after preparing a move retains both original drafts',async()=>{
 const {service}=setup(),a=await draft(service,'A','Alpha'),b=await draft(service,'B','Beta');
 const snapshot=await service.capture('owner','A'),paste=await service.preparePaste('owner','B',snapshot.botId,true);a.setText('new Alpha');await a.flush();
 await assert.rejects(service.applyPaste(paste),/source draft changed/);assert.equal(a.draft.text,'new Alpha');assert.equal(b.draft.text,'Beta');
});
test('pending send IDs remain on their original bot and cannot be copied or displaced',async()=>{
 const {service,client,store}=setup(),a=await draft(service,'A','Alpha');client.online=true;client.rpc=async()=>{throw Error('lost acknowledgement');};await a.send(true);const id=a.operation.id;
 await assert.rejects(service.copyComposer('owner','A'),/Confirm/);await service.openComposer('owner','B');assert.equal(service.get('owner','B').draft.text,'');assert.equal((await store.get('owner','A')).operations[id].botId,'A');
});
test('ready attachment references paste without downloading and grant only when target is committed',async()=>{
 const {service,store,client}=setup(),a=await draft(service,'A','with attachment');
 await store.change('owner','A',{kind:'add',slot:'normal',files:[{id:'ready',name:'image.jpg',size:4,mimeType:'image/jpeg',hasBytes:false,remote:{id:'ready',botId:'A',name:'image.jpg',size:4,mimeType:'image/jpeg',ready:true}}]});await a.refresh();
 let copied=0;client.copyAttachment=async(file,botId,id)=>{copied++;return {...file,botId,id};};client.download=()=>{throw Error('unnecessary download');};
 await service.copyComposer('owner','A');await service.openComposer('owner','B');const paste=await service.preparePaste('owner','B');await service.applyPaste(paste);const b=service.get('owner','B');assert.equal(copied,0);assert.equal(b.draft.files[0].remote.botId,'A');
 client.online=true;await b.send(true);assert.equal(copied,1);assert.equal(a.draft.files.length,1);
});
test('unfinished file bytes and original upload identity/provenance survive special copy and restart',async()=>{
 const {service,store,env}=setup(),a=await draft(service,'A','upload later');a.addFiles([new File(['exact bytes'],'file.txt',{type:'text/plain'})]);await a.flush();
 await service.copyComposer('owner','A');await service.openComposer('owner','B');await service.applyPaste(await service.preparePaste('owner','B'));
 const b=service.get('owner','B'),file=b.draft.files[0];assert.equal(file.uploadBotId,'A');assert.equal(file.uploadMode,'legacy');assert.equal(file.id,a.draft.files[0].id);assert.equal(await (await store.file('owner','B',file.id)).text(),'exact bytes');
 const fresh=new (env.load('app/bots/composer-service.ts').ComposerService)();await fresh.openComposer('owner','B');assert.equal(fresh.get('owner','B').files.get(file.id).size,11);
});
test('missing unuploaded bytes abort both destination replacement and source clearing',async()=>{
 const {service,store,draftFingerprint}=setup();await draft(service,'A','Alpha');const b=await draft(service,'B','Beta');
 await store.change('owner','A',{kind:'add',slot:'normal',files:[{id:'missing',name:'missing.jpg',size:5,mimeType:'image/jpeg',hasBytes:true}]});
 const record=await store.get('owner','A');await assert.rejects(store.captureComposer('owner','A','A',draftFingerprint(record)),/unavailable/);assert.equal((await store.get('owner','A')).slots.normal.text,'Alpha');assert.equal(b.draft.text,'Beta');
});
test('snapshot cannot cross owners, and owner change fences apply',async()=>{
 const {service,store,client}=setup();await draft(service,'A','Alpha');await service.copyComposer('owner','A');await service.openComposer('owner','B');const paste=await service.preparePaste('owner','B');
 await store.load('other','B');await assert.rejects(store.pasteComposer('other',paste.snapshotId,'B',paste.targetFingerprint,'foreign'),/unavailable/);
 client.owner='other';await assert.rejects(service.applyPaste(paste),/owner changed/);assert.equal((await store.get('owner','B')).slots.normal.text,'');
});
test('171 shared draft restores once into empty selected bot; originals and other drafts survive',async()=>{
 const {create,service,store,PORTABLE_COMPOSER}=setup(),old=create('A',true);await old.open();old.setText('shared draft');old.addFiles([new File(['blob'],'x.txt',{type:'text/plain'})]);await old.flush();
 await service.openComposer('owner','A');assert.equal(service.get('owner','A').draft.text,'shared draft');assert.equal((await store.get('owner',PORTABLE_COMPOSER)).slots.normal.text,'shared draft');
  await service.openComposer('owner','B');assert.equal(service.get('owner','B').draft.text,'');assert.equal((await store.get('owner',PORTABLE_COMPOSER)).restoredTo,'A');
  assert.equal((await service.savedDrafts('owner')).length,0);old.setText('late edit from an older171 tab');await old.flush();
  assert.equal((await service.savedDrafts('owner'))[0].slots.normal.text,'late edit from an older171 tab');
});
test('171 shared draft never overwrites non-empty per-bot draft or migrates uncertain operations',async()=>{
 const {create,service,store,PORTABLE_COMPOSER,client}=setup(),a=create('A');await a.open();a.setText('per bot');await a.flush();const old=create('A',true);await old.open();old.setText('shared');await old.flush();
 await service.openComposer('owner','A');assert.equal(service.get('owner','A').draft.text,'per bot');assert.equal((await store.get('owner',PORTABLE_COMPOSER)).restoredTo,undefined);
 client.online=true;client.rpc=async()=>{throw Error('lost');};await old.send(true);const id=old.operation.id;await service.openComposer('owner','B');assert.equal(service.get('owner','B').draft.text,'');assert.equal((await store.get('owner',PORTABLE_COMPOSER)).operations[id].botId,'A');
});
test('late upload completion cannot refill a moved source; destination resumes the same upload ID',async()=>{
 const {service,client}=setup(),a=await draft(service,'A','Alpha');client.online=true;
 let resolve;const upload=new Promise(done=>{resolve=done;}),calls=[];
 client.upload=(botId,file,progress,id)=>{calls.push({botId,file,id});return upload;};
 a.addFiles([new File(['bytes'],'x.txt',{type:'text/plain'})]);
 const until=async predicate=>{for(let i=0;i<300;i++){if(predicate())return;await new Promise(done=>setTimeout(done,2));}assert.fail('did not settle');};
 await until(()=>calls.length===1);const snapshot=await service.capture('owner','A');await service.openComposer('owner','B');
 await service.applyPaste(await service.preparePaste('owner','B',snapshot.botId,true));await until(()=>calls.length===2);
 assert.equal(calls[0].botId,'A');assert.equal(calls[1].botId,'A');assert.equal(calls[0].id,calls[1].id);
 resolve({id:calls[0].id,botId:'A',name:'x.txt',size:5,mimeType:'text/plain',ready:true});const b=service.get('owner','B');await until(()=>b.draft.files[0]?.remote?.ready);
 assert.equal(a.draft.text,'');assert.equal(a.draft.files.length,0);assert.equal(b.draft.files[0].remote.id,calls[0].id);
});
test('atomic move abort during blob copy preserves both records and paste exits a recovery slot',async()=>{
 const {service,store,env}=setup(),a=await draft(service,'A','Alpha'),b=await draft(service,'B','Beta');a.addFiles([new File(['bytes'],'x.txt',{type:'text/plain'})]);await a.flush();
 const snapshot=await service.capture('owner','A'),paste=await service.preparePaste('owner','B',snapshot.botId,true);
 await new Promise((done,fail)=>{const request=env.indexedDB.open('dawar-bot-drafts',1);request.onsuccess=()=>{const db=request.result,tx=db.transaction('files','readwrite');tx.objectStore('files').delete(['owner',snapshot.botId,snapshot.slots.normal.files[0].id]);tx.oncomplete=()=>{db.close();done();};tx.onabort=()=>fail(tx.error);};});
 await assert.rejects(service.applyPaste(paste),/unavailable/);assert.equal((await store.get('owner','A')).slots.normal.text,'Alpha');assert.equal((await store.get('owner','B')).slots.normal.text,'Beta');
 await store.change('owner','B',{kind:'edit',slot:'recovered:older',draft:{text:'older active',textVersion:'old',files:[]}});await b.refresh();b.select('recovered:older');await b.flush();
 await service.copyComposer('owner','A');await service.applyPaste(await service.preparePaste('owner','B'));assert.equal(b.record.active,'normal');assert.equal(b.draft.text,'Alpha');
});
