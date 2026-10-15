import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { installation, release, OLD, NEW, UNIT, HUB_UNIT } from './helpers/deploy-fixture.mjs';
import { preparePlan, PlanMismatch } from '../portable/deploy-plan.mjs';
import { runDeployment } from '../portable/deployment-transaction.mjs';
import { linuxDeployment } from '../portable/deployment-linux.mjs';
import { rehearse, rehearsalPassed } from '../portable/deploy-rehearsal.mjs';

// Role-aware deploys (portable/SPLIT_HUB_RUNNER.md, stages 3 and 4) against the
// fake systemd with real stand-in processes: `hub` and `runner` releases on a
// split installation, and the one-time `cutover` from the combined process.
const prepare = (f, role, options = {}) => preparePlan(f.probe, { source: NEW, role, siteUnitId: null, site: false, receiptRoot: join(f.root, 'deployments'),
  waitSeconds: 120, timeoutStopSec: 10, convergence: { healthWindowSeconds: 20, startupGraceSeconds: 5 },
  ...(role === 'hub' ? { unitId: HUB_UNIT } : { unitId: UNIT }), ...(role === 'cutover' ? { hubUnitId: HUB_UNIT, runnerHealthPort: f.ports.runnerHealthPort } : {}), ...options });
const deploy = (f, plan) => runDeployment(plan, linuxDeployment(plan, { systemctl: f.systemd.systemctl, poll: 200 }));
const show = async (f, id) => Object.fromEntries((await f.systemd.systemctl('show', id)).trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
const identity = async (f, id) => { const u = await show(f, id); return { pid: Number(u.MainPID), invocation: u.InvocationID }; };
const cwd = pid => readlinkSync(`/proc/${pid}/cwd`);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const stops = (f, id) => f.systemd.commands.filter(c => c.startsWith('stop') && c.includes(id));

test('hub release: only the hub restarts, the runner keeps running and is never drained', { timeout: 90000 }, async t => {
  const f = await installation(t, { topology: 'split' });
  const runner = await identity(f, UNIT);
  const { plan } = await prepare(f, 'hub');
  assert.equal(plan.role, 'hub');
  assert.deepEqual(plan.files.map(x => x.path), [f.hubConfig, f.hubDropIn], 'hub config and the hub release drop-in only');
  assert.ok(plan.databases.every(d => d.startsWith(f.hubDir)), 'hub databases only');
  assert.deepEqual(Object.keys(plan.activations), ['hub']);
  assert.deepEqual(plan.expectedNodes, ['node:test'], 'the connected runner must reconnect');
  for (const field of ['managerSocket', 'nativeBinaryPath', 'expectedModels']) assert.equal(plan[field], undefined, field);
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'healthy', JSON.stringify(row.lastFailure) + f.log());
  const hub = await identity(f, HUB_UNIT);
  assert.equal(cwd(hub.pid), f.newRelease);
  assert.deepEqual(await identity(f, UNIT), runner, 'the runner process was not restarted');
  assert.equal(stops(f, UNIT).length, 0);
  assert.equal(stops(f, HUB_UNIT).length, 1, 'exactly one hub stop');
  assert.equal((await f.probe.health(f.ports.runnerHealthPort)).maintenance.phase, 'open', 'no native drain');
  assert.deepEqual({ source: f.writer().source, phase: f.writer().phase }, { source: NEW, phase: 'open' });
  assert.equal(json(f.agentConfig).agent.activationReceipt.includes(OLD), true, 'runner activation unchanged');
  assert.equal(row.events.find(e => e.phase === 'healthy').proof.native, null, 'a hub release proves no native child');
});

test('hub release drain waits for hub writer work and expires without touching the runner', { timeout: 90000 }, async t => {
  const f = await installation(t, { topology: 'split', busyHub: true });
  const runner = await identity(f, UNIT);
  const { plan } = await prepare(f, 'hub', { waitSeconds: 60 });
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'expired-before-stop');
  assert.match(row.lastFailure.message, /Hub writer drain is busy\. Busy: active=1/);
  assert.equal(f.writer().phase, 'open', 'hold released');
  assert.equal(stops(f, HUB_UNIT).length, 0);
  assert.deepEqual(await identity(f, UNIT), runner);
});

