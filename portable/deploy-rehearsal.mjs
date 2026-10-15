import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { readPrivate, savePrivate } from './private-file.mjs';
import { linuxProbe, preparePlan, verifyPlan } from './deploy-plan.mjs';
import { runDeployment } from './deployment-transaction.mjs';
import { linuxDeployment } from './deployment-linux.mjs';

// Source checkouts and releases keep portable/ beside the bundled dist/portable/.
const STAND_IN = ['./rehearsal-service.mjs', '../../portable/rehearsal-service.mjs'].map(p => fileURLToPath(new URL(p, import.meta.url))).find(p => existsSync(p));
const freePort = () => new Promise((resolve, reject) => { const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const pause = ms => new Promise(r => setTimeout(r, ms));

/**
 * `deploy rehearse`: run the full transaction for this plan's release against
 * copies of the live databases under a temporary unit and ports. Production is
 * only read (plan preflight, SQLite online backups, configs); nothing there is
 * stopped, written or reconfigured. The rehearsal plan is produced by the same
 * prepare step, so prepare, preflight, drain, backup, stop, start, health and
 * (when the release is unhealthy) rollback are all exercised.
 */
export async function rehearse(plan, { systemctl, unitDirectory = join(homedir(), '.config/systemd/user'), root: rootBase = join(homedir(), '.cache/dawar-rehearsal'), keep = false, verifyProduction = true, now = new Date(), standIn = STAND_IN } = {}) {
  const probe = linuxProbe(systemctl ? { systemctl } : {});
  if (verifyProduction) await verifyPlan(plan, probe);
  mkdirSync(rootBase, { recursive: true, mode: 0o700 });
  // Short root: the manager socket path must stay under the 108-byte limit.
  const root = mkdtempSync(join(rootBase, 'r-'));
  const unitId = `dawar-rehearsal-${basename(root).slice(2).toLowerCase().replace(/[^a-z0-9]/g, 'x')}.service`;
  // Each role copies only its own half: a hub plan has no agent config, a
  // runner plan no hub config (SPLIT_HUB_RUNNER.md).
  const role = plan.role ?? 'both';
  const hubBefore = plan.currentHubConfigPath ? JSON.parse(readPrivate(plan.currentHubConfigPath)) : null;
  const agentBefore = role === 'hub' ? null : JSON.parse(readPrivate(plan.currentAgentConfigPath ?? hubBefore.agentConfigFile));
  const data = { ...(hubBefore ? { hub: join(root, 'data/hub') } : {}), ...(agentBefore ? { agent: join(root, 'data/agent') } : {}) };
  for (const directory of Object.values(data)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Consistent online copies; the live databases are opened read-only.
  for (const path of plan.databases) {
    const into = dirname(path) === hubBefore?.dataDirectory ? data.hub : dirname(path) === agentBefore?.dataDirectory ? data.agent : null;
    if (!into) throw Error(`Rehearsal cannot place ${path}.`);
    const db = new DatabaseSync(path, { readOnly: true });
    try { await backup(db, join(into, basename(path))); } finally { db.close(); }
  }
  // Activations: copies of the live ones, so prepare writes the target's here.
  const activations = join(root, 'activations');
  const copyActivation = (path, kind) => { const to = join(activations, basename(dirname(path)), `${kind}-activation.json`); savePrivate(to, readPrivate(path, 16384)); return to; };
  const ports = { gatewayPort: await freePort(), sitePort: await freePort(), healthPort: await freePort() };
  const config = join(root, 'config');
  const configPath = join(config, role === 'runner' ? 'agent.json' : 'hub.json');
  if (hubBefore) {
    const hub = { ...hubBefore, ...ports, dataDirectory: data.hub, ...(agentBefore ? { agentConfigFile: join(config, 'agent.json') } : { teamWorkspaceRoot: join(root, 'workspaces') }),
      hub: { ...hubBefore.hub, activationReceipt: copyActivation(hubBefore.hub.activationReceipt, 'hub') }, voice: { enabled: false } };
    savePrivate(join(config, 'hub.json'), JSON.stringify(hub, null, 2) + '\n');
  }
  if (agentBefore) {
    const agent = { ...agentBefore, dataDirectory: data.agent,
      agent: { ...agentBefore.agent, loopbackHubPort: ports.gatewayPort, workspaces: join(root, 'workspaces'), desktops: { enabled: false },
        activationReceipt: copyActivation(agentBefore.agent.activationReceipt, 'agent'), ...(role === 'runner' ? { healthPort: ports.healthPort } : {}) } };
    savePrivate(join(config, 'agent.json'), JSON.stringify(agent, null, 2) + '\n');
  }
  // Relay readiness is simulated: the hub stand-in reports the plan's nodes.
  savePrivate(join(config, 'rehearsal.json'), JSON.stringify({ models: plan.expectedModels ?? [], nodes: plan.expectedNodes ?? [], productionOperationId: plan.operationId }) + '\n');
  // The temporary unit runs the stand-in from the OLD release directory, with
  // the live drop-in's own TimeoutStopSec so the derivation is exercised.
  const releasesRoot = dirname(plan.releaseDirectory), oldRelease = join(releasesRoot, plan.old.source);
  const liveDropIn = readFileSync(plan.files.find(f => f.path.endsWith('.conf')).path, 'utf8');
  const timeout = liveDropIn.split('\n').find(line => /^\s*TimeoutStopSec\s*=/.test(line)) ?? 'TimeoutStopSec=infinity';
  savePrivate(join(unitDirectory, unitId), `[Unit]\nDescription=DawarTodo deploy rehearsal ${plan.operationId} (temporary)\n\n[Service]\nType=simple\nUMask=0077\nKillMode=mixed\nEnvironment=BOTS_MACHINE_SECRET=${randomBytes(32).toString('hex')}\n`);
  const dropIn = join(unitDirectory, `${unitId}.d`, '90-portable-migration.conf');
  const standInRole = { both: 'both', cutover: 'both', hub: 'hub', runner: 'agent' }[role];
  savePrivate(dropIn, `[Service]\nWorkingDirectory=${oldRelease}\nExecStart=\nExecStart=${process.execPath} ${standIn} run ${standInRole} --release ${oldRelease} --config ${configPath}\n${timeout}\n`);
  // A cutover rehearsal installs its own temporary hub unit beside this one.
  const hubUnitId = role === 'cutover' ? unitId.replace(/\.service$/, '-hub.service') : null;
  const systemd = systemctl ?? probe.systemctl;
  const result = { version: 1, kind: 'portable-deployment-rehearsal', productionOperationId: plan.operationId, source: plan.source, root, unitId, startedAt: now.toISOString() };
  try {
    await systemd('daemon-reload'); await systemd('start', '--no-block', unitId);
    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) { await pause(250); try { ready = (await probe.health(ports.healthPort)).ready === true; } catch { /* starting */ } }
    if (!ready) throw Error('The rehearsal stand-in for the current release did not become ready.');
    const prepared = await preparePlan(probe, { source: plan.source, role, unitId, siteUnitId: null, site: false, receiptRoot: join(root, 'deployments'),
      waitSeconds: Math.min(plan.waitSeconds, 300), timeoutStopSec: plan.timeoutStopSec, convergence: plan.convergence, rehearsal: true, now,
      ...(hubUnitId ? { hubUnitId, runnerHealthPort: await freePort() } : {}) });
    result.planPath = prepared.planPath;
    let receipt;
    try { receipt = await runDeployment(prepared.plan, linuxDeployment(prepared.plan, systemctl ? { systemctl, poll: 250 } : {})); }
    catch { receipt = JSON.parse(readPrivate(join(prepared.plan.receiptDirectory, 'transaction.json'), 4 * 1024 * 1024)); }
    Object.assign(result, { outcome: receipt.outcome ?? 'reconciliation-required', phases: receipt.events.map(e => e.phase), lastFailure: receipt.lastFailure ?? null });
  } catch (error) {
    Object.assign(result, { outcome: 'rehearsal-failed', lastFailure: { step: 'rehearsal-setup', message: String(error.message).slice(0, 300) } });
  } finally {
    result.endedAt = new Date().toISOString();
    if (!keep) {
      // Disposable copies: no drain proof is needed to end the stand-in.
      for (const id of [unitId, ...(hubUnitId ? [hubUnitId] : [])]) {
        try { await systemd('kill', '--signal=SIGKILL', id); } catch { /* not running */ }
        try { await systemd('stop', id); } catch { /* already stopped */ }
        rmSync(join(unitDirectory, id), { force: true }); rmSync(join(unitDirectory, `${id}.d`), { recursive: true, force: true });
      }
      try { await systemd('daemon-reload'); } catch { /* reported by the next systemctl user */ }
      rmSync(root, { recursive: true, force: true });
      result.cleanedUp = true;
    }
  }
  savePrivate(join(plan.receiptDirectory, 'rehearsal-result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export const rehearsalPassed = plan => {
  const path = join(plan.receiptDirectory, 'rehearsal-result.json');
  if (!existsSync(path)) return false;
  const r = JSON.parse(readPrivate(path));
  return r.productionOperationId === plan.operationId && r.source === plan.source && r.outcome === 'healthy';
};
