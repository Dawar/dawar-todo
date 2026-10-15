import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readPrivate, savePrivate } from './private-file.mjs';
import { convergenceDefaults } from './deployment-transaction.mjs';

const exec = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => sha256(readFileSync(path));
const sha = /^[a-f0-9]{40}$/;
export const DEFAULT_UNIT = 'dawar-todo-bots.service';
export const DEFAULT_SITE_UNIT = 'dawar-portable-site.service';
export const DEFAULT_TIMEOUT_STOP_SEC = 120;
const MAX_TIMEOUT_STOP_SEC = 600;

/** A failed plan check names the field and both values, never a secret. */
export class PlanMismatch extends Error {
  constructor(mismatches) {
    super(`Plan differs from live state: ${mismatches.map(m => `${m.field} (${m.message})`).join('; ')}`.slice(0, 900));
    this.mismatches = mismatches; this.deploymentBlocked = true;
  }
}
const refuse = (field, message) => { throw new PlanMismatch([{ field, message }]); };
const short = value => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text === undefined ? 'absent' : text.length > 80 ? `${text.slice(0, 77)}...` : text; };

// --- Release substitution -------------------------------------------------
// Prepared configs are the LIVE configs with only the release changed. Each
// derivation re-checks that nothing else differs.
export function deriveHubConfig(before, { source, releasesRoot, activationsRoot }) {
  const after = structuredClone(before);
  if (after.backendReleaseDirectory !== undefined) after.backendReleaseDirectory = join(releasesRoot, source);
  after.hub = { ...after.hub, source, activationReceipt: join(activationsRoot, source, 'hub-activation.json') };
  onlyChanged(before, after, ['backendReleaseDirectory', 'hub.source', 'hub.activationReceipt'], 'hub config');
  return after;
}
export function deriveAgentConfig(before, { source, activationsRoot }) {
  const after = structuredClone(before);
  after.agent = { ...after.agent, activationReceipt: join(activationsRoot, source, 'agent-activation.json') };
  onlyChanged(before, after, ['agent.activationReceipt'], 'agent config');
  return after;
}
const releasePattern = root => new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[a-f0-9]{40}(?=[/\\s"']|$)`, 'g');
export function deriveDropIn(text, { source, releasesRoot, timeoutStopSec }) {
  if (!Number.isSafeInteger(timeoutStopSec) || timeoutStopSec < 10 || timeoutStopSec > MAX_TIMEOUT_STOP_SEC) refuse('timeoutStopSec', `must be 10-${MAX_TIMEOUT_STOP_SEC} seconds`);
  const lines = text.split('\n');
  let sawTimeout = false;
  const out = lines.map(line => {
    if (/^\s*TimeoutStopSec\s*=/.test(line)) { sawTimeout = true; return `TimeoutStopSec=${timeoutStopSec}`; }
    return line.replace(releasePattern(releasesRoot), join(releasesRoot, source));
  });
  // A finite stop deadline belongs to the release drop-in so the unit can
  // never again sit in stop-sigterm indefinitely.
  if (!sawTimeout) {
    const service = out.findIndex(line => line.trim() === '[Service]');
    if (service < 0) refuse('dropIn', 'release drop-in has no [Service] section');
    out.splice(service + 1, 0, `TimeoutStopSec=${timeoutStopSec}`);
  }
  const before = lines.filter(l => !/^\s*TimeoutStopSec\s*=/.test(l)), after = out.filter(l => !/^\s*TimeoutStopSec\s*=/.test(l));
  if (before.length !== after.length) refuse('dropIn', 'derivation changed the line structure');
  before.forEach((line, i) => { if (line !== after[i] && !/^\s*(WorkingDirectory|ExecStart)\s*=/.test(line)) refuse('dropIn', `only WorkingDirectory/ExecStart may change, not "${short(line)}"`); });
  if (!out.some(line => line.includes(join(releasesRoot, source)))) refuse('dropIn', 'drop-in does not name a backend release');
  return out.join('\n');
}
function onlyChanged(before, after, allowed, label) {
  const walk = (a, b, path) => {
    if (allowed.includes(path)) return;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path ? `${path}.${key}` : key);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) refuse(label, `derivation changed ${path}`);
  };
  walk(before, after, '');
}
const jsonText = value => JSON.stringify(value, null, 2) + '\n';

