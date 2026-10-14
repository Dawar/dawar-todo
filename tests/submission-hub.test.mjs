import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {cpSync,mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HubStore} from '../portable/control-store.mjs';
import {RUNTIME_COMPANIONS} from '../portable/runtime-companions.mjs';

// Actual hub acceptance/dispatch/receipt classes; disposable SQLite and inert
// node transport. No live daemon, owner data, native/model or provider calls.
test('source follows real burst/queue/schedule acceptance and normal mailbox admission',async t=>{
 const root=fileURLToPath(new URL('../',import.meta.url));mkdirSync(join(root,'dist'),{recursive:true});const dir=mkdtempSync(join(root,'dist','submission-hub-'));let hub,controls;
 t.after(()=>{controls?.close();hub?.close();rmSync(dir,{recursive:true,force:true});});
 for(const name of RUNTIME_COMPANIONS)cpSync(join(root,'bot-bridge',name),join(dir,name));
 const entry=join(dir,'entry.mjs');writeFileSync(entry,`export {HubControls} from ${JSON.stringify(join(root,'portable/hub-controls.mjs'))}; export {BotRuntime} from ${JSON.stringify(join(root,'bot-bridge/runtime.mjs'))}; export {ExecutionConfiguration} from ${JSON.stringify(join(root,'bot-bridge/execution-config.mjs'))}; export {PlanLifecycle} from ${JSON.stringify(join(root,'bot-bridge/plan-lifecycle.mjs'))};`);
 const bundle=join(dir,'controls.mjs');await build({entryPoints:[entry],outfile:bundle,bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});
 const {HubControls,BotRuntime,ExecutionConfiguration,PlanLifecycle}=await import(pathToFileURL(bundle).href),path=join(dir,'state.sqlite'),owner={key:'owner',userId:'original-owner-id',name:'Dawar'};
 hub=new HubStore(path);hub.db.exec("INSERT INTO portable_nodes VALUES('node','owner','unused','fingerprint','{}',NULL,1); INSERT INTO portable_placements VALUES('jim','owner','node',1,1,0); INSERT INTO portable_authority VALUES(1,'writer',1,0)");
 const socket={readyState:1,portableHello:{capabilities:{submissionSources:true,centralBursts:true}},send:()=>{}},router={connection:()=>socket};controls=new HubControls({path,hub,owner,router,authority:{writerId:'writer',epoch:1}});
 const b=controls.store.saveBot({id:'jim',slug:'jim',name:'Jim',threadId:'thread-jim',executionMode:'single-thread',mode:'default',burstQuietSeconds:3});
 const burst=await controls.request('owner',{method:'bursts.submit',botId:b.id,operationId:'human-burst-one',params:{text:'Human message'}});
 const m=controls.store.get('burstMessage',burst.message.id);assert.equal(controls.sources.read(b,{submissionId:m.sourceSubmissionId}).source.kind,'user');
 const batch=controls.store.get('messageBurst',m.batchId),placement=hub.placement('owner',b.id);controls.bursts.dispatch(b,batch,placement);
 const row=hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(batch.id);assert.equal(JSON.parse(row.payload).submission.source.kind,'user');assert.equal(JSON.parse(row.payload).submission.deliveryOperationId,batch.id);
 const queued=await controls.request('owner',{method:'queue.add',botId:b.id,operationId:'human-queue-one',params:{text:'Queued human body'}});const q=controls.store.get('promptQueue',queued.queuedSubmission.id);assert.equal(controls.sources.read(b,{submissionId:q.sourceSubmissionId}).source.kind,'user');
 const update=await controls.request('owner',{method:'queue.update',botId:b.id,operationId:'human-queue-edit',params:{id:q.id,text:'Edited body',expectedRevision:q.revision}});const edited=controls.store.get('promptQueue',update.queuedSubmission.id);assert.equal(edited.sourceSubmissionId,'human-queue-edit');assert.equal(controls.sources.read(b,{submissionId:q.sourceSubmissionId}).source.kind,'user');
 const schedule=await controls.request('owner',{method:'schedules.save',botId:b.id,operationId:'human-schedule-one',params:{title:'Future',prompt:'Human scheduled instruction',cron:'0 23 * * *',timeZone:'America/Toronto'}});assert.equal(schedule.sourceSubmissionId,'human-schedule-one');
 const changed=await controls.request('owner',{method:'schedules.save',botId:b.id,operationId:'schedule-time-edit',params:{id:schedule.id,cron:'0 22 * * *'}});assert.equal(changed.sourceSubmissionId,schedule.sourceSubmissionId);
 const direct=controls.sources.reserveOwner('owner',{method:'turn.send',botId:b.id,operationId:'direct-human-op',params:{text:'Human direct'}},hub.placement('owner',b.id));assert.equal(JSON.parse(direct.payload).submission.source.id,owner.userId);
 const legacy=hub.enqueue('owner',b.id,'legacy-original-op',{method:'turn.send',params:{text:'Old direct body'}});const recovered=controls.sources.reserveOwner('owner',{method:'turn.send',botId:b.id,operationId:legacy.operation_id,params:{text:'Old direct body'}},hub.placement('owner',b.id));assert.equal(recovered.fingerprint,legacy.fingerprint);assert.equal(controls.store.get('submissionSource',legacy.operation_id),null);
 // Real native event projection binds original source identity, not text.
 const event={type:'codex',botId:b.id,data:{method:'item/completed',params:{threadId:b.threadId,turnId:'native-turn',item:{type:'userMessage',id:'native-item',clientId:batch.id,content:[]}}}};assert.equal(controls.nativeEvent(event,'node',1),true);assert.equal(controls.sources.read(b,{submissionId:batch.id}).native.itemId,'native-item');
 assert.throws(()=>controls.nativeEvent(event,'foreign-node',1),/Foreign/);assert.equal(controls.nativeEvent({...event,data:{...event.data,params:{...event.data.params,threadId:'retained-old-context',turnId:'other-turn'}}},'node',1),true);assert.equal(controls.sources.read(b,{submissionId:batch.id}).native.turnId,'native-turn');assert.equal(JSON.parse(hub.db.prepare('SELECT payload FROM portable_mailbox WHERE operation_id=?').get(batch.id).payload).method,'portable.burstDispatch');
 // Held burst -> normal queue copies original human author, not transfer actor.
 const held=await controls.request('owner',{method:'bursts.submit',botId:b.id,operationId:'held-human-one',params:{text:'Held body'}});await controls.request('owner',{method:'bursts.stop',botId:b.id,operationId:'hold-original',params:{}});const state=controls.bursts.read(b),current=controls.store.get('messageBurst',held.message.batchId);
 const transfer=await controls.request('owner',{method:'bursts.queue',botId:b.id,operationId:'held-transfer-one',params:{threadId:b.threadId,controlRevision:state.controlRevision,messages:[{id:held.message.id,batchId:current.id,revision:current.revision}]}});const transferred=controls.store.get('promptQueue',transfer.transfer.items[0].queueId);assert.equal(transferred.sourceSubmissionId,held.message.id);
 assert.equal(controls.store.list('promptQueue',b.id).length,2);assert.equal(hub.db.prepare('SELECT count(*) n FROM portable_mailbox').get().n,3);
 // Actual turn/start + steer + lost-ACK readback use native clientId while
 // retaining their original delivery receipt IDs. The RPC is an inert fixture.
 const nativeCalls=[],events=[],store=controls.store;
 const runtime={store,ready:true,sources:controls.sources,answers:{assertPrepared:()=>{},dispatch:()=>{},accept:()=>{}},memoryMaintenance:{context:async()=>({}),cancelPreparation:()=>{}},contextDelivery:{prepare:(bot,context)=>({context,commit:()=>{}})},load:async()=>{},ensureCurrentActivity:async()=>{},scheduledUncertain:()=>false,primary:{single:()=>true},nativeQueueList:async()=>[],settings:()=>({model:'fixture-model',effort:'medium',serviceTier:null}),saveBot:(bot,patch)=>store.saveBot({...bot,...patch}),projectTerminalTurn:()=>{},emitEvent:(type,data,botId)=>events.push({type,data,botId})};
 runtime.plans=new PlanLifecycle(runtime);runtime.executionConfig=new ExecutionConfiguration(runtime);runtime.startTurn=BotRuntime.prototype.startTurn.bind(runtime);runtime.emitUserMessage=BotRuntime.prototype.emitUserMessage.bind(runtime);
 runtime.submitNative=async(method,params,attempt)=>{if(attempt)attempt.started=true;nativeCalls.push({method,params});return method==='turn/steer'?{turnId:params.expectedTurnId}:{turn:{id:'fixture-native-turn',status:'inProgress',items:[]}};};
 store.saveBot({...store.bot(b.id),mode:'default',activeTurnId:null,queuePaused:false});
 const startSource=runtime.sources.capture(store.bot(b.id),'human-native-source',runtime.sources.ownerSource(),'');runtime.sources.delivery(b,'original-native-delivery',startSource);
 await BotRuntime.prototype.sendAdmitted.call(runtime,store.bot(b.id),{text:'Human direct'},'original-native-delivery',null,null,false,null,[{type:'text',text:'Human direct',text_elements:[]}]);
 assert.equal(nativeCalls[0].method,'turn/start');assert.equal(nativeCalls[0].params.clientUserMessageId,startSource.submissionId);assert.equal(events.at(-1).data.params.item.clientId,startSource.submissionId);
 const steering=runtime.sources.capture(store.bot(b.id),'human-steer-source',runtime.sources.ownerSource(),'');runtime.sources.delivery(b,'original-steer-delivery',steering);
 await BotRuntime.prototype.sendAdmitted.call(runtime,store.bot(b.id),{text:'Human steer'},'original-steer-delivery',null,null,false,null,[{type:'text',text:'Human steer',text_elements:[]}]);
 assert.equal(nativeCalls[1].method,'turn/steer');assert.equal(nativeCalls[1].params.clientUserMessageId,steering.submissionId);
 store.saveOperation('original-native-delivery','original-hash','uncertain',{method:'turn.send',botId:b.id,params:{text:'Human direct'}});const op=store.operation('original-native-delivery');
 runtime.historyPage=async()=>({data:[{id:'fixture-native-turn',status:'completed',items:[{type:'userMessage',id:'original-native-item',clientId:startSource.submissionId,content:[]}]}],nextCursor:null});
 const recoveredNative=await BotRuntime.prototype.reconcileOperation.call(runtime,op);assert.equal(recoveredNative.turn.id,'fixture-native-turn');assert.equal(nativeCalls.length,2);assert.equal(store.operation(op.id).status,'done');
 // Bot's next queued start is default while the human Plan remains selected.
 store.saveBot({...store.bot(b.id),mode:'plan',activeTurnId:null});store.remove('botActivity',b.id);
 const botSource=runtime.sources.capture(store.bot(b.id),'bot-native-source',{kind:'bot',id:'cody',name:'Cody',color:'#217050'},'Exact bot body');runtime.sources.delivery(b,'original-bot-delivery',botSource);
 await BotRuntime.prototype.sendAdmitted.call(runtime,store.bot(b.id),{text:'Exact bot body'},'original-bot-delivery',null,null,true,null,[{type:'text',text:'Exact bot body',text_elements:[]}]);
 assert.equal(nativeCalls[2].method,'turn/start');assert.equal(nativeCalls[2].params.clientUserMessageId,botSource.submissionId);assert.equal(nativeCalls[2].params.collaborationMode.mode,'default');assert.match(nativeCalls[2].params.input[0].text,/Verified DawarTodo source/);assert.equal(store.bot(b.id).mode,'plan');

});
