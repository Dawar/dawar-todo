import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { NodeJournal } from '../portable/control-store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { MinimalCodex } from '../bot-bridge/claude-test-support.mjs';
import { checkPaths, openReadOnly, bridgeBlockers, findingText } from '../bot-bridge/state-invariants.mjs';
import { notifyHighFindings, InvariantMonitor } from '../portable/invariant-monitor.mjs';

const NOW = Date.parse('2026-10-15T18:00:00Z'), HOUR = 3600000, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'invariants-'));
  const paths = { hub: join(dir, 'control.sqlite'), node: join(dir, 'native-control.sqlite'), journal: join(dir, 'node-journal.sqlite') };
  const hub = new Store(paths.hub), node = new Store(paths.node), journal = new NodeJournal(paths.journal);
  // The hub's control.sqlite also holds the portable mailbox/placement tables.
  hub.db.exec(`CREATE TABLE portable_placements(bot_id TEXT PRIMARY KEY, owner TEXT NOT NULL, node_id TEXT NOT NULL, epoch INTEGER NOT NULL, control_revision INTEGER NOT NULL DEFAULT 1, stopped INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE portable_mailbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, bot_id TEXT NOT NULL, node_id TEXT NOT NULL, epoch INTEGER NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, receipt_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  const at = iso(NOW - 30 * DAY);
  for (const [id, slug, name] of [['bot-atlas', 'atlas', 'Atlas'], ['bot-connie', 'connie', 'Connie'], ['bot-sian', 'sian', 'Sian']]) {
    const bot = { id, slug, name, threadId: `thread-${slug}`, cwd: join(dir, slug), status: 'idle', executionMode: 'single-thread', updatedAt: at, lastReadAt: at, archived: false };
    hub.saveBot(bot); node.saveBot(bot);
    hub.db.prepare("INSERT INTO portable_placements(bot_id,owner,node_id,epoch) VALUES(?,?,?,1)").run(id, 'owner', 'node:a');
  }
  t.after(async () => { hub.close(); node.close(); journal.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, paths, hub, node, journal };
}
const find = (report, check, botId) => report.findings.filter(f => f.check === check && (!botId || f.botId === botId));

// Oct 15, case 1: the shared idle predicate counted delivered and merged queue
// history as pending work, so 27 of 30 bots were never reviewed. Proactive
// reviews recorded "not-idle" skips for days with nothing actually pending.
test('Oct 15 case 1: delivered queue history reported as busy', async t => {
  const { paths, hub, node } = await fixture(t);
  hub.meta('initiative-settings', { enabled: true });
  hub.put('initiativeBot', { id: 'bot-atlas', botId: 'bot-atlas', failures: 0, lastReviewAt: iso(NOW - 9 * DAY), lastSkip: 'not-idle', lastSkipAt: iso(NOW - 10 * 60000), skippingSince: iso(NOW - 9 * DAY) });
  for (const [i, state] of ['delivered', 'merged', 'delivered', 'consumed'].entries())
    node.put('promptQueue', { id: `history-${i}`, botId: 'bot-atlas', state, createdAt: iso(NOW - 9 * DAY) });
  // The predicate as it was before 56b60c4: only four states counted as finished.
  const before = id => !node.list('promptQueue', id).some(row => !['consumed', 'deleted', 'failed', 'cancelled'].includes(row.state));
  const report = checkPaths(paths, { now: NOW, currentEpoch: 'live', idleProbe: before });

  const [busy] = find(report, 'busy-without-blocker', 'bot-atlas');
  assert.equal(busy?.severity, 'high', 'busy idle check with no pending work is reported');
  assert.equal(busy.botName, 'Atlas');
  assert.deepEqual(busy.record, { kind: 'bot', id: 'bot-atlas' });
  assert.match(busy.suggestedAction, /predicate/);
  const [skipped] = find(report, 'initiative-skipped', 'bot-atlas');
  assert.equal(skipped?.severity, 'medium');
  assert.match(skipped.message, /9 days .*not-idle.*no pending work/);
  assert.deepEqual(bridgeBlockers(openReadOnly(paths.node), node.bot('bot-atlas')), []);
  assert.equal(find(report, 'queue-state-unknown').length, 0, 'delivered and merged are known states');

  // The fixed predicate (the real one) agrees with the store: no finding.
  const runtime = new BotRuntime({ store: node, codex: new MinimalCodex(), root: join(paths.node, '..', 'bots') });
  t.after(() => runtime.usage.stop());
  const live = checkPaths(paths, { now: NOW, currentEpoch: 'live', idleProbe: id => runtime.memoryMaintenance.idle(node.bot(id)) });
  assert.equal(find(live, 'busy-without-blocker').length, 0);

  // A queue item that is really waiting is pending work, not a false busy.
  node.put('promptQueue', { id: 'waiting', botId: 'bot-atlas', state: 'queued', createdAt: iso(NOW - HOUR) });
  const waiting = checkPaths(paths, { now: NOW, currentEpoch: 'live', idleProbe: before });
  assert.equal(find(waiting, 'busy-without-blocker').length, 0);
  assert.match(find(waiting, 'initiative-skipped')[0].message, /Node shows: 1 waiting queue item/);
});

// Oct 15, case 2: a turn failed right before a restart, so its recovery row
// never got a releaseActionId and its native retry belonged to the dead
// process. Every pass threw and Connie stayed in "Checking execution".
test('Oct 15 case 2: recovery row with no releaseActionId on a dead epoch', async t => {
  const { paths, node } = await fixture(t);
  node.put('nativeErrorRecovery', { id: 'bot-connie', botId: 'bot-connie', threadId: 'thread-connie', failedTurnId: 'turn-1', attempts: 32, errorCode: 'responseStreamDisconnected',
    nativeRetry: true, nativeRetryEpoch: 'previous-process', phase: 'native-retrying', terminalConfirmed: false, createdAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - 2 * 60000) });
  node.put('botActivity', { id: 'bot-connie', botId: 'bot-connie', threadId: 'thread-connie', generation: 40, activeTurnId: null, unresolved: true, reason: 'checking-current-native-state',
    attempts: 32, reconciliationError: 'Provided value cannot be bound to SQLite parameter 2', recoveryCheckedAt: iso(NOW - 60000) });

  const live = checkPaths(paths, { now: NOW, currentEpoch: 'live-process' });
  const [dead] = find(live, 'recovery-dead-epoch', 'bot-connie');
  assert.equal(dead?.severity, 'high');
  assert.deepEqual(dead.record, { kind: 'nativeErrorRecovery', id: 'bot-connie' });
  assert.match(dead.message, /previous-process.*no longer running/);
  assert.match(dead.message, /no releaseActionId/);
  const [budget] = find(live, 'activity-over-budget', 'bot-connie');
  assert.equal(budget?.severity, 'high');
  assert.match(budget.message, /32 reconciliation attempts.*cannot be bound/);
  assert.match(findingText(budget), /^Connie: /);

  // The same row on the live epoch is a legitimate in-progress native retry.
  node.put('nativeErrorRecovery', { ...node.get('nativeErrorRecovery', 'bot-connie'), nativeRetryEpoch: 'live-process', releaseActionId: 'recovery:release' });
  node.put('nativeRecoveryAction', { id: 'recovery:release', botId: 'bot-connie', state: 'connection-ended', epoch: 'live-process', createdAt: iso(NOW) });
  assert.equal(find(checkPaths(paths, { now: NOW, currentEpoch: 'live-process' }), 'recovery-dead-epoch').length, 0);
  // An offline copy has no live epoch; a recently touched row is not flagged...
  assert.equal(find(checkPaths(paths, { now: NOW }), 'recovery-dead-epoch').length, 0);
  // ...but one untouched past the offline window is.
  assert.equal(find(checkPaths(paths, { now: NOW + 2 * HOUR }), 'recovery-dead-epoch').length, 1);
});

// Oct 15, case 3: Connie's Oct 5 inbox row stayed accepted with no terminal
// status for 10 days because nothing in the portable agent reconciled it.
test('Oct 15 case 3: a 10-day accepted inbox row', async t => {
  const { paths, node, hub } = await fixture(t);
  node.put('primaryInbox', { id: 'peer:432942828b0f', botId: 'bot-connie', state: 'accepted', turnId: '01a10dfc-0097-7452-8d7e-eabe373308d6',
    createdAt: iso(NOW - 10 * DAY), acceptedAt: iso(NOW - 10 * DAY), reconcileAfter: iso(NOW - 4 * DAY) });
  node.put('primaryInbox', { id: 'fresh', botId: 'bot-connie', state: 'accepted', turnId: 'turn-now', createdAt: iso(NOW - 10 * 60000), acceptedAt: iso(NOW - 10 * 60000) });
  node.put('primaryInbox', { id: 'settled', botId: 'bot-connie', state: 'accepted', terminalStatus: 'completed', createdAt: iso(NOW - 20 * DAY), acceptedAt: iso(NOW - 20 * DAY) });
  hub.put('primaryInbox', { id: 'hub-uncertain', botId: 'bot-sian', state: 'uncertain', createdAt: iso(NOW - 7 * HOUR), attemptedAt: iso(NOW - 7 * HOUR) });

  const report = checkPaths(paths, { now: NOW });
  const stale = find(report, 'inbox-stale');
  assert.deepEqual(stale.map(f => [f.store, f.record.id, f.severity]), [['node', 'peer:432942828b0f', 'high'], ['hub', 'hub-uncertain', 'medium']]);
  assert.match(stale[0].message, /accepted with no terminal status after 10 days \(turn 01a10dfc/);
  assert.match(stale[0].suggestedAction, /Never resend/);
  assert.equal(stale[0].botName, 'Connie');
  assert.equal(report.counts.high, 1);
});

test('hub mailbox, journal, queue states and dead placements', async t => {
  const { paths, hub, journal } = await fixture(t);
  const mail = hub.db.prepare("INSERT INTO portable_mailbox(operation_id,owner,bot_id,node_id,epoch,fingerprint,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)");
  mail.run('op-stuck', 'owner', 'bot-sian', 'node:a', 1, 'f', JSON.stringify({ method: 'turn.start' }), 'received', NOW - 2 * HOUR, NOW - 2 * HOUR);
  mail.run('op-done', 'owner', 'bot-sian', 'node:a', 1, 'f', '{}', 'terminal', NOW - 9 * DAY, NOW - 9 * DAY);
  mail.run('op-fresh', 'owner', 'bot-sian', 'node:a', 1, 'f', '{}', 'running', NOW - 60000, NOW - 60000);
  mail.run('op-old-epoch', 'owner', 'bot-atlas', 'node:a', 0, 'f', '{}', 'native-accepted', NOW - 60000, NOW - 60000);
  hub.put('promptQueue', { id: 'odd', botId: 'bot-sian', state: 'parked', createdAt: iso(NOW) });
  hub.put('promptQueue', { id: 'in-flight', botId: 'bot-sian', state: 'uncertain', createdAt: iso(NOW - 2 * DAY) });
  journal.db.prepare("INSERT INTO node_commands VALUES(?,?,?,?,NULL)").run('op-journal', 'f',
    JSON.stringify({ bot_id: 'bot-sian', created_at: NOW - 3 * HOUR, payload: JSON.stringify({ method: 'queue.send' }) }), 'unknown');
  journal.db.prepare("INSERT INTO node_commands VALUES(?,?,?,?,NULL)").run('op-weird', 'f', JSON.stringify({ bot_id: 'bot-sian', created_at: NOW }), 'limbo');

  const report = checkPaths(paths, { now: NOW });
  assert.deepEqual(find(report, 'mailbox-nonterminal').map(f => [f.record.id, f.severity]), [['op-stuck', 'medium']]);
  assert.match(find(report, 'mailbox-nonterminal')[0].message, /turn.start has been received for 2 h\./);
  assert.deepEqual(find(report, 'mailbox-dead-placement').map(f => f.record.id), ['op-old-epoch']);
  assert.deepEqual(find(report, 'queue-state-unknown').map(f => f.record.id), ['odd']);
  assert.deepEqual(find(report, 'queue-stale').map(f => [f.record.id, f.severity]), [['in-flight', 'high']]);
  assert.deepEqual(find(report, 'journal-command-stale').map(f => [f.record.id, f.severity]), [['op-journal', 'high']]);
  assert.deepEqual(find(report, 'journal-state-unknown').map(f => f.record.id), ['op-weird']);
  assert.deepEqual(report.errors, []);
  for (const f of report.findings) assert.ok(f.key && f.severity && f.record.kind && f.record.id && f.message && f.suggestedAction, f.check);
  // Stable keys: the same stuck record is the same finding on the next run.
  assert.deepEqual(checkPaths(paths, { now: NOW + 60000 }).findings.map(f => f.key).sort(), report.findings.map(f => f.key).sort());
});

test('the checker is read-only and bounded', async t => {
  const { paths, node } = await fixture(t);
  for (let i = 0; i < 50; i++) node.put('primaryInbox', { id: `old-${i}`, botId: 'bot-sian', state: 'accepted', createdAt: iso(NOW - 3 * DAY), acceptedAt: iso(NOW - 3 * DAY) });
  node.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = await readFile(paths.node);
  const report = checkPaths(paths, { now: NOW, rowLimit: 10, maxFindings: 5 });
  assert.equal(report.findings.length, 5);
  assert.equal(report.truncated, true);
  assert.deepEqual(await readFile(paths.node), before, 'the database file is unchanged');
  const db = openReadOnly(paths.node);
  t.after(() => db.close());
  assert.throws(() => db.exec("DELETE FROM records"), /readonly|read-only/i);
  // A missing table (an older or partial store) is skipped, not an error.
  assert.deepEqual(checkPaths({ journal: paths.hub }, { now: NOW }).errors, []);
});

test('high findings notify once each; the monitor keeps the latest report', async t => {
  const { paths, node } = await fixture(t);
  node.put('primaryInbox', { id: 'old', botId: 'bot-connie', state: 'accepted', createdAt: iso(NOW - 10 * DAY), acceptedAt: iso(NOW - 10 * DAY) });
  const sent = [], notify = finding => { sent.push(finding.key); };
  const seen = new Set();
  const report = checkPaths(paths, { now: NOW });
  await notifyHighFindings(report, seen, notify);
  await notifyHighFindings(report, seen, notify);
  assert.equal(sent.length, 1, 'deduplicated by finding key');

  const reports = [];
  const monitor = new InvariantMonitor({ paths: () => paths, options: () => ({ now: NOW }), onReport: r => reports.push(r), notify, intervalMs: 60000, initialDelayMs: 60000 });
  const latest = await monitor.run();
  assert.equal(monitor.last, latest);
  assert.equal(reports.length, 1);
  assert.equal(latest.counts.high, 1);
  assert.equal(sent.length, 2, 'a new monitor instance has its own dedupe set; the notification id dedupes downstream');
  monitor.stop();
});
