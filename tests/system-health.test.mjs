import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { HubHealth, acceptNodeReport, compactReport, findingNotificationId, NODE_REPORT_FINDINGS } from '../portable/invariant-monitor.mjs';
import { portableHarness, settle } from './helpers/portable-harness.mjs';

const finding = (over = {}) => ({ key: 'node:inbox-stale:primaryInbox:abc', check: 'inbox-stale', severity: 'high', store: 'node', botId: 'bot-1', botName: 'Connie',
  record: { kind: 'primaryInbox', id: 'peer:1' }, message: 'Inbox item is accepted with no terminal status after 10 days.', suggestedAction: 'Read the native turn.', ageMs: 864000000, ...over });
const report = findings => ({ version: 1, checkedAt: new Date().toISOString(), durationMs: 3, truncated: false,
  counts: { high: findings.filter(f => f.severity === 'high').length, medium: findings.filter(f => f.severity === 'medium').length, low: 0 }, findings, errors: [] });

test('node reports are validated and scoped to the bots placed on that node', () => {
  const accepted = acceptNodeReport(report([finding(), finding({ key: 'k2', botId: 'foreign-bot' }), finding({ key: 'k3', botId: null, severity: 'medium' })]), id => id === 'bot-1');
  assert.deepEqual(accepted.findings.map(f => f.key), ['node:inbox-stale:primaryInbox:abc', 'k3']);
  assert.deepEqual(accepted.counts, { high: 1, medium: 1, low: 0 });
  assert.throws(() => acceptNodeReport({ version: 2, findings: [] }, () => true), /Invalid health report/);
  assert.throws(() => acceptNodeReport(report([finding({ severity: 'urgent' })]), () => true), /Invalid health finding/);
  assert.throws(() => acceptNodeReport(report(Array.from({ length: NODE_REPORT_FINDINGS + 1 }, (_, i) => finding({ key: `k${i}` }))), () => true));
  const big = compactReport(report(Array.from({ length: 150 }, (_, i) => finding({ key: `k${i}` }))));
  assert.equal(big.findings.length, NODE_REPORT_FINDINGS);
  assert.equal(big.truncated, true);
});

test('the hub notifies each high finding once through the bot notification table', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-health-'));
  const control = new Store(join(dir, 'control.sqlite'));
  t.after(async () => { control.close(); await rm(dir, { recursive: true, force: true }); });
  const inserts = [];
  const application = { prepare: sql => ({ bind: (...values) => ({ run: async () => { inserts.push({ sql, values }); } }) }) };
  const health = new HubHealth({ controlPath: join(dir, 'control.sqlite'), owner: 'Dawar@Example.com', application, online: id => id === 'node:a' });
  t.after(() => health.stop());
  const r = acceptNodeReport(report([finding(), finding({ key: 'medium-one', severity: 'medium' })]), () => true);
  await health.receive('node:a', r);
  await health.receive('node:a', r);
  assert.equal(inserts.length, 1, 'medium findings and repeats are not notified');
  assert.match(inserts[0].sql, /INSERT OR IGNORE INTO todo_bot_notifications/);
  const [id, owner, botId, title, body] = inserts[0].values;
  assert.match(id, /^[a-f0-9]{64}$/);
  assert.equal(id, findingNotificationId({ ...finding(), key: `node:a:${finding().key}` }));
  assert.deepEqual([owner, botId, title], ['dawar@example.com', 'bot-1', 'System health']);
  assert.match(body, /^Connie: Inbox item .* Next: Read the native turn\./);

  const view = health.view();
  assert.equal(view.hub, null, 'the hub scan has not run yet');
  assert.deepEqual(view.nodes.map(n => [n.nodeId, n.online, n.report.counts.high]), [['node:a', true, 1]]);
  const own = await health.monitor.run();
  assert.equal(health.view().hub, own);
  assert.deepEqual(own.errors, []);
});

test('the agent sends its report only to a hub that accepts health frames', async t => {
  const h = await portableHarness(t);
  const latest = report([finding()]);
  h.transport.health = { last: latest, stop() {} };
  assert.equal(h.transport.hubHealth, false, 'this hub did not offer the capability');
  h.transport.sendHealth();
  await settle();
  assert.ok(!h.frames.includes('health'), 'an older hub would close the socket on an unknown frame');
  h.transport.hubHealth = true;
  h.transport.sendHealth();
  await settle();
  assert.ok(h.frames.includes('health'));
});
