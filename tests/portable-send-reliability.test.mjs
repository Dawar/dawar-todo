import test from 'node:test';
import assert from 'node:assert/strict';
import {portableHarness,until,settle} from './helpers/portable-harness.mjs';

// Scheduler and agent recovery loops run on intervals in production
// (gateway scheduler, agent recoveryTimer). Tests advance them explicitly;
// nobody sends another message to "wake" the queue.
async function background(h,rounds=6){for(let i=0;i<rounds;i++){await h.transport.recover();await h.controls.tick();await settle();}}
const queued=(h,botId)=>h.controls.store.list('promptQueue',botId);

test('a queued message saves durably while the bot is busy and starts after a MISSED native completion',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('turn.send',{text:'first'},'turn-send-first-0001',bot.id);
  await until(()=>h.codex.starts().length===1,'first turn started');
  const first=h.codex.starts()[0];
  // Saving is a hub durable acknowledgement; it does not wait for Codex.
  const saved=await h.request('queue.add',{text:'second'},'queue-add-second-0001',bot.id);
  assert.ok(saved.result.queuedSubmission?.id,'durable queue acknowledgement');
  assert.equal(queued(h,bot.id).length,1);
  // The native turn finishes, but its turn/completed notification is lost.
  h.codex.complete(bot.threadId,'turn-1',{notify:false});
  await background(h,8);
  assert.equal(h.mailbox('turn-send-first-0001').state,'terminal','original send settles against native facts');
  await until(()=>h.codex.starts().length===2,'queued message started without another owner message',100);
  const second=h.codex.starts()[1];
  assert.notEqual(second.params.clientUserMessageId,first.params.clientUserMessageId);
  assert.equal(second.params.input[0].text,'second');
  assert.equal(h.codex.starts().length,2,'no duplicate dispatch');
});

test('a proved pre-native deferral stays the original received command and retries itself once',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('queue.add',{text:'later'},'queue-add-later-0001',bot.id);
  // Admission evidence is temporarily unavailable before journal.prepare.
  h.codex.failNext.set('thread/queue/list',Object.assign(Error('native read timed out'),{}));
  await h.controls.tick();
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.queueDispatch');
  assert.ok(op,'queue dispatch reserved');
  await until(()=>h.node(op.operation_id),'node received the command');
  await settle();await settle();
  assert.equal(h.node(op.operation_id).state,'received','deferral is not an unknown delivery');
  assert.notEqual(h.mailbox(op.operation_id).state,'unknown');
  assert.equal(h.codex.starts().length,0);
  await background(h,4);
  await until(()=>h.codex.starts().length===1,'original command admitted on recovery');
  assert.equal(h.node(op.operation_id).state,'native-accepted');
  assert.equal(h.codex.starts().length,1,'exactly one native submission');
  assert.equal(h.nodeStore.operation(op.operation_id).status,'done');
});

test('an old nonblocking question does not block automatic queue admission',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('turn.send',{text:'ask me later'},'turn-send-ask-0001',bot.id);
  await until(()=>h.codex.starts().length===1);
  // The turn left a nonblocking question behind, then completed.
  h.nodeStore.put('pending',{id:'epoch:question-1',botId:bot.id,async:true,request:{id:'question-1',method:'item/tool/requestUserInput',params:{threadId:bot.threadId,turnId:'turn-1',isBlocking:false,questions:[]}}});
  h.codex.complete(bot.threadId,'turn-1');
  await until(()=>h.mailbox('turn-send-ask-0001').state==='terminal');
  await h.request('queue.add',{text:'keep going'},'queue-add-keep-0001',bot.id);
  await background(h,4);
  await until(()=>h.codex.starts().length===2,'queued work starts while the nonblocking question stays visible',100);
  assert.equal(h.nodeStore.list('pending',bot.id).length,1,'question is preserved');
});

test('a lost receipt reconciles the original ID on reconnect without a second dispatch',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('queue.add',{text:'once'},'queue-add-once-0001',bot.id);
  h.drop.receipt=true;
  await h.controls.tick();
  await until(()=>h.codex.starts().length===1,'native turn started');
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.queueDispatch').operation_id;
  await settle();
  assert.notEqual(h.mailbox(op).state,'native-accepted','acknowledgement was lost');
  await h.disconnect();h.drop.receipt=false;await h.reconnect();
  await background(h,3);
  await until(()=>['native-accepted','terminal'].includes(h.mailbox(op).state),'original receipt recovered');
  assert.equal(JSON.parse(h.mailbox(op).receipt).turnId,'turn-1');
  assert.equal(h.codex.starts().length,1,'no duplicate native submission');
  assert.equal(queued(h,bot.id)[0].state,'delivered');
});

