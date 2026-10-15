import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDeployment, failureReason } from '../portable/deployment-transaction.mjs';

function setup(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'deploy-transaction-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let time = 1_000_000;
  const clock = () => time, sleep = async ms => { time += ms; };
  const spec = { version: 1, kind: 'portable-deployment', operationId: 'deploy-test-operation', source: 'b'.repeat(40), waitSeconds: 300,
    receiptDirectory: join(directory, 'receipt'), controllerDirectory: join(directory, 'controller') };
  const calls = [];
  const adapter = {
    reconcile: async () => ({ newHealthy: false, foreignWriter: false }),
    preflight: async () => {}, prepareHold: async () => ({ native: { operationId: spec.operationId } }), begin: async (_, row) => row.hold,
    observe: async () => ({ safe: true }), freezeBackup: async () => ({}), backup: async () => ({ verified: true }), seal: async () => ({ safe: true }),
    stop: async () => {}, waitOldExit: async () => ({ oldExited: true }), escalateStop: async () => {}, prepareStart: async () => {}, start: async () => {},
    waitHealthy: async () => ({ newHealthy: true, proof: { source: spec.source } }), finalize: async () => {}, release: async () => {},
    rollback: async () => {}, waitPreviousHealthy: async () => ({ healthy: true, proof: { source: 'a'.repeat(40) } }), ensureRunning: async () => {},
    ...overrides,
  };
  const recorded = new Proxy(adapter, { get: (target, name) => typeof target[name] === 'function' ? (...args) => { calls.push(name); return target[name](...args); } : target[name] });
  const receipt = () => JSON.parse(readFileSync(join(spec.receiptDirectory, 'transaction.json'), 'utf8'));
  return { spec, adapter: recorded, calls, clock, sleep, receipt, advance: ms => { time += ms; } };
}
const run = f => runDeployment(f.spec, f.adapter, { clock: f.clock, sleep: f.sleep });

test('a transient observation error after stop-intent is retried, not fatal', async t => {
  let calls = 0;
  const f = setup(t, { waitOldExit: async () => { if (++calls < 3) throw Error('systemctl show timed out'); return { oldExited: true }; } });
  const row = await run(f);
  assert.equal(row.outcome, 'healthy');
  assert.equal(row.failures.length, 2);
  assert.equal(row.failures[0].step, 'wait-old-exit');
  assert.equal(row.lastFailure, undefined);
});

test('a healthy deployment finalizes', async t => {
  const f = setup(t);
  const row = await run(f);
  assert.equal(row.outcome, 'healthy');
  assert.deepEqual(row.events.map(e => e.phase), ['prepared', 'draining', 'backup-verified', 'stop-intent', 'old-process-exited', 'start-intent', 'healthy', 'finalized']);
  assert.ok(!f.calls.includes('rollback'));
});

test('the drain deadline expiring after stop-intent does not abandon a stopped service', async t => {
  let f;
  f = setup(t, { waitOldExit: async () => { f.advance(20 * 60 * 1000); return { oldExited: true }; } });
  const row = await run(f);
  assert.ok(f.clock() > row.deadline, 'the original drain deadline has passed');
  assert.equal(row.outcome, 'healthy');
  assert.ok(f.calls.includes('start'));
});

test('an old process that outlives its stop window is escalated once, then the target starts', async t => {
  let exits = 0;
  const f = setup(t, { waitOldExit: async () => ({ oldExited: ++exits > 1 }) });
  const row = await run(f);
  assert.equal(f.calls.filter(c => c === 'escalateStop').length, 1);
  assert.ok(row.escalatedAt);
  assert.equal(row.outcome, 'healthy');
});

test('an unhealthy target is rolled back: before-configs restored and the previous release started', async t => {
  const f = setup(t, { waitHealthy: async () => ({ newHealthy: false, reason: 'target not healthy: ready false' }) });
  const row = await run(f);
  assert.equal(row.outcome, 'rolled-back');
  assert.deepEqual(row.events.slice(-3).map(e => e.phase), ['start-intent', 'rollback-intent', 'rolled-back']);
  assert.deepEqual(f.calls.slice(-3), ['rollback', 'waitPreviousHealthy', 'ensureRunning']);
  assert.equal(row.lastFailure.step, 'wait-healthy');
  assert.match(row.lastFailure.message, /ready false/);
  assert.equal(row.events.at(-2).cause.step, 'wait-healthy');
});

