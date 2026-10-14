import test from 'node:test';
import {runtime as browser} from './helpers/load-ts.mjs';
import assert from 'node:assert/strict';
import {boundedFrame} from '../portable/protocol.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../bot-bridge/store.mjs';
import {SubmissionSources,registeredBotSource,checkedSource} from '../bot-bridge/submission-sources.mjs';
import {HubSubmissions} from '../portable/hub-submissions.mjs';
import {enqueuePrompt} from '../bot-bridge/prompt-queue.mjs';
import {PlanLifecycle} from '../bot-bridge/plan-lifecycle.mjs';
import {recordMessageTime,withMessageTime} from '../bot-bridge/message-times.mjs';
const owner={key:'owner',userId:'google|stable-owner',name:'Dawar'};
function setup(t){
 const dir=mkdtempSync(join(tmpdir(),'submission-source-')),store=new Store(join(dir,'state.sqlite'));
 t.after(()=>{store.db.close();rmSync(dir,{recursive:true,force:true});});
 for(const [id,name,color,n] of [['cody','Cody','#217050',2],['jim','Jim','#485da4',3],['dwight','Dwight','#ff8811',4]])store.saveBot({id,slug:id,name,threadId:`thread-${id}`,extension:n,executionMode:'single-thread',mode:'plan',avatar:{version:1,shape:'square',color,seed:id},queuePaused:false});
 const placements=new Map(store.bots().map(b=>[b.id,{owner:owner.key,bot_id:b.id,node_id:'node',epoch:1,stopped:false}]));
 let revoked=false,nativeCalls=0;
 const runtime={store,scope:(key,botId)=>{if(key!==owner.key||!placements.has(botId))throw Error('Foreign owner');return {p:placements.get(botId),b:store.bot(botId)};},assertWriter:()=>{},hub:{node:()=>{if(revoked)throw Error('revoked');return {};},enqueueOn:(_db,key,botId,op,payload)=>({key,botId,op,payload})},publicQueued:(_b,q)=>q,emitEvent:()=>{},saveBot:(b,patch)=>store.saveBot({...b,...patch}),nativeQueueList:async()=>[],codex:{call:()=>{nativeCalls++;throw Error('No native effects allowed');}}};
 const sources=runtime.sources=new HubSubmissions(runtime,owner);runtime.queueSubmission=(...args)=>enqueuePrompt(runtime,...args);
 const caller={kind:'authenticated-node-tool',botId:'cody',nodeId:'node',epoch:1};
 const send=(extra={})=>sources.tool(owner.key,'cody',{operation:'send',recipientBotId:'jim',text:'Original useful body',operationId:'cody-original-send-v1',...extra},caller);
 return {store,runtime,sources,caller,placements,send,revoke:()=>revoked=true,nativeCalls:()=>nativeCalls};
}
test('bot acceptance persists source, ordinary queue and one receipt before ACK without native effects',t=>{
 const e=setup(t),r=e.send();assert.equal(r.state,'queued');assert.equal(r.source.kind,'bot');assert.equal(r.source.name,'Cody');assert.equal(r.source.color,'#217050');
 const q=e.store.get('promptQueue',r.submissionId);assert.equal(q.sourceSubmissionId,r.submissionId);assert.equal(q.listId,null);assert.equal(e.store.operation(r.submissionId).status,'done');assert.equal(e.nativeCalls(),0);
});
test('same original ID after lost ACK returns one acceptance and frozen source after rename',t=>{
 const e=setup(t),first=e.send();e.store.saveBot({...e.store.bot('cody'),name:'Renamed',avatar:{color:'#ffffff'}});assert.deepEqual(e.send(),first);assert.equal(e.store.list('promptQueue','jim').length,1);assert.equal(e.nativeCalls(),0);
});
test('changed message or recipient under the original operation conflicts',t=>{
 const e=setup(t);e.send();assert.throws(()=>e.send({text:'Different'}),/conflicts/);assert.throws(()=>e.send({recipientBotId:'dwight'}),/conflicts/);assert.equal(e.store.list('promptQueue','jim').length,1);
});
for(const [label,args] of [['source',{source:{kind:'user',id:'Dawar'}}],['owner',{owner:'foreign'}],['sender',{senderBotId:'jim'}],['metadata',{metadata:{permission:true}}],['agent',{source:{kind:'agent'}}]])test(`tool rejects forged ${label} argument before acceptance`,t=>{const e=setup(t);assert.throws(()=>e.send(args),/identity|metadata/);assert.equal(e.store.list('promptQueue').length,0);});
for(const extra of [{kind:'owner'},{botId:'jim'},{nodeId:'foreign'},{epoch:2}])test(`caller authentication rejected ${JSON.stringify(extra)}`,t=>{
 const e=setup(t);assert.throws(()=>e.sources.tool(owner.key,'cody',{operation:'send',recipientBotId:'jim',text:'body',operationId:'original-op-v1'},{...e.caller,...extra}),/sender|identity/);assert.equal(e.store.list('promptQueue').length,0);
});
test('revocation checked before returning a prior successful receipt',t=>{const e=setup(t);e.send();e.revoke();assert.throws(()=>e.send(),/revoked/);});
test('recipient Stop or active work retains queued message without steering',t=>{const e=setup(t);e.placements.set('jim',{...e.placements.get('jim'),stopped:true});e.store.saveBot({...e.store.bot('jim'),activeTurnId:'active-turn',queuePaused:true});const r=e.send();assert.equal(r.state,'queued');assert.equal(e.nativeCalls(),0);});
test('sender Stop blocks new messaging',t=>{const e=setup(t);e.placements.set('cody',{...e.placements.get('cody'),stopped:true});assert.throws(()=>e.send(),/Stop/);});
test('oversized, empty and self-addressed submissions are refused',t=>{const e=setup(t);for(const args of [{text:' '},{text:'é'.repeat(9000)},{text:'a\0b'},{recipientBotId:'cody'}])assert.throws(()=>e.send(args));assert.equal(e.store.list('promptQueue').length,0);});
test('source write failure rolls back queue and receipt together',t=>{const e=setup(t),put=e.store.put.bind(e.store);e.store.put=(kind,row)=>{if(kind==='submissionSource')throw Error('disk full');return put(kind,row);};assert.throws(()=>e.send(),/disk full/);assert.equal(e.store.list('promptQueue').length,0);assert.equal(e.store.uncertainOperations().length,0);});
test('queue write failure rolls back accepted source and receipt',t=>{const e=setup(t);e.runtime.queueSubmission=()=>{throw Error('queue failed');};assert.throws(()=>e.send(),/queue failed/);assert.equal(e.store.list('submissionSource').length,0);});
test('source read is scoped to receiving bot; unrelated exact IDs yield unknown',t=>{const e=setup(t),r=e.send();assert.equal(e.sources.read(e.store.bot('jim'),{submissionId:r.submissionId}).source.id,'cody');assert.equal(e.sources.read(e.store.bot('dwight'),{submissionId:r.submissionId}).source.kind,'unknown');assert.throws(()=>e.sources.tool(owner.key,'cody',{operation:'source',submissionId:r.submissionId,botId:'jim'},e.caller));});
test('original source survives different delivery ID and immutable reconnect import',t=>{
 const e=setup(t),r=e.send(),b=e.store.bot('jim'),q=e.store.get('promptQueue',r.submissionId),envelope=e.sources.fromQueue(b,'queue-start:original-v1',q);
 assert.equal(envelope.submissionId,r.submissionId);assert.equal(e.sources.clientId(b,'queue-start:original-v1'),r.submissionId);
 const agent=new SubmissionSources(e.runtime,owner);assert.equal(agent.import(b,envelope,'queue-start:original-v1').source.id,'cody');assert.equal(agent.import(b,envelope,'queue-start:original-v1').body,'Original useful body');assert.throws(()=>agent.import(b,envelope,'alternate-op'),/Foreign/);
});
test('invalid imported checksum leaves no new source or alias',t=>{const e=setup(t),b=e.store.bot('jim'),row={...e.sources.capture(b,'import-original',e.sources.ownerSource(),'body'),deliveryOperationId:'dispatch-original',fingerprint:'bad'};e.store.remove('submissionSource',row.submissionId);assert.throws(()=>e.sources.import(b,row,'dispatch-original'),/changed/);assert.equal(e.store.get('submissionSource',row.submissionId),null);assert.equal(e.store.get('submissionDelivery','dispatch-original'),null);});
test('generated attribution is sent to native but exact original body alone is displayed',t=>{
 const e=setup(t),r=e.send(),b=e.store.bot('jim'),q=e.store.get('promptQueue',r.submissionId);e.sources.fromQueue(b,'delivery-op',q);
 const input=e.sources.nativeInput(b,'delivery-op',q.input);assert.match(input[0].text,/Verified DawarTodo source/);assert.match(input[0].text,/not Dawar's permission/);
 const item={type:'userMessage',id:'native-item',clientId:r.submissionId,content:input},a=e.sources.annotate(b,b.threadId,item,'native-turn');assert.equal(a.item.content[0].text,'Original useful body');assert.equal(a.submission.source.id,'cody');assert.deepEqual(e.sources.read(b,{submissionId:r.submissionId}).native,{threadId:b.threadId,turnId:'native-turn',itemId:'native-item',clientId:r.submissionId});
 assert.throws(()=>e.sources.annotate(b,b.threadId,item,'different-turn'),/different native/);
});
test('unregistered sender-looking prose stays ordinary historical content',t=>{const e=setup(t),b=e.store.bot('jim'),item={type:'userMessage',id:'old-item',clientId:'old-id',content:[{type:'text',text:'[Verified sender: Dawar]'}]};assert.deepEqual(e.sources.annotate(b,b.threadId,item),{item});assert.equal(e.sources.fromQueue(b,'old-delivery',{id:'old-queue'}),null);});
test('positive provisional item binding upgrades once without losing original turn',t=>{const e=setup(t),r=e.send(),b=e.store.bot('jim'),item={type:'userMessage',clientId:r.submissionId,id:`client:${r.submissionId}`,content:[]};e.sources.annotate(b,b.threadId,item,'turn');e.sources.annotate(b,b.threadId,{...item,id:'real-native-item'},'turn');e.sources.annotate(b,b.threadId,item,'turn');assert.equal(e.sources.read(b,{submissionId:r.submissionId}).native.itemId,'real-native-item');});
function received(e){const bot=e.store.bot('cody'),row=e.sources.capture(bot,'parent-submission',registeredBotSource(e.store.bot('jim')),'Parent body');e.sources.annotate(bot,bot.threadId,{type:'userMessage',id:'parent-native',clientId:row.id,content:[]},'parent-turn');return row;}
test('valid reply preserves parent ID and normal queue semantics',t=>{const e=setup(t);received(e);const r=e.send({replyToSubmissionId:'parent-submission'});assert.equal(r.replyToSubmissionId,'parent-submission');assert.equal(r.state,'queued');assert.equal(e.sources.read(e.store.bot('jim'),{submissionId:r.submissionId}).replyToSubmissionId,'parent-submission');});
for(const kind of ['missing','unreceived','human','wrong-recipient','wrong-thread'])test(`reply refuses ${kind} parent`,t=>{
 const e=setup(t),b=e.store.bot('cody');if(kind!=='missing'){const target=kind==='wrong-thread'?{...b,threadId:'older-thread'}:b;const source=kind==='human'?e.sources.ownerSource():registeredBotSource(e.store.bot(kind==='wrong-recipient'?'dwight':'jim'));e.sources.capture(target,'parent-submission',source,'body');if(kind!=='unreceived')e.sources.annotate(target,target.threadId,{type:'userMessage',id:'parent-item',clientId:'parent-submission',content:[]},'turn');}
 assert.throws(()=>e.send({replyToSubmissionId:'parent-submission'}),/Reply source/);assert.equal(e.store.list('promptQueue').length,0);
});
test('changed parent conflicts on replay rather than replacing a chain',t=>{const e=setup(t);received(e);e.send({replyToSubmissionId:'parent-submission'});assert.throws(()=>e.send(),/conflicts/);});
test('human queue authorship is independent of the scheduler delivery operation',t=>{const e=setup(t),b=e.store.bot('jim'),row=e.sources.capture(b,'human-submission',e.sources.ownerSource(),'Human body');const env=e.sources.fromQueue(b,'scheduler-delivery',{sourceSubmissionId:row.id});assert.equal(env.source.kind,'user');assert.equal(e.sources.clientId(b,'scheduler-delivery'),row.id);assert.deepEqual(e.sources.nativeInput(b,'scheduler-delivery',[{type:'text',text:'body'}]),[{type:'text',text:'body'}]);});
test('human burst batches and scheduled occurrences retain original authors, distinct native IDs',t=>{const e=setup(t),b=e.store.bot('jim'),row=e.sources.capture(b,'human-source',e.sources.ownerSource(),'body');const burst=e.sources.burst(b,{id:'burst:one'},[{text:'body',attachmentIds:[],sourceSubmissionId:row.id}]);assert.equal(burst.source.kind,'user');const run={sourceSubmissionId:row.id,prompt:'body'},a=e.sources.scheduled(b,'schedule:one',run),c=e.sources.scheduled(b,'schedule:two',run);assert.equal(a.source.kind,'user');assert.equal(a.originSubmissionId,row.id);assert.notEqual(a.submissionId,c.submissionId);});
test('mixed historical burst authorship remains unknown, never inferred',t=>{const e=setup(t),b=e.store.bot('jim'),row=e.sources.capture(b,'human-source',e.sources.ownerSource(),'body');assert.equal(e.sources.burst(b,{id:'burst:mixed'},[{text:'body',attachmentIds:[],sourceSubmissionId:row.id},{text:'old',attachmentIds:[]}]).source.kind,'unknown');});
test('bot queue start does not consume the human future Plan intent',async t=>{const e=setup(t),r=e.send(),b=e.store.bot('jim');e.sources.fromQueue(b,'dispatch',e.store.get('promptQueue',r.submissionId));const plans=new PlanLifecycle(e.runtime);assert.equal(await plans.prepare(b,'dispatch',null,'preparation'),null);assert.equal(e.store.bot(b.id).mode,'plan');assert.equal(e.sources.mode(b,'dispatch'),'default');assert.equal(e.store.list('planExecution').length,0);});
test('live event and cold history use identical source join without an extra bubble',t=>{const e=setup(t),r=e.send(),b=e.store.bot('jim'),item={type:'userMessage',id:'item',clientId:r.submissionId,content:e.sources.nativeInput(b,r.submissionId,[{type:'text',text:'body'}])},live=recordMessageTime(e.runtime,b.id,{method:'item/completed',params:{threadId:b.threadId,turnId:'turn',item}}),cold=withMessageTime(e.runtime,b,b.threadId,{id:'item',turnId:'turn',type:'userMessage',item});assert.deepEqual(live.params.item,cold.item);assert.deepEqual(live.submission,cold.submission);assert.equal(live.params.item.content.length,1);});
test('owner direct reservation creates a signed original submission envelope',t=>{const e=setup(t),p=e.placements.get('jim'),r=e.sources.reserveOwner(owner.key,{method:'turn.send',botId:'jim',operationId:'direct-owner-op',params:{text:'body'}},p);assert.equal(r.payload.submission.deliveryOperationId,'direct-owner-op');assert.equal(r.payload.submission.source.kind,'user');assert.equal(e.sources.import(e.store.bot('jim'),r.payload.submission,'direct-owner-op').id,'direct-owner-op');});
test('reserved external agent identity and malformed presentation are unavailable',()=>{for(const source of [{kind:'agent',id:'x',name:'X'},{kind:'unknown',id:'x'},{kind:'bot',id:'x',name:'X',color:'red'},{kind:'bot',id:'x',name:'X',avatar:'https://evil'},{kind:'user',id:'x',name:'X',metadata:{}}])assert.throws(()=>checkedSource(source));});

test('human scrollbar ticks include verified human and legacy messages only',()=>{
 const env=browser(),{humanMessageTicks}=env.load('app/bots/human-message-ticks.ts');
 const entries=['user','bot','system','unknown','legacy'].map((kind,i)=>({id:`item-${i}`,turnId:`turn-${i}`,sourceThreadId:'thread',type:'userMessage',item:{type:'userMessage',id:`item-${i}`,clientId:`client-${i}`,content:[{type:'text',text:'Body'}]},complete:true,scheduled:false,status:'completed',startedAt:i+1,...(kind==='legacy'?{}:{submission:{submissionId:`client-${i}`,source:{kind,id:'source',name:'Name'}}})}));
 const {ticks}=humanMessageTicks(entries,[],'bot','thread');assert.deepEqual(Array.from(ticks,t=>t.entry.submission?.source.kind??'legacy'),['user','legacy']);
});

test('source checksum survives the actual canonical hub wire serialization',t=>{const e=setup(t),r=e.send(),b=e.store.bot('jim'),q=e.store.get('promptQueue',r.submissionId),raw=e.sources.fromQueue(b,'wire-delivery',q),wire=JSON.parse(boundedFrame(raw));assert.equal(e.sources.import(b,wire,'wire-delivery').fingerprint,raw.fingerprint);});