test('runner release: native drain and restart of the runner only; hub, writer and site untouched', { timeout: 90000 }, async t => {
  const f = await installation(t, { topology: 'split' });
  const hub = await identity(f, HUB_UNIT), writer = f.writer(), hubConfig = f.hash(f.hubConfig);
  const { plan } = await prepare(f, 'runner');
  assert.equal(plan.role, 'runner');
  assert.equal(plan.localWriter, undefined, 'a runner release holds no hub writer');
  assert.equal(plan.healthPort, f.ports.runnerHealthPort);
  assert.deepEqual(plan.files.map(x => x.path), [f.agentConfig, f.dropIn]);
  assert.ok(plan.databases.every(d => d.startsWith(f.agentDir)));
  assert.deepEqual(Object.keys(plan.activations), ['agent']);
  assert.ok(plan.controllerDirectory.endsWith('/deployments/controller'), 'hub and runner releases share one controller lock');
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'healthy', JSON.stringify(row.lastFailure) + f.log());
  const runner = await identity(f, UNIT);
  assert.equal(cwd(runner.pid), f.newRelease);
  assert.ok(row.events.find(e => e.phase === 'healthy').proof.native.pid > 0, 'native child proven');
  assert.deepEqual(await identity(f, HUB_UNIT), hub, 'the hub kept serving');
  assert.deepEqual(f.writer(), writer, 'hub writer never frozen or flipped');
  assert.equal(f.hash(f.hubConfig), hubConfig);
  assert.equal((await f.probe.health(f.ports.runnerHealthPort)).source, NEW);
  assert.equal((await f.probe.health(f.ports.healthPort)).source, OLD, 'hub stays on its own release');
});

test('runner rollback restores the runner config and release; the hub never notices', { timeout: 120000 }, async t => {
  const f = await installation(t, { topology: 'split', targetHealthy: false });
  const hub = await identity(f, HUB_UNIT), writer = f.writer();
  const { plan } = await prepare(f, 'runner');
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'rolled-back', JSON.stringify(row.lastFailure) + f.log());
  assert.deepEqual(plan.files.map(x => f.hash(x.path)), plan.files.map(x => x.beforeSHA256));
  assert.equal((await f.probe.health(f.ports.runnerHealthPort)).source, OLD);
  assert.deepEqual(await identity(f, HUB_UNIT), hub);
  assert.deepEqual(f.writer(), writer);
});

test('a role plan refuses a unit running the other role', { timeout: 60000 }, async t => {
  const f = await installation(t, { topology: 'split' });
  const wrong = await prepare(f, 'hub', { unitId: UNIT }).catch(e => e);
  assert.ok(wrong instanceof PlanMismatch);
  assert.match(wrong.message, /role/);
  const combined = await prepare(f, 'both', { unitId: HUB_UNIT }).catch(e => e);
  assert.ok(combined instanceof PlanMismatch);
});

test('cutover: one drained transaction installs the hub unit and turns the combined unit into the runner', { timeout: 120000 }, async t => {
  const f = await installation(t);
  const { plan } = await prepare(f, 'cutover');
  assert.equal(plan.role, 'cutover');
  const hubUnitPath = join(f.units, HUB_UNIT), hubDropIn = join(f.units, `${HUB_UNIT}.d`, '90-portable-release.conf');
  assert.deepEqual(plan.files.map(x => [x.path, x.beforeSHA256 === null]), [[f.hubConfig, false], [f.agentConfig, false], [f.dropIn, false], [hubUnitPath, true], [hubDropIn, true]]);
  const hubAfter = json(plan.files[0].preparedPath), agentAfter = json(plan.files[1].preparedPath);
  assert.equal(hubAfter.mode, 'hub');
  assert.equal(hubAfter.agentConfigFile, undefined);
  assert.equal(hubAfter.backendReleaseDirectory, undefined);
  assert.equal(hubAfter.teamWorkspaceRoot, join(f.root, 'bots'), 'the hub names the workspaces the combined process inherited');
  assert.equal(agentAfter.agent.healthPort, f.ports.runnerHealthPort);
  assert.match(readFileSync(plan.files[2].preparedPath, 'utf8'), new RegExp(`run agent --native-child --release ${f.newRelease} --config ${f.agentConfig}`));
  assert.match(readFileSync(plan.files[4].preparedPath, 'utf8'), new RegExp(`run hub --native-child --release ${f.newRelease} --config ${f.hubConfig}`));
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'healthy', JSON.stringify(row.lastFailure) + f.log());
  assert.equal(stops(f, UNIT).length, 1, 'the combined process was stopped exactly once, drained');
  assert.ok(f.systemd.enabled.has(HUB_UNIT), 'the hub starts at boot');
  const hub = await identity(f, HUB_UNIT), runner = await identity(f, UNIT);
  assert.equal(cwd(hub.pid), f.newRelease); assert.equal(cwd(runner.pid), f.newRelease);
  // The gateway's non-secret environment moved with it; bot secrets did not.
  const hubEnv = readFileSync(`/proc/${hub.pid}/environ`, 'utf8').split('\0');
  assert.ok(hubEnv.includes('BOTS_PRIMARY_DESKTOP_BOT_ID=bot-primary'), 'primary desktop bot carried to the hub');
  assert.ok(hubEnv.includes('BOTS_OPERATOR_ALIASES={"ops":"50% $"}'), 'quoted values survive the unit file');
  assert.ok(!hubEnv.some(v => v.startsWith('BOTS_MACHINE_SECRET=')), 'the runner secret stays with the runner');
  const order = f.systemd.commands.filter(c => c.startsWith('start --no-block'));
  assert.deepEqual(order.slice(-2), [`start --no-block ${HUB_UNIT}`, `start --no-block ${UNIT}`], 'hub first, then the runner');
  assert.equal((await f.probe.health(f.ports.healthPort)).role, 'hub');
  assert.equal((await f.probe.health(f.ports.runnerHealthPort)).role, 'runner');
  assert.deepEqual({ source: f.writer().source, phase: f.writer().phase }, { source: NEW, phase: 'open' });
  // Routine releases now work per role on the cut-over installation.
  const third = 'c'.repeat(39) + '3'; release(f.root, third);
  const next = await preparePlan(f.probe, { source: third, role: 'hub', unitId: HUB_UNIT, siteUnitId: null, site: false, receiptRoot: join(f.root, 'deployments'),
    waitSeconds: 120, timeoutStopSec: 10, convergence: { healthWindowSeconds: 20, startupGraceSeconds: 5 } });
  assert.equal(next.plan.old.source, NEW);
  const hubRow = await deploy(f, next.plan);
  assert.equal(hubRow.outcome, 'healthy', JSON.stringify(hubRow.lastFailure) + f.log());
  assert.deepEqual(await identity(f, UNIT), runner, 'a hub release after cutover leaves the runner alone');
});

