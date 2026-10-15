import { randomUUID } from 'node:crypto';
import { botProvider } from './provider-router.mjs';

// Native model-context compaction: owner-triggered and idle-triggered.
//
// Evidence. Pressure comes only from the pinned native
// `thread/tokenUsage/updated` notification for the bot's exact thread:
//   tokenUsage.last.totalTokens  -> tokens in the context window after the
//                                   latest model request (input incl. cached
//                                   + output). This is "current context".
//   tokenUsage.total.totalTokens -> cumulative usage for the whole thread.
//                                   Recorded for display, NEVER a trigger.
//   tokenUsage.modelContextWindow -> the selected model's window, or null.
// Claude bots emit the same notification shape (claude-items.mjs). Missing,
// foreign-thread or post-compaction evidence never triggers compaction.
//
// Lifecycle. thread/compact/start answers `{}` at once; that ACK is only
// "compacting". Completion is the matching contextCompaction item (or the
// deprecated thread/compacted notification) on the same thread in the same
// process. An ACK lost to timeout/disconnect is "unconfirmed" and is never
// resubmitted; a late matching item still settles it.
//
// Idle policy. One attempt per bot/thread/context generation (the exact usage
// observation). It is due when current context >= thresholdTokens AND no
// native progress has been observed for idleMinutes. It runs from the
// existing runtime tick / portable agent recovery loop, one bot at a time.

export const IDLE_COMPACTION_DEFAULTS = Object.freeze({ enabled: true, thresholdTokens: 200_000, idleMinutes: 54 });
export const IDLE_COMPACTION_LIMITS = Object.freeze({ thresholdTokens: [20_000, 2_000_000], idleMinutes: [5, 1440] });
// Without lifecycle evidence a submitted compaction stops holding admission.
export const COMPACTION_LIFECYCLE_LIMIT_MS = 30 * 60_000;
const IN_FLIGHT = new Set(['requested', 'submitting', 'compacting']);
const HELD_METHODS = new Set(['turn/start', 'turn/steer', 'thread/queue/start', 'thread/compact/start', 'review/start']);
const ACTIVITY = new Set(['turn/started', 'turn/completed', 'item/started', 'item/completed', 'thread/tokenUsage/updated']);
const iso = ms => new Date(ms).toISOString();

export function idlePolicy(bot) {
  const p = bot?.idleCompaction;
  return { ...IDLE_COMPACTION_DEFAULTS, ...(p && typeof p === 'object' ? p : {}) };
}

/** Validates a `bots.update` idleCompaction patch; returns the full policy. */
export function idlePolicyPatch(bot, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['enabled', 'thresholdTokens', 'idleMinutes'].includes(k)))
    throw new Error('Idle compaction accepts enabled, thresholdTokens and idleMinutes.');
  const next = { ...idlePolicy(bot), ...value };
  const [tMin, tMax] = IDLE_COMPACTION_LIMITS.thresholdTokens, [mMin, mMax] = IDLE_COMPACTION_LIMITS.idleMinutes;
  if (typeof next.enabled !== 'boolean') throw new Error('Idle compaction enabled must be true or false.');
  if (!Number.isSafeInteger(next.thresholdTokens) || next.thresholdTokens < tMin || next.thresholdTokens > tMax)
    throw new Error(`Choose a context threshold from ${tMin} to ${tMax} tokens.`);
  if (!Number.isSafeInteger(next.idleMinutes) || next.idleMinutes < mMin || next.idleMinutes > mMax)
    throw new Error(`Choose an idle delay from ${mMin} to ${mMax} minutes.`);
  return next;
}

/** Current-context evidence from a native tokenUsage notification, or null. */
export function contextEvidence(params) {
  const usage = params?.tokenUsage, last = usage?.last?.totalTokens;
  if (typeof params?.threadId !== 'string' || !Number.isSafeInteger(last) || last < 0) return null;
  const total = usage.total?.totalTokens, window = usage.modelContextWindow;
  return { threadId: params.threadId, turnId: typeof params.turnId === 'string' ? params.turnId : null, contextTokens: last,
    cumulativeTokens: Number.isSafeInteger(total) ? total : null,
    modelContextWindow: Number.isSafeInteger(window) && window > 0 ? window : null };
}

