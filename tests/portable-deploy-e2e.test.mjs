import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installation, OLD, NEW, MODELS, UNIT } from './helpers/deploy-fixture.mjs';
import { preparePlan, verifyPlan, PlanMismatch } from '../portable/deploy-plan.mjs';
import { runDeployment } from '../portable/deployment-transaction.mjs';
import { linuxDeployment } from '../portable/deployment-linux.mjs';
import { rehearse, rehearsalPassed } from '../portable/deploy-rehearsal.mjs';

const prepare = (f, options = {}) => preparePlan(f.probe, { source: NEW, unitId: UNIT, siteUnitId: null, site: false, receiptRoot: join(f.root, 'deployments'),
  waitSeconds: 120, timeoutStopSec: 10, convergence: { healthWindowSeconds: 20, startupGraceSeconds: 5 }, ...options });
const deploy = (f, plan) => runDeployment(plan, linuxDeployment(plan, { systemctl: f.systemd.systemctl, poll: 200 }));
const cwd = pid => readFileSync(`/proc/${pid}/stat`) && import('node:fs').then(fs => fs.readlinkSync(`/proc/${pid}/cwd`));

test('prepare derives the whole plan from live state and preflight accepts it', { timeout: 60000 }, async t => {
  const f = await installation(t);
  const { plan, planPath } = await prepare(f);
  assert.ok(existsSync(planPath));
  const live = await f.systemd.systemctl('show', UNIT);
  assert.match(live, new RegExp(`MainPID=${plan.old.pid}\\b`));
  assert.deepEqual(plan.localWriter.expected, { writerId: 'migration:test-writer', epoch: 1, source: OLD }, 'from the live hub writer row');
  assert.deepEqual(plan.expectedModels, MODELS, 'from live health');
  assert.equal(plan.old.source, OLD);
  assert.equal(plan.nativeBinarySHA256, f.nativeSHA);
  assert.deepEqual(plan.files.map(x => x.path), [f.hubConfig, f.agentConfig, f.dropIn]);
  assert.deepEqual(plan.files.map(x => x.beforeSHA256), [f.hubConfig, f.agentConfig, f.dropIn].map(f.hash));
  // Prepared configs are the live ones with only the release substituted.
  const before = JSON.parse(readFileSync(f.hubConfig, 'utf8')), after = JSON.parse(readFileSync(plan.files[0].preparedPath, 'utf8'));
  assert.equal(after.hub.source, NEW);
  assert.equal(after.backendReleaseDirectory, f.newRelease);
  assert.deepEqual({ ...after, hub: before.hub, backendReleaseDirectory: before.backendReleaseDirectory }, before);
  const dropIn = readFileSync(plan.files[2].preparedPath, 'utf8');
  assert.match(dropIn, new RegExp(`WorkingDirectory=${f.newRelease}\n`));
  assert.match(dropIn, /^TimeoutStopSec=10$/m, 'finite stop deadline replaces infinity');
  assert.doesNotMatch(dropIn, new RegExp(OLD));
  // Target activations derived from the live writer and manifest.
  const hubActivation = JSON.parse(readFileSync(plan.activations.hub.path, 'utf8'));
  assert.deepEqual(hubActivation, { kind: 'portable-hub-activation', executionEnabled: true, writerId: 'migration:test-writer', epoch: 1, source: NEW });
  assert.equal(JSON.parse(readFileSync(plan.activations.agent.path, 'utf8')).releaseManifestSHA256, plan.manifestSHA256);
  assert.deepEqual(await verifyPlan(plan, f.probe), { verified: true, fields: Object.keys(plan).length - 3 });
});

test('preflight names a stale hub writer source (the 2026-10-14 refusals) and other drift', { timeout: 60000 }, async t => {
  const f = await installation(t);
  const { plan } = await prepare(f);
  const stale = structuredClone(plan); stale.localWriter.expected.source = '5454951' + '0'.repeat(33);
  const error = await verifyPlan(stale, f.probe).catch(e => e);
  assert.ok(error instanceof PlanMismatch);
  assert.deepEqual(error.mismatches.map(m => m.field), ['localWriter.expected.source']);
  assert.match(error.message, /localWriter\.expected\.source \(plan 5454951.*live a{39}1\)/);
  const drift = structuredClone(plan); drift.expectedModels = ['gpt-other']; drift.old.pid += 1; drift.files[1].beforeSHA256 = '0'.repeat(64);
  const fields = (await verifyPlan(drift, f.probe).catch(e => e)).mismatches.map(m => m.field);
  for (const field of ['expectedModels', 'old.pid', 'files[1].beforeSHA256']) assert.ok(fields.some(x => x.startsWith(field)), `${field} in ${fields}`);
  // A hand-edited prepared config is refused even when its hash is updated.
  const handCopied = structuredClone(plan);
  const { writeFileSync } = await import('node:fs'); const { createHash } = await import('node:crypto');
  const text = readFileSync(plan.files[0].preparedPath, 'utf8').replace('"owner"', '"owner2"');
  writeFileSync(plan.files[0].preparedPath, text); handCopied.files[0].afterSHA256 = createHash('sha256').update(text).digest('hex');
  const copied = await verifyPlan(handCopied, f.probe).catch(e => e);
  assert.ok(copied.mismatches.some(m => m.message.includes('only the release substituted')), JSON.stringify(copied.mismatches));
});