test('Send and Queue save while the execution machine is offline; delivery follows reconnect',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.disconnect();
  const saved=await h.request('queue.add',{text:'offline save'},'queue-add-offline-0001',bot.id);
  assert.ok(saved.result.queuedSubmission?.id);
  const message=await h.request('bursts.submit',{text:'typed while offline',attachments:[],messageId:'burst-message-offline-01'},'burst-submit-offline-0001',bot.id).catch(e=>e);
  assert.ok(!(message instanceof Error),`burst saved: ${message.message}`);
  await h.reconnect();
  await background(h,4);
  await until(()=>h.codex.starts().length>=1,'saved input delivered after reconnect',100);
});

test('a missing hub team acknowledgement before native start defers instead of failing the original message',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('queue.add',{text:'needs team context'},'queue-add-team-0001',bot.id);
  h.drop.control=true;
  // Shorten the hub acknowledgement timeout for this test only.
  const original=global.setTimeout;
  global.setTimeout=(fn,ms,...rest)=>original(fn,ms===15000?30:ms,...rest);
  t.after(()=>{global.setTimeout=original;});
  await h.controls.tick();
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.queueDispatch').operation_id;
  await until(()=>h.node(op),'received');
  for(let i=0;i<10;i++)await settle();
  global.setTimeout=original;
  assert.notEqual(h.mailbox(op).state,'terminal','not a terminal failure');
  assert.notEqual(queued(h,bot.id)[0].state,'failed','original message is not failed');
  h.drop.control=false;
  await background(h,4);
  await until(()=>h.codex.starts().length===1,'original message delivered once team context is available',100);
  assert.equal(h.codex.starts().length,1);
});

test('a burst Send whose hub team acknowledgement is missing stays pending and delivers its original message (Sian)',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  const original=global.setTimeout;
  global.setTimeout=(fn,ms,...rest)=>original(fn,ms===15000?30:ms,...rest);
  t.after(()=>{global.setTimeout=original;});
  h.drop.control=true;
  const submitted=(await h.request('bursts.submit',{text:'from the phone',attachments:[],messageId:'burst-message-sian-0001'},'burst-submit-sian-0001',bot.id)).result;
  await h.request('bursts.start',{},'burst-start-sian-0001',bot.id);
  await h.controls.bursts.tick();
  await until(()=>h.mailboxes(bot.id).some(m=>m.method==='portable.burstDispatch'),'burst dispatched');
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.burstDispatch')?.operation_id;
  assert.ok(op,'burst reserved');
  for(let i=0;i<10;i++)await settle();
  global.setTimeout=original;
  const b=h.controls.store.get('messageBurst',op);
  assert.ok(!['failed','uncertain'].includes(b.state),`burst stays deliverable, got ${b.state}: ${b.error}`);
  h.drop.control=false;
  await background(h,4);
  await until(()=>h.codex.starts().length===1,'original burst delivered',100);
  assert.equal(h.codex.starts()[0].params.input[0].text,'from the phone');
  assert.equal(h.controls.store.get('burstMessage',submitted.message.id).state,'sent');
});

test('Stop stays authoritative: a stopped bot does not drain its queue after a missed completion',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('turn.send',{text:'first'},'turn-send-stop-0001',bot.id);
  await until(()=>h.codex.starts().length===1);
  await h.request('queue.add',{text:'must wait'},'queue-add-stop-0001',bot.id);
  h.hub.db.prepare('UPDATE portable_placements SET stopped=1,control_revision=control_revision+1 WHERE bot_id=?').run(bot.id);
  h.codex.complete(bot.threadId,'turn-1',{notify:false});
  await background(h,8);
  assert.equal(h.codex.starts().length,1,'stopped bot receives no automatic work');
  assert.equal(queued(h,bot.id)[0].state,'queued');
});

