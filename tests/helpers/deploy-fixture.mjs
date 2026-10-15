import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { savePrivate } from '../../portable/private-file.mjs';
import { Store } from '../../bot-bridge/store.mjs';
import { FakeSystemd } from './fake-systemd.mjs';
import { linuxProbe } from '../../portable/deploy-plan.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const OLD = 'a'.repeat(39) + '1', NEW = 'b'.repeat(39) + '2';
export const MODELS = ['gpt-test-sol', 'gpt-test-luna'];
export const UNIT = 'dawar-test-bots.service';
const STAND_IN = fileURLToPath(new URL('../../portable/rehearsal-service.mjs', import.meta.url));
const pause = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => { const { createServer } = await import('node:net'); return new Promise(resolve => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); }); };

function release(root, source, { healthy = true } = {}) {
  const directory = join(root, 'backend-releases', source), files = [];
  const write = (path, text) => { mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), text); files.push({ path, sha256: sha256(text) }); };
  if (healthy) write('dist/portable/gateway.mjs', 'export function startGateway() {}\n');
  write('portable/README.md', `release ${source}\n`);
  writeFileSync(join(directory, 'release-manifest.json'), JSON.stringify({ version: 1, source, protocol: 1, runtime: '0.162.1', nodeMajor: 24, platform: 'linux', arch: 'x64', executionEnabled: false, files }));
  return directory;
}

/**
 * A production-shaped installation driven by FakeSystemd: the stand-in service
 * plays the backend (real maintenance drain, writer checks, /healthz, claimed
 * SIGTERM shutdown) from the OLD release directory with TimeoutStopSec=infinity,
 * exactly like the 2026-10-14 drop-in.
 */
