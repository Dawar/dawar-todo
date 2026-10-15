import { reconcileCurrentActivity } from './current-activity.mjs';
import { reconcilePrompt } from './prompt-queue.mjs';
import { reconcileScheduled } from './scheduled-execution.mjs';
import { passiveLegacyManagerRejections } from './legacy-manager-rejections.mjs';

// Held, unresolved and uncertain states fail closed: they refuse input or keep
// work waiting until native truth confirms them. That is correct, but on its
// own it is silent. Each state here gets a time and attempt budget; past the
// budget the bot's status names the hold, its last error and since when, an
// owner Recover re-derives it from native truth, and Dawar is notified.
// See HELD_STATES.md. Nothing here submits, steers or replays input.

const MINUTE = 60_000;
/** Budgets per held kind. `attempts: null` means the record keeps no attempt count. */
export const HOLD_BUDGETS = Object.freeze({
  activity: { ms: 15 * MINUTE, attempts: 5 },
  'native-recovery': { ms: 15 * MINUTE, attempts: 5 },
  inbox: { ms: 15 * MINUTE, attempts: null },
  'prompt-queue': { ms: 15 * MINUTE, attempts: null },
  run: { ms: 15 * MINUTE, attempts: null },
  burst: { ms: 15 * MINUTE, attempts: null },
  collaboration: { ms: 30 * MINUTE, attempts: null },
  maintenance: { ms: 30 * MINUTE, attempts: null },
});
export const NOTIFY_INTERVAL_MS = 60 * MINUTE;
const WATCH_INTERVAL_MS = 30_000;
/** Kinds with an owner Recover that re-reads native truth. */
export const RECOVERABLE = new Set(['activity', 'native-recovery', 'inbox', 'prompt-queue', 'run']);
const SETTLED_RECOVERY = new Set(['recovered', 'superseded']);
const iso = ms => new Date(ms).toISOString();
const parsed = value => { const t = Date.parse(value ?? ''); return Number.isFinite(t) ? t : null; };
const short = (value, n = 300) => typeof value === 'string' && value ? value.slice(0, n) : null;