/**
 * Pure idle decision. `usage` is the persisted contextUsage record and
 * `record` the bot's latest compaction record.
 */
export function idleDecision(bot, usage, record, nowMs) {
  const policy = idlePolicy(bot);
  if (!policy.enabled) return { state: 'disabled', policy };
  if (!usage || usage.threadId !== bot.threadId || !Number.isSafeInteger(usage.contextTokens) || !usage.generation)
    return { state: 'unknown', policy };
  if (usage.compactedAt) return { state: 'compacted', policy };
  if (usage.modelContextWindow && policy.thresholdTokens >= usage.modelContextWindow)
    return { state: 'unsupported', policy, reason: `The ${policy.thresholdTokens}-token threshold does not fit this model's ${usage.modelContextWindow}-token window.` };
  if (usage.contextTokens < policy.thresholdTokens) return { state: 'below-threshold', policy };
  if (record?.generation === usage.generation) return { state: 'attempted', policy };
  const last = Date.parse(usage.lastActivityAt ?? usage.observedAt);
  if (!Number.isFinite(last)) return { state: 'unknown', policy };
  const dueAtMs = last + policy.idleMinutes * 60_000;
  return { state: nowMs >= dueAtMs ? 'due' : 'waiting', policy, dueAt: iso(dueAtMs) };
}

/** Browser-safe projection: states, IDs, times and token counts only. */
export function publicCompaction(record, usage) {
  return {
    ...(record ? { state: record.state === 'submitting' ? 'requested' : record.state, trigger: record.trigger,
      operationId: record.operationId, requestedAt: record.requestedAt, acceptedAt: record.acceptedAt ?? null,
      completedAt: record.completedAt ?? null, reason: record.reason ?? null, turnId: record.turnId ?? null,
      itemId: record.itemId ?? null, beforeTokens: record.before?.contextTokens ?? null,
      afterTokens: record.after?.contextTokens ?? null } : { state: null }),
    context: usage ? { tokens: usage.contextTokens, window: usage.modelContextWindow, observedAt: usage.observedAt,
      lastActivityAt: usage.lastActivityAt ?? usage.observedAt, compacted: Boolean(usage.compactedAt) } : null,
  };
}

const refused = (message, extra = {}) => Object.assign(new Error(message), { compactionNotSubmitted: true, definite: true, outcome: 'rejected', ...extra });

