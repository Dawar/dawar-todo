// @ts-check
import { findNativeTurn } from "./native-reconcile.mjs";
import { readKnownActiveTurn } from "./known-turn-watch.mjs";

import { usableTurn, usableTurnId, requireTurn, terminalTurn } from "./native-turn.mjs";
export { terminalTurn } from "./native-turn.mjs";
/** @typedef {import('./store.mjs').StateRuntime} Runtime */

const now = () => new Date().toISOString();

// Persist observed ordering, including idle after completion. Bot locks do not
// serialize native notifications. Tokens must precede the first awaited read
// or mutation whose response might later project active state.
/**
 * The bot's observed-activity record, created at generation 0 on first use.
 * @param {Runtime} runtime @param {string} botId @returns {import('./store.mjs').BotActivity}
 */
function activityRecord(runtime, botId) {
  return runtime.store.get("botActivity", botId) ?? runtime.store.put("botActivity", {
    id: botId, botId, threadId: runtime.store.bot(botId).threadId, generation: 0, activeTurnId: runtime.store.bot(botId).activeTurnId ?? null,
  });
}
/** @param {Runtime} runtime @param {string} botId */
export function captureActivity(runtime, botId) {
  const activity = activityRecord(runtime, botId);
  return { botId, generation: activity.generation, activityThreadId: runtime.store.bot(botId).threadId };
}

/** @param {Runtime} runtime */
export function activityUnchanged(runtime, botId, token) {
  return token?.botId === botId && token.activityThreadId === runtime.store.bot(botId).threadId && Number.isSafeInteger(token.generation) &&
    runtime.store.get("botActivity", botId)?.generation === token.generation;
}

/** @param {Runtime} runtime */
function protectBrowser(runtime, botId) {
  runtime.desktops?.cancelBrowserMaintenance(botId);
  const p = runtime.store.get("browserRetention", botId);
  if (p && (!p.protected || p.release)) runtime.store.put("browserRetention", { ...p, protected: true, release: null, revision: p.revision + 1 });
}
/** @param {Runtime} runtime */
function advanceActivity(runtime, botId, activeTurnId, changes = {}) {
  runtime.memoryMaintenance?.cancelPreparation(botId);
  runtime.privateReviews?.userActivity(botId);
  runtime.desktops?.cancelBrowserMaintenance(botId);
  if (activeTurnId && runtime.store.get("botActivity", botId)?.activeTurnId !== activeTurnId) protectBrowser(runtime, botId);
  const token = captureActivity(runtime, botId), prior = runtime.store.get("botActivity", botId);
  if (!Number.isSafeInteger(token.generation + 1)) throw new Error("Observed activity generation exhausted.");
  // When this hold began, for the held-state budget (held-states.mjs).
  const since = !Object.hasOwn(changes, "unresolved") ? {} : changes.unresolved === true
    ? { unresolvedSince: prior?.unresolved === true ? prior.unresolvedSince ?? now() : now() } : { unresolvedSince: null };
  runtime.store.put("botActivity", { ...prior, ...changes, ...since,
    ...(Object.hasOwn(changes, 'reconciliationError') && changes.reconciliationError === null ? { recoveryKind: null, recoveryCheckedAt: null } : {}),
    id: botId, botId, threadId: runtime.store.bot(botId).threadId, generation: token.generation + 1, activeTurnId });
}

/** @param {Runtime} runtime */
export const activityUnresolved = (runtime, botId) => {
  const activity = runtime.store.get("botActivity", botId);
  return activity?.unresolved === true || Boolean(activity && activity.threadId !== runtime.store.bot(botId).threadId);
};

const waitingFlags = status => status?.type === "active" && status.activeFlags?.some(flag =>
  flag === "waitingOnApproval" || flag === "waitingOnUserInput");
const noWaitingObservation = { nativeStatus: null, nativeStatusThreadId: null, nativeStatusTurnId: null };

// Persisted status is an observation, not a question or current-execution proof.
/** @param {Runtime} runtime */
export const nativeWaiting = (runtime, botId) => {
  const bot = runtime.store.bot(botId), activity = runtime.store.get("botActivity", botId);
  return Boolean(activity && observedActiveTurn(runtime, botId, bot.activeTurnId) &&
    activity.threadId === bot.threadId && activity.nativeStatusThreadId === bot.threadId && activity.nativeStatusTurnId === bot.activeTurnId &&
    waitingFlags(activity.nativeStatus));
};

