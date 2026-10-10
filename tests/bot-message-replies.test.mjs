import assert from 'node:assert/strict';
import test from 'node:test';
import { runtime } from './helpers/load-ts.mjs';
const reply={id:'reply:verified',botId:'bot',threadId:'thread',turnId:'origin',itemId:'answer',role:'assistant',text:'Original 👩🏽‍💻\n第二行',truncated:false};
const file={id:'file',name:'image.jpeg',size:3,mimeType:'image/jpeg',hasBytes:false,remote:{id:'file',botId:'bot',name:'image.jpeg',size:3,mimeType:'image/jpeg',ready:true}};
const plain=value=>JSON.parse(JSON.stringify(value));
function setup(){
 const env=runtime({Error,TypeError}),{BotDraftStore,changeDraft,emptyRecord,draftFingerprint}=env.load('app/bots/draft-store.ts'),{BotComposer}=env.load('app/bots/composer-controller.ts');
 const calls=[],store=new BotDraftStore(env.indexedDB);const transport={owner:'owner',online:true,replyAvailable:true,rpc:async(...args)=>{calls.push(args);return args[0]==='queue.delete'?{deleted:true}:{turn:{id:'sent'}};},upload:async()=>{},download:async()=>{throw Error('No recovery download needed');}};
 return{env,store,changeDraft,emptyRecord,draftFingerprint,calls,transport,create:botId=>new BotComposer('owner',botId??'bot',store,transport)};
}
async function seeded(s){const c=s.create();await c.open();c.setText('typed text');await c.flush();await s.store.change('owner','bot',{kind:'add',slot:'normal',files:[file]});await c.refresh();return c;}
test('select/cancel preserves text and ready file references, reply survives independent draft reload',async()=>{
 const s=setup(),c=await seeded(s);c.setReply(reply);await c.flush();assert.equal(c.draft.text,'typed text');assert.deepEqual(plain(c.draft.files),[file]);
 const reload=s.create();await reload.open();assert.deepEqual(plain(reload.draft.reply),reply);assert.equal(reload.draft.files.length,1);
 const other=s.create('other');await other.open();assert.equal(other.draft.reply,undefined);assert.equal(other.draft.text,'');
 reload.setReply();await reload.flush();assert.equal(reload.draft.reply,undefined);assert.equal(reload.draft.text,'typed text');assert.equal(reload.draft.files[0].remote.id,'file');
});
test('reply-only selection changes fingerprint and displaces rather than discards concurrent draft reference',()=>{
 const{changeDraft,emptyRecord,draftFingerprint}=setup();const original=emptyRecord('owner','bot');const selected=changeDraft(original,{kind:'reply',slot:'normal',reply,version:'reply-version',base:'empty'});
 assert.equal(draftFingerprint(original),JSON.stringify(['normal','empty',[]]));assert.notEqual(draftFingerprint(original),draftFingerprint(selected));const second=changeDraft(selected,{kind:'text',slot:'normal',text:'other tab',version:'text-version',base:'empty'});
 assert.deepEqual(plain(second.slots['recovered:reply-version'].reply),reply);assert.deepEqual(plain(second.slots.normal.reply),reply);
});
test('queue/burst/direct operations freeze exact reply snapshot and success clears it with committed content',async()=>{
 for(const[kind,args]of [['turn.send',[false,false]],['queue.add',[true,false,'nightly']],['bursts.submit',[false,true]]]){
 const s=setup(),c=await seeded(s);c.setReply(reply);await c.flush();await c.send(...args);assert.equal(s.calls[0][0],kind);assert.deepEqual(plain(s.calls[0][2].reply),reply);assert.equal(s.calls[0][2].text,'typed text');assert.deepEqual(plain(s.calls[0][2].attachments),['file']);assert.equal(c.draft.reply,undefined);assert.equal(c.draft.text,'');assert.equal(c.draft.files.length,0);
 }
});
test('lost ACK/reload reuses original operation ID, target and snapshot; no new allocation',async()=>{
 const s=setup(),c=await seeded(s);c.setReply(reply);await c.flush();s.transport.rpc=async(...args)=>{s.calls.push(args);throw Error('lost acknowledgement');};await c.send();const id=c.operation.id;
 c.setText('next draft');await c.flush();const reload=s.create();await reload.open();s.transport.rpc=async(...args)=>{s.calls.push(args);return{turn:{id:'original-turn'}};};await reload.reconcile();
 assert.equal(s.calls[0][3],id);assert.equal(s.calls[1][3],id);assert.deepEqual(plain(s.calls[1][2]),plain(s.calls[0][2]));assert.equal(reload.draft.text,'next draft');assert.equal(reload.operation,undefined);
});
test('positive removal checkout restores reply to normal composer; rejected/unconfirmed removal stays locked',async()=>{
 const s=setup(),c=await seeded(s),item={id:'q',revision:1,state:'queued',input:[{type:'text',text:'queued new text'}],attachments:[file.remote],reply};
 assert.equal(await c.checkout(item),true);assert.equal(c.record.active,'normal');assert.deepEqual(plain(c.draft.reply),reply);assert.equal(c.draft.text,'queued new text');assert.equal(c.draft.queueId,undefined);assert.equal(c.draft.files[0].remote.id,'file');
 c.setReply();await c.flush();await c.send(true);assert.equal(s.calls[1][0],'queue.add');assert.equal(s.calls[1][2].reply,undefined);
 const s2=setup(),c2=s2.create();await c2.open();s2.transport.rpc=async()=>{throw Error('lost delete ACK');};assert.equal(await c2.checkout(item),false);assert.equal(c2.operation.method,'queue.delete');assert.equal(c2.record.active,'normal');assert.deepEqual(plain(Object.values(c2.record.slots).find(d=>d.queueSource).reply),reply);
});
test('cross-bot transfer retains identity but prevents send/grants; older service cannot silently discard a reply',async()=>{
 const s=setup(),c=await seeded(s);c.setReply({...reply,botId:'other'});await c.flush();await c.send();assert.equal(s.calls.length,0);assert.match(c.actionError,/another bot/);assert.equal(c.draft.text,'typed text');
 c.setReply(reply);await c.flush();s.transport.replyAvailable=false;await c.send();assert.equal(s.calls.length,0);assert.match(c.actionError,/updated bot service/);assert.deepEqual(plain(c.draft.reply),reply);
});
test('late reply selection/cancel never modifies a frozen pending operation',async()=>{
 const s=setup(),c=await seeded(s);c.setReply(reply);await c.flush();s.transport.rpc=async()=>{throw Error('lost ACK');};await c.send();const id=c.operation.id;
 c.setReply();await c.flush();assert.equal(c.draft.reply,undefined);assert.deepEqual(plain(c.operation.params.reply),reply);assert.equal(c.operation.id,id);
});
test('disjoint source insertion preserves reader position and both explicit history gaps',async()=>{
 const s=setup(),{BotTimeline}=s.env.load('app/bots/timeline-controller.ts');
 const entry=(id,at)=>({id,turnId:`turn-${id}`,type:'agentMessage',item:{type:'agentMessage',id,text:id,phase:'final_answer'},complete:true,scheduled:false,status:'completed',startedAt:at,messageAt:at});
 const controller=new BotTimeline('owner','bot',{owner:'owner',online:true,rpc:async()=>({kind:'page',entries:[entry('early',1),entry('late',3)],attachments:[],olderCursor:'older',revision:'r',eventCursor:0,complete:false})},{read:async()=>null,write:async()=>{}});
 await controller.refresh();controller.getSnapshot().gaps.push({before:'turn-late:late',stop:'turn-early:early',cursor:'hole'});controller.position({anchor:'turn-late:late',offset:17,following:false});controller.revealSource(entry('middle',2));const state=controller.getSnapshot();assert.deepEqual(plain(state.position),{anchor:'turn-late:late',offset:17,following:false});assert.deepEqual(plain(state.entries.map(e=>e.id)),['early','middle','late']);assert.equal(state.gaps.length,2);await controller.dispose();
});
