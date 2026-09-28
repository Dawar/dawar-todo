import { enqueuePrompt, mutatePrompt, stagedQueue } from "./prompt-queue.mjs";
import { captureActivity, activityUnchanged } from "./turn-state.mjs";

// Runs under the bot lock. Awaited work is validation/read-only with respect to
// the queue; the returned synchronous closure and operation receipt commit in
// one transaction. No durable "dispatching" window precedes local acceptance.
export async function prepareLocalQueueMutation(runtime, method, botId, params, id) {
  if (!["queue.add", "queue.update", "queue.delete", "queue.reorder", "queue.resume"].includes(method)) return null;
  const bot = runtime.store.bot(botId);
  if (method === "queue.add") {
    if (bot.archived) throw new Error("Restore this bot first.");
    if (!runtime.ready) throw new Error("Codex is not ready.");
    const input = await runtime.messageInput(bot, params);
    return () => enqueuePrompt(runtime, runtime.store.bot(botId), params, id, input);
  }
  if (["queue.update", "queue.delete"].includes(method)) {
    const item = runtime.store.get("promptQueue", params.id);
    if (!item) {
      if (params.expectedRevision !== undefined) throw new Error("Revision checks require an existing staged prompt. Refresh the queue.");
      // Absence is not deletion proof. Validate against native metadata before
      // reserving any legacy mutation, then keep its existing uncertain path.
      const queue = await runtime.queueList(bot);
      if (!queue.some(entry => entry.id === params.id)) throw new Error("Queued prompt not found.");
      return null;
    }
    if (item.botId !== botId) throw new Error("Queued prompt is not owned by this bot.");
    const input = method === "queue.update" ? await runtime.messageInput(bot, params) : undefined;
    return () => mutatePrompt(runtime, runtime.store.bot(botId), runtime.store.get("promptQueue", item.id), method, params, id, input);
  }
  if (method === "queue.reorder") {
    const queue = await runtime.queueList(bot);
    const local = stagedQueue(runtime.store, botId);
    if (!Array.isArray(params.ids) || params.ids.length !== queue.length ||
        new Set(params.ids).size !== queue.length || queue.some(item => !params.ids.includes(item.id)))
      throw new Error("Reorder must include every queued prompt once.");
    if (!local.length && queue.length) return null;
    const legacy = queue.filter(item => !runtime.store.get("promptQueue", item.id));
    if (legacy.some((item, index) => params.ids[index] !== item.id))
      throw new Error("Legacy native prompts must remain ahead of staged prompts until they finish.");
    return () => {
      if (stagedQueue(runtime.store, botId).some(item => ["dispatching", "uncertain"].includes(item.state)))
        throw new Error("Reordering waits for the unconfirmed queued send to be reconciled.");
      params.ids.slice(legacy.length).forEach((itemId, position) =>
        runtime.store.put("promptQueue", { ...runtime.store.get("promptQueue", itemId), position }));
      runtime.emitEvent("queue", {}, botId);
      return {};
    };
  }
  if (stagedQueue(runtime.store, botId).some(item => item.state !== "queued") || runtime.plans.blocked(botId))
    throw new Error("Reconcile unconfirmed execution, or edit/remove a rejected prompt, before resuming this queue.");
  if (bot.archived) throw new Error("Restore this bot first.");
  // This read may repair CURRENT projection, independently of queue acceptance.
  // It never resumes a queue or settles an unknown historical operation.
  if (!await runtime.reconcileCurrentActivity(botId))
    throw new Error("Current native activity is unresolved. Recovery will retry; the queue was not resumed.");
  const activity = captureActivity(runtime, botId);
  return () => {
    if (!activityUnchanged(runtime, botId, activity) || runtime.activityUnresolved(botId))
      throw new Error("Native activity changed during recovery. Refresh before resuming the queue again.");
    const current = runtime.store.bot(botId);
    if ((current.queuePauseRevision ?? 0) !== (bot.queuePauseRevision ?? 0))
      throw new Error("A newer queue pause needs review. Refresh before resuming again.");
    if (bot.status !== "interrupted" && current.status === "interrupted")
      throw new Error("The turn was interrupted during recovery. Review it before resuming the queue again.");
    const after = runtime.store.bot(botId);
    runtime.saveBot(after, { queuePaused: false, error: null,
      status: runtime.store.list("pending", botId).length ? "waiting" : after.activeTurnId ? "running" : "idle" });
    runtime.store.afterCommit(() => setImmediate(() => void runtime.tick().catch(error => runtime.emit("fault", error))));
    return {};
  };
}

export async function acceptLocalQueueOperation(runtime, request, fingerprint) {
  const { method, botId, params, operationId } = request;
  let mutation;
  try { mutation = await prepareLocalQueueMutation(runtime, method, botId, params, operationId); }
  catch (error) { error.outcome = "rejected"; throw error; }
  if (!mutation) return null;
  try {
    const result = runtime.store.transaction(() => {
      const data = { method, botId, params, localOnly: "queue-v1", createdAt: new Date().toISOString() };
      runtime.store.saveOperation(operationId, fingerprint, "dispatching", data);
      const value = mutation();
      runtime.store.saveOperation(operationId, fingerprint, "done", { ...data, result: value });
      return value;
    });
    return { handled: true, result };
  } catch (error) {
    const receipt = runtime.store.operation(operationId);
    if (receipt?.status === "done") return { handled: true, result: receipt.result };
    // SQLite atomicity: no committed receipt implies no committed mutation.
    // Retrying this local operation may validate/commit; it cannot send a turn.
    error.outcome = receipt ? "uncertain" : "rejected";
    throw error;
  }
}
