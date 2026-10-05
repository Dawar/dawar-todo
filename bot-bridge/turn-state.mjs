import { findNativeTurn } from "./native-reconcile.mjs";

import { usableTurn, usableTurnId, requireTurn, terminalTurn } from "./native-turn.mjs";
export { terminalTurn } from "./native-turn.mjs";

const now = () => new Date().toISOString();

// Persist observed ordering, including idle after completion. Bot locks do not
// serialize native notifications. Tokens must precede the first awaited read
// or mutation whose response might later project active state.
export function captureActivity(runtime, botId) {
  let activity = runtime.store.get("botActivity", botId);
  if (!activity) activity = runtime.store.put("botActivity", {
    id: botId, botId, threadId: runtime.store.bot(botId).threadId, generation: 0, activeTurnId: runtime.store.bot(botId).activeTurnId ?? null,
  });
  return { botId, generation: activity.generation, activityThreadId: runtime.store.bot(botId).threadId };
}

export function activityUnchanged(runtime, botId, token) {
  return token?.botId === botId && token.activityThreadId === runtime.store.bot(botId).threadId && Number.isSafeInteger(token.generation) &&
    runtime.store.get("botActivity", botId)?.generation === token.generation;
}

function advanceActivity(runtime, botId, activeTurnId, changes = {}) {
  const token = captureActivity(runtime, botId);
  if (!Number.isSafeInteger(token.generation + 1)) throw new Error("Observed activity generation exhausted.");
  runtime.store.put("botActivity", { ...runtime.store.get("botActivity", botId), ...changes,
    id: botId, botId, threadId: runtime.store.bot(botId).threadId, generation: token.generation + 1, activeTurnId });
}

export const activityUnresolved = (runtime, botId) => {
  const activity = runtime.store.get("botActivity", botId);
  return activity?.unresolved === true || Boolean(activity && activity.threadId !== runtime.store.bot(botId).threadId);
};

const waitingFlags = status => status?.type === "active" && status.activeFlags?.some(flag =>
  flag === "waitingOnApproval" || flag === "waitingOnUserInput");
const noWaitingObservation = { nativeStatus: null, nativeStatusThreadId: null, nativeStatusTurnId: null };

// Persisted status is an observation, not a question or current-execution proof.
export const nativeWaiting = (runtime, botId) => {
  const bot = runtime.store.bot(botId), activity = runtime.store.get("botActivity", botId);
  return Boolean(observedActiveTurn(runtime, botId, bot.activeTurnId) &&
    activity.threadId === bot.threadId && activity.nativeStatusThreadId === bot.threadId && activity.nativeStatusTurnId === bot.activeTurnId &&
    waitingFlags(activity.nativeStatus));
};

// Exact pending questions remain visible independently of a current-turn proof:
// nonblocking questions can intentionally outlive the turn which asked them.
export const pendingQuestions = (runtime, botId) => {
  const threadId = runtime.store.bot(botId).threadId;
  return runtime.store.list("pending", botId).filter(p => p.request?.params?.threadId === threadId &&
    usableTurnId(p.request?.params?.turnId));
};
const blockingQuestion = (runtime, botId) => pendingQuestions(runtime, botId).some(p => p.request.params.isBlocking !== false);

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
    if (status.type === "notLoaded") runtime.loaded.delete(bot.threadId);
    runtime.saveBot(bot, { status: status.type === "systemError" ? "error" :
      settledInputStatus(runtime, botId, true) });
    return true;
  });
}

export function requireCurrentActivity(runtime, botId, turnId = null, reason = "current-state-required") {
  captureActivity(runtime, botId);
  const current = runtime.store.get("botActivity", botId);
  if (current.unresolved && !current.nativeStatus && (!turnId || current.unresolvedTurnId === turnId)) return;
  advanceActivity(runtime, botId, current.activeTurnId, { ...noWaitingObservation, unresolved: true,
    unresolvedTurnId: turnId ?? current.unresolvedTurnId ?? null, reason,
    reconcileAfter: null, reconciliationError: null, attempts: 0 });
}

// Only an actual new submission may invalidate a previous current-state proof.
// Persist before crossing that boundary, including when its ACK is later lost.
// This is ordering metadata; original operations/inputs remain in their ledger.
export function beginTurnDispatch(runtime, botId, operationId) {
  return runtime.store.transaction(() => {
    const generation = captureActivity(runtime, botId).generation + 1;
    advanceActivity(runtime, botId, runtime.store.get("botActivity", botId).activeTurnId, {
      ...noWaitingObservation, unresolved: true, unresolvedTurnId: null, reason: "native-start-in-flight",
      dispatchOperationId: operationId, dispatchGeneration: generation,
      reconcileAfter: null, reconciliationError: null, attempts: 0,
    });
    return { botId, generation, activityThreadId: runtime.store.bot(botId).threadId, operationId, authority: "submission" };
  });
}

