import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/load-ts.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const until=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,2));}assert.fail('did not settle');};
function setup(){
 const env=runtime({Error,TypeError}),{BotDraftStore,PORTABLE_COMPOSER}=env.load('app/bots/draft-store.ts'),{BotComposer}=env.load('app/bots/composer-controller.ts');
 const store=new BotDraftStore(env.indexedDB),calls=[];
 const transport={owner:'owner',online:true,storageAvailable:true,rpc:async(...args)=>{calls.push(args);return{deleted:true};},upload:async(botId,file,progress,id)=>({id,botId,name:file.name,size:file.size,mimeType:file.type,ready:true}),download:async()=>{throw Error('unnecessary download');},copyAttachment:async(source,botId,id)=>({...source,botId,id})};
 return {store,transport,calls,PORTABLE_COMPOSER,create:(bot='one',portable=true)=>new BotComposer('owner',bot,store,transport,undefined,undefined,portable)};
}
test('text and upload in progress follow selection, retain upload origin, and commit attachments to the selected bot',async()=>{
 const {create,store,transport,calls,PORTABLE_COMPOSER}=setup(),c=create();await c.open();c.setText('portable');
 const upload=deferred();let origin;
 transport.upload=async(botId,file,progress,id)=>{origin={botId,id,file};return upload.promise;};
 c.addFiles([new File(['bytes'],'image.png',{type:'image/png'})]);await until(()=>origin);c.bindBot('two');
 assert.equal(c.draft.text,'portable');assert.equal(c.draft.files.length,1);
 upload.resolve({id:origin.id,botId:origin.botId,size:5,name:'image.png',mimeType:'image/png',ready:true});await until(()=>c.draft.files[0]?.remote);await c.flush();
 assert.equal(c.draft.files[0].remote.botId,'one');await c.send(true);
 assert.equal(calls[0][0],'queue.add');assert.equal(calls[0][1],'two');assert.notEqual(calls[0][2].attachments[0],origin.id);
 assert.equal(c.draft.text,'');assert.equal((await store.get('owner',PORTABLE_COMPOSER)).operations && Object.keys((await store.get('owner',PORTABLE_COMPOSER)).operations).length,0);
});
test('lost send acknowledgement freezes target and operation across bot switch and restart',async()=>{
 const {create,transport,calls}=setup(),c=create();await c.open();c.setText('frozen');await c.flush();
 transport.rpc=async(...args)=>{calls.push(args);throw Error('lost');};await c.send(true);const id=c.operation.id;
 c.bindBot('two');const restored=create('two');await restored.open();transport.rpc=async(...args)=>{calls.push(args);return{};};await restored.send();
 assert.equal(calls[1][1],'one');assert.equal(calls[1][3],id);assert.equal(calls[1][0],'queue.add');
});
test('failed attachment copy reuses its saved identity and never submits; edited text during copy needs another click',async()=>{
 const {create,transport,calls}=setup(),c=create();await c.open();c.setText('first');c.addFiles([new File(['x'],'x.txt',{type:'text/plain'})]);await until(()=>c.draft.files[0]?.remote);await c.flush();c.bindBot('two');
 const ids=[];transport.copyAttachment=async(source,botId,id)=>{ids.push(id);throw Error('lost copy');};await c.send(true);assert.equal(calls.length,0);
 const copy=deferred();transport.copyAttachment=async(source,botId,id)=>{ids.push(id);return copy.promise;};const sending=c.send(true);await until(()=>ids.length===2);c.setText('changed');await c.flush();copy.resolve({...c.draft.files[0].remote,id:ids[1],botId:'two'});await sending;
 assert.equal(ids[0],ids[1]);assert.equal(calls.length,0);assert.match(c.actionError,/draft changed/);await c.send(true);assert.equal(calls[0][2].text,'changed');
});
test('queue checkout uses ready references without a download, yields normal composer, and repeated stale checkout does not delete twice',async()=>{
 const {create,transport,calls}=setup(),c=create();await c.open();
 const item={id:'queue',revision:2,state:'queued',listId:'nightly',input:[{type:'text',text:'edit me'}],attachments:[{id:'ready',botId:'one',name:'image.jpg',size:3,mimeType:'image/jpeg',ready:true}]};
 assert.equal(await c.checkout(item),true);assert.equal(c.record.active,'normal');assert.equal(c.draft.queueSource,undefined);await c.resumeUploads();assert.equal(c.draft.files[0].error,undefined);
 const again=create();await again.open();assert.equal(await again.checkout(item),true);assert.equal(calls.length,1);await again.send(true);assert.equal(calls[1][0],'queue.add');assert.equal(calls[1][2].listId,undefined);
});
test('legacy draft migration moves bytes atomically and does not adopt uncertain sends',async()=>{
 const {create,store,PORTABLE_COMPOSER}=setup(),legacy=create('one',false);await legacy.open();legacy.setText('saved');legacy.addFiles([new File(['retained'],'file.txt',{type:'text/plain'})]);await legacy.flush();
 await store.seedPortable('owner','one');const c=create();await c.open();assert.equal(c.draft.text,'saved');assert.equal(await (await store.file('owner',PORTABLE_COMPOSER,c.draft.files[0].id)).text(),'retained');assert.equal((await store.get('owner','one')).slots.normal.text,'');
});
test('legacy uncertain submission keeps its origin and is never adopted as a new portable send',async()=>{
 const {create,store,transport,PORTABLE_COMPOSER}=setup(),legacy=create('one',false);await legacy.open();legacy.setText('already submitted');await legacy.flush();transport.rpc=async()=>{throw Error('lost');};await legacy.send(true);const id=legacy.operation.id;
 await store.seedPortable('owner','one');assert.equal((await store.get('owner','one')).operations[id].params.text,'already submitted');assert.equal((await store.get('owner',PORTABLE_COMPOSER)).slots.normal.text,'');
});
test('restoring another legacy draft preserves displaced portable draft and its local bytes',async()=>{
 const {create,store,PORTABLE_COMPOSER}=setup(),a=create('one',false),b=create('two',false);await a.open();await b.open();a.setText('first');b.setText('second');await a.flush();await b.flush();await store.seedPortable('owner','one');await store.seedPortable('owner','two',true);
 const record=await store.get('owner',PORTABLE_COMPOSER);assert.equal(record.slots.normal.text,'second');assert.ok(Object.values(record.slots).some(draft=>draft.text==='first'));assert.equal((await store.get('owner','two')).slots.normal.text,'');
});
test('false removal acknowledgement cannot unlock checkout or send the saved queue copy',async()=>{
 const {create,transport,calls}=setup(),c=create();await c.open();transport.rpc=async(...args)=>{calls.push(args);return{deleted:false};};const item={id:'queue',revision:1,state:'queued',input:[{type:'text',text:'queued'}],attachments:[]};assert.equal(await c.checkout(item),false);assert.equal(c.operation.method,'queue.delete');assert.equal(c.draft.text,'');await c.send(true);assert.ok(calls.every(call=>call[0]==='queue.delete'));
});
test('ready cloud references remain usable when an old local preview blob is missing',async()=>{
 const {store,create,PORTABLE_COMPOSER}=setup();await store.load('owner','one');await store.change('owner','one',{kind:'add',slot:'normal',files:[{id:'ready',name:'ready.jpg',size:5,mimeType:'image/jpeg',hasBytes:true,remote:{id:'ready',botId:'one',name:'ready.jpg',size:5,mimeType:'image/jpeg',ready:true}}]});
 await store.seedPortable('owner','one');const c=create();await c.open();assert.equal(c.storageError,'');assert.equal(c.draft.files[0].hasBytes,false);assert.equal(c.draft.files[0].remote.id,'ready');assert.equal((await store.get('owner',PORTABLE_COMPOSER)).slots.normal.files.length,1);
});
