import { createHash } from "node:crypto";
import { findNativeTurn } from "./native-reconcile.mjs";
import { finishLocalOperation } from "./prompt-queue.mjs";

const now = () => new Date().toISOString();
const terminal = new Set(["completed", "failed", "interrupted"]);

// Compatibility lane: schedules still use the main native thread. These
// receipts preserve identity for the later independent-background-thread lane.
export async function dispatchScheduled(runtime, bot, run) {
  const operationId = `schedule:${run.id}`;
  if (runtime.store.operation(operationId)) return; // Reconciliation, never blind retry.
  const fingerprint = createHash("sha256").update(JSON.stringify({ botId: bot.id, runId: run.id, prompt: run.prompt })).digest("hex");
  runtime.store.transaction(() => {
    runtime.store.put("run", { ...run, operationId, threadId: bot.threadId, executionLane: "main-legacy",
      status: "starting", startedAt: now() });
    runtime.store.saveOperation(operationId, fingerprint, "dispatching", {
      method: "schedule.dispatch", botId: bot.id, runId: run.id, clientId: operationId, createdAt: now(),
    });
  });
  const attempt = { started: false, rejected: false };
  try {
    const result = await runtime.send(bot, { text: run.prompt }, operationId, run, attempt);
    finishLocalOperation(runtime.store, operationId, result);
  } catch (error) {
    const current = runtime.store.get("run", run.id);
    // Native terminal notification can precede the RPC reply or local failure.
    if (terminal.has(current.status) && current.turnId) {
      finishLocalOperation(runtime.store, operationId, { turnId: current.turnId });
    } else {
      const uncertain = attempt.started && !attempt.rejected;
      runtime.store.transaction(() => {
        runtime.store.put("run", { ...current, status: uncertain ? "uncertain" : "failed", error: error.message,
          ...(uncertain ? {} : { finishedAt: now() }) });
        runtime.store.saveOperation(operationId, fingerprint, uncertain ? "uncertain" : "failed", {
          ...runtime.store.operation(operationId), outcome: uncertain ? "uncertain" : "rejected", error: error.message,
        });
        if (!uncertain && runtime.store.get("activeRun", bot.id)?.operationId === operationId)
          runtime.store.remove("activeRun", bot.id);
      });
      runtime.notify(bot, `schedule-failure:${run.id}`, error.message);
    }
  }
  runtime.emitEvent("schedules", {}, bot.id);
}

export async function reconcileScheduled(runtime, run) {
  const bot = runtime.store.bot(run.botId);
  const found = await findNativeTurn(runtime, run.threadId ?? bot.threadId, {
    turnId: run.turnId, clientId: run.operationId ?? `schedule:${run.id}`, cursor: run.reconcileCursor ?? null,
  });
  runtime.store.transaction(() => {
    const current = runtime.store.get("run", run.id);
    if (!current || !["starting", "running", "uncertain"].includes(current.status)) return;
    runtime.store.put("run", { ...current, reconcileCursor: found.nextCursor,
      reconcileAfter: new Date(Date.now() + 60000).toISOString(),
      ...(found.turn ? { turnId: found.turn.id, status: found.turn.status === "inProgress" ? "running" : found.turn.status,
        error: found.turn.error?.message ?? null, ...(terminal.has(found.turn.status) ? { finishedAt: now() } : {}) } : {}) });
    if (found.turn) {
      const active = runtime.store.get("activeRun", bot.id);
      if (found.turn.status === "inProgress" && (!active || active.turnId === found.turn.id ||
          active.operationId === (run.operationId ?? `schedule:${run.id}`))) {
        runtime.store.put("activeRun", { id: bot.id, botId: bot.id, runId: run.id,
          operationId: run.operationId ?? `schedule:${run.id}`, turnId: found.turn.id });
        const currentBot = runtime.store.bot(bot.id);
        if (!currentBot.activeTurnId || currentBot.activeTurnId === found.turn.id)
          runtime.saveBot(currentBot, { activeTurnId: found.turn.id, status: "running" });
      } else if (terminal.has(found.turn.status) && active?.runId === run.id &&
          (active.turnId === found.turn.id || active.operationId === (run.operationId ?? `schedule:${run.id}`)))
        runtime.store.remove("activeRun", bot.id);
      finishLocalOperation(runtime.store, run.operationId ?? `schedule:${run.id}`, { turn: found.turn });
    }
    runtime.emitEvent("schedules", {}, bot.id);
  });
}