// --- Live observation -----------------------------------------------------
export function linuxProbe({ systemctl = async (...args) => (await exec('systemctl', ['--user', ...args], { timeout: 10000, maxBuffer: 65536 })).stdout } = {}) {
  const proc = (pid, name) => readFileSync(`/proc/${pid}/${name}`);
  return {
    systemctl,
    async unit(id) {
      const text = await systemctl('show', id, '--property=MainPID,InvocationID,ActiveState,SubState,ControlGroup,Job,LoadState,DropInPaths,WantedBy,RequiredBy,BoundBy,RequisiteOf,ConsistsOf');
      return Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    },
    processStart(pid) { try { const text = proc(pid, 'stat').toString(); return text.slice(text.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } },
    // Only the hub configuration path is taken from the environment.
    processConfig(pid) {
      const env = proc(pid, 'environ').toString().split('\0').find(v => v.startsWith('DAWAR_HUB_CONFIG='))?.slice(17);
      const command = proc(pid, 'cmdline').toString().split('\0').filter(Boolean), i = command.indexOf('--config');
      return { environment: env, command: i >= 0 ? command[i + 1] : undefined };
    },
    processCwd(pid) { try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; } },
    async health(port) {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5000) });
      return { http: r.status, ...await r.json() };
    },
  };
}
export function liveWriter(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { admission: db.prepare('SELECT * FROM portable_async_admission WHERE id=1').get() ?? null,
      authority: db.prepare('SELECT writer_id,epoch,frozen FROM portable_authority WHERE id=1').get() ?? null };
  } finally { db.close(); }
}

/**
 * Everything a plan says about the world, read from the world. prepare writes
 * it; preflight reads it again and requires every field to be identical.
 */
