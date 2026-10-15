import test from 'node:test';
import assert from 'node:assert/strict';
import {portableHarness,until,settle,OWNER,NODE} from './helpers/portable-harness.mjs';

// Inventory section 2 acceptance (SPLIT_HUB_RUNNER.md stage 2): replacing the
// gateway/hub process preserves an already-running native turn and its tool
// connection, accepts durable new input, recovers events and cannot dispatch
// twice. The runner side is the shipped bundled AgentTransport over its real
// journal and native store; the hub half is closed and reopened over the same
// control.sqlite, as a new gateway process would. The node link is in-memory
// (portable-harness.mjs), so this is protocol-level proof, not a live restart.
async function background(h,rounds=6){for(let i=0;i<rounds;i++){await h.transport.recover();await h.controls.tick();await settle();}}
const queued=(h,botId)=>h.controls.store.list('promptQueue',botId);
const schedules=(h,botId)=>h.controls.store.list('schedule',botId);
const SCHEDULE={title:'Daily',prompt:'check in',cron:'0 9 * * *',enabled:true};

test('a hub replacement keeps the running native turn, recovers its events, takes new input and dispatches once',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('turn.send',{text:'long running work'},'turn-send-long-0001',bot.id);
  await until(()=>h.codex.starts().length===1,'native turn started');
  await until(()=>['native-accepted','running'].includes(h.mailbox('turn-send-long-0001')?.state),'hub recorded the native acceptance');
  // The running turn calls a hub tool. The hub commits it, then its process is
  // replaced before the answer reaches the runner.
  h.drop.controlResult=true;
  const call=h.runtime.dynamicToolTracked(h.runtime.store.bot(bot.id),{tool:'bots_schedule_save',callId:'call-schedule-0001',threadId:bot.threadId,turnId:'turn-1',arguments:SCHEDULE}).catch(error=>error);
  await until(()=>h.frames.includes('dropped:control-result'),'hub committed the tool call');
  let during;
  await h.replaceHub({beforeStart:async()=>{
    // No gateway runs. The native turn and the runner are untouched; the turn
    // finishes and its completion event can only be journaled on the runner.
    during={activeTurn:h.runtime.store.bot(bot.id).activeTurnId,native:h.codex.thread(bot.threadId).turns[0].status,relay:h.runtime.relayOnline};
    h.codex.complete(bot.threadId,'turn-1');await settle();await settle();
    h.drop.controlResult=false;
  }});
  assert.deepEqual(during,{activeTurn:'turn-1',native:'inProgress',relay:false},'the native turn kept running while the hub was away');
  assert.ok(!h.codex.calls.some(c=>['turn/interrupt','thread/unsubscribe'].includes(c.method)),'nothing interrupted the native turn or its tools');
  // The unanswered tool call ends uncertain, is never replayed, and its one
  // committed effect is the only one.
  const outcome=await call;
  assert.equal(outcome.outcome,'uncertain');
  // Events recorded during the outage reach the new hub from the journal cursor.
  await background(h,6);
  await until(()=>h.mailbox('turn-send-long-0001').state==='terminal','completion recovered after the replacement');
  assert.equal(h.frames.filter(f=>f==='tool:bots_schedule_save').length,1,'the uncertain hub request was not sent again');
  assert.equal(schedules(h,bot.id).length,1);
  // A native retry of the same call (same callId) reconciles to the original.
  const retried=await h.controls.tool(OWNER,bot.id,'bots_schedule_save',{...SCHEDULE,operationId:'tool:call-schedule-0001'},{kind:'authenticated-node-tool',botId:bot.id,nodeId:NODE,epoch:h.runtime.store.bot(bot.id).epoch??1}).catch(error=>error);
  assert.equal(retried.id,schedules(h,bot.id)[0].id,'the retry returns the one committed schedule');
  assert.equal(retried.id,'tool:call-schedule-0001');
  assert.equal(schedules(h,bot.id).length,1,'no second effect');
  // New input is durably accepted by the new hub and dispatched exactly once.
  const saved=await h.request('queue.add',{text:'after the replacement'},'queue-add-after-0001',bot.id);
  assert.ok(saved.result.queuedSubmission?.id,'durable acknowledgement from the new hub');
  await background(h,6);
  await until(()=>h.codex.starts().length===2,'new input delivered',100);
  await background(h,4);
  assert.equal(h.codex.starts().length,2,'no duplicate native submission');
  assert.equal(h.codex.starts()[1].params.input[0].text,'after the replacement');
  assert.equal(queued(h,bot.id)[0].state,'delivered');
});

test('a dispatch whose acknowledgement died with the old hub reconciles by original ID, never twice',async t=>{
  const h=await portableHarness(t);
  const bot=await h.createBot();
  await h.request('queue.add',{text:'once only'},'queue-add-once-0002',bot.id);
  h.drop.receipt=true;
  await h.controls.tick();
  await until(()=>h.codex.starts().length===1,'native turn started');
  const op=h.mailboxes(bot.id).find(m=>m.method==='portable.queueDispatch').operation_id;
  await settle();
  assert.notEqual(h.mailbox(op).state,'native-accepted','the old hub never learned of the native start');
  // The new process has none of the old one's lost frames.
  await h.replaceHub({beforeStart:async()=>{h.drop.receipt=false;}});
  await background(h,4);
  await until(()=>['native-accepted','terminal'].includes(h.mailbox(op).state),'original receipt recovered by the new hub');
  assert.equal(JSON.parse(h.mailbox(op).receipt).turnId,'turn-1');
  await background(h,4);
  assert.equal(h.codex.starts().length,1,'no duplicate native submission');
  assert.equal(h.node(op).state==='native-accepted'||h.node(op).state==='terminal',true);
});
