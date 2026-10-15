import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEPLOY_BUNDLES, buildDeployBundles } from '../portable/deploy-bundles.mjs';
import { RUNTIME_COMPANIONS } from '../portable/runtime-companions.mjs';
import { installation, NEW, UNIT } from './helpers/deploy-fixture.mjs';
import { preparePlan } from '../portable/deploy-plan.mjs';
import { rehearse } from '../portable/deploy-rehearsal.mjs';

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Mirrors portable/package.mjs: the whole portable/ source tree, then the
// deploy bundles over their sources; bot-bridge/ holds only the bundled agent,
// store.mjs and the runtime companions, never the other bridge modules.
function packagedLayout(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dawartodo-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  cpSync(join(repo, 'portable'), join(directory, 'portable'), { recursive: true });
  mkdirSync(join(directory, 'bot-bridge'));
  for (const file of ['store.mjs', ...RUNTIME_COMPANIONS]) cpSync(join(repo, 'bot-bridge', file), join(directory, 'bot-bridge', file));
  cpSync(join(repo, 'bot-bridge/native_queue_receipts.py'), join(directory, 'portable/native_queue_receipts.py'));
  symlinkSync(join(repo, 'node_modules'), join(directory, 'node_modules'));
  return directory;
}
const node = (directory, args) => spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', timeout: 30000 });

test('reproduces the packaged failure: the source stand-in needs bot-bridge modules a release does not ship', async t => {
  const directory = packagedLayout(t);
  const result = node(directory, [join(directory, 'portable/rehearsal-service.mjs'), '--help']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_MODULE_NOT_FOUND[\s\S]*bot-bridge\/runtime-maintenance\.mjs/);
});

test('the bundled deploy CLI and rehearsal stand-in resolve every import from a packaged release', { timeout: 60000 }, async t => {
  const directory = packagedLayout(t);
  await buildDeployBundles(join(directory, 'portable'), { root: repo });
  for (const bundle of DEPLOY_BUNDLES) {
    const result = node(directory, [join(directory, 'portable', bundle.file), ...bundle.check]);
    assert.equal(result.status, 0, `${bundle.file}: ${result.stderr}`);
  }
});

test('a rehearsal runs end to end with the packaged stand-in', { timeout: 120000 }, async t => {
  const directory = packagedLayout(t);
  await buildDeployBundles(join(directory, 'portable'), { root: repo });
  const standIn = join(directory, 'portable/rehearsal-service.mjs');
  const f = await installation(t, { standIn });
  const { plan } = await preparePlan(f.probe, { source: NEW, unitId: UNIT, siteUnitId: null, site: false, receiptRoot: join(f.root, 'deployments'),
    waitSeconds: 120, timeoutStopSec: 10, convergence: { healthWindowSeconds: 20, startupGraceSeconds: 5 } });
  const result = await rehearse(plan, { systemctl: f.systemd.systemctl, unitDirectory: f.units, root: join(f.root, 'r'), standIn });
  assert.equal(result.outcome, 'healthy', JSON.stringify(result) + f.log());
});