function ownsDispatch(runtime, botId, token) {
  const activity = runtime.store.get("botActivity", botId);
  return token?.authority === "submission" && token.botId === botId &&
    activity?.dispatchOperationId === token.operationId && activity.dispatchGeneration === token.generation;
}

// A real submission's late ACK/error is new evidence, unlike an arbitrary
// number of later history reads. It may require a new current read, but never
// replaces newer active/terminal state. Only dispatch call sites possess this
// token; historical recovery cannot manufacture one from captureActivity.
export function requireDispatchReconciliation(runtime, botId, token, turn = null) {
  if (!ownsDispatch(runtime, botId, token) || terminalTurn(turn) ||
      (usableTurnId(turn?.id) && (terminalTurn(runtime.store.get("planTurnEvidence", turn.id)) || observedActiveTurn(runtime, botId, turn.id)))) return;
  requireCurrentActivity(runtime, botId, usableTurn(turn) ? turn.id : null, "submission-needs-current-state");
}

export function observedActiveTurn(runtime, botId, turnId) {
  return Boolean(!activityUnresolved(runtime, botId) && usableTurnId(turnId) && runtime.store.bot(botId).activeTurnId === turnId &&
    runtime.store.get("botActivity", botId)?.activeTurnId === turnId &&
    !terminalTurn(runtime.store.get("planTurnEvidence", turnId)));
}

function saveActive(runtime, botId, turn, changes, nativeStatus) {
  const bot = runtime.store.bot(botId);
  const activity = runtime.store.get("botActivity", botId);
  const observation = nativeStatus ?? (activity?.threadId === bot.threadId && activity.nativeStatusThreadId === bot.threadId &&
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
export function observeStartedTurn(runtime, botId, turn, changes = {}) {
  if (!usableTurn(turn) || turn.status !== "inProgress") return false;
  return runtime.store.transaction(() => {
    if (terminalTurn(runtime.store.get("planTurnEvidence", turn.id))) return false;
    saveActive(runtime, botId, turn, changes);
    return true;
  });
}

// Native completion is authoritative about this turn, not about a newer turn.
export function projectTerminalTurn(runtime, botId, turn, completeEvidence = false) {
  if (!terminalTurn(turn)) return false;
  return runtime.store.transaction(() => {
    captureActivity(runtime, botId);
    const activity = runtime.store.get("botActivity", botId);
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
    if (watch?.turnId === turn.id) runtime.store.put("turnWatch", { ...watch, state: "terminal", checkedAt: now() });
    return matches;
  });
}

// ACK authority is tied to the actual dispatch, never a token captured before
// a historical lookup. A later current proof wins, even if old history still
// says inProgress. A stale ACK can retain containment for a fresh current read;
// later historical recovery cannot repeat that invalidation.
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
export function projectCurrentActive(runtime, botId, turn, token, nativeStatus) {
  return runtime.store.transaction(() => {
    if (!activityUnchanged(runtime, botId, token) || !usableTurn(turn) || turn.status !== "inProgress" ||
        terminalTurn(runtime.store.get("planTurnEvidence", turn.id))) return false;
    saveActive(runtime, botId, turn, {}, nativeStatus);
    return true;
  });
}

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
export async function reconcileActiveTurns(runtime, limit = 2) {
  let checked = 0;
  for (const bot of runtime.store.bots()) {
    if (!bot.activeTurnId || bot.archived || runtime.locks.has(bot.id) || checked >= limit) continue;
    const watch = runtime.store.get("turnWatch", bot.id);
    const same = watch?.turnId === bot.activeTurnId;
    if (same && Date.parse(watch.reconcileAfter ?? "") > Date.now()) continue;
    checked++;
    await runtime.lock(bot.id, async () => {
      if (runtime.store.bot(bot.id).activeTurnId !== bot.activeTurnId) return;
      runtime.store.put("turnWatch", { id: bot.id, botId: bot.id, turnId: bot.activeTurnId, state: "checking",
        cursor: same ? watch.cursor : null, reconcileAfter: new Date(Date.now() + 60000).toISOString() });
      const found = await findNativeTurn(runtime, bot.threadId, { turnId: bot.activeTurnId, cursor: same ? watch.cursor : null });
      const current = runtime.store.get("turnWatch", bot.id);
      if (current?.turnId !== bot.activeTurnId || current.state === "terminal") return;
      runtime.store.put("turnWatch", { ...current, cursor: found.nextCursor, state: found.turn ? "observed" : "unconfirmed", checkedAt: now() });
      if (found.turn) {
        runtime.recordScheduledEvidence(bot.id, found.turn);
        projectTerminalTurn(runtime, bot.id, found.turn, true);
      }
    }).catch(error => runtime.emit("fault", error));
  }
}
