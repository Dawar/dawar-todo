// Deploy rehearsal stand-in. Runs under a temporary unit against COPIES of the
// databases and configs and answers exactly the surfaces the deploy controller
// uses: /healthz, the owner maintenance socket and SIGTERM shutdown. It runs no
// gateway, scheduler, voice, relay, Codex/Claude or bot work, so a rehearsal can
// never reach users, phones or bots.
//
// `run both` (default) stands in for the combined process; `run hub` and
// `run agent` for the separate hub and runner (SPLIT_HUB_RUNNER.md): the hub
// has the writer checks and no manager socket, the runner has the maintenance
// socket and native child and no hub writer.
//
// What is real: the hub activation and writer checks the hub makes at start
// (source-bound writer row, frozen authority), RuntimeMaintenance and its
// drain counts over the copied native-control store, the claimed-shutdown
// proof, closing keep-alive connections, and loading the release's gateway
// and agent modules. What is simulated: native thread idleness (no Codex is
// started) and relay/site readiness.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readPrivate } from './private-file.mjs';
import { hubActivation } from './hub-authority.mjs';
import { closeHttpServer } from './close-http.mjs';
import { Store } from '../bot-bridge/store.mjs';
import { RuntimeMaintenance } from '../bot-bridge/runtime-maintenance.mjs';
import { maintenanceReason } from '../bot-bridge/maintenance-reason.mjs';

// Static imports resolve before this line: `--help` proves a packaged
// release can load the stand-in (portable/package.mjs runs it).
if (process.argv.includes('--help')) { console.log('rehearsal-service.mjs [run both|hub|agent] --release RELEASE_DIRECTORY --config REHEARSAL_CONFIG [--native-child]'); process.exit(0); }
const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const role = args[0] === 'run' ? args[1] : 'both';
if (!['both', 'hub', 'agent'].includes(role)) throw Error(`Unknown rehearsal role ${role}.`);
const configPath = option('--config'), release = option('--release') ?? process.cwd();
const own = JSON.parse(readPrivate(configPath));
const c = role === 'agent' ? null : own, a = role === 'agent' ? own : role === 'both' ? JSON.parse(readPrivate(c.agentConfigFile)) : null;
const rehearsal = JSON.parse(readPrivate(join(dirname(configPath), 'rehearsal.json')));
const manifest = JSON.parse(readFileSync(join(release, 'release-manifest.json'), 'utf8'));
process.umask(0o077);

// The hub reads its writer row on every write, so readiness re-checks it.
const writerProblems = () => {
  const found = [];
  try {
    const activation = hubActivation(c);
    const db = new DatabaseSync(join(c.dataDirectory, 'control.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT * FROM portable_async_admission WHERE id=1').get(), authority = db.prepare('SELECT * FROM portable_authority WHERE id=1').get();
      if (row?.source !== c.hub.source) found.push(`hub writer source is ${row?.source}, config is ${c.hub.source}`);
      if (row?.phase !== 'open' || authority?.frozen !== 0) found.push(`hub writer is ${row?.phase} frozen=${authority?.frozen}`);
      if (authority?.writer_id !== activation?.writerId || authority?.epoch !== activation?.epoch) found.push('hub writer differs from activation');
    } finally { db.close(); }
  } catch (error) { found.push(`hub activation: ${error.message}`); }
  return found;
};
const problems = [];
if (c && c.mode !== role) problems.push(`config mode ${c.mode} cannot run ${role}`);
if (a && a.mode !== 'agent') problems.push(`agent config mode ${a.mode}`);
// The runner reports its own release: the source its activation names.
const agentSource = role === 'agent' ? (() => {
  try {
    const activation = JSON.parse(readPrivate(a.agent.activationReceipt, 16384));
    if (activation.source !== manifest.source) problems.push(`agent activation ${activation.source} differs from release ${manifest.source}`);
    return activation.source;
  } catch (error) { problems.push(`agent activation: ${error.message}`); return null; }
})() : null;
const modules = { both: ['dist/portable/gateway.mjs', 'bot-bridge/portable-agent.mjs'], hub: ['dist/portable/gateway.mjs'], agent: ['bot-bridge/portable-agent.mjs'] }[role];
for (const entry of modules) {
  const path = join(release, entry);
  // A runner release must carry the agent bundle; older combined releases may not.
  if (!existsSync(path)) { if (entry.startsWith('dist/') || role === 'agent') problems.push(`release lacks ${entry}`); continue; }
  try { await import(pathToFileURL(path).href); } catch (error) { problems.push(`release ${entry} failed to load: ${String(error.message).slice(0, 120)}`); }
}