// Exact pending questions remain visible independently of a current-turn proof:
// nonblocking questions can intentionally outlive the turn which asked them.
/** @param {Runtime} runtime */
export const pendingQuestions = (runtime, botId) => {
  const threadId = runtime.store.bot(botId).threadId;
  return runtime.store.list("pending", botId).filter(p => p.request?.params?.threadId === threadId &&
    usableTurnId(p.request?.params?.turnId));
};
/** @param {Runtime} runtime */
const blockingQuestion = (runtime, botId) => pendingQuestions(runtime, botId).some(p => p.request.params.isBlocking !== false);

/** @param {Runtime} runtime */
export function settledInputStatus(runtime, botId, blockingOnly = false) {
  const bot = runtime.store.bot(botId);
  if (nativeWaiting(runtime, botId) || (blockingOnly ? blockingQuestion(runtime, botId) : pendingQuestions(runtime, botId).length)) return "waiting";
  if (activityUnresolved(runtime, botId)) return bot.status === "error" ? "error" : "interrupted";
  return observedActiveTurn(runtime, botId, bot.activeTurnId) ? "running" : bot.queuePaused ? "interrupted" : "idle";
}

// Status notifications carry current thread authority but no turn identity.
// Fence outstanding reads/ACKs, then recover identity without inventing a
// terminal outcome or replaying input. In particular, unload invalidates the
// subscription cache so the next bounded recovery actually resumes it.
/** @param {Runtime} runtime */
export function observeThreadStatus(runtime, botId, status) {
  if (!status || !["idle", "active", "notLoaded", "systemError"].includes(status.type)) return false;
  return runtime.store.transaction(() => {
    const bot = runtime.store.bot(botId);
    const known = runtime.store.get("botActivity", botId)?.threadId === bot.threadId &&
      observedActiveTurn(runtime, botId, bot.activeTurnId);
    const unresolved = status.type !== "active" || !known;
    advanceActivity(runtime, botId, bot.activeTurnId, { ...(known && status.type === "active" ?
      { nativeStatus: status, nativeStatusThreadId: bot.threadId, nativeStatusTurnId: bot.activeTurnId } : noWaitingObservation),
      ...(unresolved ? { unresolved: true, reason: `native-thread-${status.type}`,
        reconcileAfter: null, reconciliationError: null, attempts: 0 } : {}) });
    if (status.type === "notLoaded" && bot.threadId) runtime.loaded.delete(bot.threadId);
    runtime.saveBot(bot, { status: status.type === "systemError" ? "error" :
      settledInputStatus(runtime, botId, true) });
    return true;
  });
}

/** @param {Runtime} runtime */
export function requireCurrentActivity(runtime, botId, turnId = null, reason = "current-state-required") {
  const current = activityRecord(runtime, botId);
  if (current.unresolved && !current.nativeStatus && (!turnId || current.unresolvedTurnId === turnId)) return;
  advanceActivity(runtime, botId, current.activeTurnId, { ...noWaitingObservation, unresolved: true,
    unresolvedTurnId: turnId ?? current.unresolvedTurnId ?? null, reason,
    reconcileAfter: null, reconciliationError: null, attempts: 0 });
}

// Only an actual new submission may invalidate a previous current-state proof.
// Persist before crossing that boundary, including when its ACK is later lost.
// This is ordering metadata; original operations/inputs remain in their ledger.
/** @param {Runtime} runtime */
export function beginTurnDispatch(runtime, botId, operationId) {
  protectBrowser(runtime, botId);
  return runtime.store.transaction(() => {
    const generation = captureActivity(runtime, botId).generation + 1;
    advanceActivity(runtime, botId, activityRecord(runtime, botId).activeTurnId, {
      ...noWaitingObservation, unresolved: true, unresolvedTurnId: null, reason: "native-start-in-flight",
      dispatchOperationId: operationId, dispatchGeneration: generation,
      reconcileAfter: null, reconciliationError: null, attempts: 0,
    });
    return { botId, generation, activityThreadId: runtime.store.bot(botId).threadId, operationId, authority: "submission" };
  });
}

/** @param {Runtime} runtime */
function ownsDispatch(runtime, botId, token) {
  const activity = runtime.store.get("botActivity", botId);
  return token?.authority === "submission" && token.botId === botId &&
    !!activity && activity.dispatchOperationId === token.operationId && activity.dispatchGeneration === token.generation;
}

