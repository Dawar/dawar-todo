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
    id: botId, botId, generation: 0, activeTurnId: runtime.store.bot(botId).activeTurnId ?? null,
  });
  return { botId, generation: activity.generation };
}

export function activityUnchanged(runtime, botId, token) {
  return token?.botId === botId && Number.isSafeInteger(token.generation) &&
    runtime.store.get("botActivity", botId)?.generation === token.generation;
}

function advanceActivity(runtime, botId, activeTurnId, changes = {}) {
  const token = captureActivity(runtime, botId);
  if (!Number.isSafeInteger(token.generation + 1)) throw new Error("Observed activity generation exhausted.");
  runtime.store.put("botActivity", { ...runtime.store.get("botActivity", botId), ...changes,
    id: botId, botId, generation: token.generation + 1, activeTurnId });
}

export const activityUnresolved = (runtime, botId) => runtime.store.get("botActivity", botId)?.unresolved === true;

export function requireCurrentActivity(runtime, botId, turnId = null, reason = "current-state-required") {
  captureActivity(runtime, botId);
  const current = runtime.store.get("botActivity", botId);
  if (current.unresolved && (!turnId || current.unresolvedTurnId === turnId)) return;
  advanceActivity(runtime, botId, current.activeTurnId, { unresolved: true,
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
      unresolved: true, unresolvedTurnId: null, reason: "native-start-in-flight",
      dispatchOperationId: operationId, dispatchGeneration: generation,
      reconcileAfter: null, reconciliationError: null, attempts: 0,
    });
    return { botId, generation, operationId, authority: "submission" };
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

function saveActive(runtime, botId, turn, changes) {
  const bot = runtime.store.bot(botId);
  advanceActivity(runtime, botId, turn.id, { unresolved: false, unresolvedTurnId: null,
    reason: null, reconcileAfter: null, reconciliationError: null, attempts: 0 });
  const active = runtime.store.get("activeRun", botId);
  if (active?.turnId && active.turnId !== turn.id) runtime.store.remove("activeRun", botId);
  runtime.saveBot(bot, { ...changes, activeTurnId: turn.id,
    status: runtime.store.list("pending", botId).some(pending => pending.request.params.isBlocking !== false) ? "waiting" : "running" });
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
      advanceActivity(runtime, botId, activity.activeTurnId === turn.id ? null : activity.activeTurnId);
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
        runtime.store.list("pending", botId).length ? "waiting" : bot.queuePaused ? "interrupted" : "idle",
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
export function projectCurrentActive(runtime, botId, turn, token) {
  return runtime.store.transaction(() => {
    if (!activityUnchanged(runtime, botId, token) || !usableTurn(turn) || turn.status !== "inProgress" ||
        terminalTurn(runtime.store.get("planTurnEvidence", turn.id))) return false;
    saveActive(runtime, botId, turn, {});
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
      reason: null, reconcileAfter: null, reconciliationError: null, attempts: 0 });
    runtime.store.remove("activeRun", botId);
    const current = runtime.store.bot(botId);
    runtime.saveBot(current, { activeTurnId: null, status: runtime.store.list("pending", botId).length ? "waiting" :
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