export async function installation(t, { targetHealthy = true, activatingMs = 0, busyBot = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dpl-'));
  chmodSync(root, 0o700);
  const units = join(root, 'units'), hubDir = join(root, 'live/hub'), agentDir = join(root, 'live/agent'), configDir = join(root, 'config');
  for (const d of [units, hubDir, agentDir, configDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const oldRelease = release(root, OLD), newRelease = release(root, NEW, { healthy: targetHealthy });
  const nativeBinary = join(root, 'native/codex'); mkdirSync(join(root, 'native')); copyFileSync('/bin/sleep', nativeBinary); chmodSync(nativeBinary, 0o700);
  const nativeSHA = sha256(readFileSync(nativeBinary));
  const writer = { writerId: 'migration:test-writer', epoch: 1 };
  savePrivate(join(root, 'activations', OLD, 'hub-activation.json'), JSON.stringify({ kind: 'portable-hub-activation', executionEnabled: true, ...writer, source: OLD }) + '\n');
  savePrivate(join(root, 'activations', OLD, 'agent-activation.json'), JSON.stringify({ kind: 'portable-agent-activation', executionEnabled: true, nodeId: 'node:test', runtime: '0.162.1', source: OLD }) + '\n');
  const control = new DatabaseSync(join(hubDir, 'control.sqlite'));
  control.exec(`CREATE TABLE portable_authority(id INTEGER PRIMARY KEY CHECK(id=1), writer_id TEXT NOT NULL, epoch INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE portable_async_admission(id INTEGER PRIMARY KEY CHECK(id=1),writer_id TEXT NOT NULL,epoch INTEGER NOT NULL,source TEXT NOT NULL,phase TEXT NOT NULL,generation INTEGER NOT NULL,operation_id TEXT,deadline INTEGER NOT NULL);
    CREATE TABLE portable_async_work(id TEXT PRIMARY KEY,writer_id TEXT NOT NULL,epoch INTEGER NOT NULL,source TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL,pid INTEGER NOT NULL);
    CREATE TABLE portable_async_drains(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,deadline INTEGER NOT NULL,state TEXT NOT NULL);`);
  control.prepare('INSERT INTO portable_authority VALUES(1,?,?,0)').run(writer.writerId, writer.epoch);
  control.prepare("INSERT INTO portable_async_admission VALUES(1,?,?,?,'open',0,NULL,0)").run(writer.writerId, writer.epoch, OLD);
  control.close();
  const application = new DatabaseSync(join(hubDir, 'application.sqlite')); application.exec('CREATE TABLE todos(id TEXT PRIMARY KEY); INSERT INTO todos VALUES(\'kept\')'); application.close();
  const store = new Store(join(agentDir, 'native-control.sqlite'));
  if (busyBot) store.saveBot({ id: 'busy-bot', slug: 'busy', name: 'Busy', threadId: 'thread-busy', status: 'running', activeTurnId: 'turn-1' });
  store.close();
  const ports = { gatewayPort: await freePort(), sitePort: await freePort(), healthPort: await freePort() };
  const hubConfig = join(configDir, 'hub.json'), agentConfig = join(configDir, 'agent.json');
  savePrivate(hubConfig, JSON.stringify({ version: 1, mode: 'both', dataDirectory: hubDir, agentConfigFile: agentConfig, ...ports, externalSite: true,
    backendReleaseDirectory: oldRelease, publicOrigin: 'https://work.example.test', owner: { key: 'owner' },
    hub: { source: OLD, activationReceipt: join(root, 'activations', OLD, 'hub-activation.json') } }, null, 2) + '\n');
  savePrivate(agentConfig, JSON.stringify({ version: 1, mode: 'agent', dataDirectory: agentDir, agent: { codexBinary: nativeBinary, codexBinarySHA256: nativeSHA,
    workspaces: join(root, 'bots'), nodeId: 'node:test', centralRouting: true, loopbackHubPort: ports.gatewayPort,
    activationReceipt: join(root, 'activations', OLD, 'agent-activation.json') } }, null, 2) + '\n');
  savePrivate(join(configDir, 'rehearsal.json'), JSON.stringify({ models: MODELS }) + '\n');
  savePrivate(join(units, UNIT), `[Unit]\nDescription=test backend\n\n[Service]\nType=simple\nEnvironment=BOTS_MACHINE_SECRET=${randomBytes(32).toString('hex')}\nEnvironment=DAWAR_HUB_CONFIG=${hubConfig}\nKillMode=mixed\n`);
  const dropIn = join(units, `${UNIT}.d`, '90-portable-migration.conf');
  savePrivate(dropIn, `[Unit]\n[Service]\nWorkingDirectory=${oldRelease}\nExecStart=\nExecStart=${process.execPath} ${STAND_IN} --native-child --release ${oldRelease} --config ${hubConfig}\nRestart=on-failure\nUMask=0077\nKillMode=mixed\nTimeoutStopSec=infinity\n`);
  const systemd = new FakeSystemd({ unitDirectory: units, log: join(root, 'services.log') });
  t.after(() => { systemd.close(); if (!process.env.KEEP_DEPLOY_FIXTURE) rmSync(root, { recursive: true, force: true }); });
  await systemd.systemctl('start', '--no-block', UNIT);
  const probe = linuxProbe({ systemctl: systemd.systemctl });
  await until(async () => (await probe.health(ports.healthPort).catch(() => ({}))).ready === true, 15000, () => readFileSync(join(root, 'services.log'), 'utf8'));
  systemd.activatingMs = activatingMs;
  return { root, units, hubDir, agentDir, hubConfig, agentConfig, dropIn, ports, systemd, probe, oldRelease, newRelease, nativeSHA,
    log: () => existsSync(join(root, 'services.log')) ? readFileSync(join(root, 'services.log'), 'utf8') : '',
    writer: () => { const db = new DatabaseSync(join(hubDir, 'control.sqlite'), { readOnly: true }); try { return db.prepare('SELECT * FROM portable_async_admission').get(); } finally { db.close(); } },
    hash: path => sha256(readFileSync(path)) };
}
export async function until(test, ms, detail = () => '') {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await test()) return; await pause(100); }
  throw Error(`Timed out. ${detail().slice(-2000)}`);
}