// Test fixtures stand in for the native runtime with an inert child of the
// configured binary so the controller's native-process proof is exercised.
const native = a && args.includes('--native-child') ? spawn(a.agent.codexBinary, ['3600'], { stdio: 'ignore' }) : null;
let store = null, runtime = null, manager = null;
if (a) {
  store = new Store(join(a.dataDirectory, 'native-control.sqlite'));
  runtime = { store, epoch: randomUUID(), emitEvent() {}, codex: { pending: new Map(), async call(method) {
    if (method === 'thread/loaded/list') return { data: [], nextCursor: null };
    throw Error('The rehearsal runs no native threads.');
  } } };
  runtime.maintenance = new RuntimeMaintenance(runtime, { source: () => {}, invocation: process.env.INVOCATION_ID ?? null });
  const secret = process.env.BOTS_MACHINE_SECRET ?? '';
  const socketPath = join(a.dataDirectory, 'manager', 'manager.sock');
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  try { unlinkSync(socketPath); } catch { /* absent */ }
  manager = createServer(async (req, res) => {
    const reply = (status, data) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (req.url !== '/runtime/maintenance' || req.method !== 'POST' || !secret || Buffer.byteLength(token) !== Buffer.byteLength(secret) || !timingSafeEqual(Buffer.from(token), Buffer.from(secret)))
      return reply(403, { error: 'Owner maintenance authentication required.' });
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      reply(200, { result: await runtime.maintenance.control(JSON.parse(Buffer.concat(chunks))) });
    } catch (error) { reply(409, { error: 'Maintenance blocked or identity changed.', reason: maintenanceReason(error) }); }
  });
  manager.listen(socketPath);
}

// Relay and site readiness are simulated; `nodes` is the rehearsal's own list.
const health = createServer((req, res) => {
  if (req.url !== '/healthz') return void res.writeHead(404).end();
  const current = [...problems, ...(c && !runtime?.maintenance.current ? writerProblems() : [])];
  const ready = current.length === 0;
  const body = role === 'hub'
    ? { ready, role: 'hub', siteReady: true, source: c.hub.source, writer: { ready }, voice: { enabled: false, idle: true }, nodes: rehearsal.nodes ?? [], relayConnected: (rehearsal.nodes ?? []).length > 0 }
    : { ready, relayConnected: true, ...(role === 'both' ? { siteReady: true } : {}), source: role === 'agent' ? agentSource : c.hub.source, codexVersion: manifest.runtime,
      role: role === 'agent' ? 'runner' : 'both', models: rehearsal.models, maintenance: runtime.maintenance.snapshot() };
  res.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ...body, rehearsal: true, problems: current }));
});
health.listen(role === 'agent' ? a.agent.healthPort : c.healthPort, '127.0.0.1');

let closing;
process.on('SIGTERM', () => {
  closing ??= (async () => {
    // Same rule as production: only an unexpired claimed drain may stop a
    // native owner; the hub has no native work to prove idle.
    if (runtime) { await runtime.maintenance.prepareShutdown(); runtime.shutdownStarted = true; }
    await Promise.all([closeHttpServer(health), ...(manager ? [closeHttpServer(manager)] : [])]);
    runtime?.maintenance.close(); store?.close(); native?.kill('SIGKILL');
    process.exit(0);
  })().catch(error => { closing = null; console.error(`Rehearsal shutdown refused: ${error.message}`); });
});
