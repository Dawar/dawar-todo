import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { HubStore, NodeJournal } from '../portable/control-store.mjs';
import { BotMemoryMaintenance } from '../bot-bridge/memory-maintenance.mjs';
import { NativeErrorRecovery } from '../bot-bridge/native-error-recovery.mjs';
import { nightly, dataDirectories } from '../portable/nightly-invariants.mjs';
import { writeFileSync } from 'node:fs';

const NOW = Date.parse('2026-10-15T18:00:00Z'), HOUR = 3600000, DAY = 24 * HOUR;
const iso = ms => new Date(ms).toISOString();

// A small "production" layout: the hub's data directory and the agent's.
async function production(t) {
  const root = await mkdtemp(join(tmpdir(), 'nightly-prod-'));
  const hubData = join(root, 'hub'), nodeData = join(root, 'agent'), out = join(root, 'reports');
  const control = new HubStore(join(hubData, 'control.sqlite')), hub = new Store(join(hubData, 'control.sqlite'));
  const node = new Store(join(nodeData, 'native-control.sqlite')), journal = new NodeJournal(join(nodeData, 'node-journal.sqlite'));
  control.db.exec("INSERT INTO portable_nodes VALUES('node:a','owner','key','fp','{}',NULL,1)");
  const at = iso(NOW - 30 * DAY);
  for (const [id, slug, name] of [['bot-atlas', 'atlas', 'Atlas'], ['bot-connie', 'connie', 'Connie'], ['bot-sian', 'sian', 'Sian']]) {
    const bot = { id, slug, name, threadId: `thread-${slug}`, cwd: join(root, slug), status: 'idle', executionMode: 'single-thread', updatedAt: at, lastReadAt: at, archived: false };
    hub.saveBot(bot); node.saveBot(bot);
    control.db.prepare("INSERT INTO portable_placements(bot_id,owner,node_id,epoch,stopped) VALUES(?,?,?,1,0)").run(id, 'owner', 'node:a');
  }
  // Case 1: delivered queue history. Case 2: Connie's recovery row. Case 3: the 10-day inbox row.
  for (const [i, state] of ['delivered', 'merged'].entries()) node.put('promptQueue', { id: `history-${i}`, botId: 'bot-atlas', state, createdAt: iso(NOW - 9 * DAY) });
  node.put('nativeErrorRecovery', { id: 'bot-connie', botId: 'bot-connie', threadId: 'thread-connie', failedTurnId: 'turn-1', attempts: 32, errorCode: 'responseStreamDisconnected',
    nativeRetry: true, nativeRetryEpoch: 'previous-process', phase: 'native-retrying', terminalConfirmed: false, createdAt: iso(NOW - 5 * HOUR), updatedAt: iso(NOW - 3 * HOUR) });
  node.put('primaryInbox', { id: 'peer:432942828b0f', botId: 'bot-connie', state: 'accepted', turnId: 'turn-oct-5', createdAt: iso(NOW - 10 * DAY), acceptedAt: iso(NOW - 10 * DAY) });
  // A queued hub item Sian could take right now, two hours old.
  hub.put('promptQueue', { id: 'sian-head', botId: 'bot-sian', state: 'queued', position: 1, createdAt: iso(NOW - 2 * HOUR), text: 'hello' });
  for (const db of [hub.db, node.db, journal.db]) db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  t.after(async () => { control.close(); hub.close(); node.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  return { root, hubData, nodeData, out, hub, node };
}
const checks = report => report.findings.map(f => f.check);
const leftovers = async () => (await readdir(tmpdir())).filter(name => name.startsWith('dawar-invariants-'));

test('nightly replay copies production, checks and simulates, reports and cleans up', async t => {
  const p = await production(t);
  const files = ['hub/control.sqlite', 'agent/native-control.sqlite', 'agent/node-journal.sqlite'];
  const before = await Promise.all(files.map(f => readFile(join(p.root, f))));
  const already = await leftovers();
  const report = await nightly({ hubData: p.hubData, nodeData: p.nodeData, out: p.out, now: NOW });

  assert.deepEqual(await Promise.all(files.map(f => readFile(join(p.root, f)))), before, 'production files are byte-for-byte unchanged');
  assert.deepEqual(await leftovers(), already, 'the copies are deleted');
  assert.deepEqual(report.simulations.map(s => [s.name, s.error]), [['snapshot-equivalence', null], ['queue-admission', null], ['idle-check', null], ['recovery-resume', null]]);
  assert.ok(report.simulations.every(s => s.checked > 0), JSON.stringify(report.simulations));
  for (const check of ['inbox-stale', 'recovery-dead-epoch', 'sim-queue-head-stalled']) assert.ok(checks(report).includes(check), check);
  // The fixed code paths handle the Oct 15 rows: no busy bot, no recovery fault.
  assert.ok(!checks(report).some(c => /busy-without-blocker|recovery-resume-fault/.test(c)), checks(report).join());
  const files2 = await readdir(p.out);
  assert.ok(files2.includes('latest.md') && files2.some(f => /^invariants-.*\.json$/.test(f)));
  const md = await readFile(join(p.out, 'latest.md'), 'utf8');
  assert.match(md, /HIGH · inbox-stale · Connie/);
  assert.match(md, /\| recovery-resume \| 1 \| 0 \|/);
});

test('the simulations catch the Oct 15 code faults on the recorded rows', async t => {
  const p = await production(t);
  // Reintroduce both bugs as they were before 56b60c4.
  // resume() looked up the release action unconditionally; the idle check
  // treated only four queue states as finished.
  const resume = NativeErrorRecovery.prototype.resume, idle = BotMemoryMaintenance.prototype.idle;
  NativeErrorRecovery.prototype.resume = async function (botId, ...rest) {
    this.runtime.store.db.prepare('SELECT json FROM records WHERE kind=? AND id=?').get('nativeRecoveryAction', this.get(botId).releaseActionId);
    return resume.call(this, botId, ...rest);
  };
  BotMemoryMaintenance.prototype.idle = function (bot) { return idle.call(this, bot) && !this.store.list('promptQueue', bot.id).some(r => !['consumed', 'deleted', 'failed', 'cancelled'].includes(r.state)); };
  t.after(() => { NativeErrorRecovery.prototype.resume = resume; BotMemoryMaintenance.prototype.idle = idle; });
  const report = await nightly({ hubData: p.hubData, nodeData: p.nodeData, out: p.out, now: NOW });
  const fault = report.findings.find(f => f.check === 'sim-recovery-resume-fault');
  assert.equal(fault?.botName, 'Connie');
  assert.match(fault.message, /cannot be bound/);
  const busy = report.findings.find(f => f.check === 'sim-idle-busy-without-blocker');
  assert.equal(busy?.botName, 'Atlas');
});

test('snapshot equivalence names a hub/node identity disagreement', async t => {
  const p = await production(t);
  p.hub.saveBot({ ...p.hub.bot('bot-sian'), threadId: 'thread-sian-old' });
  p.hub.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const report = await nightly({ hubData: p.hubData, nodeData: p.nodeData, out: p.out, now: NOW });
  const mismatch = report.findings.find(f => f.check === 'sim-snapshot-mismatch');
  assert.match(mismatch?.message ?? '', /hub record disagree on threadId \("thread-sian-old" vs "thread-sian"\)/);
});

test('data directories come from the portable config, including combined mode', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'nightly-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ mode: 'agent', dataDirectory: '/data/agent' }));
  writeFileSync(join(dir, 'hub.json'), JSON.stringify({ mode: 'both', dataDirectory: '/data/hub', agentConfigFile: join(dir, 'agent.json') }));
  assert.deepEqual(dataDirectories(join(dir, 'hub.json')), { hub: '/data/hub', node: '/data/agent' });
  assert.deepEqual(dataDirectories(join(dir, 'agent.json')), { hub: null, node: '/data/agent' });
  await assert.rejects(nightly({ hubData: join(dir, 'none'), nodeData: null, out: join(dir, 'out') }), /No production database/);
});
