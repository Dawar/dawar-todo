import { createHash } from "node:crypto";
import { findNativeTurn } from "./native-reconcile.mjs";
import { rememberInputProvenance } from "./artifact-outputs.mjs";
import { retainAcceptedActivity } from "./turn-state.mjs";

const now = () => new Date().toISOString();
const pendingStates = new Set(["queued", "dispatching", "uncertain", "failed"]);
export function stagedQueue(store, botId) {
  return store.list("promptQueue", botId).filter(item => pendingStates.has(item.state))
    .sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
export function finishLocalOperation(store, id, result) {
  const operation = store.operation(id);
  if (operation) store.saveOperation(id, operation.fingerprint, "done", { ...operation, result, error: null });
  return result;
}
export function enqueuePrompt(runtime, bot, params, id, input) {
  return runtime.store.transaction(() => {
    const existing = runtime.store.get("promptQueue", id);
    if (existing && existing.botId !== bot.id) throw new Error("Queue identity belongs to another bot.");
    const item = existing ?? runtime.store.put("promptQueue", {
      id, botId: bot.id, threadId: bot.threadId, clientUserMessageId: id, input,
      attachmentIds: [...(params.attachments ?? [])],
      state: "queued", revision: 1, position: Math.max(0, ...stagedQueue(runtime.store, bot.id).map(entry => entry.position)) + 1,
      source: { kind: "conversation", operationId: id }, createdAt: now(),
    });
    runtime.store.put("queuedAttachments", { id, botId: bot.id, attachmentIds: params.attachments ?? [] });
    const result = finishLocalOperation(runtime.store, id, { queuedSubmission: runtime.publicQueued(bot, item) });
    runtime.emitEvent("queue", {}, bot.id);
    return result;
  });
}
export function mutatePrompt(runtime, bot, item, method, params, operationId, input) {
  return runtime.store.transaction(() => {
    item = runtime.store.get("promptQueue", item.id);
    if (!item || item.botId !== bot.id) throw new Error("Queued prompt is not owned by this bot.");
    if (params.expectedRevision !== undefined && (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 1 ||
        item.revision !== params.expectedRevision)) throw new Error("This queued prompt changed. Reopen its current revision; your edit was not applied.");
    if (!["queued", "failed"].includes(item.state))
      throw new Error("This queued send is unconfirmed. Its identity and input must be reconciled before editing or removal.");
    if (method === "queue.delete") {
      runtime.store.put("promptQueue", { ...item, state: "cancelled", cancelledAt: now() });
      runtime.emitEvent("queue", {}, bot.id);
      return finishLocalOperation(runtime.store, operationId, { deleted: true });
    }
    const next = runtime.store.put("promptQueue", { ...item, input, state: "queued", revision: item.revision + 1,
      attachmentIds: [...(params.attachments ?? [])], clientUserMessageId: item.id,
      error: null, operationId: null, updatedAt: now() });
    runtime.store.put("queuedAttachments", { id: item.id, botId: bot.id, attachmentIds: params.attachments ?? [] });
    runtime.emitEvent("queue", {}, bot.id);
    return finishLocalOperation(runtime.store, operationId, { queuedSubmission: runtime.publicQueued(bot, next) });
  });
}
export async function dispatchPrompt(runtime, bot, item) {
  if (item.state !== "queued") return;
  const operationId = `queue-start:${createHash("sha256").update(`${bot.id}:${item.id}:${item.revision}`).digest("hex")}`;
  const prior = runtime.store.operation(operationId);
  if (prior) {
    await reconcilePrompt(runtime, { ...item, operationId });
    return;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify({ botId: bot.id, id: item.id, revision: item.revision, input: item.input })).digest("hex");
  // A definitively rejected item can be edited into a new revision. Its new
  // dispatch has a distinct native identity; uncertainty can never be edited.
  const clientId = operationId;
  const originalAttachments = runtime.store.get("queuedAttachments", item.id);
  const attachmentIds = [...(item.attachmentIds ?? (originalAttachments?.botId === bot.id ? originalAttachments.attachmentIds : []) ?? [])];
  runtime.store.transaction(() => {
    const frozen = runtime.store.get("queuedAttachments", clientId);
    if (frozen && (frozen.botId !== bot.id || JSON.stringify(frozen.attachmentIds) !== JSON.stringify(attachmentIds)))
      throw new Error("Native dispatch attachment identity conflicts with its immutable receipt.");
    runtime.store.put("queuedAttachments", { id: clientId, botId: bot.id, queueId: item.id,
      revision: item.revision, attachmentIds, immutable: true });
    runtime.store.put("promptQueue", { ...item, attachmentIds, state: "dispatching", operationId, clientUserMessageId: clientId, attemptedAt: now() });
    runtime.store.saveOperation(operationId, fingerprint, "dispatching", {
      method: "queue.dispatch", botId: bot.id, queueId: item.id, revision: item.revision,
      clientId, params: { attachments: attachmentIds }, createdAt: now(),
    });
  });
  const attempt = { started: false, rejected: false };
  try {
    const result = await runtime.send(bot, { text: item.input.filter(part => part.type === "text").map(part => part.text).join("\n"),
      stagedInput: item.input }, clientId, null, attempt, true);
    runtime.store.transaction(() => {
      runtime.store.put("promptQueue", { ...runtime.store.get("promptQueue", item.id), state: "delivered",
        turnId: result.turn?.id ?? result.turnId, deliveredAt: now(), error: null });
      finishLocalOperation(runtime.store, operationId, result);
      runtime.emitEvent("queue", {}, bot.id);
    });
  } catch (error) {
    if (runtime.store.operation(operationId)?.status === "done") return;
    if (!attempt.started) runtime.plans.rejected(runtime.store.get("planExecution", clientId), attempt);
    const uncertain = attempt.started && !attempt.rejected;
    runtime.store.transaction(() => {
      runtime.store.put("promptQueue", { ...runtime.store.get("promptQueue", item.id),
        state: uncertain ? "uncertain" : "failed", error: error.message });
      const operation = runtime.store.operation(operationId);
      runtime.store.saveOperation(operationId, fingerprint, uncertain ? "uncertain" : "failed", {
        ...operation, outcome: uncertain ? "uncertain" : "rejected", error: error.message,
      });
      runtime.saveBot(runtime.store.bot(bot.id), { queuePaused: true, error: `Queued prompt needs review: ${error.message}` });
      runtime.emitEvent("queue", {}, bot.id);
    });
  }
}
export async function reconcilePrompt(runtime, item) {
  const operation = item.operationId && runtime.store.operation(item.operationId);
  let result = operation?.status === "done" ? operation.result : null;
  let fullEvidence = false;
  let nextCursor = null;
  if (!result) {
    const found = await findNativeTurn(runtime, item.threadId, { turnId: item.turnId,
      clientId: item.clientUserMessageId, cursor: item.reconcileCursor ?? null });
    nextCursor = found.nextCursor;
    if (found.turn) { result = { turn: found.turn }; fullEvidence = true; }
  }
  runtime.store.transaction(() => {
    const current = runtime.store.get("promptQueue", item.id);
    if (!current || !["dispatching", "uncertain", "queued"].includes(current.state)) return;
    runtime.store.put("promptQueue", { ...current, operationId: item.operationId,
      state: result ? "delivered" : "uncertain", reconcileCursor: nextCursor,
      reconcileAfter: new Date(Date.now() + 30000).toISOString(),
      ...(result ? { turnId: result.turn?.id ?? result.turnId, deliveredAt: now(), error: null }
        : { error: "Native execution is unconfirmed. This prompt was not resent." }) });
    if (result && operation) finishLocalOperation(runtime.store, item.operationId, result);
    if (result) {
      retainAcceptedActivity(runtime, item.botId, result.turn);
      const turnId = result.turn?.id ?? result.turnId;
      const bot = runtime.store.bot(item.botId);
      // Exact native acceptance/receipt binds this revision even if canonical
      // inputs contain inline images or no local paths. Never match equal text.
      const canonical = result.turn?.items?.find(entry => entry.type === "userMessage" && entry.clientId === current.clientUserMessageId);
      if (turnId) rememberInputProvenance(runtime, bot, turnId, canonical ?? {
        type: "userMessage", id: `client:${current.clientUserMessageId}`, clientId: current.clientUserMessageId, content: current.input,
      });
      if (result.turn) runtime.projectTerminalTurn(item.botId, result.turn, fullEvidence);
    }
    runtime.emitEvent("queue", {}, item.botId);
  });
}