test('duplicate completion events and duplicate receipts settle once and dispatch the next message once',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('turn.send',{text:'first'},'turn-send-dup-0001',bot.id);
  await until(()=>h.codex.starts().length===1);
  await h.request('queue.add',{text:'next'},'queue-add-dup-0001',bot.id);
  h.codex.complete(bot.threadId,'turn-1');
  const completed=h.codex.thread(bot.threadId).turns[0];
  h.codex.emit('notification',{method:'turn/completed',params:{threadId:bot.threadId,turn:{...completed}}});
  await until(()=>h.mailbox('turn-send-dup-0001').state==='terminal');
  const row=h.node('turn-send-dup-0001');h.transport.receipt(row);h.transport.receipt(row);
  await background(h,6);
  await until(()=>h.codex.starts().length===2);
  h.codex.emit('notification',{method:'turn/completed',params:{threadId:bot.threadId,turn:{...completed}}});
  await background(h,6);
  assert.equal(h.codex.starts().length,2,'exactly one dispatch of the queued message');
  assert.equal(h.mailbox('turn-send-dup-0001').state,'terminal');
});

test('queue, schedule and burst input keep their original submission identity across a deferral retry',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  const ids=[];
  // Queue: the deferral keeps the reserved operation; retry submits it under the same client ID.
  await h.request('queue.add',{text:'queued'},'queue-add-ident-0001',bot.id);
  h.codex.failNext.set('thread/queue/list',Error('slow native read'));
  await h.controls.tick();await background(h,4);
  await until(()=>h.codex.starts().length===1);
  const q=h.controls.store.list('promptQueue',bot.id)[0];
  assert.equal(h.codex.starts()[0].params.clientUserMessageId,q.clientUserMessageId,'queue submission ID is the native client ID');
  ids.push(q.clientUserMessageId);
  h.codex.complete(bot.threadId,'turn-1');await background(h,3);
  // Schedule: the original occurrence operation is the native client ID.
  const schedule=(await h.request('schedules.save',{title:'Daily',prompt:'check in',cron:'0 9 * * *',enabled:true},'schedule-save-ident-01',bot.id)).result;
  await h.request('schedules.run',{id:schedule.id},'schedule-run-ident-0001',bot.id);
  h.codex.failNext.set('thread/queue/list',Error('slow native read'));
  await h.controls.tick();await background(h,4);
  await until(()=>h.codex.starts().length===2,'scheduled occurrence started');
  const run=h.controls.store.get('run','schedule-run-ident-0001');
  assert.equal(h.codex.starts()[1].params.clientUserMessageId,h.nodeStore.operation(run.operationId)?.clientId??h.codex.starts()[1].params.clientUserMessageId);
  ids.push(h.codex.starts()[1].params.clientUserMessageId);
  h.codex.complete(bot.threadId,'turn-2');await background(h,3);
  // Burst: the human message keeps its saved source through the batch.
  await h.request('bursts.submit',{text:'typed',attachments:[],messageId:'burst-message-ident-01'},'burst-submit-ident-0001',bot.id);
  await h.request('bursts.start',{},'burst-start-ident-0001',bot.id);
  h.codex.failNext.set('thread/queue/list',Error('slow native read'));
  await h.controls.bursts.tick();await background(h,4);
  const burst=h.controls.store.list('messageBurst',bot.id).find(b=>!b.supersededBy);
  assert.ok(!['failed','uncertain'].includes(burst.state),`a transient native read before submission does not fail the burst: ${burst.state} ${burst.error}`);
  await until(()=>h.codex.starts().length===3,'burst started');
  ids.push(h.codex.starts()[2].params.clientUserMessageId);
  assert.equal(new Set(ids).size,3,'distinct original identities');
  assert.equal(h.codex.starts().length,3,'each original input submitted exactly once');
});

test('a failed current-activity read before queue admission is a deferral, not an unknown delivery',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  const {requireCurrentActivity}=await import('../bot-bridge/turn-state.mjs');
  await h.request('queue.add',{text:'after recovery'},'queue-add-activity-0001',bot.id);
  // Native activity becomes unresolved between the hub's work read and the
  // node's admission, and the first recovery read fails.
  const dispatch=h.controls.dispatch.bind(h.controls);
  h.controls.dispatch=(...args)=>{const row=dispatch(...args);
    h.nodeStore.transaction(()=>requireCurrentActivity(h.runtime,bot.id,null,'test-unresolved'));h.runtime.loaded.delete(bot.threadId);
    for(const method of ['thread/resume','thread/read','thread/turns/list'])h.codex.failNext.set(method,Error('native read failed'));return row;};
  await h.controls.tick();
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.queueDispatch')?.operation_id;
  assert.ok(op);
  await until(()=>h.node(op));for(let i=0;i<4;i++)await settle();
  assert.notEqual(h.mailbox(op).state,'unknown','no false unknown delivery');
  h.codex.failNext.clear();
  assert.equal(h.node(op).state,'received');
  // The bounded recovery backoff elapses (5 s in production).
  const activity=h.nodeStore.get('botActivity',bot.id);h.nodeStore.put('botActivity',{...activity,reconcileAfter:new Date(Date.now()-1).toISOString()});
  await background(h,6);
  await until(()=>h.codex.starts().length===1,'original queue item delivered after recovery',100);
});

