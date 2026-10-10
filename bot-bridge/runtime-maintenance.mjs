import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { passiveLegacyManagerRejections } from './legacy-manager-rejections.mjs';
import { MaintenanceTerminalProof } from './maintenance-terminal-proof.mjs';

const processStart = pid => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
const processAlive = identity => Boolean(identity?.start && processStart(identity.pid) === identity.start);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const phases = new Set(['draining', 'sealed', 'claimed']);
const stamp = ms => new Date(ms).toISOString();
const denied = () => Object.assign(Error('A bounded runtime update is in progress. Your input was not submitted; retain it and retry after maintenance ends.'), { outcome: 'rejected', maintenance: true });
const starts = new Set(['turn/start', 'thread/start', 'thread/fork', 'thread/resume', 'thread/queue/add', 'thread/queue/start', 'thread/compact/start']);
const direct = new Set(['turn.send', 'queue.send', 'bots.create', 'bots.recover', 'thread.compact', 'runs.send', 'runs.resume', 'runs.decide']);

/** Local owner maintenance only. No bot tool or browser-supplied authority. */
export class RuntimeMaintenance {
  constructor(runtime, { clock = Date.now, monotonic = () => performance.now(), source = checkSource, invocation = process.env.INVOCATION_ID ?? null, alive = processAlive, terminalProof = new MaintenanceTerminalProof(runtime.store) } = {}) {
    Object.assign(this, { runtime, store: runtime.store, clock, monotonic, source, invocation });
    this.scope = new AsyncLocalStorage(); this.admissions = 0; this.requests = 0; this.generation = 0;
    this.terminalProof = terminalProof;
    // A dead process cannot retain an admission fence. Preserve its original
    // receipt; never renew, replay, or infer that a claimed restart succeeded.
    for (const row of this.store.list('runtimeMaintenance')) if (phases.has(row.phase)) {
      if (!row.processIdentity || alive(row.processIdentity)) throw Error('The original maintenance owner may still be alive. Do not start a competing bridge.');
      this.store.put('runtimeMaintenance', { ...row, phase: 'process-ended', endedAt: stamp(clock()), reason: 'Previous process ended; inspect the original restart receipt.' });
    }
    this.timer = setInterval(() => this.expire(), 1000); this.timer.unref();
  }
  close() { clearInterval(this.timer); }
  expire() {
    if (this.current && (this.current.expiresAtMs <= this.clock() || this.monotonic() >= this.currentDeadline)) this.end('expired', 'The bounded maintenance deadline elapsed. No further restart is authorized by this lease.');
  }
  holding() { this.expire(); return Boolean(this.current); }
  snapshot() {
    this.expire();
    const row = this.current;
    return { version: 1, instanceId: this.runtime.epoch, invocationId: this.invocation,
      ...(row ? { operationId: row.id, phase: row.phase, commit: row.commit, expiresAt: stamp(row.expiresAtMs), reason: row.reason ?? null } : { phase: 'open' }),
      admissions: this.admissions, requests: this.requests };
  }
  end(phase, reason) {
    const row = this.current; if (!row) return;
    this.current = null; this.proof = null; this.passiveProof = null;
    try { this.store.put('runtimeMaintenance', { ...row, phase, reason, endedAt: stamp(this.clock()) }); }
    catch (error) { this.runtime.emit?.('fault', error); } // an expired RAM fence cannot trap human input
    this.runtime.emitEvent?.('runtime', { maintenance: this.snapshot() });
  }
  async admit(fn) {
    const parent = this.scope.getStore();
    if (parent?.open) return fn();
    if (this.holding()) throw denied();
    return this.permit(fn);
  }
  // Called only after canonical question ownership/input validation. An answer
  // finishes already accepted work; it cannot create a new ordinary admission.
  async continueInput(fn) {
    if (this.holding() && this.current.phase !== 'draining') throw denied();
    return this.permit(fn);
  }
  async permit(fn) {
    const parent = this.scope.getStore(); if (parent?.open) return fn();
    const permit = { open: true }; this.admissions++;
    try { return await this.scope.run(permit, fn); }
    finally { permit.open = false; this.admissions--; }
  }
  native(method, params = {}) {
    if (this.holding() && (starts.has(method) || method === 'thread/goal/set' && (params.objective !== undefined || params.status === 'active')) && !this.scope.getStore()?.open) throw denied();
  }
  async track(fn) {
    if (this.holding() && this.current.phase !== 'draining') throw denied();
    this.requests++;
    try { return await fn(); } finally { this.requests--; }
  }
  async handle(request, origin, fn) {
    return this.track(() => {
      const { method, botId, params = {}, operationId } = request;
      // Existing receipts are read/reconciled, not replayed. Inner code still
      // validates fingerprint/provenance; the native guard remains in force.
      if (operationId && this.store.operation(operationId)) return fn();
      const admission = direct.has(method) || method === 'queue.add' && !this.runtime.primary.single(this.store.bot(botId)) ||
        method === 'goals.set' && (params.objective !== undefined || params.status === 'active');
      return admission ? this.admit(fn) : fn();
    });
  }
  counts() {
    const count = sql => this.store.db.prepare(sql).get().n;
    const bots = this.store.bots();
    const counts = {
      admissions: this.admissions, requests: this.requests, nativeRpc: this.runtime.codex.pending?.size ?? 0,
      localActive: bots.filter(b => b.activeTurnId || b.status === 'running').length,
      auxiliaryActive: count("SELECT count(*) n FROM records WHERE kind IN ('runLane','managerWorker','collaborationContext') AND (json_extract(json,'$.activeTurnId') IS NOT NULL OR json_extract(json,'$.status')='running')"),
      acceptedOrUnknown: count("SELECT count(*) n FROM records WHERE (kind='primaryInbox' AND json_extract(json,'$.state') IN ('dispatching','uncertain','accepted') AND json_extract(json,'$.terminalStatus') IS NULL) OR (kind IN ('messageBurst','burstBatch') AND json_extract(json,'$.state') IN ('dispatching','uncertain')) OR (kind='promptQueue' AND json_extract(json,'$.state') IN ('dispatching','uncertain','native-queued')) OR (kind IN ('runIntake','answerExecution','managerOperation','managerExecution') AND json_extract(json,'$.state') IN ('dispatching','uncertain')) OR (kind='managerTask' AND json_extract(json,'$.state') IN ('starting','running','uncertain','provisioning')) OR (kind='runLane' AND json_extract(json,'$.provisioning') IN ('dispatching','uncertain'))") + count("SELECT count(*) n FROM operations WHERE status IN ('dispatching','uncertain')") - passiveLegacyManagerRejections(this.store).length,
      collaborationUnknown: count("SELECT count(*) n FROM records WHERE (kind='collaborationContext' AND (json_extract(json,'$.status')='unknown' OR json_extract(json,'$.provisioning') IN ('dispatching','uncertain') OR json_extract(json,'$.releaseState') IN ('dispatching','uncertain'))) OR (kind='collaborationDelivery' AND json_extract(json,'$.state') IN ('dispatching','uncertain','accepted') AND json_extract(json,'$.terminalStatus') IS NULL) OR (kind='collaborationResource' AND json_extract(json,'$.state')<>'released') OR (kind IN ('collaborationEffect','collaborationStopGoal') AND json_extract(json,'$.state') IN ('dispatching','uncertain')) OR (kind='collaborationGoal' AND json_extract(json,'$.goal.status')='active')"),
      pendingInput: count("SELECT count(*) n FROM records WHERE kind IN ('pending','managerRequest','runPending','collaborationPending')"),
      activeGoals: count("SELECT count(*) n FROM records WHERE kind='nativeGoal' AND json_extract(json,'$.goal.status')='active'"),
      calls: count("SELECT count(*) n FROM records WHERE kind='operatorCall' AND json_extract(json,'$.endedAt') IS NULL"),
      desktops: this.runtime.desktops?.sessions.size ?? 0,
      volatileSecure: this.runtime.secure?.live.size ?? 0,
      taskRequestWork: Number(Boolean(this.runtime.taskRequests?.busy)),
      taskRequestUnknown: count("SELECT count(*) n FROM records WHERE kind='taskRequestDelivery' AND json_extract(json,'$.state') IN ('dispatching','uncertain')"),
      secureTransfers: this.runtime.secure?.transfers.size ?? 0,
      browserMaintenance: this.runtime.desktops?.browserMaintenance.size ?? 0,
      bufferedRelay: Number(this.runtime.relayBuffered?.() ?? 0),
      runtimeTick: Number(Boolean(this.runtime.tickRunning)),
      localLocks: this.runtime.locks?.size ?? 0,
      historyReads: (this.runtime.historyReads?.active ?? 0) + (this.runtime.historyReads?.pending.size ?? 0),
      browserRetention: Number(Boolean(this.runtime.desktops?.retentionBusy)),
      serviceWork: Number(this.runtime.serviceWork?.() ?? 0),
    };
    const p = this.passiveProof;
    if (p && this.current?.id === p.operationId && this.generation === p.generation &&
        this.monotonic() - p.at <= 5000 && this.terminalProof.snapshot()?.fingerprint === p.fingerprint && this.terminalProof.fresh(p.native)) {
      counts.acceptedOrUnknown -= p.native.terminalInputs.length;
      counts.pendingInput -= p.native.passiveQuestions.length;
    }
    return counts;
  }
  async qualifyPassive(deadline) {
    const counts = this.counts(), snapshot = this.terminalProof.snapshot();
    if (!snapshot || Object.entries(counts).some(([key,n]) => !['acceptedOrUnknown','pendingInput'].includes(key) && n !== 0) ||
        counts.acceptedOrUnknown !== snapshot.input.accepted.length || counts.pendingInput !== snapshot.input.questions.length) return;
    const generation = this.generation, operationId = this.current?.id;
    this.passiveProof = null;
    this.requests++;
    try {
      const remaining = deadline - this.monotonic(); if (remaining < 1) return;
      const native = await this.terminalProof.read(snapshot.input, remaining);
      if (!operationId || this.current?.id !== operationId || this.current.phase !== 'draining' || generation !== this.generation ||
          this.monotonic() > deadline || this.terminalProof.snapshot()?.fingerprint !== snapshot.fingerprint ||
          !this.terminalProof.matches(snapshot,native) || !this.terminalProof.fresh(native)) return;
      this.passiveProof = { operationId, generation, fingerprint:snapshot.fingerprint, native, at:this.monotonic() };
    } catch { /* Unavailable/unknown metadata remains a strict blocker. */ }
    finally { this.requests--; }
  }
  begin(p) {
    if (!p || Object.keys(p).some(k => !['action','operationId','commit','version','instanceId','invocationId','unitId','waitSeconds'].includes(k)) || !/^[a-zA-Z0-9:_-]{10,180}$/.test(p.operationId) || !/^[a-f0-9]{40}$/.test(p.commit) ||
        !/^\d+\.\d+\.\d+$/.test(p.version) || p.instanceId !== this.runtime.epoch || p.invocationId !== this.invocation ||
        typeof p.unitId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}\.service$/.test(p.unitId) ||
        !Number.isSafeInteger(p.waitSeconds) || p.waitSeconds < 1 || p.waitSeconds > 900) throw Error('Invalid exact maintenance identity or deadline.');
    const fingerprint = createHash('sha256').update(JSON.stringify([p.commit,p.version,p.instanceId,p.invocationId,p.unitId,p.waitSeconds])).digest('hex');
    const prior = this.store.get('runtimeMaintenance', p.operationId);
    if (prior) { if (prior.fingerprint !== fingerprint) throw Error('Maintenance operation input changed.'); return this.public(prior); }
    if (this.holding()) throw Error('Another maintenance lease exists; inspect its original operation.');
    this.source(p.commit, p.version);
    const row = { id: p.operationId, fingerprint, ...p, processIdentity: { pid: process.pid, start: processStart(process.pid) }, phase: 'draining', createdAt: stamp(this.clock()), expiresAtMs: this.clock() + p.waitSeconds * 1000 };
    this.store.transaction(() => this.store.put('runtimeMaintenance', row));
    this.current = row; this.currentDeadline = this.monotonic() + p.waitSeconds * 1000; this.proof = null;
    this.runtime.emitEvent?.('runtime', { maintenance: this.snapshot() });
    return this.public(row);
  }
  public(row) { return { operationId: row.id, phase: row.phase, active: this.current?.id === row.id, commit: row.commit, version: row.version, instanceId: row.instanceId,
    invocationId: row.invocationId, unitId: row.unitId, expiresAt: stamp(row.expiresAtMs),
    remainingMs: this.current?.id === row.id ? Math.max(0, Math.min(row.expiresAtMs - this.clock(), this.currentDeadline - this.monotonic())) : 0, reason: row.reason ?? null }; }
  owned(p) {
    this.expire();
    const row = this.store.get('runtimeMaintenance', p?.operationId);
    if (!row || row.instanceId !== p.instanceId || row.invocationId !== p.invocationId || row.commit !== p.commit || row.version !== p.version || row.unitId !== p.unitId || row.waitSeconds !== p.waitSeconds) throw Error('Maintenance identity changed.');
    return row;
  }
  async observe(row) {
    const deadline = this.monotonic() + 20_000;
    await this.qualifyPassive(deadline);
    const counts = this.counts();
    if (Object.values(counts).some(n => n !== 0)) return { safe: false, counts, reason: 'Current work, tools, volatile state or unknown acceptance remains.' };
    const generation = this.generation, collaborationChange=this.store.meta('collaboration-change');
    const read = (method, params) => {
      const left = deadline - this.monotonic(); if (left <= 0) throw Error('Native maintenance observation exceeded its deadline.');
      return this.runtime.codex.call(method, params, Math.min(left, 5000));
    };
    let cursor = null; const seen = new Set(), threads = new Set();
    do {
      if (seen.has(cursor) || seen.size >= 10 || this.monotonic() >= deadline) throw Error('Native maintenance observation exceeded its bound.');
      seen.add(cursor);
      const page = await read('thread/loaded/list', { cursor, limit: 100 });
      if (!Array.isArray(page?.data) || !Object.hasOwn(page, 'nextCursor') || page.data.some(id => typeof id !== 'string') || page.nextCursor !== null && typeof page.nextCursor !== 'string') throw Error('Incomplete loaded-thread metadata.');
      page.data.forEach(id => threads.add(id)); cursor = page.nextCursor;
    } while (cursor !== null);
    if (threads.size > 100) throw Error('Native maintenance observation exceeds 100 loaded sessions.');
    let activeGoals = 0, nativeQueues = 0, active = 0;
    for (const threadId of threads) {
      if (this.monotonic() >= deadline) throw Error('Native maintenance observation exceeded its deadline.');
      const { thread } = await read('thread/read', { threadId, includeTurns: false });
      if (thread?.id !== threadId || !['idle','notLoaded'].includes(thread.status?.type)) { active++; continue; }
      const goal = await read('thread/goal/get', { threadId });
      if (!goal || !Object.hasOwn(goal, 'goal') || goal.goal && (goal.goal.threadId !== threadId || !['active','paused','blocked','usageLimited','budgetLimited','complete'].includes(goal.goal.status))) throw Error('Unknown native Goal state.');
      if (goal.goal?.status === 'active') activeGoals++;
      const page = await read('thread/queue/list', { threadId, limit: 1, cursor: null });
      if (!Array.isArray(page?.data) || !Object.hasOwn(page,'nextCursor') || page.nextCursor !== null && typeof page.nextCursor !== 'string') throw Error('Unknown accepted native queue state.');
      if (page.data.length || page.nextCursor !== null) nativeQueues++;
    }
    await this.qualifyPassive(deadline);
    const after = this.counts(), safe = this.monotonic() <= deadline && !active && !activeGoals && !nativeQueues && generation === this.generation && collaborationChange===this.store.meta('collaboration-change') && !Object.values(after).some(n => n !== 0);
    if (safe && this.current?.id === row.id && this.current.phase === 'draining') this.proof = { generation, collaborationChange, at: this.clock(), monotonicAt: this.monotonic(), operationId: row.id };
    return { safe, counts: after, native: { loaded: threads.size, active, activeGoals, nativeQueues }, reason: safe ? null : 'Native work/Goal/queue or concurrent activity prevents restart.' };
  }
  async control(p) {
    if (p?.action === 'begin') return this.begin(p);
    const row = this.owned(p);
    if (p.action === 'status') return { ...this.public(row), counts: this.counts() };
    if (p.action === 'cancel') {
      if (row.phase === 'claimed') throw Error('A restart was claimed; inspect the original receipt.');
      if (this.current?.id === row.id) this.end('cancelled', 'Owner cancelled this maintenance lease.');
      return this.public(this.store.get('runtimeMaintenance', row.id));
    }
    if (p.action === 'observe') {
      if (this.current?.id !== row.id || row.phase !== 'draining') throw Error('Maintenance is not draining.');
      return { ...this.public(row), ...await this.observe(row) };
    }
    if (p.action === 'seal' || p.action === 'claim') {
      if (Math.min(row.expiresAtMs - this.clock(), this.currentDeadline - this.monotonic()) < 45_000) throw Error('Maintenance deadline leaves no safe restart handoff window.');
      if (this.current?.id !== row.id || row.phase !== (p.action === 'seal' ? 'draining' : 'sealed') ||
          !this.proof || this.proof.operationId !== row.id || this.proof.generation !== this.generation || this.proof.collaborationChange!==this.store.meta('collaboration-change') || this.monotonic() - this.proof.monotonicAt > 5000 || Object.values(this.counts()).some(n => n !== 0)) throw Error('Fresh drained state is not proven; no restart authorized.');
      this.source(row.commit, row.version);
      const next = { ...row, phase: p.action === 'seal' ? 'sealed' : 'claimed' };
      this.store.put('runtimeMaintenance', next); this.current = next;
      return this.public(next);
    }
    throw Error('Unknown maintenance action.');
  }
}

function checkSource(commit, version) {
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 5000 }).trim();
  if (git(['rev-parse','HEAD']) !== commit || git(['status','--porcelain'])) throw Error('Reviewed maintenance source changed.');
  const pin = readFileSync(new URL('./codex-version.mjs', import.meta.url), 'utf8');
  if (!pin.includes(`CODEX_VERSION = "${version}"`)) throw Error('Reviewed runtime version changed.');
}
