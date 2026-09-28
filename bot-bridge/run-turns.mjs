import { observedActiveTurn } from "./turn-state.mjs";

const nullable = value => typeof value === "string" && value ? value : null;
const date = value => {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

// Metadata only. Never include internal reconciliation cursors, prompts,
// operation results, native items or file bodies in the activity index.
export function publicRunTurn(receipt) {
  return { id: receipt.id, botId: receipt.botId, runId: receipt.runId,
    operationId: receipt.operationId ?? receipt.id, turnId: nullable(receipt.turnId),
    status: receipt.status, error: nullable(receipt.error)?.slice(0, 2048) ?? null,
    createdAt: date(receipt.createdAt), finishedAt: date(receipt.finishedAt) };
}

export function listRunTurns(runtime, bot, params) {
  if (typeof params.runId !== "string" || !params.runId || params.runId.length > 512)
    throw new Error("A valid run ID is required.");
  runtime.owned("run", params.runId, bot.id);
  const limit = params.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Choose a page size from 1 to 50.");
  let after = "";
  if (params.cursor != null) {
    try {
      if (typeof params.cursor !== "string" || params.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(params.cursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8"));
      if (cursor.v !== 1 || cursor.botId !== bot.id || cursor.runId !== params.runId ||
          typeof cursor.after !== "string" || !cursor.after || cursor.after.length > 512) throw new Error();
      after = cursor.after;
    } catch { throw new Error("Invalid continuation cursor. Reopen this run."); }
  }
  // Stable identity order, independent of mutable status/finish times. New
  // continuations before the current key are discovered by refreshing page 1.
  const rows = runtime.store.db.prepare(`SELECT json FROM records
    WHERE kind='runTurn' AND bot_id=? AND json_extract(json,'$.runId')=? AND id>?
    ORDER BY id LIMIT ?`).all(bot.id, params.runId, after, limit + 1);
  const turns = rows.slice(0, limit).map(row => publicRunTurn(JSON.parse(row.json)));
  return { turns, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({
    v: 1, botId: bot.id, runId: params.runId, after: turns.at(-1).id,
  })).toString("base64url") : null };
}

export function activeScheduledTurn(runtime, botId) {
  const context = runtime.scheduledContext(botId);
  if (!context || !observedActiveTurn(runtime, botId, context.turnId)) return null;
  const run = runtime.store.get("run", context.runId);
  const continuation = context.operationId !== (run.operationId ?? `schedule:${run.id}`);
  const receipt = continuation ? runtime.store.get("runTurn", context.operationId) : run;
  if (["completed", "failed", "interrupted"].includes(receipt?.status) ||
      ["completed", "failed", "interrupted"].includes(runtime.store.get("planTurnEvidence", context.turnId)?.status)) return null;
  return { botId, runId: context.runId, turnId: context.turnId, operationId: context.operationId,
    continuation };
}