// A real submission's late ACK/error is new evidence, unlike an arbitrary
// number of later history reads. It may require a new current read, but never
// replaces newer active/terminal state. Only dispatch call sites possess this
// token; historical recovery cannot manufacture one from captureActivity.
/** @param {Runtime} runtime @param {string} botId @param {any} token @param {any} [turn] */
export function requireDispatchReconciliation(runtime, botId, token, turn = null) {
  if (!ownsDispatch(runtime, botId, token) || terminalTurn(turn) ||
      (usableTurnId(turn?.id) && (terminalTurn(runtime.store.get("planTurnEvidence", turn.id)) || observedActiveTurn(runtime, botId, turn.id)))) return;
  requireCurrentActivity(runtime, botId, usableTurn(turn) ? turn.id : null, "submission-needs-current-state");
}

/** @param {Runtime} runtime */
export function observedActiveTurn(runtime, botId, turnId) {
  return Boolean(!activityUnresolved(runtime, botId) && usableTurnId(turnId) && runtime.store.bot(botId).activeTurnId === turnId &&
    runtime.store.get("botActivity", botId)?.activeTurnId === turnId &&
    !terminalTurn(runtime.store.get("planTurnEvidence", turnId)));
}

/** @param {Runtime} runtime @param {string} botId @param {any} turn @param {object} changes @param {any} [nativeStatus] */
function saveActive(runtime, botId, turn, changes, nativeStatus) {
  const bot = runtime.store.bot(botId);
  const activity = runtime.store.get("botActivity", botId);
  const observation = nativeStatus ?? (activity && activity.threadId === bot.threadId && activity.nativeStatusThreadId === bot.threadId &&
    activity.nativeStatusTurnId === turn.id ? activity.nativeStatus : null);
  advanceActivity(runtime, botId, turn.id, { nativeStatus: observation,
    nativeStatusThreadId: observation ? bot.threadId : null, nativeStatusTurnId: observation ? turn.id : null,
    unresolved: false, unresolvedTurnId: null,
    reason: null, reconcileAfter: null, reconciliationError: null, attempts: 0 });
  const active = runtime.store.get("activeRun", botId);
  if (active?.turnId && active.turnId !== turn.id) runtime.store.remove("activeRun", botId);
  runtime.saveBot(bot, { ...changes, activeTurnId: turn.id,
    // This native start/current read establishes turn identity in the same transaction.
    status: waitingFlags(observation) || blockingQuestion(runtime, botId) ? "waiting" : "running" });
}

// Direct native start observations, unlike awaited snapshots, establish the
// next generation themselves. Both generation and bot state commit together.
/** @param {Runtime} runtime */
export function observeStartedTurn(runtime, botId, turn, changes = {}) {
  if (!usableTurn(turn) || turn.status !== "inProgress") return false;
  return runtime.store.transaction(() => {
    if (terminalTurn(runtime.store.get("planTurnEvidence", turn.id))) return false;
    saveActive(runtime, botId, turn, changes);
    return true;
  });
}

// Native completion is authoritative about this turn, not about a newer turn.
/** @param {Runtime} runtime */
export function projectTerminalTurn(runtime, botId, turn, completeEvidence = false) {
  if (!terminalTurn(turn)) return false;
  return runtime.store.transaction(() => {
    const activity = activityRecord(runtime, botId);
    const previous = runtime.store.get("planTurnEvidence", turn.id);
    // Duplicate unrelated terminal evidence does not establish new current
    // activity, and must not starve the current-state reconciliation reader.
    if (previous?.status !== turn.status || activity.activeTurnId === turn.id || runtime.store.bot(botId).activeTurnId === turn.id)
      advanceActivity(runtime, botId, activity.activeTurnId === turn.id ? null : activity.activeTurnId,
        activity.activeTurnId === turn.id ? noWaitingObservation : {});
    runtime.plans.note(botId, { method: "turn/completed", params: { turn } }, completeEvidence);
    for (const pending of runtime.store.list("pending", botId)) {
      if (!pending.async && pending.request.params.turnId === turn.id) {
        runtime.store.remove("pending", pending.id);
        runtime.emitEvent("request.resolved", { key: pending.id }, botId);
      }
    }
    const bot = runtime.store.bot(botId);
    const matches = bot.activeTurnId === turn.id;
    if (matches) runtime.saveBot(bot, {
      activeTurnId: null,
      status: turn.status === "interrupted" ? "interrupted" : turn.status === "failed" ? "error" :
        pendingQuestions(runtime, botId).length ? "waiting" : bot.queuePaused ? "interrupted" : "idle",
      ...(turn.status === "interrupted" ? { queuePaused: true } : {}),
      error: turn.error?.message ?? null, updatedAt: now(),
    });
    if (matches && turn.status === "interrupted") runtime.bursts?.pause(botId);
    const active = runtime.store.get("activeRun", botId);
    if (active?.turnId === turn.id) runtime.store.remove("activeRun", botId);
    const watch = runtime.store.get("turnWatch", botId);
    if (watch && watch.turnId === turn.id) runtime.store.put("turnWatch", { ...watch, state: "terminal", checkedAt: now() });
    return matches;
  });
}