test('a failed prepareStart never starts the target and converges on the previous release', async t => {
  const f = setup(t, { prepareStart: async () => { throw Error('files[0].path changed after the plan was prepared.'); } });
  const row = await run(f);
  assert.equal(row.outcome, 'rolled-back');
  assert.ok(!f.calls.includes('start'));
  assert.equal(row.lastFailure.step, 'prepare-start');
});

test('a failing rollback still leaves the unit running and explains why', async t => {
  const f = setup(t, { waitHealthy: async () => ({ newHealthy: false }), rollback: async () => { throw Error('Backup of /x is missing.'); },
    waitPreviousHealthy: async () => ({ healthy: false }) });
  const row = await run(f);
  assert.equal(row.outcome, 'rollback-unhealthy');
  assert.ok(f.calls.includes('ensureRunning'));
  assert.ok(row.failures.some(x => x.step === 'rollback' && /Backup of \/x is missing/.test(x.message)));
});

// Leaves a receipt at stop-intent (the controller "died" observing the old
// process), then rewrites its phase as a later crash point would have.
async function interruptedAt(t, phase, overrides) {
  const f = setup(t, { waitOldExit: async () => ({ oldExited: false }), escalateStop: async () => { throw Error('controller host lost its user bus'); } });
  await assert.rejects(run(f), /lost its user bus/);
  assert.equal(f.receipt().outcome, 'reconciliation-required');
  assert.ok(f.calls.includes('ensureRunning'), 'even an aborted controller asks systemd to keep the unit running');
  const row = f.receipt(), at = new Date().toISOString();
  const later = { 'start-intent': ['old-process-exited', 'start-intent'], 'rollback-intent': ['old-process-exited', 'start-intent', 'rollback-intent'] }[phase];
  row.events.push(...later.map(p => ({ phase: p, at })));row.phase = phase;delete row.outcome;
  writeFileSync(join(f.spec.receiptDirectory, 'transaction.json'), JSON.stringify(row));
  const g = setup(t, overrides); g.spec = f.spec; f.calls.length = 0;
  return g;
}

test('a restarted controller resumes an interrupted rollback instead of starting the target again', async t => {
  const g = await interruptedAt(t, 'rollback-intent');
  const row = await run(g);
  assert.equal(row.outcome, 'rolled-back');
  assert.ok(!g.calls.includes('start') && !g.calls.includes('prepareStart'));
  assert.deepEqual(g.calls.slice(-3), ['rollback', 'waitPreviousHealthy', 'ensureRunning']);
  assert.equal((await run(g)).outcome, 'rolled-back', 'a finished rollback is returned unchanged');
});

test('a transient foreign writer while the target starts is pending, not a refusal', async t => {
  const g = await interruptedAt(t, 'start-intent', { reconcile: async () => ({ newHealthy: false, foreignWriter: true }) });
  const row = await run(g);
  assert.equal(row.outcome, 'healthy');
  assert.ok(g.calls.includes('waitHealthy'));
});

test('a foreign writer before stop-intent is still refused', async t => {
  const f = setup(t, { reconcile: async () => ({ newHealthy: false, foreignWriter: true }) });
  await assert.rejects(run(f), /Actual writer differs/);
  assert.equal(f.receipt().outcome, 'blocked-before-stop');
  assert.ok(!f.calls.includes('stop'));
});

test('before stop-intent a refusal records the step and a bounded, credential-free reason', async t => {
  const f = setup(t, { observe: async () => { throw Error(`Maintenance observe refused (409): Bearer abc.def BOTS_MACHINE_SECRET=hunter2 ${'x'.repeat(500)}`); } });
  await assert.rejects(run(f));
  const row = f.receipt();
  assert.equal(row.outcome, 'blocked-before-stop');
  assert.equal(row.lastFailure.step, 'observe-drain');
  assert.equal(row.lastFailure.released, true);
  assert.ok(row.lastFailure.message.length <= 300);
  assert.doesNotMatch(row.lastFailure.message, /abc\.def|hunter2/);
});

test('an expired drain records why it expired', async t => {
  const f = setup(t, { observe: async () => ({ safe: false, reason: 'Current work, tools, volatile state or unknown acceptance remains.' }) });
  const row = await run(f);
  assert.equal(row.outcome, 'expired-before-stop');
  assert.equal(row.lastFailure.step, 'observe-drain');
  assert.match(row.lastFailure.message, /Current work/);
  assert.ok(!f.calls.includes('stop'));
});

test('failure reasons are bounded and redact credentials', () => {
  assert.equal(failureReason(Error('a\nb')), 'a b');
  assert.equal(failureReason(Error('TOKEN=abc ok')), 'TOKEN=[redacted] ok');
  assert.equal(failureReason(Error('y'.repeat(1000))).length, 300);
});