export async function discover(probe, { source, unitId = DEFAULT_UNIT, siteUnitId = DEFAULT_SITE_UNIT, site: wantSite, waitSeconds = 900, timeoutStopSec = DEFAULT_TIMEOUT_STOP_SEC, convergence: chosen = {}, rehearsal = false }) {
  if (!sha.test(source ?? '')) refuse('source', 'a full 40-character release SHA is required');
  // Convergence windows are plan policy, not live state; the stop window must
  // outlast the unit's finite TimeoutStopSec.
  const convergence = { ...convergenceDefaults, stopWindowSeconds: timeoutStopSec + 60, ...chosen };
  if (convergence.stopWindowSeconds < timeoutStopSec + 30) refuse('convergence.stopWindowSeconds', `must exceed TimeoutStopSec ${timeoutStopSec} by 30 seconds`);
  const u = await probe.unit(unitId), pid = Number(u.MainPID);
  if (u.ActiveState !== 'active' || !(pid > 0)) refuse('unitId', `${unitId} is ${u.ActiveState ?? 'unknown'} with MainPID ${u.MainPID ?? 'absent'}`);
  // A unit that pulls the backend in (e.g. the front with Wants=) can start
  // the previous release while the controller waits for the old exit.
  const pullers = ['WantedBy', 'RequiredBy', 'BoundBy', 'RequisiteOf', 'ConsistsOf'].flatMap(key => String(u[key] ?? '').split(/\s+/).filter(Boolean).map(name => `${key}=${name}`))
    .filter(entry => !entry.endsWith('.target'));
  if (pullers.length) refuse('unitId', `${unitId} is pulled in by ${pullers.join(', ')}; restarting those units would start it outside the controller`);
  const start = probe.processStart(pid);
  if (!start) refuse('old.start', `process ${pid} identity unavailable`);
  const { environment, command } = probe.processConfig(pid);
  if (environment && command && environment !== command) refuse('currentHubConfigPath', 'service environment and command name different hub configs');
  const currentHubConfigPath = environment ?? command;
  if (!isAbsolute(currentHubConfigPath ?? '')) refuse('currentHubConfigPath', 'the live process names no absolute hub config');
  const hub = JSON.parse(readPrivate(currentHubConfigPath)), agentPath = hub.agentConfigFile;
  if (!isAbsolute(agentPath ?? '')) refuse('files', 'hub config names no agent config');
  const agent = JSON.parse(readPrivate(agentPath));
  const healthPort = hub.healthPort ?? 47821, h = await probe.health(healthPort);
  if (h.http !== 200 || !h.ready) refuse('old.health', `live health is ${h.http} ready=${Boolean(h.ready)}`);
  if (h.maintenance?.phase !== 'open') refuse('old.maintenance', `live maintenance is ${h.maintenance?.phase ?? 'unknown'}`);
  if (h.source !== hub.hub?.source) refuse('old.source', `live health ${short(h.source)} differs from hub config ${short(hub.hub?.source)}`);
  if (h.source === source) refuse('source', 'target is already the live release');
  const writerPath = join(hub.dataDirectory, 'control.sqlite'), w = liveWriter(writerPath);
  if (!w.admission || w.admission.phase !== 'open' || w.admission.operation_id !== null) refuse('localWriter.expected', `live writer admission is ${w.admission?.phase ?? 'absent'}`);
  if (!w.authority || w.authority.writer_id !== w.admission.writer_id || w.authority.epoch !== w.admission.epoch || w.authority.frozen !== 0) refuse('localWriter.expected', 'live writer authority differs from its admission row or is frozen');
  if (w.admission.source !== h.source) refuse('localWriter.expected.source', `live writer row ${short(w.admission.source)} differs from live health ${short(h.source)}`);
  const cwd = probe.processCwd(pid);
  if (!cwd) refuse('releaseDirectory', 'live process release directory unavailable');
  const releasesRoot = dirname(cwd), releaseDirectory = join(releasesRoot, source), manifestPath = join(releaseDirectory, 'release-manifest.json');
  if (!existsSync(manifestPath)) refuse('releaseDirectory', `${releaseDirectory} has no release-manifest.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.source !== source || manifest.nodeMajor !== 24 || !/^\d+\.\d+\.\d+$/.test(manifest.runtime ?? '')) refuse('manifestSHA256', 'target manifest source/runtime/node differs');
  const manifestSHA256 = fileHash(manifestPath);
  const activationsRoot = dirname(dirname(hub.hub.activationReceipt ?? '/'));
  const nativeBinaryPath = agent.agent?.codexBinary;
  if (!isAbsolute(nativeBinaryPath ?? '') || !existsSync(nativeBinaryPath)) refuse('nativeBinaryPath', 'agent config names no native binary');
  const nativeBinarySHA256 = fileHash(nativeBinaryPath);
  if (agent.agent.codexBinarySHA256 && agent.agent.codexBinarySHA256 !== nativeBinarySHA256) refuse('nativeBinarySHA256', 'native binary differs from the agent config hash');
  // Activations: target receipts derived from the live ones.
  const liveAgentActivation = JSON.parse(readPrivate(agent.agent.activationReceipt, 16384));
  const activationContent = {
    hub: { kind: 'portable-hub-activation', executionEnabled: true, writerId: w.admission.writer_id, epoch: w.admission.epoch, source },
    agent: { kind: 'portable-agent-activation', executionEnabled: true, nodeId: liveAgentActivation.nodeId, runtime: manifest.runtime, source, releaseManifestSHA256: manifestSHA256, codexBinarySHA256: nativeBinarySHA256 },
  };
  const activations = {};
  for (const kind of ['hub', 'agent']) {
    const path = join(activationsRoot, source, `${kind}-activation.json`), text = JSON.stringify(activationContent[kind]) + '\n';
    if (existsSync(path)) {
      const actual = JSON.parse(readPrivate(path, 16384));
      for (const [key, value] of Object.entries(activationContent[kind])) if (actual[key] !== value) refuse(`activations.${kind}.${key}`, `existing ${short(actual[key])}, live-derived ${short(value)}`);
      activations[kind] = { path, sha256: fileHash(path) };
    } else activations[kind] = { path, sha256: sha256(text), create: text };
  }
  // The release drop-in is the one naming a backend release.
  const dropIns = String(u.DropInPaths ?? '').split(/\s+/).filter(Boolean).filter(path => existsSync(path) && readFileSync(path, 'utf8').includes(`${releasesRoot}/`));
  if (dropIns.length !== 1) refuse('files', `expected exactly one release drop-in for ${unitId}, found ${dropIns.length}`);
  const prepared = {
    hub: jsonText(deriveHubConfig(hub, { source, releasesRoot, activationsRoot })),
    agent: jsonText(deriveAgentConfig(agent, { source, activationsRoot })),
    dropIn: deriveDropIn(readFileSync(dropIns[0], 'utf8'), { source, releasesRoot, timeoutStopSec }),
  };
  const files = [[currentHubConfigPath, prepared.hub], [agentPath, prepared.agent], [dropIns[0], prepared.dropIn]]
    .map(([path, text]) => ({ path, beforeSHA256: fileHash(path), afterSHA256: sha256(text), prepared: text }));
  const databases = [hub.dataDirectory, agent.dataDirectory].flatMap(d => readdirSync(d).filter(n => n.endsWith('.sqlite')).sort().map(n => join(d, n)));
  let site;
  const s = siteUnitId ? await probe.unit(siteUnitId) : null;
  if (wantSite === true && s?.ActiveState !== 'active') refuse('site', `${siteUnitId} is not active`);
  if (wantSite !== false && s?.LoadState === 'loaded' && s.ActiveState === 'active' && Number(s.MainPID) > 0)
    site = { unitId: siteUnitId, oldPid: Number(s.MainPID), oldStart: probe.processStart(Number(s.MainPID)), oldInvocationId: s.InvocationID };
  const models = [...(h.models ?? [])];
  if (!models.length) refuse('expectedModels', 'live health reports no models');
  return {
    version: 1, kind: 'portable-deployment', source, runtime: manifest.runtime, waitSeconds,
    unitId, releaseDirectory, manifestSHA256, managerSocket: join(agent.dataDirectory, 'manager', 'manager.sock'),
    nativeBinaryPath, nativeBinarySHA256, expectedModels: models, healthPort,
    old: { pid, start, invocationId: u.InvocationID, source: h.source, controlGroup: u.ControlGroup || undefined },
    currentHubConfigPath, controllerDirectory: join(dirname(writerPath), 'deployments', unitId),
    localWriter: { path: writerPath, expected: { writerId: w.admission.writer_id, epoch: w.admission.epoch, source: w.admission.source } },
    ...(hub.retainedRecordsPath ? { retainedRecordsPath: hub.retainedRecordsPath } : {}),
    databases, files, activations, timeoutStopSec,
    convergence,
    ...(site ? { site } : {}), ...(rehearsal ? { rehearsal: true } : {}),
  };
}

const instanceFields = ['operationId', 'controllerUnitId', 'receiptDirectory', 'featureAuthority'];
const comparable = plan => {
  const copy = Object.fromEntries(Object.entries(plan).filter(([key]) => !instanceFields.includes(key)));
  copy.files = plan.files?.map(({ path, beforeSHA256, afterSHA256 }) => ({ path, beforeSHA256, afterSHA256 }));
  copy.activations = plan.activations && Object.fromEntries(Object.entries(plan.activations).map(([k, v]) => [k, { path: v.path, sha256: v.sha256 }]));
  return JSON.parse(JSON.stringify(copy));
};
function differences(expected, actual, path = '', out = []) {
  if (expected && actual && typeof expected === 'object' && typeof actual === 'object') {
    const keys = Array.isArray(expected) && Array.isArray(actual) && expected.length !== actual.length ? null : new Set([...Object.keys(expected), ...Object.keys(actual)]);
    if (!keys) out.push({ field: path, message: `plan has ${expected.length} entries, live ${actual.length}` });
    else for (const key of keys) differences(expected[key], actual[key], Array.isArray(expected) ? `${path}[${key}]` : path ? `${path}.${key}` : key, out);
  } else if (JSON.stringify(expected) !== JSON.stringify(actual)) out.push({ field: path, message: `plan ${short(expected)}, live ${short(actual)}` });
  return out;
}

/** Preflight: every plan field must equal a fresh observation of live state. */
export async function verifyPlan(spec, probe) {
  const mismatches = [];
  if (!/^[A-Za-z0-9:_-]{10,180}$/.test(spec.operationId ?? '')) mismatches.push({ field: 'operationId', message: 'invalid' });
  if (!/^[A-Za-z0-9_-]{8,100}\.service$/.test(spec.controllerUnitId ?? '')) mismatches.push({ field: 'controllerUnitId', message: 'invalid' });
  if (!isAbsolute(spec.receiptDirectory ?? '')) mismatches.push({ field: 'receiptDirectory', message: 'must be absolute' });
  let live;
  try {
    live = await discover(probe, { source: spec.source, unitId: spec.unitId, siteUnitId: spec.site?.unitId ?? null, site: Boolean(spec.site),
      waitSeconds: spec.waitSeconds, timeoutStopSec: spec.timeoutStopSec, convergence: spec.convergence, rehearsal: spec.rehearsal === true });
  } catch (error) {
    if (error instanceof PlanMismatch) throw new PlanMismatch([...mismatches, ...error.mismatches]);
    throw new PlanMismatch([...mismatches, { field: 'live', message: String(error.message).slice(0, 200) }]);
  }
  mismatches.push(...differences(comparable(spec), comparable(live)));
  for (const [i, file] of (spec.files ?? []).entries()) {
    if (!isAbsolute(file.preparedPath ?? '') || !existsSync(file.preparedPath)) { mismatches.push({ field: `files[${i}].preparedPath`, message: 'missing' }); continue; }
    if (fileHash(file.preparedPath) !== file.afterSHA256) mismatches.push({ field: `files[${i}].preparedPath`, message: 'content differs from afterSHA256' });
    if (live.files[i] && live.files[i].prepared !== readFileSync(file.preparedPath, 'utf8')) mismatches.push({ field: `files[${i}].preparedPath`, message: 'not the live config with only the release substituted' });
  }
  for (const [kind, a] of Object.entries(spec.activations ?? {}))
    if (!existsSync(a.path) || fileHash(a.path) !== a.sha256) mismatches.push({ field: `activations.${kind}`, message: 'target activation receipt missing or changed' });
  const controller = spec.controllerUnitId && await probe.unit(spec.controllerUnitId).catch(() => null);
  if (controller && !['inactive', undefined, ''].includes(controller.ActiveState)) mismatches.push({ field: 'controllerUnitId', message: `${spec.controllerUnitId} is already ${controller.ActiveState}` });
  if (mismatches.length) throw new PlanMismatch(mismatches);
  return { verified: true, fields: Object.keys(comparable(spec)).length };
}

const timestamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '');
/** `deploy prepare <sha>`: the whole private plan, generated from live state, then preflighted. */
export async function preparePlan(probe, { source, receiptRoot, now = new Date(), ...options }) {
  const live = await discover(probe, { source, ...options });
  const id = `${source.slice(0, 12)}-${timestamp(now)}`;
  const receiptDirectory = join(receiptRoot ?? join(dirname(dirname(live.releaseDirectory)), 'deployments'), id);
  if (existsSync(receiptDirectory)) refuse('receiptDirectory', `${receiptDirectory} already exists`);
  const plan = { ...live, operationId: `deploy-${id}`, controllerUnitId: `dawar-deploy-${id}.service`, receiptDirectory,
    files: live.files.map(({ path, beforeSHA256, afterSHA256 }) => ({ path, beforeSHA256, afterSHA256, preparedPath: join(receiptDirectory, `${basename(path)}.prepared`) })),
    activations: Object.fromEntries(Object.entries(live.activations).map(([kind, { path, sha256: digest }]) => [kind, { path, sha256: digest }])) };
  for (const [i, file] of live.files.entries()) savePrivate(plan.files[i].preparedPath, file.prepared, { exclusive: true });
  // Target activations are new files beside the live ones; existing ones were
  // validated field by field in discover().
  for (const a of Object.values(live.activations)) if (a.create) savePrivate(a.path, a.create, { exclusive: true });
  const planPath = join(receiptDirectory, 'plan.private.json');
  savePrivate(planPath, JSON.stringify(plan, null, 2) + '\n', { exclusive: true });
  try { await verifyPlan(plan, probe); }
  catch (error) { savePrivate(join(receiptDirectory, 'preflight-failure.json'), JSON.stringify({ at: new Date().toISOString(), mismatches: error.mismatches ?? [{ field: 'live', message: String(error.message).slice(0, 300) }] }, null, 2) + '\n'); throw error; }
  return { planPath, plan };
}