// ACK authority is tied to the actual dispatch, never a token captured before
// a historical lookup. A later current proof wins, even if old history still
// says inProgress. A stale ACK can retain containment for a fresh current read;
// later historical recovery cannot repeat that invalidation.
/** @param {Runtime} runtime */
export function acknowledgeTurnDispatch(runtime, botId, turn, token, changes = {}) {
  requireTurn(turn); // Validate terminal ACKs too, before the early return.
  if (turn.status !== "inProgress") return false;
  return runtime.store.transaction(() => {
    if (!ownsDispatch(runtime, botId, token)) return false;
    if (!activityUnchanged(runtime, botId, token)) {
      requireDispatchReconciliation(runtime, botId, token, turn);
      return false;
    }
    const terminal = runtime.store.get("planTurnEvidence", turn.id);
    const bot = runtime.store.bot(botId);
    if ((terminal?.botId === botId && terminalTurn(terminal)) || (bot.activeTurnId && bot.activeTurnId !== turn.id)) {
      requireDispatchReconciliation(runtime, botId, token, turn);
      return false;
    }
    saveActive(runtime, botId, turn, changes);
    return true;
  });
}

// Only a fenced native CURRENT-state read uses these functions. They do not
// mark an old operation/turn completed, rejected, or safe to replay.
/** @param {Runtime} runtime */
export function projectCurrentActive(runtime, botId, turn, token, nativeStatus) {
  return runtime.store.transaction(() => {
    if (!activityUnchanged(runtime, botId, token) || !usableTurn(turn) || turn.status !== "inProgress" ||
        terminalTurn(runtime.store.get("planTurnEvidence", turn.id))) return false;
    saveActive(runtime, botId, turn, {}, nativeStatus);
    return true;
  });
}

/** @param {Runtime} runtime @param {string} botId @param {any} token @param {any} [latest] */
export function projectCurrentIdle(runtime, botId, token, latest = null) {
  return runtime.store.transaction(() => {
    if (!activityUnchanged(runtime, botId, token)) return false;
    const bot = runtime.store.bot(botId);
    // Separate exact terminal evidence can retain a missed interruption gate.
    // An idle status alone never invents a historical outcome.
    if (terminalTurn(latest) && (bot.activeTurnId === latest.id ||
        runtime.store.get("botActivity", botId)?.activeTurnId === latest.id)) {
      runtime.recordScheduledEvidence(botId, latest);
      projectTerminalTurn(runtime, botId, latest);
      if (latest.status === "interrupted" && !runtime.store.bot(botId).queuePaused)
        runtime.saveBot(runtime.store.bot(botId), { queuePaused: true });
    }
    advanceActivity(runtime, botId, null, { unresolved: false, unresolvedTurnId: null,
      ...noWaitingObservation, reason: null, reconcileAfter: null, reconciliationError: null, attempts: 0 });
    runtime.store.remove("activeRun", botId);
    const current = runtime.store.bot(botId);
    runtime.saveBot(current, { activeTurnId: null, status: pendingQuestions(runtime, botId).length ? "waiting" :
      current.queuePaused ? "interrupted" : "idle" });
    return true;
  });
}

