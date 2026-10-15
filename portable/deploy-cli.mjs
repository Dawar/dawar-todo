import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivate } from './private-file.mjs';
import { runDeployment, failureReason } from './deployment-transaction.mjs';
import { linuxDeployment } from './deployment-linux.mjs';
import { linuxProbe, preparePlan, verifyPlan, DEFAULT_UNIT, DEFAULT_SITE_UNIT, DEFAULT_TIMEOUT_STOP_SEC } from './deploy-plan.mjs';
import { rehearse, rehearsalPassed } from './deploy-rehearsal.mjs';

// deploy-cli.mjs prepare <sha> [--unit U] [--site U | --no-site] [--receipts DIR] [--wait-seconds N] [--timeout-stop-sec N] [--health-window-seconds N]
// deploy-cli.mjs preflight --plan PLAN
// deploy-cli.mjs rehearse  --plan PLAN [--keep]
// deploy-cli.mjs launch    --plan PLAN [--skip-rehearsal]   (runs `run` in its own transient unit)
// deploy-cli.mjs run       --plan PLAN [--skip-rehearsal]   (legacy: --plan PLAN)
const usage = 'Use deploy-cli.mjs prepare <sha> | preflight|rehearse|launch|run --plan PRIVATE_ABSOLUTE_PLAN. See portable/DEPLOY.md.';
const argv = process.argv.slice(2), command = argv[0]?.startsWith('--') ? 'run' : argv.shift();
const flag = name => argv.includes(name), value = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const number = (name, fallback) => { const v = value(name); if (v === undefined) return fallback; const n = Number(v); if (!Number.isSafeInteger(n)) throw Error(`${name} must be an integer.`); return n; };
process.umask(0o077);
const print = value => console.log(JSON.stringify(value, null, 2));
const loadPlan = () => { const path = value('--plan'); if (!isAbsolute(path ?? '')) throw Error(usage); return JSON.parse(readPrivate(path)); };

try {
  if (command === 'prepare') {
    const source = argv[0];
    if (!/^[a-f0-9]{40}$/.test(source ?? '')) throw Error('prepare needs the full 40-character release SHA.');
    const { planPath, plan } = await preparePlan(linuxProbe(), { source, unitId: value('--unit') ?? DEFAULT_UNIT,
      siteUnitId: flag('--no-site') ? null : value('--site') ?? DEFAULT_SITE_UNIT, site: flag('--no-site') ? false : value('--site') ? true : undefined,
      receiptRoot: value('--receipts'), waitSeconds: number('--wait-seconds', 900), timeoutStopSec: number('--timeout-stop-sec', DEFAULT_TIMEOUT_STOP_SEC),
      convergence: value('--health-window-seconds') ? { healthWindowSeconds: number('--health-window-seconds') } : {} });
    print({ planPath, operationId: plan.operationId, source: plan.source, old: { source: plan.old.source, pid: plan.old.pid }, localWriter: plan.localWriter.expected,
      expectedModels: plan.expectedModels, site: plan.site?.unitId ?? null, preflight: 'passed', next: `node ${fileURLToPath(import.meta.url)} rehearse --plan ${planPath}` });
  } else if (command === 'preflight') {
    print({ preflight: 'passed', ...await verifyPlan(loadPlan(), linuxProbe()) });
  } else if (command === 'rehearse') {
    const result = await rehearse(loadPlan(), { keep: flag('--keep') });
    print(result); if (result.outcome !== 'healthy') process.exitCode = 1;
  } else if (command === 'launch' || command === 'run') {
    const plan = loadPlan();
    if (!flag('--skip-rehearsal') && !rehearsalPassed(plan)) throw Error('No healthy rehearsal for this plan. Run `deploy-cli.mjs rehearse --plan …` first or pass --skip-rehearsal.');
    if (command === 'launch') {
      // The controller must outlive the shell and the service it restarts.
      const args = ['--user', `--unit=${plan.controllerUnitId}`, '--collect', '--property=UMask=0077', process.execPath, fileURLToPath(import.meta.url), 'run', '--plan', value('--plan'), ...(flag('--skip-rehearsal') ? ['--skip-rehearsal'] : [])];
      const { stdout, stderr } = await promisify(execFile)('systemd-run', args, { timeout: 15000 });
      print({ launched: plan.controllerUnitId, receipt: join(plan.receiptDirectory, 'transaction.json'), output: (stdout + stderr).trim() });
    } else {
      let receipt, error;
      try { receipt = await runDeployment(plan, linuxDeployment(plan)); } catch (e) { error = e; }
      try { receipt ??= JSON.parse(readPrivate(join(plan.receiptDirectory, 'transaction.json'), 4 * 1024 * 1024)); } catch { /* no receipt yet: preflight refused */ }
      print({ operationId: plan.operationId, source: plan.source, phase: receipt?.phase ?? null, outcome: receipt?.outcome ?? 'refused',
        lastFailure: receipt?.lastFailure ?? (error ? { step: 'preflight', message: failureReason(error) } : null) });
      if (receipt?.outcome !== 'healthy') process.exitCode = 1;
    }
  } else throw Error(usage);
} catch (error) {
  console.error(JSON.stringify({ error: failureReason(error), mismatches: error.mismatches }, null, 2));
  process.exitCode = 1;
}