export class ContextCompaction {
  constructor(runtime, { clock = Date.now } = {}) {
    Object.assign(this, { runtime, store: runtime.store, clock });
    this.running = false;
  }
  record(botId) { return this.store.get('contextCompaction', botId); }
  usage(botId) { return this.store.get('contextUsage', botId); }
  /** A previous process cannot confirm its in-flight request: never repeat it. */
  recover() {
    for (const row of this.store.list('contextCompaction')) {
      if (!IN_FLIGHT.has(row.state) || row.processEpoch === this.runtime.epoch) continue;
      this.save(row.botId, { ...row, state: row.state === 'requested' ? 'blocked' : 'unconfirmed',
        reason: row.state === 'requested' ? 'The runtime restarted before compaction was submitted. Nothing was sent.' :
          'The runtime restarted before native compaction was confirmed. It was not repeated; check the conversation before compacting again.' });
    }
  }
  inFlight(botId) {
    const row = this.record(botId);
    if (!row || !IN_FLIGHT.has(row.state) || row.processEpoch !== this.runtime.epoch) return null;
    return this.clock() - Date.parse(row.requestedAt) < COMPACTION_LIFECYCLE_LIMIT_MS ? row : null;
  }
  /** Codex admission guard: no new turn while this thread's compaction is in flight. */
  native(method, params = {}) {
    if (!HELD_METHODS.has(method) || typeof params.threadId !== 'string') return;
    const bot = this.store.bots().find(b => b.threadId === params.threadId);
    if (bot && this.inFlight(bot.id) && !(method === 'thread/compact/start' && this.submitting === bot.id))
      throw Object.assign(new Error('Context compaction is running in this conversation. Your input was not submitted and is retained; send it when compaction finishes.'), { outcome: 'rejected', definite: true });
  }
  save(botId, row) {
    const saved = this.store.put('contextCompaction', { ...row, id: botId, botId, updatedAt: iso(this.clock()) });
    this.settleOperation(row);
    this.project(botId);
    return saved ?? row;
  }
  /**
   * An owner request whose ACK was lost is an uncertain operation, which holds
   * every idle gate. Settle it from lifecycle evidence, or once its bounded
   * window ends, as failed-uncertain: never replayed under the same ID, and a
   * new explicit owner action may compact again.
   */
  settleOperation(row) {
    const op = row.trigger === 'manual' && row.operationId && this.store.operation(row.operationId);
    // A previous process's dispatching receipt can no longer be answered by it.
    const earlier = row.processEpoch !== this.runtime.epoch;
    if (!op || op.method !== 'thread.compact' || op.botId !== row.botId || !(op.status === 'uncertain' || earlier && op.status === 'dispatching')) return;
    const { id, fingerprint, ...data } = op;
    delete data.status;
    if (row.state === 'completed') this.store.saveOperation(id, fingerprint, 'done', { ...data, result: { compaction: publicCompaction(row, this.usage(row.botId)) } });
    else if (['failed', 'blocked'].includes(row.state)) this.store.saveOperation(id, fingerprint, 'failed', { ...data, error: row.reason, outcome: 'rejected' });
    else if (row.state === 'unconfirmed' && (earlier || this.clock() - Date.parse(row.requestedAt) >= COMPACTION_LIFECYCLE_LIMIT_MS))
      this.store.saveOperation(id, fingerprint, 'failed', { ...data, error: row.reason, outcome: 'uncertain' });
  }
  project(botId) {
    const bot = this.store.bot(botId);
    if (!bot) return;
    const next = publicCompaction(this.record(botId), this.usage(botId));
    if (JSON.stringify(bot.contextCompaction ?? null) !== JSON.stringify(next)) this.runtime.saveBot(bot, { contextCompaction: next });
  }
  /** Reason this bot cannot be compacted now, or null. Manual ignores Stop only. */
  blocker(bot, { manual = false, operationId = null } = {}) {
    const runtime = this.runtime;
    if (!bot || bot.archived || bot.archiving || bot.deletedAt || !bot.threadId) return 'This bot has no current conversation to compact.';
    if (runtime.maintenance.holding()) return 'A runtime update is in progress.';
    if (!runtime.ready) return 'The native runtime is not ready.';
    if (botProvider(bot) === 'claude' && !runtime.codex.claudeReady) return 'The Claude backend is unavailable on this machine.';
    if (!manual && (bot.queuePaused || bot.managerPaused)) return 'Stop is on; automatic compaction is held.';
    if (bot.activeTurnId || runtime.activityUnresolved(bot.id) || runtime.scheduledUncertain(bot.id)) return 'Wait for this turn to finish before compacting.';
    if (this.store.list('pending', bot.id).length) return 'A question is waiting for your answer.';
    if (this.store.get('nativeGoal', bot.id)?.goal?.status === 'active') return 'An active Goal is continuing this conversation.';
    // Reuse the memory-maintenance idle gate for every other kind of queued,
    // accepted or unknown work. Stop/primary mode are decided above.
    if (!runtime.memoryMaintenance.idle({ ...bot, executionMode: 'single-thread', queuePaused: false, managerPaused: false }, null, operationId))
      return 'Queued, accepted or unconfirmed work is still pending for this bot.';
    if (this.inFlight(bot.id)) return 'Compaction is already in progress.';
    return null;
  }
  /** Owner action. Runs under the request's bot lock (runtime.handleRequest). */
  async manual(bot, operationId) {
    const prior = this.record(bot.id);
    if (prior?.operationId === operationId) return { compaction: publicCompaction(prior, this.usage(bot.id)) };
    if (this.inFlight(bot.id)) return { compaction: publicCompaction(prior, this.usage(bot.id)), coalesced: true };
    return this.start(bot, { trigger: 'manual', operationId });
  }
  async start(bot, { trigger, operationId, generation = null }) {
    const manual = trigger === 'manual', runtime = this.runtime;
    const block = reason => {
      if (manual) this.save(bot.id, { ...this.record(bot.id), state: 'blocked', trigger, operationId, threadId: bot.threadId,
        requestedAt: iso(this.clock()), processEpoch: runtime.epoch, reason, acceptedAt: null, completedAt: null, turnId: null, itemId: null, after: null });
      throw refused(reason);
    };
    let reason = this.blocker(bot, { manual, operationId });
    if (reason) block(reason);
    await runtime.load(bot);
    await runtime.ensureCurrentActivity(bot.id).catch(error => block(error.message));
    if (!runtime.primary.single(bot) && (await runtime.queueList(runtime.store.bot(bot.id))).length)
      block('Native queued prompts run first.');
    // Re-check after every await, then submit synchronously from here.
    const current = runtime.store.bot(bot.id);
    if (current.threadId !== bot.threadId) block('The conversation changed before compaction.');
    if ((reason = this.blocker(current, { manual, operationId }))) block(reason);
    const usage = this.usage(bot.id);
    if (!manual) {
      const decision = idleDecision(current, usage, this.record(bot.id), this.clock());
      if (decision.state !== 'due' || usage.generation !== generation) throw refused('Idle compaction is no longer due.');
    }
    const row = { state: 'submitting', trigger, operationId, threadId: current.threadId, provider: botProvider(current),
      generation: generation ?? usage?.generation ?? null, requestedAt: iso(this.clock()), acceptedAt: null, completedAt: null,
      processEpoch: runtime.epoch, nativePid: runtime.codex.process?.pid ?? null, turnId: null, itemId: null, reason: null,
      before: usage?.threadId === current.threadId ? { contextTokens: usage.contextTokens, observedAt: usage.observedAt } : null, after: null };
    this.save(bot.id, row);
    this.submitting = bot.id;
    let ack;
    try { ack = runtime.codex.call('thread/compact/start', { threadId: current.threadId }); }
    finally { this.submitting = null; }
    try { await ack; }
    catch (error) {
      const latest = this.record(bot.id);
      if (latest?.operationId === operationId && latest.state === 'completed') return { compaction: publicCompaction(latest, this.usage(bot.id)) };
      const definite = error.definite === true;
      if (latest?.operationId === operationId)
        this.save(bot.id, { ...latest, state: definite ? 'failed' : 'unconfirmed', reason: definite ? error.message :
          'Native acceptance was not confirmed. Compaction was not repeated; check the conversation before compacting again.' });
      throw definite ? refused(error.message) : Object.assign(error, { outcome: 'uncertain' });
    }
    const latest = this.record(bot.id);
    if (latest?.operationId === operationId && latest.state === 'submitting')
      this.save(bot.id, { ...latest, state: 'compacting', acceptedAt: iso(this.clock()) });
    return { compaction: publicCompaction(this.record(bot.id), this.usage(bot.id)) };
  }
  /** Native notifications for a bot's own main thread. */
  note(bot, message) {
    const p = message.params ?? {}, threadId = p.threadId ?? p.thread?.id;
    if (threadId !== bot.threadId) return;
    const at = iso(this.clock());
    let usage = this.usage(bot.id);
    if (usage && usage.threadId !== bot.threadId) usage = null;
    let row = this.record(bot.id);
    // A late item can settle an unconfirmed request only inside its bounded
    // window; later native auto-compaction is not this request's evidence.
    const live = row && row.threadId === threadId && row.processEpoch === this.runtime.epoch &&
      (IN_FLIGHT.has(row.state) && row.state !== 'requested' ||
        row.state === 'unconfirmed' && (!row.turnId || row.turnId === (p.turnId ?? p.turn?.id)) &&
        this.clock() - Date.parse(row.requestedAt) < COMPACTION_LIFECYCLE_LIMIT_MS);
    if (message.method === 'thread/tokenUsage/updated') {
      const evidence = contextEvidence(p);
      if (evidence) {
        usage = { ...evidence, observedAt: at, lastActivityAt: at, generation: `${threadId}:${evidence.turnId ?? ''}:${at}`, compactedAt: null };
        this.store.put('contextUsage', { ...usage, id: bot.id, botId: bot.id });
        if (row?.state === 'completed' && row.threadId === threadId && !row.after)
          row = this.save(bot.id, { ...row, after: { contextTokens: evidence.contextTokens, observedAt: at } });
        return;
      }
    }
    const compacted = (message.method === 'item/completed' && p.item?.type === 'contextCompaction') || message.method === 'thread/compacted';
    if (ACTIVITY.has(message.method) || compacted) {
      if (usage) {
        usage = { ...usage, lastActivityAt: at, ...(compacted ? { compactedAt: at } : {}) };
        this.store.put('contextUsage', { ...usage, id: bot.id, botId: bot.id });
      }
    }
    if (live && message.method === 'item/started' && p.item?.type === 'contextCompaction' && !row.turnId)
      this.save(bot.id, { ...row, turnId: p.turnId ?? null });
    else if (live && message.method === 'turn/started' && !row.turnId && IN_FLIGHT.has(row.state))
      this.save(bot.id, { ...row, turnId: p.turn?.id ?? null });
    else if (live && compacted && (!row.turnId || !p.turnId || row.turnId === p.turnId))
      this.save(bot.id, { ...row, state: 'completed', completedAt: at, turnId: row.turnId ?? p.turnId ?? null, itemId: p.item?.id ?? null, reason: null });
    else if (live && message.method === 'turn/completed' && row.turnId === p.turn?.id && IN_FLIGHT.has(row.state))
      this.save(bot.id, { ...row, state: p.turn.status === 'completed' ? 'unconfirmed' : 'failed',
        reason: p.turn.status === 'completed' ? 'The native turn ended without a compaction item.' :
          String(p.turn.error?.message ?? `Native compaction ${p.turn.status}.`).slice(0, 500) });
    else if (message.method === 'turn/completed' || compacted) this.project(bot.id);
  }
  /**
   * One bounded step from the existing tick. `admit(bot)` lets the portable
   * agent add its synchronized Stop/placement fence.
   */
  async tick({ admit = () => true } = {}) {
    if (this.running || !this.runtime.ready || this.runtime.maintenance.holding()) return null;
    this.running = true;
    try {
      const nowMs = this.clock();
      for (const row of this.store.list('contextCompaction')) {
        if (IN_FLIGHT.has(row.state) && row.state !== 'requested' && nowMs - Date.parse(row.requestedAt) >= COMPACTION_LIFECYCLE_LIMIT_MS)
          this.save(row.botId, { ...row, state: 'unconfirmed', reason: 'No native compaction lifecycle arrived in time. It was not repeated.' });
        else if (row.state === 'unconfirmed') this.settleOperation(row);
      }
      const due = this.store.list('contextUsage').map(usage => {
        const bot = this.store.bot(usage.botId);
        return bot && { bot, usage, decision: idleDecision(bot, usage, this.record(bot.id), nowMs) };
      }).filter(c => c?.decision.state === 'due' && !this.runtime.locks.has(c.bot.id) && !this.blocker(c.bot) && admit(c.bot))
        .sort((a, b) => a.decision.dueAt.localeCompare(b.decision.dueAt));
      const next = due[0];
      if (!next) return null;
      const operationId = `compaction:idle:${randomUUID()}`;
      return await this.runtime.lock(next.bot.id, () => this.runtime.maintenance.admit(() => {
        const bot = this.store.bot(next.bot.id);
        if (!admit(bot)) throw refused('Automatic compaction is held by the assigned controls.');
        return this.start(bot, { trigger: 'idle', operationId, generation: next.usage.generation });
      })).catch(error => {
        // Any non-submission leaves the generation eligible for a later tick;
        // a submitted attempt is recorded and never retried for this generation.
        if (!error.compactionNotSubmitted) this.runtime.emit('fault', error);
        return null;
      });
    } finally { this.running = false; }
  }
}
