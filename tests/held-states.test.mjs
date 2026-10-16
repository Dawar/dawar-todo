import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { MinimalCodex } from '../bot-bridge/claude-test-support.mjs';
import { HOLD_BUDGETS, NOTIFY_INTERVAL_MS, HeldStateWatch, heldStates, heldView, overBudget, recoverHeld } from '../bot-bridge/held-states.mjs';
import { requireCurrentActivity } from '../bot-bridge/turn-state.mjs';
import { acceptNodeNotice } from '../portable/hub-notices.mjs';
import { InitiativeCoordinator, initiativeSkipHold, INITIATIVE_SKIP_BUDGET_MS } from '../bot-bridge/initiative-coordinator.mjs';

const MINUTE = 60_000;
const INPUT_METHODS = ['turn/start', 'turn/steer', 'thread/queue/add', 'thread/queue/start'];

// Native truth for one idle thread whose turns are all finished.
class IdleCodex extends MinimalCodex {
  pending = new Map();
  turns = [];
  async call(method, params) {
    if (method === 'thread/read') { this.calls.push({ method, params }); return { thread: { id: params.threadId, status: { type: 'idle' } } }; }
    if (method === 'thread/turns/list') { this.calls.push({ method, params }); return { data: [...this.turns], nextCursor: null }; }
    return super.call(method, params);
  }
}