// Receipt success means accepted, not finished. Supervise active main turns
// even after a queue/send operation has a done receipt and left its retry list.
/** @param {Runtime} runtime @param {number} [limit] @param {(botId: string) => boolean} [eligible] */
export async function reconcileActiveTurns(runtime, limit = 2, eligible = () => true) {
  let checked = 0;
  for (const bot of runtime.store.bots()) {
    // A turn on a bot with no thread cannot be read back; nothing to reconcile.
    if (!bot.activeTurnId || !bot.threadId || bot.archived || runtime.locks.has(bot.id) || checked >= limit || !eligible(bot.id)) continue;
    const threadId = bot.threadId;
    const watch = runtime.store.get("turnWatch", bot.id);
    const same = watch?.turnId === bot.activeTurnId && watch.threadId === bot.threadId;
    if (same && Date.parse(watch.reconcileAfter ?? "") > Date.now()) continue;
    checked++;
    await runtime.lock(bot.id, async () => {
      const selected = runtime.store.bot(bot.id);
      if (selected.activeTurnId !== bot.activeTurnId || selected.threadId !== bot.threadId) return;
      const known = observedActiveTurn(runtime, bot.id, bot.activeTurnId);
      const token = runtime.store.get("botActivity", bot.id) ? captureActivity(runtime, bot.id) : null;
      const epoch = runtime.epoch, native = runtime.codex.process;
      runtime.store.put("turnWatch", { id: bot.id, botId: bot.id, turnId: bot.activeTurnId, state: "checking",
        threadId: bot.threadId,
        cursor: same ? watch?.cursor : null, reconcileAfter: new Date(Date.now() + 60000).toISOString() });
      const currentScope = () => {
        const selected = runtime.store.bot(bot.id), current = runtime.store.get("turnWatch", bot.id);
        const activityMatches = token ? activityUnchanged(runtime, bot.id, token) : !runtime.store.get("botActivity", bot.id);
        return runtime.epoch === epoch && runtime.codex.process === native && activityMatches &&
          selected.activeTurnId === bot.activeTurnId && selected.threadId === bot.threadId &&
          !!current && current.turnId === bot.activeTurnId && current.threadId === bot.threadId && current.state !== "terminal";
      };
      const cursor = same ? watch?.cursor : null;
      const found = known
        ? await readKnownActiveTurn(runtime, bot, cursor, currentScope)
        : await findNativeTurn(runtime, threadId, { turnId: bot.activeTurnId, cursor });
      const current = runtime.store.get("turnWatch", bot.id);
      if (!currentScope() || !current) return;
      const completeEvidence = found.completeEvidence ?? (found.turn?.itemsView === "full");
      runtime.store.put("turnWatch", { ...current, cursor: found.nextCursor, state: found.turn ? "observed" : "unconfirmed", checkedAt: now() });
      if (found.turn && completeEvidence) {
        runtime.recordScheduledEvidence(bot.id, found.turn);
        projectTerminalTurn(runtime, bot.id, found.turn, completeEvidence);
      }
    }).catch(error => runtime.emit("fault", error));
  }
}

// An accepted inbox record names its ORIGINAL native turn. When that turn's
// completion was missed and the bot has since moved on, it is no longer the
// bot's activeTurnId, so the watchdog above never reads it again and the
// record counts as accepted-or-unknown work forever. Read that exact turn
// (bounded, read-only, summary view) and settle only a terminal native fact.
// Absence or inProgress leaves the record accepted; nothing is resubmitted.
/** @param {Runtime} runtime @param {number} [limit] @param {(botId: string) => boolean} [eligible] */
export async function reconcileAcceptedInbox(runtime, limit = 2, eligible = () => true) {
  const rows = runtime.store.db.prepare(`SELECT json_remove(json,'$.text','$.input') AS json FROM records WHERE kind='primaryInbox'
    AND json_extract(json,'$.state')='accepted' AND json_extract(json,'$.terminalStatus') IS NULL AND json_extract(json,'$.turnId') IS NOT NULL ORDER BY rowid`).all();
  const due = item => {
    const bot = runtime.store.bots().find(b => b.id === item?.botId);
    return Boolean(bot && !bot.archived && item.state === "accepted" && !item.terminalStatus && usableTurnId(item.turnId) &&
      item.threadId === bot.threadId && bot.activeTurnId !== item.turnId &&
      runtime.store.get("botActivity", bot.id)?.activeTurnId !== item.turnId && !(Date.parse(item.reconcileAfter ?? "") > Date.now()));
  };
  let checked = 0;
  for (const { json } of rows) {
    const item = JSON.parse(String(json));
    if (checked >= limit) break;
    if (!due(item) || runtime.locks.has(item.botId) || !eligible(item.botId)) continue;
    checked++;
    await runtime.lock(item.botId, async () => {
      const current = runtime.store.get("primaryInbox", item.id);
      if (!current || !due(current) || current.turnId !== item.turnId) return;
      runtime.store.put("primaryInbox", { ...current, reconcileAfter: new Date(Date.now() + 60000).toISOString() });
      const found = await findNativeTurn(runtime, current.threadId, { turnId: current.turnId, cursor: current.reconcileCursor ?? null, itemsView: "summary" });
      const latest = runtime.store.get("primaryInbox", item.id);
      if (!latest || latest.state !== "accepted" || latest.terminalStatus || latest.turnId !== current.turnId || latest.threadId !== current.threadId) return;
      if (terminalTurn(found.turn)) runtime.primary.bind(latest, found.turn);
      else runtime.store.put("primaryInbox", { ...latest, reconcileCursor: found.nextCursor });
    }).catch(error => runtime.emit("fault", error));
  }
  return checked;
}