test('run: drain, backup, stop with keep-alive-safe shutdown, start the target, healthy', { timeout: 90000 }, async t => {
  const f = await installation(t);
  const { plan } = await prepare(f);
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'healthy', JSON.stringify(row.lastFailure) + f.log());
  const unit = Object.fromEntries((await f.systemd.systemctl('show', UNIT)).trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
  assert.equal(await cwd(Number(unit.MainPID)), f.newRelease);
  assert.equal(f.writer().source, NEW);
  assert.deepEqual(plan.files.map(x => f.hash(x.path)), plan.files.map(x => x.afterSHA256));
  assert.ok(row.events.find(e => e.phase === 'healthy').proof.native.pid > 0, 'native child proven');
  assert.ok(f.systemd.commands.filter(c => c.startsWith('stop')).length === 1, 'exactly one stop');
});

test('rollback: an unhealthy target restores the before-configs and the previous release', { timeout: 120000 }, async t => {
  const f = await installation(t, { targetHealthy: false });
  const { plan } = await prepare(f);
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'rolled-back', JSON.stringify(row.lastFailure) + f.log());
  assert.equal(row.lastFailure.step, 'wait-healthy');
  assert.match(row.lastFailure.message, /target not healthy/);
  assert.deepEqual(plan.files.map(x => f.hash(x.path)), plan.files.map(x => x.beforeSHA256));
  assert.equal(f.writer().source, OLD);
  assert.equal(f.writer().phase, 'open');
  const health = await f.probe.health(f.ports.healthPort);
  assert.equal(health.source, OLD); assert.equal(health.ready, true);
});

test('a target that starts through an activating helper is pending, not foreign', { timeout: 90000 }, async t => {
  const f = await installation(t, { activatingMs: 1500 });
  const { plan } = await prepare(f);
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'healthy', JSON.stringify(row.lastFailure) + f.log());
});

test('rehearse: the full transaction runs on copies under a temporary unit; production is untouched', { timeout: 120000 }, async t => {
  const f = await installation(t);
  const { plan } = await prepare(f);
  const show = async () => (await f.systemd.systemctl('show', UNIT)).match(/MainPID=(\d+)/)[1];
  const before = { pid: await show(), files: plan.files.map(x => f.hash(x.path)), writer: f.writer(), units: readdirSync(f.units).sort() };
  const result = await rehearse(plan, { systemctl: f.systemd.systemctl, unitDirectory: f.units, root: join(f.root, 'r') });
  assert.equal(result.outcome, 'healthy', JSON.stringify(result) + f.log());
  assert.ok(result.phases.includes('stop-intent') && result.phases.includes('finalized'));
  assert.ok(rehearsalPassed(plan));
  assert.deepEqual({ pid: await show(), files: plan.files.map(x => f.hash(x.path)), writer: f.writer(), units: readdirSync(f.units).sort() }, before);
  assert.equal(existsSync(result.root), false, 'rehearsal copies removed');
});

// 2026-10-15: the rehearsal before 3d0277a expired on a busy copy and the Oct 5
// accepted inbox row ("localActive=1, acceptedOrUnknown=1") and was skipped.
test('rehearse settles copied work whose exact native turn is terminal; production keeps its rows', { timeout: 120000 }, async t => {
  const f = await installation(t, { busyBot: true, staleInbox: true, nativeTurns: [
    { threadId: 'thread-connie', turnId: 'turn-old', status: 'interrupted' }, { threadId: 'thread-busy', turnId: 'turn-1', status: 'completed' }] });
  const { plan } = await prepare(f);
  const result = await rehearse(plan, { systemctl: f.systemd.systemctl, unitDirectory: f.units, root: join(f.root, 'r'), nativeHistory: f.nativeHistory });
  assert.equal(result.outcome, 'healthy', JSON.stringify(result) + f.log());
  assert.deepEqual(result.settledCopies.map(s => [s.kind, s.id, s.status]).sort(),
    [['activeTurn', 'busy-bot', 'completed'], ['primaryInbox', 'peer:4329428-stale', 'interrupted']]);
  const { Store } = await import('../bot-bridge/store.mjs');
  const live = new Store(join(f.agentDir, 'native-control.sqlite'));
  try {
    assert.equal(live.get('primaryInbox', 'peer:4329428-stale').terminalStatus, undefined, 'production row untouched');
    assert.equal(live.bot('busy-bot').activeTurnId, 'turn-1');
  } finally { live.close(); }
});