async function setup(t, { codex = new IdleCodex() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'held-states-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const runtime = new BotRuntime({ store, codex, root: join(dir, 'bots') });
  t.after(async () => { runtime.usage.stop(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const at = new Date().toISOString();
  const bot = (id = 'bot-1', name = 'Connie') => store.saveBot({ id, slug: id, name, threadId: `thread-${id}`, cwd: join(dir, id), status: 'idle',
    executionMode: 'single-thread', updatedAt: at, lastReadAt: at, archived: false });
  return { dir, store, runtime, codex, bot };
}
const ago = ms => new Date(Date.now() - ms).toISOString();

test('every held kind has a documented budget; within budget nothing escalates, past it the status names the hold', async t => {
  const { store, runtime, bot } = await setup(t);
  const b = bot();
  for (const kind of ['activity', 'native-recovery', 'inbox', 'prompt-queue', 'run', 'burst', 'collaboration', 'maintenance'])
    assert.ok(HOLD_BUDGETS[kind]?.ms > 0, `${kind} has a time budget`);
  assert.deepEqual([HOLD_BUDGETS.activity.ms, HOLD_BUDGETS.activity.attempts], [15 * MINUTE, 5]);

  store.put('botActivity', { id: b.id, botId: b.id, threadId: b.threadId, generation: 1, activeTurnId: null, unresolved: true, unresolvedSince: ago(5 * MINUTE), attempts: 1 });
  store.put('primaryInbox', { id: 'inbox-1', botId: b.id, threadId: b.threadId, kind: 'schedule', summary: 'Nightly report', state: 'accepted', turnId: 'old-turn', createdAt: ago(10 * 24 * 60 * MINUTE) });
  store.put('promptQueue', { id: 'queue-1', botId: b.id, threadId: b.threadId, state: 'uncertain', createdAt: ago(2 * MINUTE) });
  store.put('run', { id: 'run-1', botId: b.id, status: 'uncertain', executionLane: 'main-legacy', scheduledAt: ago(16 * MINUTE) });
  store.put('messageBurst', { id: 'burst-1', botId: b.id, state: 'dispatching', createdAt: ago(1 * MINUTE) });
  store.put('managerOperation', { id: 'op-1', botId: b.id, state: 'uncertain', createdAt: ago(31 * MINUTE) });
  store.put('nativeErrorRecovery', { id: b.id, botId: b.id, threadId: b.threadId, failedTurnId: 'failed', attempts: 2, phase: 'pending', errorCode: 'responseStreamDisconnected', createdAt: ago(1 * MINUTE) });

  const held = heldStates(runtime, store.bot(b.id));
  assert.deepEqual(held.map(item => item.kind).sort(), ['activity', 'burst', 'collaboration', 'inbox', 'native-recovery', 'prompt-queue', 'run']);
  const over = held.filter(item => overBudget(item)).map(item => item.kind).sort();
  assert.deepEqual(over, ['collaboration', 'inbox', 'run'], 'only holds past their time budget escalate');

  // The attempt budget escalates independently of time.
  store.put('botActivity', { ...store.get('botActivity', b.id), attempts: 5 });
  assert.ok(heldStates(runtime, store.bot(b.id)).filter(overBudget).some(item => item.kind === 'activity'));

  const view = heldView(runtime, store.bot(b.id));
  assert.equal(view.label, 'Stuck: work never confirmed', 'the oldest hold leads');
  assert.match(view.reason, /Connie has had work marked accepted for 10 days/);
  assert.equal(runtime.primary.work(store.bot(b.id)).held.label, view.label, 'the work view (status + sidebar) carries it');

  // Current, legitimate work is not a hold.
  store.put('primaryInbox', { ...store.get('primaryInbox', 'inbox-1'), turnId: 'live' });
  store.saveBot({ ...store.bot(b.id), activeTurnId: 'live' });
  assert.ok(!heldStates(runtime, store.bot(b.id)).some(item => item.kind === 'inbox'), 'accepted work on the current turn is working');
  store.put('primaryInbox', { ...store.get('primaryInbox', 'inbox-1'), turnId: null });
  assert.ok(!heldStates(runtime, store.bot(b.id)).some(item => item.kind === 'inbox'), 'accepted work waiting for a turn is in line');
});

test('reason text names the hold, the failed checks, the last error and when it began', async t => {
  const { store, runtime, bot } = await setup(t);
  const b = bot();
  store.put('botActivity', { id: b.id, botId: b.id, threadId: b.threadId, generation: 1, activeTurnId: null, unresolved: true, reason: 'native-thread-idle',
    unresolvedSince: ago(130 * MINUTE), attempts: 34, reconciliationError: 'Provided value cannot be bound to SQLite parameter 2.' });
  store.put('nativeErrorRecovery', { id: b.id, botId: b.id, threadId: b.threadId, failedTurnId: 'turn-failed', attempts: 34, phase: 'native-retrying',
    nativeRetry: true, nativeRetryEpoch: 'replaced-process', errorCode: 'responseStreamDisconnected', createdAt: ago(140 * MINUTE),
    reason: 'Native current-state recovery is unavailable; checking again without replaying input.' });
  const view = heldView(runtime, store.bot(b.id));
  const byKind = Object.fromEntries(view.held.map(item => [item.kind, item]));
  assert.equal(byKind.activity.reason, "Connie can't confirm whether it is working after 34 failed checks; it has refused new messages for 2 hours.");
  assert.match(byKind['native-recovery'].reason, /retry owned by a process that was replaced 2 hours ago; it cannot finish by itself/);
  assert.equal(byKind.activity.lastError, 'Provided value cannot be bound to SQLite parameter 2.');
  assert.equal(byKind.activity.since, store.get('botActivity', b.id).unresolvedSince);
  assert.match(byKind.activity.what, /New messages and queued work are refused/);
  assert.equal(byKind.activity.recoverable, true);
  assert.equal(view.label, 'Stuck: recovery failing', 'the earliest hold (the native failure) leads the status');
  assert.equal(view.since, byKind['native-recovery'].since);
});

test('unresolved activity records when its hold began and keeps it across repeated holds', async t => {
  const { store, runtime, bot } = await setup(t);
  const b = bot();
  requireCurrentActivity(runtime, b.id, null, 'first');
  const since = store.get('botActivity', b.id).unresolvedSince;
  assert.ok(Date.parse(since) <= Date.now());
  requireCurrentActivity(runtime, b.id, 'turn-x', 'second');
  assert.equal(store.get('botActivity', b.id).unresolvedSince, since, 'a continuing hold keeps its start');
});

test("Recover supersedes a replaced process's native retry, settles from thread/read + turns/list, never resends, and is idempotent", async t => {
  const { store, runtime, codex, bot } = await setup(t);
  const b = bot();
  runtime.loaded.add(b.threadId);
  store.put('botActivity', { id: b.id, botId: b.id, threadId: b.threadId, generation: 3567, activeTurnId: null, unresolved: true, reason: 'native-thread-idle',
    unresolvedSince: ago(130 * MINUTE), attempts: 34, reconcileAfter: new Date(Date.now() + 5 * MINUTE).toISOString(),
    reconciliationError: 'Provided value cannot be bound to SQLite parameter 2.' });
  store.put('nativeErrorRecovery', { id: b.id, botId: b.id, threadId: b.threadId, failedTurnId: 'turn-failed', attempts: 34, phase: 'native-retrying',
    nativeRetry: true, nativeRetryEpoch: 'replaced-process', errorCode: 'responseStreamDisconnected', terminalConfirmed: false, createdAt: ago(140 * MINUTE),
    nextRetryAt: new Date(Date.now() + 5 * MINUTE).toISOString() });
  store.put('nativeRecoveryAction', { id: 'recovery:old', botId: b.id, threadId: b.threadId, failedTurnId: 'turn-failed', kind: 'unsubscribe',
    epoch: 'replaced-process', nativeIdentity: { pid: 999999, start: '1', platform: process.platform }, state: 'uncertain' });
  store.put('primaryInbox', { id: 'queued-msg', botId: b.id, threadId: b.threadId, kind: 'schedule', summary: 'Waiting', state: 'queued', createdAt: ago(MINUTE), input: [{ type: 'text', text: 'do not resend' }] });

  // Only the authenticated owner browser may recover.
  await assert.rejects(runtime.handle({ method: 'held.recover', botId: b.id, operationId: 'held-recover:anon-0001', params: { kind: 'activity', id: b.id } }), /owner browser/);
  const result = await runtime.handle({ method: 'held.recover', botId: b.id, clientId: 'browser:owner', operationId: 'held-recover:owner-0001', params: { kind: 'activity', id: b.id } });
  assert.equal(result.resolved, true, result.error);
  assert.deepEqual(result.superseded.map(row => row.kind).sort(), ['nativeErrorRecovery', 'nativeRecoveryAction']);
  const recovery = store.get('nativeErrorRecovery', b.id);
  assert.equal(recovery.phase, 'superseded');
  assert.equal(recovery.nativeRetry, false);
  assert.equal(recovery.supersededEpoch, 'replaced-process');
  assert.equal(store.get('nativeRecoveryAction', 'recovery:old').state, 'connection-ended');
  assert.equal(store.get('nativeRecoveryAction', 'recovery:old').outcome, 'uncertain', 'the dead request keeps its unknown outcome');
  assert.equal(store.get('botActivity', b.id).unresolved, false);
  assert.equal(store.get('botActivity', b.id).unresolvedSince, null);
  assert.equal(runtime.primary.work(store.bot(b.id)).held, null);
  const methods = codex.calls.map(call => call.method);
  assert.ok(methods.includes('thread/read') && methods.includes('thread/turns/list'), 'native truth was read');
  assert.ok(!methods.some(method => INPUT_METHODS.includes(method)), `no input was submitted: ${methods.join(', ')}`);
  assert.equal(store.get('primaryInbox', 'queued-msg').state, 'queued', 'queued input is untouched');

  const calls = codex.calls.length, before = JSON.stringify(store.list('nativeErrorRecovery'));
  const again = await recoverHeld(runtime, b.id, { kind: 'activity', id: b.id });
  assert.equal(again.resolved, true);
  assert.deepEqual(again.superseded, []);
  assert.equal(codex.calls.length, calls, 'a settled hold needs no further reads');
  assert.equal(JSON.stringify(store.list('nativeErrorRecovery')), before);
});

test('Recover keeps a current-process native retry and leaves the hold when native truth is still busy', async t => {
  class BusyCodex extends IdleCodex {
    async call(method, params) {
      if (method === 'thread/read') { this.calls.push({ method, params }); return { thread: { id: params.threadId, status: { type: 'active', activeFlags: [] } } }; }
      return super.call(method, params);
    }
  }
  const { store, runtime, codex, bot } = await setup(t, { codex: new BusyCodex() });
  const b = bot();
  runtime.loaded.add(b.threadId);
  store.put('botActivity', { id: b.id, botId: b.id, threadId: b.threadId, generation: 1, activeTurnId: null, unresolved: true, unresolvedSince: ago(30 * MINUTE), attempts: 6 });
  store.put('nativeErrorRecovery', { id: b.id, botId: b.id, threadId: b.threadId, failedTurnId: 'turn-failed', attempts: 6, phase: 'native-retrying',
    nativeRetry: true, nativeRetryEpoch: runtime.epoch, errorCode: 'responseStreamDisconnected', createdAt: ago(30 * MINUTE) });
  const result = await recoverHeld(runtime, b.id, { kind: 'native-recovery', id: b.id });
  assert.equal(result.resolved, false);
  assert.deepEqual(result.superseded, [], 'a retry owned by this live process is left to Codex');
  assert.equal(store.get('nativeErrorRecovery', b.id).phase, 'native-retrying');
  assert.ok(result.held?.held.some(item => item.kind === 'activity'), 'the hold stays visible');
  assert.ok(!codex.calls.some(call => INPUT_METHODS.includes(call.method)));
  await assert.rejects(recoverHeld(runtime, b.id, { kind: 'maintenance', id: 'x', extra: 1 }), /kind and record ID/);
});

test('Recover settles a long-accepted inbox row from its exact terminal native turn without resending it', async t => {
  const { store, runtime, codex, bot } = await setup(t);
  const b = bot();
  store.put('primaryInbox', { id: 'peer:432942828b0f', botId: b.id, threadId: b.threadId, kind: 'schedule', summary: 'Oct 5 task', state: 'accepted',
    turnId: 'turn-oct5', acceptedAt: ago(10 * 24 * 60 * MINUTE), createdAt: ago(10 * 24 * 60 * MINUTE), input: [{ type: 'text', text: 'original' }] });
  codex.turns = [{ id: 'turn-oct5', status: 'interrupted', items: [{ type: 'userMessage', id: 'u1', clientId: 'peer:432942828b0f', content: [] }] }];
  const before = heldView(runtime, store.bot(b.id));
  assert.equal(before.held[0].kind, 'inbox');
  const result = await runtime.handle({ method: 'held.recover', botId: b.id, clientId: 'browser:owner', operationId: 'held-recover:inbox-0001', params: { kind: 'inbox', id: 'peer:432942828b0f' } });
  assert.equal(result.resolved, true, result.error);
  assert.equal(store.get('primaryInbox', 'peer:432942828b0f').terminalStatus, 'interrupted');
  assert.ok(!codex.calls.some(call => INPUT_METHODS.includes(call.method)));
  // Same operation ID returns its recorded result; a fresh one is a harmless no-op.
  assert.deepEqual(await runtime.handle({ method: 'held.recover', botId: b.id, clientId: 'browser:owner', operationId: 'held-recover:inbox-0001', params: { kind: 'inbox', id: 'peer:432942828b0f' } }), result);
  assert.equal((await recoverHeld(runtime, b.id, { kind: 'inbox', id: 'peer:432942828b0f' })).resolved, true);
});

test('holds without an automatic recovery refuse Recover definitively', async t => {
  const { store, runtime, bot } = await setup(t);
  const b = bot();
  store.put('messageBurst', { id: 'burst-1', botId: b.id, state: 'dispatching', createdAt: ago(20 * MINUTE) });
  await assert.rejects(recoverHeld(runtime, b.id, { kind: 'burst', id: 'burst-1' }), error => error.outcome === 'rejected');
  assert.equal(store.get('messageBurst', 'burst-1').state, 'dispatching');
});

test('notifications: one per new escalated hold, at most one per bot per hour, none within budget', async t => {
  const { store, runtime, bot } = await setup(t);
  const b = bot();
  let now = Date.now();
  const watch = new HeldStateWatch(runtime, { clock: () => now });
  const notices = () => store.list('notice').filter(n => n.botId === b.id);

  store.put('promptQueue', { id: 'queue-1', botId: b.id, threadId: b.threadId, state: 'uncertain', createdAt: new Date(now - 5 * MINUTE).toISOString() });
  watch.tick({ force: true });
  assert.equal(notices().length, 0, 'within budget');
  now += 11 * MINUTE; watch.tick({ force: true });
  assert.equal(notices().length, 1);
  assert.match(notices()[0].body, /Connie has had a queued message unconfirmed for 16 minutes\. .*Open Bot details to Recover\./);
  assert.equal(notices()[0].title, 'Connie');
  now += 1 * MINUTE; watch.tick({ force: true });
  assert.equal(notices().length, 1, 'the same hold does not notify again');

  store.put('run', { id: 'run-1', botId: b.id, status: 'uncertain', executionLane: 'main-legacy', scheduledAt: new Date(now - 20 * MINUTE).toISOString() });
  now += 5 * MINUTE; watch.tick({ force: true });
  assert.equal(notices().length, 1, 'a new hold within the hour waits');
  now = Date.parse(store.get('heldEscalation', b.id).notifiedAt) + NOTIFY_INTERVAL_MS; watch.tick({ force: true });
  assert.equal(notices().length, 2, 'after an hour the new hold notifies');
  assert.match(notices().find(n => /scheduled run/.test(n.body)).body, /scheduled run with an unconfirmed start/);

  // Resolved, then held again inside the hour: still rate-limited.
  store.remove('run', 'run-1'); store.remove('promptQueue', 'queue-1');
  now += MINUTE; watch.tick({ force: true });
  assert.deepEqual(store.get('heldEscalation', b.id).keys, []);
  store.put('promptQueue', { id: 'queue-2', botId: b.id, threadId: b.threadId, state: 'uncertain', createdAt: new Date(now - 20 * MINUTE).toISOString() });
  now += MINUTE; watch.tick({ force: true });
  assert.equal(notices().length, 2);
  // Throttled between forced passes.
  const lastRun = watch.lastRun; now += 1000; watch.tick();
  assert.equal(watch.lastRun, lastRun);
});

test('a runtime-wide maintenance hold notifies once, not once per bot', async t => {
  const { store, runtime, bot } = await setup(t);
  bot('bot-a', 'Ada'); bot('bot-b', 'Bert');
  let now = Date.now();
  runtime.maintenance.current = { id: 'maintenance-1', phase: 'draining', createdAt: new Date(now - 40 * MINUTE).toISOString(), expiresAtMs: now + 60 * MINUTE };
  runtime.maintenance.holding = () => true;
  new HeldStateWatch(runtime, { clock: () => now }).tick({ force: true });
  assert.equal(store.list('notice').length, 1);
  assert.match(store.list('notice')[0].body, /Runtime maintenance has held every bot for 40 minutes/);
  assert.equal(heldView(runtime, store.bot('bot-b')).label, 'Held by maintenance', 'every bot shows the hold');
  runtime.maintenance.current = null;
});

test('portable runner hands notices to the hub; the hub stores each once in the push outbox', async t => {
  const { store, runtime, bot } = await setup(t);
  const b = bot();
  const handed = [];
  runtime.noticeSink = notice => { handed.push(notice); return true; };
  runtime.notify(b, 'held:test', 'Connie is stuck.');
  runtime.notify(b, 'held:test', 'Connie is stuck.');
  assert.equal(handed.length, 1, 'a delivered notice is not handed over again');
  assert.ok(store.list('notice')[0].deliveredAt);
  runtime.noticeSink = () => false;
  runtime.notify(b, 'held:other', 'Still stuck.');
  assert.equal(store.list('notice').find(n => n.body === 'Still stuck.').deliveredAt, null, 'an unassigned bot keeps it undelivered');

  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE todo_bot_notifications(id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, bot_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT)');
  const application = { prepare: sql => ({ bind: (...values) => ({ run: async () => sqlite.prepare(sql).run(...values) }) }) };
  const notice = handed[0];
  assert.equal(await acceptNodeNotice(application, 'Owner@Example.com', b.id, { id: notice.id, title: notice.title, body: notice.body }), true);
  assert.equal(await acceptNodeNotice(application, 'owner@example.com', b.id, { id: notice.id, title: notice.title, body: notice.body }), true);
  assert.deepEqual(sqlite.prepare('SELECT owner_key, bot_id, title, body, delivered_at FROM todo_bot_notifications').all().map(row => ({ ...row })),
    [{ owner_key: 'owner@example.com', bot_id: b.id, title: 'Connie', body: 'Connie is stuck.', delivered_at: null }]);
  assert.equal(await acceptNodeNotice(application, 'owner@example.com', b.id, { id: 'not-a-hash', title: 'x', body: 'y' }), false);
  sqlite.close();
});

test('thinking refused for longer than a day becomes a visible skip hold; a finished thought clears it', async t => {
  const { store } = await setup(t);
  let now = Date.parse('2026-10-15T12:00:00Z');
  const coordinator = new InitiativeCoordinator({ store, executor: {}, bots: () => [], clock: () => now });
  coordinator.skip('bot-1', 'Original pending work must settle first.');
  assert.equal(initiativeSkipHold(coordinator.botState('bot-1'), now), null, 'within budget');
  now += INITIATIVE_SKIP_BUDGET_MS / 2; coordinator.skip('bot-1', 'Still busy.');
  now += INITIATIVE_SKIP_BUDGET_MS / 2;
  assert.deepEqual(initiativeSkipHold(coordinator.botState('bot-1'), now),
    { since: '2026-10-15T12:00:00.000Z', reason: 'Thinking has been skipped for 24 hours: Still busy.' });
  coordinator.saveBotState('bot-1', { lastThinkAt: new Date(now).toISOString(), skippedSince: null });
  assert.equal(initiativeSkipHold(coordinator.botState('bot-1'), now), null);
});

test('portable agent loop re-checks unresolved activity without a delivery attempt: 2 per pass, backoff honoured, assigned only', async t => {
  const { dir, store, runtime, codex, bot } = await setup(t);
  // Bundled like the shipped agent (it imports extensionless TypeScript).
  const { build } = await import('esbuild');
  const { cpSync, mkdirSync, mkdtempSync, rmSync } = await import('node:fs');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { RUNTIME_COMPANIONS } = await import('../portable/runtime-companions.mjs');
  const root = fileURLToPath(new URL('../', import.meta.url));
  mkdirSync(join(root, 'dist'), { recursive: true });
  const bundle = mkdtempSync(join(root, 'dist', 'held-agent-test-'));
  t.after(() => rmSync(bundle, { recursive: true, force: true }));
  for (const name of RUNTIME_COMPANIONS) cpSync(join(root, 'bot-bridge', name), join(bundle, name));
  await build({ entryPoints: [join(root, 'portable/agent.mjs')], outfile: join(bundle, 'agent.mjs'), bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external', logLevel: 'error' });
  const { AgentTransport } = await import(pathToFileURL(join(bundle, 'agent.mjs')).href);
  const { NodeJournal } = await import('../portable/control-store.mjs');
  const { nodeKey } = await import('../portable/protocol.mjs');
  const journal = new NodeJournal(join(dir, 'node-journal.sqlite'));
  t.after(() => journal.close());
  const ids = ['bot-a', 'bot-b', 'bot-c', 'bot-x'];
  for (const id of ids) {
    bot(id, id);
    runtime.loaded.add(`thread-${id}`);
    store.put('botActivity', { id, botId: id, threadId: `thread-${id}`, generation: 1, activeTurnId: null, unresolved: true, reason: 'native-thread-idle', attempts: 0, reconcileAfter: null });
  }
  // bot-x is not assigned to this node.
  journal.synchronize(['bot-a', 'bot-b', 'bot-c'].map(bot_id => ({ bot_id, epoch: 1, control_revision: 1, stopped: 0 })));
  const transport = new AgentTransport({ config: {}, runtime, journal, key: nodeKey(join(dir, 'node-key.pem')),
    enrollment: { nodeId: 'node-1', owner: 'owner', hub: 'https://hub.test/' }, socketFactory: () => { throw Error('no socket'); } });
  t.after(() => transport.close?.());
  // Isolate this loop from the startup barrier pass, which re-checks admissible bots on its own.
  transport.startup.recover = async () => {};
  runtime.ready = true;
  const unresolved = () => ids.filter(id => store.get('botActivity', id).unresolved);
  const later = new Date(Date.now() + 5 * MINUTE).toISOString();

  // Each bot's backoff holds: its own reconcileAfter, or a native recovery's nextRetryAt.
  store.put('botActivity', { ...store.get('botActivity', 'bot-a'), reconcileAfter: later });
  store.put('nativeErrorRecovery', { id: 'bot-b', botId: 'bot-b', threadId: 'thread-bot-b', failedTurnId: 'failed', attempts: 1, phase: 'pending',
    errorCode: 'responseStreamDisconnected', nextRetryAt: later, createdAt: new Date().toISOString() });
  // Maintenance holds the whole check.
  runtime.maintenance.holding = () => true;
  await transport.recover();
  assert.deepEqual(unresolved(), ids);
  delete runtime.maintenance.holding;

  await transport.recover();
  assert.deepEqual(unresolved(), ['bot-a', 'bot-b', 'bot-x'], 'only the due, assigned bot cleared');
  assert.ok(!codex.calls.some(call => ['thread-bot-a', 'thread-bot-b', 'thread-bot-x'].includes(call.params?.threadId)), 'backed-off and unassigned bots were not read');

  // Once due, at most two bots per pass.
  store.put('botActivity', { ...store.get('botActivity', 'bot-a'), reconcileAfter: null });
  store.put('nativeErrorRecovery', { ...store.get('nativeErrorRecovery', 'bot-b'), nextRetryAt: null });
  store.put('botActivity', { ...store.get('botActivity', 'bot-c'), unresolved: true });
  await transport.recover();
  assert.equal(unresolved().filter(id => id !== 'bot-x').length, 1, 'two of three due bots per pass');
  await transport.recover();
  assert.deepEqual(unresolved(), ['bot-x'], 'unassigned bot keeps waiting');
  assert.ok(!codex.calls.some(call => INPUT_METHODS.includes(call.method)), 'nothing was delivered');
});
