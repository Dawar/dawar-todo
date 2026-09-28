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
  if (run.executionLane === "run-v1") return;
  const bot = runtime.store.bot(run.botId);
  const found = await findNativeTurn(runtime, run.threadId ?? bot.threadId, {
    turnId: run.turnId, clientId: run.operationId ?? `schedule:${run.id}`, cursor: run.reconcileCursor ?? null,
  });
  runtime.store.transaction(() => {
    const current = runtime.store.get("run", run.id);
    if (!current) return;
    if (terminal.has(current.status)) {
      if (found.turn?.id === current.turnId) {
        runtime.projectTerminalTurn(bot.id, found.turn, true);
        finishLocalOperation(runtime.store, run.operationId ?? `schedule:${run.id}`, { turn: found.turn });
      }
      return;
    }
    if (!["starting", "running", "uncertain"].includes(current.status)) return;
    runtime.store.put("run", { ...current, reconcileCursor: found.nextCursor,
      reconcileAfter: new Date(Date.now() + 60000).toISOString(),
      ...(found.turn ? { turnId: found.turn.id, status: found.turn.status === "inProgress" ? "running" : found.turn.status,
        error: found.turn.error?.message ?? null, ...(terminal.has(found.turn.status) ? { finishedAt: now() } : {}) } : {}) });
    if (found.turn) {
      runtime.recordScheduledTurn(bot.id, run.id, run.operationId ?? `schedule:${run.id}`, found.turn);
      runtime.projectTerminalTurn(bot.id, found.turn, true);
      finishLocalOperation(runtime.store, run.operationId ?? `schedule:${run.id}`, { turn: found.turn });
    }
    runtime.emitEvent("schedules", {}, bot.id);
  });
}

export function scheduledContext(runtime, botId, turnId = runtime.store.bot(botId).activeTurnId) {
  if (!turnId) return null;
  const find = kind => {
    const row = runtime.store.db.prepare(`SELECT json FROM records WHERE kind=? AND kind IN ('run','runTurn')
      AND bot_id=? AND json_extract(json,'$.turnId')=? AND json_extract(json,'$.laneId') IS NULL
      AND COALESCE(json_extract(json,'$.executionLane'),'main-legacy')<>'run-v1' LIMIT 1`).get(kind, botId, turnId);
    return row ? JSON.parse(row.json) : null;
  };
  const continuation = find("runTurn");
  const run = continuation ? runtime.store.get("run", continuation.runId) :
    find("run");
  if (run?.botId === botId) return { botId, runId: run.id, turnId,
    operationId: continuation?.operationId ?? run.operationId ?? `schedule:${run.id}` };
  const active = runtime.store.get("activeRun", botId);
  if (active?.botId === botId && active.turnId === turnId && runtime.store.get("run", active.runId)?.botId === botId) return active;
  return null;
}

export async function reconcileRunTurn(runtime, receipt) {
  if (receipt.laneId) return;
  const bot = runtime.store.bot(receipt.botId);
  if (runtime.store.get("run", receipt.runId)?.botId !== bot.id) throw new Error("Scheduled continuation owner mismatch.");
  const found = await findNativeTurn(runtime, receipt.threadId ?? bot.threadId, {
    turnId: receipt.turnId, clientId: receipt.operationId ?? receipt.id, cursor: receipt.reconcileCursor ?? null,
  });
  runtime.store.transaction(() => {
    const current = runtime.store.get("runTurn", receipt.id);
    if (!current || terminal.has(current.status)) return;
    runtime.store.put("runTurn", { ...current, threadId: receipt.threadId ?? bot.threadId,
      status: found.turn ? current.status : "uncertain", reconcileCursor: found.nextCursor,
      reconcileAfter: new Date(Date.now() + 60000).toISOString(), checkedAt: now() });
    if (!found.turn) return; // Retain original identity; never dispatch a replacement.
    runtime.recordScheduledTurn(bot.id, receipt.runId, receipt.operationId ?? receipt.id, found.turn);
    runtime.projectTerminalTurn(bot.id, found.turn, true);
    finishLocalOperation(runtime.store, receipt.operationId ?? receipt.id, { turn: found.turn });
  });
}

export async function recoverRunTurns(runtime, limit = 2, startup = false) {
  let checked = 0;
  for (const receipt of runtime.store.list("runTurn")) {
    if (receipt.laneId) continue;
    if (terminal.has(receipt.status) || runtime.locks.has(receipt.botId) || checked >= limit ||
        (!startup && Date.parse(receipt.reconcileAfter ?? "") > Date.now())) continue;
    checked++;
    await runtime.lock(receipt.botId, () => reconcileRunTurn(runtime, receipt)).catch(error => {
      const current = runtime.store.get("runTurn", receipt.id);
      if (!current || terminal.has(current.status)) return;
      runtime.store.put("runTurn", { ...current, status: "uncertain", reconciliationError: error.message,
        reconcileAfter: new Date(Date.now() + 60000).toISOString() });
    });
  }
}