test('rehearse names the exact copied record that blocks the drain when its native turn is unknown', { timeout: 120000 }, async t => {
  const f = await installation(t, { staleInbox: true, nativeTurns: [{ threadId: 'thread-connie', turnId: 'turn-old', status: 'inProgress' }] });
  const { plan } = await prepare(f, { waitSeconds: 60 });
  const result = await rehearse(plan, { systemctl: f.systemd.systemctl, unitDirectory: f.units, root: join(f.root, 'r'), nativeHistory: f.nativeHistory });
  assert.equal(result.outcome, 'expired-before-stop', JSON.stringify(result) + f.log());
  assert.deepEqual(result.settledCopies, []);
  assert.match(result.lastFailure.message, /acceptedOrUnknown=1\. Blocking: primaryInbox peer:4329428-stale \(Connie: Communications Manager\) accepted turn turn-old/);
  assert.deepEqual(result.lastFailure.blockers, ['primaryInbox peer:4329428-stale (Connie: Communications Manager) accepted turn turn-old']);
});

test('rehearse reports a broken release as rolled back without touching production', { timeout: 150000 }, async t => {
  const f = await installation(t, { targetHealthy: false });
  const { plan } = await prepare(f);
  const writer = f.writer();
  const result = await rehearse(plan, { systemctl: f.systemd.systemctl, unitDirectory: f.units, root: join(f.root, 'r') });
  assert.equal(result.outcome, 'rolled-back', JSON.stringify(result) + f.log());
  assert.match(result.lastFailure.message, /target not healthy/);
  assert.equal(rehearsalPassed(plan), false);
  assert.deepEqual(f.writer(), writer);
});

test('a drain that never becomes idle expires before stop and names the busy counters', { timeout: 90000 }, async t => {
  const f = await installation(t, { busyBot: true });
  const { plan } = await prepare(f, { waitSeconds: 60 });
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'expired-before-stop');
  assert.equal(row.lastFailure.step, 'observe-drain');
  assert.match(row.lastFailure.message, /localActive=1\. Blocking: bot Busy running turn turn-1/);
  assert.equal(f.writer().phase, 'open', 'hold released');
  assert.ok(!f.systemd.commands.some(c => c.startsWith('stop')));
  assert.equal((await f.probe.health(f.ports.healthPort)).maintenance.phase, 'open');
});

test('preflight refuses a backend unit that another unit pulls in (the front restart race)', { timeout: 60000 }, async t => {
  const f = await installation(t);
  f.systemd.reverse[UNIT] = { WantedBy: 'default.target dawar-portable-front.service' };
  const error = await prepare(f).catch(e => e);
  assert.ok(error instanceof PlanMismatch);
  assert.match(error.message, /pulled in by WantedBy=dawar-portable-front\.service/);
});

test('an unplanned start after the old exit makes the controller yield and reopen the writer', { timeout: 90000 }, async t => {
  const f = await installation(t);
  const { plan } = await prepare(f);
  // A dependency (e.g. restarting the front) queues a start of the backend
  // behind the controller's stop job.
  f.systemd.afterCommand = async args => { if (args[0] === 'stop' && args.includes(UNIT)) { f.systemd.afterCommand = null; await f.systemd.systemctl('start', UNIT); } };
  const issued = f.systemd.commands.length;
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'yielded-to-unplanned-start', JSON.stringify(row.lastFailure) + f.log());
  assert.equal(row.lastFailure.step, 'unplanned-start');
  assert.match(row.lastFailure.message, /started by another job/);
  assert.ok(!f.systemd.commands.slice(issued).some(c => c.startsWith('start --no-block')), 'the controller never started the target');
  assert.deepEqual(plan.files.map(x => f.hash(x.path)), plan.files.map(x => x.beforeSHA256));
  assert.deepEqual({ source: f.writer().source, phase: f.writer().phase }, { source: OLD, phase: 'open' });
  const { until } = await import('./helpers/deploy-fixture.mjs');
  await until(async () => (await f.probe.health(f.ports.healthPort).catch(() => ({}))).ready === true, 15000, f.log);
});

// Adversarial review R-3 (ADVERSARIAL_REVIEW_20261015.md).
const rehearsalModels = (f, models) => writeFileSync(join(f.root, 'config', 'rehearsal.json'), JSON.stringify({ models, nodes: ['node:test'] }) + '\n', { mode: 0o600 });

test('a target whose native catalog gained a model is healthy, not rolled back', { timeout: 90000 }, async t => {
  const f = await installation(t);
  const { plan } = await prepare(f);
  assert.deepEqual(plan.expectedModels, MODELS);
  rehearsalModels(f, [...MODELS, 'gpt-test-new']); // only the new process reads it
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'healthy', JSON.stringify(row.lastFailure) + f.log());
});

test('rollback drains the started target through its own maintenance claim before stopping it', { timeout: 120000 }, async t => {
  const f = await installation(t);
  const { plan } = await prepare(f);
  rehearsalModels(f, MODELS.slice(0, 1)); // a planned model is missing: the target stays unhealthy
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'rolled-back', JSON.stringify(row.lastFailure) + f.log());
  const drain = JSON.parse(readFileSync(join(plan.receiptDirectory, 'rollback-drain.json'), 'utf8'));
  assert.equal(drain.drained, true, drain.reason);
  assert.doesNotMatch(f.log(), /Rehearsal shutdown refused/, 'the target was not stopped without a claimed drain');
  assert.equal(f.systemd.commands.filter(c => c.startsWith('kill')).length, 0, 'no SIGKILL escalation');
});