// An Oct 5 production row: accepted for an OLDER turn whose completion was
// missed while the bot moved on. The current-turn watchdog never reads it.
test('an accepted inbox row for an older terminal turn settles from native facts without a resend',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  const thread=h.codex.thread(bot.threadId);
  const old=(id,status,clientId)=>thread.turns.push({id,status,startedAt:1,items:[{type:'userMessage',id:`user-${id}`,clientId,content:[]}]});
  old('old-interrupted','interrupted','peer:old-interrupted');old('still-running','inProgress','peer:still-running');
  const accepted=(id,turnId)=>h.nodeStore.put('primaryInbox',{id,botId:bot.id,threadId:bot.threadId,kind:'peer',sourceId:id,state:'accepted',turnId,
    createdAt:'2026-10-05T21:33:00.054Z',acceptedAt:'2026-10-05T21:33:01.492Z',error:null});
  accepted('peer:old-interrupted','old-interrupted');accepted('peer:still-running','still-running');accepted('peer:unknown','never-listed');
  assert.equal(h.runtime.maintenance.counts().acceptedOrUnknown,3);
  await background(h,3);
  assert.equal(h.nodeStore.get('primaryInbox','peer:old-interrupted').terminalStatus,'interrupted','exact terminal native fact settles the row');
  assert.equal(h.nodeStore.get('primaryInbox','peer:old-interrupted').state,'accepted');
  for(const id of ['peer:still-running','peer:unknown']){
    const row=h.nodeStore.get('primaryInbox',id);
    assert.equal(row.state,'accepted');assert.equal(row.terminalStatus,undefined,`${id} stays accepted-or-unknown`);
  }
  assert.equal(h.runtime.maintenance.counts().acceptedOrUnknown,2);
  assert.equal(h.codex.starts().length,0,'nothing resubmitted');
  assert.ok(!h.codex.calls.some(c=>c.method==='thread/queue/add'),'nothing re-queued');
  // Read-only and bounded: a row is not read again inside its backoff.
  const reads=h.codex.calls.filter(c=>c.method==='thread/turns/list').length;
  await background(h,2);
  assert.equal(h.codex.calls.filter(c=>c.method==='thread/turns/list').length,reads);
});

// Adversarial review 2026-10-15 (ADVERSARIAL_REVIEW_20261015.md). These reproduce
// open defects; they are `todo` until the owner picks the admission fix.
test('Stop during a pre-native deferral leaves the queue resumable',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('queue.add',{text:'deferred then stopped'},'queue-add-review-c-0001',bot.id);
  h.codex.failNext.set('thread/queue/list',Error('native read timed out'));
  await h.controls.tick();
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.queueDispatch').operation_id;
  await until(()=>h.node(op));for(let i=0;i<4;i++)await settle();
  assert.equal(h.node(op).state,'received','the transient read defers before submission');
  await h.request('turn.interrupt',{scope:'main'},'stop-main-review-c-0001',bot.id).catch(()=>{});
  await background(h,6);
  await h.request('queue.resume',{},'queue-resume-review-c-0001',bot.id);
  await background(h,8);
  assert.equal(h.codex.starts().length,1,'the resumed queue item starts exactly once');
  const [item]=queued(h,bot.id);
  assert.equal(item.operationId,op,'the original dispatch identity is kept, not replaced');
  assert.equal(item.state,'delivered');
  await background(h,4);
  assert.equal(h.codex.starts().length,1,'no second start after more recovery rounds');
});

test('a transient failure while preparing queued input defers instead of becoming unknown',{todo:'R-5: importAttachment/prepareReply/messageInput errors before journal.prepare settle as unknown'},async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('queue.add',{text:'with attachment'},'queue-add-review-a-0001',bot.id);
  const original=h.runtime.messageInput.bind(h.runtime);let failed=false;
  h.runtime.messageInput=async(...args)=>{if(!failed){failed=true;throw new Error('Cloud download failed. Retry the same attachment ID.');}return original(...args);};
  await h.controls.tick();
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.queueDispatch').operation_id;
  await until(()=>h.node(op));for(let i=0;i<6;i++)await settle();
  assert.equal(h.node(op).state,'received','nothing was submitted, so the original command stays received');
  await background(h,6);
  assert.equal(h.codex.starts().length,1);
});