test('cutover rollback removes the hub unit, restores the combined configs and starts the combined release', { timeout: 150000 }, async t => {
  const f = await installation(t, { targetHealthy: false });
  const { plan } = await prepare(f, 'cutover');
  const row = await deploy(f, plan);
  assert.equal(row.outcome, 'rolled-back', JSON.stringify(row.lastFailure) + f.log());
  assert.equal(existsSync(join(f.units, HUB_UNIT)), false);
  assert.equal(existsSync(join(f.units, `${HUB_UNIT}.d`)), false);
  assert.ok(!f.systemd.enabled.has(HUB_UNIT));
  assert.deepEqual(plan.files.filter(x => x.beforeSHA256).map(x => f.hash(x.path)), plan.files.filter(x => x.beforeSHA256).map(x => x.beforeSHA256));
  assert.equal(json(f.hubConfig).mode, 'both');
  const health = await f.probe.health(f.ports.healthPort);
  assert.deepEqual({ role: health.role, source: health.source, ready: health.ready }, { role: 'both', source: OLD, ready: true });
  assert.equal((await show(f, HUB_UNIT)).MainPID, '0');
  assert.deepEqual({ source: f.writer().source, phase: f.writer().phase }, { source: OLD, phase: 'open' });
  // Nothing is left that would refuse a retried cutover.
  await prepare(f, 'cutover', { now: new Date(Date.now() + 1000) });
});

for (const role of ['hub', 'runner', 'cutover']) {
  test(`rehearse a ${role} plan on copies; production is untouched`, { timeout: 120000 }, async t => {
    const f = await installation(t, role === 'cutover' ? {} : { topology: 'split' });
    const { plan } = await prepare(f, role);
    const units = [UNIT, ...(role === 'cutover' ? [] : [HUB_UNIT])];
    const before = { ids: await Promise.all(units.map(id => identity(f, id))), files: plan.files.map(x => existsSync(x.path) && f.hash(x.path)), writer: f.writer(), units: readdirSync(f.units).sort() };
    const result = await rehearse(plan, { systemctl: f.systemd.systemctl, unitDirectory: f.units, root: join(f.root, 'r') });
    assert.equal(result.outcome, 'healthy', JSON.stringify(result) + f.log());
    assert.ok(rehearsalPassed(plan));
    assert.deepEqual({ ids: await Promise.all(units.map(id => identity(f, id))), files: plan.files.map(x => existsSync(x.path) && f.hash(x.path)), writer: f.writer(), units: readdirSync(f.units).sort() }, before);
    assert.equal(existsSync(result.root), false);
  });
}
