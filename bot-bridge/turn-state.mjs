import { findNativeTurn } from "./native-reconcile.mjs";

const now = () => new Date().toISOString();
export const terminalTurn = turn => ["completed", "failed", "interrupted"].includes(turn?.status);

// Native completion is authoritative about this turn, not about a newer turn.
export function projectTerminalTurn(runtime, botId, turn, completeEvidence = false) {
  if (!terminalTurn(turn)) return false;
  return runtime.store.transaction(() => {
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

export function projectActiveTurn(runtime, botId, turn, changes = {}) {
  if (turn.status !== "inProgress") return false;
  const terminal = runtime.store.get("planTurnEvidence", turn.id);
  const bot = runtime.store.bot(botId);
  if ((terminal?.botId === botId && terminalTurn(terminal)) || (bot.activeTurnId && bot.activeTurnId !== turn.id)) return false;
  runtime.saveBot(bot, { ...changes, activeTurnId: turn.id,
    status: runtime.store.list("pending", botId).some(pending => pending.request.params.isBlocking !== false) ? "waiting" : "running" });
  return true;
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
