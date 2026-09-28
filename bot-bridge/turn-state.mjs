import { findNativeTurn } from "./native-reconcile.mjs";

const now = () => new Date().toISOString();
export const terminalTurn = turn => ["completed", "failed", "interrupted"].includes(turn?.status);

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

function advanceActivity(runtime, botId, activeTurnId) {
  const token = captureActivity(runtime, botId);
  if (!Number.isSafeInteger(token.generation + 1)) throw new Error("Observed activity generation exhausted.");
  runtime.store.put("botActivity", { id: botId, botId, generation: token.generation + 1, activeTurnId });
}

export function observedActiveTurn(runtime, botId, turnId) {
  return Boolean(turnId && runtime.store.bot(botId).activeTurnId === turnId &&
    runtime.store.get("botActivity", botId)?.activeTurnId === turnId &&
    !terminalTurn(runtime.store.get("planTurnEvidence", turnId)));
}

function saveActive(runtime, botId, turn, changes) {
  const bot = runtime.store.bot(botId);
  advanceActivity(runtime, botId, turn.id);
  const active = runtime.store.get("activeRun", botId);
  if (active?.turnId && active.turnId !== turn.id) runtime.store.remove("activeRun", botId);
  runtime.saveBot(bot, { ...changes, activeTurnId: turn.id,
    status: runtime.store.list("pending", botId).some(pending => pending.request.params.isBlocking !== false) ? "waiting" : "running" });
}

// Direct native start observations, unlike awaited snapshots, establish the
// next generation themselves. Both generation and bot state commit together.
export function observeStartedTurn(runtime, botId, turn, changes = {}) {
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
    const active = runtime.store.get("activeRun", botId);
    if (active?.turnId === turn.id) runtime.store.remove("activeRun", botId);
    const watch = runtime.store.get("turnWatch", botId);
    if (watch?.turnId === turn.id) runtime.store.put("turnWatch", { ...watch, state: "terminal", checkedAt: now() });
    return matches;
  });
}

export function projectActiveTurn(runtime, botId, turn, token, changes = {}) {
  if (turn.status !== "inProgress") return false;
  return runtime.store.transaction(() => {
    if (!activityUnchanged(runtime, botId, token)) return false;
    const terminal = runtime.store.get("planTurnEvidence", turn.id);
    const bot = runtime.store.bot(botId);
    if ((terminal?.botId === botId && terminalTurn(terminal)) || (bot.activeTurnId && bot.activeTurnId !== turn.id)) return false;
    saveActive(runtime, botId, turn, changes);
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