export function formatDuration(ms) {
  const minutes = Math.max(1, Math.floor(ms / MINUTE));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

const rows = (store, sql, ...args) => store.db.prepare(sql).all(...args).map(row => JSON.parse(row.json));
// Message bodies never enter this projection.
const metadata = (store, kind, botId, condition) => rows(store, `SELECT json_remove(json,'$.input','$.text','$.prompt') AS json
  FROM records WHERE kind=? AND bot_id=? AND ${condition}`, kind, botId);

/**
 * Every currently held record of one bot, budgets not yet applied. `since` is
 * the record's own timestamp when it has one, else the first time the watch
 * observed it (heldObservation), else now.
 */
export function heldStates(runtime, bot, now = Date.now()) {
  const store = runtime.store, out = [];
  if (!bot || bot.archived || bot.deletedAt) return out;
  const seen = new Map(store.list('heldObservation', bot.id).map(row => [`${row.kind}:${row.recordId}`, parsed(row.firstSeenAt)]));
  const add = item => {
    const own = parsed(item.since), first = seen.get(`${item.kind}:${item.id}`) ?? null;
    const since = [own, first].filter(v => v !== null);
    out.push({ ...item, since: iso(since.length ? Math.min(...since) : now) });
  };
  const activity = store.get('botActivity', bot.id);
  if (activity && (activity.unresolved === true || activity.threadId !== bot.threadId))
    add({ kind: 'activity', id: bot.id, since: activity.unresolvedSince, attempts: activity.attempts ?? 0,
      lastError: short(activity.reconciliationError), checkedAt: activity.recoveryCheckedAt ?? null, retryAt: activity.reconcileAfter ?? null,
      what: 'New messages and queued work are refused until current execution is confirmed.' });
  const recovery = store.get('nativeErrorRecovery', bot.id);
  if (recovery && recovery.threadId === bot.threadId && !SETTLED_RECOVERY.has(recovery.phase))
    add({ kind: 'native-recovery', id: bot.id, since: recovery.createdAt, attempts: recovery.attempts ?? 0,
      lastError: short(recovery.reason) ?? (recovery.errorCode ? `Codex reported ${recovery.errorCode}.` : null), phase: recovery.phase,
      deadEpoch: Boolean(recovery.nativeRetry && recovery.nativeRetryEpoch && recovery.nativeRetryEpoch !== runtime.epoch),
      retryAt: recovery.nextRetryAt ?? null, what: `The failed turn ${recovery.failedTurnId} and any new input wait for this recovery.` });
  for (const item of metadata(store, 'primaryInbox', bot.id, `json_extract(json,'$.terminalStatus') IS NULL AND json_extract(json,'$.state') IN ('dispatching','uncertain','accepted')`)) {
    // Accepted work bound to the current turn is working, and accepted work
    // without a turn is waiting in line; neither is a hold.
    if (item.state === 'accepted' && (!item.turnId || item.turnId === bot.activeTurnId || activity?.activeTurnId === item.turnId)) continue;
    add({ kind: 'inbox', id: item.id, since: item.attemptedAt ?? item.acceptedAt ?? item.createdAt, attempts: null, lastError: short(item.error), state: item.state,
      what: item.state === 'accepted' ? `${item.kind === 'schedule' ? 'Scheduled' : 'Shared'} work "${short(item.summary, 80) ?? item.id}" never confirmed its finish (turn ${item.turnId}).`
        : `Delivery of "${short(item.summary, 80) ?? item.id}" is unconfirmed, so later automatic work waits.` });
  }
  for (const item of metadata(store, 'promptQueue', bot.id, `json_extract(json,'$.state') IN ('dispatching','uncertain','native-queued')`))
    add({ kind: 'prompt-queue', id: item.id, since: item.updatedAt ?? item.createdAt, attempts: null, lastError: short(item.error), state: item.state,
      what: 'A queued message\'s delivery is unconfirmed; it is held, not resent.' });
  for (const run of metadata(store, 'run', bot.id, `json_extract(json,'$.status') IN ('starting','uncertain')`)) {
    if (run.executionLane === 'run-v1') continue;
    add({ kind: 'run', id: run.id, since: run.startedAt ?? run.scheduledAt, attempts: null, lastError: short(run.reconciliationError ?? run.error), state: run.status,
      what: `Scheduled run ${run.title ? `"${short(run.title, 80)}" ` : ''}has an unconfirmed start.` });
  }
  for (const burst of metadata(store, 'messageBurst', bot.id, `json_extract(json,'$.state') IN ('preparing','dispatching')`))
    add({ kind: 'burst', id: burst.id, since: burst.updatedAt ?? burst.createdAt, attempts: null, lastError: short(burst.error), state: burst.state,
      what: 'A message batch is still preparing or confirming its delivery.' });
  // Reviewed pre-effect legacy manager refusals are settled history, exactly
  // as native error recovery treats them (localFence).
  const passive = new Set(passiveLegacyManagerRejections(store, bot.id).map(row => row.id));
  for (const kind of ['managerOperation', 'managerExecution', 'answerExecution', 'runIntake'])
    for (const row of metadata(store, kind, bot.id, `json_extract(json,'$.state') IN ('dispatching','uncertain')`)) {
      if (kind === 'managerOperation' && passive.has(row.id)) continue;
      add({ kind: 'collaboration', id: `${kind}:${row.id}`, since: row.updatedAt ?? row.createdAt, attempts: null, lastError: short(row.error), state: row.state,
        what: 'A collaboration step has an unknown outcome; it is held, not repeated.' });
    }
  if (runtime.maintenance?.holding?.()) {
    const m = runtime.maintenance.current;
    add({ kind: 'maintenance', id: m.id ?? 'maintenance', since: m.createdAt, attempts: null, lastError: short(m.reason), state: m.phase,
      what: 'Runtime maintenance holds new work for every bot.' });
  }
  return out;
}

export function overBudget(item, now = Date.now()) {
  const budget = HOLD_BUDGETS[item.kind];
  if (!budget) return false;
  return now - Date.parse(item.since) >= budget.ms || (budget.attempts !== null && (item.attempts ?? 0) >= budget.attempts);
}

const LABELS = {
  activity: 'Stuck: execution unconfirmed',
  'native-recovery': 'Stuck: recovery failing',
  inbox: 'Stuck: work never confirmed',
  'prompt-queue': 'Stuck: queued delivery unconfirmed',
  run: 'Stuck: scheduled run unconfirmed',
  burst: 'Stuck: message batch unconfirmed',
  collaboration: 'Stuck: collaboration outcome unknown',
  maintenance: 'Held by maintenance',
};

/** Plain-language reason for one held item past its budget. */
export function heldReason(item, bot, now = Date.now()) {
  const name = bot?.name ?? 'This bot', age = formatDuration(now - Date.parse(item.since));
  const tries = item.attempts ? ` after ${item.attempts} failed check${item.attempts === 1 ? '' : 's'}` : '';
  switch (item.kind) {
    case 'activity': return `${name} can't confirm whether it is working${tries}; it has refused new messages for ${age}.`;
    case 'native-recovery': return item.deadEpoch
      ? `${name}'s recovery is waiting on a retry owned by a process that was replaced ${age} ago; it cannot finish by itself.`
      : `${name}'s conversation recovery has not finished${tries} in ${age}.`;
    case 'inbox': return item.state === 'accepted' ? `${name} has had work marked accepted for ${age}, but its finish was never confirmed.`
      : `${name} has had a delivery waiting for confirmation for ${age}.`;
    case 'prompt-queue': return `${name} has had a queued message unconfirmed for ${age}.`;
    case 'run': return `${name} has had a scheduled run with an unconfirmed start for ${age}.`;
    case 'burst': return `${name} has had a message batch stuck before delivery for ${age}.`;
    case 'collaboration': return `${name} has had a collaboration step with an unknown outcome for ${age}.`;
    case 'maintenance': return `Runtime maintenance has held every bot for ${age}.`;
    default: return `${name} has been held for ${age}.`;
  }
}

const publicItem = (item, bot, now) => ({ kind: item.kind, id: item.id, label: LABELS[item.kind], reason: heldReason(item, bot, now),
  what: item.what, since: item.since, attempts: item.attempts, lastError: item.lastError, recoverable: RECOVERABLE.has(item.kind) });

/** The escalated view shown in status, or null while every hold is within budget. */
export function heldView(runtime, bot, now = Date.now()) {
  const over = heldStates(runtime, bot, now).filter(item => overBudget(item, now))
    .sort((a, b) => a.since.localeCompare(b.since) || a.kind.localeCompare(b.kind));
  if (!over.length) return null;
  // Lead with what blocks the bot itself rather than a runtime-wide hold.
  const lead = over.find(item => item.kind !== 'maintenance') ?? over[0];
  return { label: LABELS[lead.kind], reason: heldReason(lead, bot, now), lastError: lead.lastError, since: lead.since,
    held: over.slice(0, 10).map(item => publicItem(item, bot, now)), more: Math.max(0, over.length - 10) };
}

const RECOVERY_REFUSED = 'This hold changed or has no automatic recovery. Refresh the bot; nothing was sent.';
const refuse = message => Object.assign(Error(message), { outcome: 'rejected', definite: true });

/**
 * Artifacts owned by a process epoch that no longer exists cannot change any
 * more: a native retry inside a replaced Codex process will never report, and
 * a release/resume request on its closed stdio connection can neither
 * complete nor affect the current connection. Mark them superseded so the
 * normal current-state read (thread/read + turns/list) can decide.
 */
export function supersedeDeadEpoch(runtime, botId, now = Date.now()) {
  const store = runtime.store, changed = [];
  const row = store.get('nativeErrorRecovery', botId);
  if (row && !SETTLED_RECOVERY.has(row.phase) && row.nativeRetry && row.nativeRetryEpoch && row.nativeRetryEpoch !== runtime.epoch) {
    store.put('nativeErrorRecovery', { ...row, phase: 'superseded', nativeRetry: false, nativeRetryEpoch: null, nextRetryAt: null,
      supersededEvidence: 'owner-recover-replaced-process-native-retry', supersededEpoch: row.nativeRetryEpoch, updatedAt: iso(now) });
    changed.push({ kind: 'nativeErrorRecovery', id: botId });
    runtime.nativeErrorRecovery?.publish?.(botId);
  }
  const pid = runtime.codex?.process?.pid ?? null;
  for (const action of store.list('nativeRecoveryAction', botId)) {
    if (!['dispatching', 'uncertain'].includes(action.state) || !action.epoch || action.epoch === runtime.epoch) continue;
    // The same native process could still answer; only a different process
    // (or none recorded for the old epoch) proves the request is dead.
    if (action.nativeIdentity?.pid && action.nativeIdentity.pid === pid) continue;
    store.put('nativeRecoveryAction', { ...action, state: 'connection-ended', outcome: 'uncertain', priorState: action.state,
      evidence: 'owner-recover-replaced-process-epoch', finishedAt: iso(now) });
    changed.push({ kind: 'nativeRecoveryAction', id: action.id });
  }
  return changed;
}

/**
 * Owner Recover for one held record. Runs under the bot lock (via dispatch).
 * It only re-reads native truth through the existing read-only reconcilers;
 * it never starts, steers or re-queues input. Repeating it is harmless.
 */
export async function recoverHeld(runtime, botId, p = {}) {
  if (!p || typeof p !== 'object' || Object.keys(p).some(k => !['kind', 'id'].includes(k)) || typeof p.kind !== 'string' || typeof p.id !== 'string')
    throw refuse('Recover needs the held kind and record ID.');
  const bot = runtime.store.bot(botId), now = Date.now();
  const before = heldStates(runtime, bot, now).find(item => item.kind === p.kind && item.id === p.id);
  if (!before) return { kind: p.kind, id: p.id, resolved: true, superseded: [], held: heldView(runtime, bot, now) };
  if (!RECOVERABLE.has(before.kind)) throw refuse(RECOVERY_REFUSED);
  const superseded = supersedeDeadEpoch(runtime, botId, now);
  let error = null;
  try {
    if (before.kind === 'activity' || before.kind === 'native-recovery') {
      // Bypass only the backoff timers; the read and its fences are unchanged.
      const activity = runtime.store.get('botActivity', botId);
      if (activity?.reconcileAfter) runtime.store.put('botActivity', { ...activity, reconcileAfter: null });
      const recovery = runtime.store.get('nativeErrorRecovery', botId);
      if (recovery && !SETTLED_RECOVERY.has(recovery.phase)) runtime.store.put('nativeErrorRecovery', { ...recovery, nextRetryAt: iso(now) });
      if (runtime.activityUnresolved(botId)) await reconcileCurrentActivity(runtime, botId);
    } else if (before.kind === 'inbox') {
      const item = runtime.store.get('primaryInbox', p.id);
      if (item?.botId !== botId) throw refuse(RECOVERY_REFUSED);
      runtime.store.put('primaryInbox', { ...item, reconcileAfter: null });
      await runtime.primary.recover(runtime.store.get('primaryInbox', p.id));
    } else if (before.kind === 'prompt-queue') {
      const item = runtime.store.get('promptQueue', p.id);
      if (item?.botId !== botId) throw refuse(RECOVERY_REFUSED);
      await reconcilePrompt(runtime, item);
    } else if (before.kind === 'run') {
      const run = runtime.store.get('run', p.id);
      if (run?.botId !== botId) throw refuse(RECOVERY_REFUSED);
      await reconcileScheduled(runtime, run);
    }
  } catch (e) {
    if (e.outcome === 'rejected') throw e;
    error = e.message;
  }
  runtime.primary?.publish?.(botId);
  const after = heldStates(runtime, runtime.store.bot(botId), Date.now()).find(item => item.kind === p.kind && item.id === p.id);
  return { kind: p.kind, id: p.id, resolved: !after, superseded, ...(error ? { error } : {}), held: heldView(runtime, runtime.store.bot(botId)) };
}

/**
 * Periodic bookkeeping: records first-seen times, republishes a bot's work
 * view when a hold crosses its budget, and notifies Dawar once per new
 * escalated hold, at most once per bot per hour.
 */
export class HeldStateWatch {
  constructor(runtime, { clock = Date.now, interval = WATCH_INTERVAL_MS } = {}) {
    Object.assign(this, { runtime, clock, interval });
    this.lastRun = 0;
  }
  tick({ force = false } = {}) {
    const now = this.clock();
    if (!force && now - this.lastRun < this.interval) return;
    this.lastRun = now;
    const store = this.runtime.store;
    let maintenanceOwner = null;
    for (const bot of store.bots().sort((a, b) => a.id.localeCompare(b.id))) {
      try {
        const items = heldStates(this.runtime, bot, now);
        this.observe(bot, items, now);
        const over = items.filter(item => overBudget(item, now));
        // A runtime-wide hold notifies through one bot, not all of them.
        const own = over.filter(item => item.kind !== 'maintenance' || (maintenanceOwner ??= bot.id) === bot.id);
        this.escalate(bot, over, own, now);
      } catch (error) { this.runtime.emit?.('fault', error); }
    }
  }
  observe(bot, items, now) {
    const store = this.runtime.store, current = new Set(items.map(item => `${item.kind}:${item.id}`));
    const prior = store.list('heldObservation', bot.id), known = new Set(prior.map(row => `${row.kind}:${row.recordId}`));
    for (const row of prior) if (!current.has(`${row.kind}:${row.recordId}`)) store.remove('heldObservation', row.id);
    for (const item of items) if (!known.has(`${item.kind}:${item.id}`))
      store.put('heldObservation', { id: `${bot.id}:${item.kind}:${item.id}`, botId: bot.id, kind: item.kind, recordId: item.id, firstSeenAt: iso(now) });
  }
  escalate(bot, over, notifiable, now) {
    const store = this.runtime.store, state = store.get('heldEscalation', bot.id);
    const keys = over.map(item => `${item.kind}:${item.id}`).sort();
    if (!over.length && !state?.keys?.length) return;
    const changed = JSON.stringify(keys) !== JSON.stringify(state?.keys ?? []);
    const notified = new Set((state?.notifiedKeys ?? []).filter(key => keys.includes(key)));
    const fresh = notifiable.filter(item => !notified.has(`${item.kind}:${item.id}`));
    const lastAt = parsed(state?.notifiedAt);
    let notifiedAt = state?.notifiedAt ?? null;
    if (fresh.length && (lastAt === null || now - lastAt >= NOTIFY_INTERVAL_MS)) {
      const lead = fresh[0], extra = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : '';
      const body = `${heldReason(lead, bot, now)}${extra}${lead.lastError ? ` Last error: ${lead.lastError.slice(0, 200)}` : ''} Open Bot details to Recover.`;
      this.runtime.notify(bot, `held:${bot.id}:${now}`, body.slice(0, 1000));
      for (const item of fresh) notified.add(`${item.kind}:${item.id}`);
      notifiedAt = iso(now);
    }
    store.put('heldEscalation', { id: bot.id, botId: bot.id, keys, notifiedKeys: [...notified].sort(), notifiedAt, updatedAt: iso(now) });
    if (changed) this.runtime.primary?.publish?.(bot.id);
  }
}
