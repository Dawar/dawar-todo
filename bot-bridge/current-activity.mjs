import { captureActivity, activityUnchanged, activityUnresolved, requireCurrentActivity,
  projectCurrentActive, projectCurrentIdle } from "./turn-state.mjs";

// Called under the main bot lock (or before startup readiness). Receipt/history
// lookup cannot release this barrier: only current native status + a fence can.
export async function reconcileCurrentActivity(runtime, botId) {
  const bot = runtime.store.bot(botId);
  requireCurrentActivity(runtime, botId, null, "checking-current-native-state");
  const token = captureActivity(runtime, botId);
  try {
    if (!bot.threadId || bot.archived) throw new Error("Restore a provisioned bot before checking native activity.");
    const read = async () => {
      const { thread } = await runtime.codex.call("thread/read", { threadId: bot.threadId, includeTurns: false });
      if (thread?.id !== bot.threadId || !["idle", "active"].includes(thread.status?.type))
        throw new Error("Native current activity is unavailable; no conflicting input was sent.");
      return thread;
    };
    const initial = await read();
    let page = null, pageError = null;
    try {
      // No full history/items hydration. One newest metadata page bounds work.
      page = await runtime.codex.call("thread/turns/list", {
        threadId: bot.threadId, cursor: null, limit: 25, sortDirection: "desc", itemsView: "notLoaded",
      });
    } catch (error) { pageError = error; }
    // Read status again after the turn metadata. An explicit current idle is
    // sufficient even if historical metadata is temporarily unreadable.
    const current = await read();
    if (!activityUnchanged(runtime, botId, token)) {
      if (!activityUnresolved(runtime, botId)) return true; // A newer native start established identity.
      throw new Error("Native activity changed during the current-state read. Containment was retained.");
    }
    const turns = Array.isArray(page?.data) ? page.data : [];
    if (current.status.type === "idle") return projectCurrentIdle(runtime, botId, token, turns[0]);
    if (initial.status.type !== "active" || pageError || turns[0]?.status !== "inProgress" ||
        typeof turns[0].id !== "string" || !turns[0].id ||
        turns.filter(turn => turn?.status === "inProgress").length !== 1)
      throw new Error("Native thread is busy, but its current turn is not yet identified. Input remains contained.");
    const established = runtime.store.transaction(() => {
      if (!projectCurrentActive(runtime, botId, turns[0], token)) return false;
      runtime.recordScheduledEvidence(botId, turns[0]);
      return !activityUnresolved(runtime, botId);
    });
    if (!established && activityUnchanged(runtime, botId, token))
      throw new Error("Current native turn conflicts with retained terminal evidence. Input remains contained pending another read.");
    return established || !activityUnresolved(runtime, botId);
  } catch (error) {
    const state = runtime.store.get("botActivity", botId);
    if (!state?.unresolved) return true;
    const attempts = (state.attempts ?? 0) + 1;
    runtime.store.put("botActivity", { ...state, attempts, reconciliationError: error.message,
      reconcileAfter: new Date(Date.now() + (attempts === 1 ? 5000 : attempts === 2 ? 15000 : 30000)).toISOString() });
    return false;
  }
}

export async function recoverCurrentActivities(runtime, limit = 2, startup = false) {
  let checked = 0;
  const due = runtime.store.list("botActivity").filter(state => state.unresolved)
    .sort((a, b) => (a.reconcileAfter ?? "").localeCompare(b.reconcileAfter ?? "") || a.id.localeCompare(b.id));
  for (const state of due) {
    if (checked >= limit) break;
    if (runtime.locks.has(state.botId) || runtime.store.bot(state.botId).archived ||
        (!startup && Date.parse(state.reconcileAfter ?? "") > Date.now())) continue;
    checked++;
    await runtime.lock(state.botId, () => activityUnresolved(runtime, state.botId)
      ? reconcileCurrentActivity(runtime, state.botId) : undefined);
  }
}
