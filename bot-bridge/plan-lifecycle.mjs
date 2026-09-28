import { randomUUID } from "node:crypto";
import { findNativeTurn } from "./native-reconcile.mjs";

const now = () => new Date().toISOString();
const terminal = new Set(["completed", "failed", "interrupted"]);
const proposed = item => (item?.type === "plan" && typeof item.text === "string" && Boolean(item.text.trim())) ||
  (item?.type === "agentMessage" && item.phase === "final_answer" && !item.questions?.length &&
    typeof item.text === "string" && /<proposed_plan>\s*\S[\s\S]*?<\/proposed_plan>/.test(item.text));

// Only metadata/evidence flags are retained, never assistant reasoning or text.
export class PlanLifecycle {
  constructor(runtime) { this.runtime = runtime; this.store = runtime.store; }
  blocked(botId) {
    return this.store.list("planExecution", botId).some(record =>
      ["dispatching", "resetting", "uncertain", "blocked"].includes(record.state) ||
      (record.state === "running" && terminal.has(this.store.get("planTurnEvidence", record.turnId)?.status)));
  }
  async prepare(bot, operationId, run) {
    await this.settle(bot.id);
    bot = this.store.bot(bot.id);
    if (this.blocked(bot.id)) throw new Error("The previous Plan transition needs reconciliation before another turn can start.");
    if (run || operationId.startsWith("manager-notice:") || bot.mode !== "plan") return null;
    if ((await this.runtime.nativeQueueList(bot)).length)
      throw new Error("Let the legacy native queue finish before starting a Plan turn. New Queue next prompts are safely staged.");
    const existing = this.store.get("planExecution", operationId);
    if (existing) return existing;
    return this.store.transaction(() => {
      const intentId = bot.modeIntentId ?? `legacy:${randomUUID()}`;
      if (!bot.modeIntentId) this.runtime.saveBot(this.store.bot(bot.id), { modeIntentId: intentId });
      return this.store.put("planExecution", { id: operationId, botId: bot.id, threadId: bot.threadId,
        intentId, state: "dispatching", turnId: null, createdAt: now() });
    });
  }
  bind(record, turn, completeEvidence = false) {
    if (!record) return;
    const current = this.store.get("planExecution", record.id);
    if (!current || ["consumed", "superseded", "finished"].includes(current.state)) return;
    this.store.put("planExecution", { ...current, turnId: turn.id, state: "running", reconcileCursor: null });
    if (terminal.has(turn.status)) this.note(record.botId, { method: "turn/completed", params: { turn } }, completeEvidence);
    const outcome = this.store.get("planTurnEvidence", turn.id);
    if (terminal.has(outcome?.status)) this.schedule(record.botId);
  }
  rejected(record, attempt) {
    if (!record) return;
    if (!attempt?.started || attempt.rejected)
      this.store.put("planExecution", { ...this.store.get("planExecution", record.id), state: "finished", finishedAt: now() });
    // Unknown dispatch remains identifiable by its original client message ID.
  }
  note(botId, message, completeEvidence = false) {
    const p = message.params ?? {};
    const turnId = p.turnId ?? p.turn?.id;
    if (!turnId) return;
    if (message.method !== "turn/completed" && !(message.method === "item/completed" && proposed(p.item))) return;
    const current = this.store.get("planTurnEvidence", turnId);
    if (current && current.botId !== botId) return;
    this.store.put("planTurnEvidence", { ...current, id: turnId, botId,
      proposed: Boolean(current?.proposed || proposed(p.item) || p.turn?.items?.some(proposed)),
      completeEvidence: Boolean(current?.completeEvidence || completeEvidence || p.turn?.itemsView === "full"),
      status: p.turn?.status ?? current?.status ?? "inProgress",
      error: p.turn?.error?.message ?? current?.error ?? null, updatedAt: now() });
    if (message.method === "turn/completed") this.schedule(botId);
  }
  schedule(botId) {
    // Notification callbacks may run inside an awaited mutation. Serialize the
    // consumption behind it; startTurn also checks this barrier before dispatch.
    void this.runtime.lock(botId, () => this.settle(botId)).catch(error => this.runtime.emit("fault", error));
  }
  async settle(botId) {
    for (const record of this.store.list("planExecution", botId)) {
      if (["consumed", "superseded", "finished", "uncertain", "blocked"].includes(record.state)) continue;
      if (record.state === "resetting") {
        this.store.put("planExecution", { ...record, state: "uncertain", error: "Plan reset acknowledgement was not recorded; no replay was made." });
        continue;
      }
      const outcome = record.turnId && this.store.get("planTurnEvidence", record.turnId);
      if (!terminal.has(outcome?.status)) continue;
      const bot = this.store.bot(botId);
      if (outcome.status === "completed" && !outcome.proposed && !outcome.completeEvidence) continue;
      if (outcome.status !== "completed" || !outcome.proposed) {
        this.store.put("planExecution", { ...record, state: "finished", finishedAt: now() });
        continue;
      }
      if (bot.mode !== "plan" || bot.modeIntentId !== record.intentId) {
        this.store.put("planExecution", { ...record, state: "superseded", finishedAt: now() });
        continue;
      }
      if (this.store.unconfirmedSettings(botId, record.createdAt)) {
        if (!record.reconciliationError) {
          this.store.put("planExecution", { ...record, reconciliationError: "A newer settings operation is unconfirmed." });
          this.runtime.saveBot(bot, { error: "Plan completion is waiting for an unconfirmed settings save; no reset was sent." });
        }
        continue;
      }
      if (bot.activeTurnId && bot.activeTurnId !== record.turnId) {
        this.store.put("planExecution", { ...record, state: "blocked", error: "A newer native turn started before Plan consumption could be synchronized." });
        this.runtime.saveBot(bot, { queuePaused: true, error: "Plan completion needs review: a newer native turn is already active." });
        continue;
      }
      // Persist before crossing native settings boundary. A lost acknowledgement
      // cannot cause a blind replay after restart or a newer explicit intent.
      this.store.put("planExecution", { ...record, state: "resetting", resetOperationId: `plan-reset:${record.id}`, resetStartedAt: now() });
      try {
        await this.runtime.syncQueueSettings({ ...bot, mode: "default" });
        this.store.transaction(() => {
          const current = this.store.bot(botId);
          if (current.modeIntentId === record.intentId && current.mode === "plan")
            this.runtime.saveBot(current, { mode: "default" });
          this.store.put("planExecution", { ...this.store.get("planExecution", record.id), state: "consumed", consumedAt: now() });
        });
      } catch (error) {
        if (this.store.get("planExecution", record.id)?.state === "consumed") continue;
        this.store.put("planExecution", { ...this.store.get("planExecution", record.id), state: error.definite ? "blocked" : "uncertain", error: error.message });
        this.runtime.saveBot(this.store.bot(botId), { queuePaused: true,
          error: error.definite ? "Plan mode could not reset. Choose standard mode explicitly before resuming the queue."
            : "The plan was delivered, but its native mode reset is unconfirmed. Native reconciliation is required before settings or another turn." });
      }
    }
  }
  async recover(limit = 2) {
    let count = 0;
    for (const record of this.store.list("planExecution")) {
      if (!["dispatching", "running", "resetting"].includes(record.state)) continue;
      if (this.runtime.locks.has(record.botId)) continue;
      if (record.state === "resetting") {
        this.store.put("planExecution", { ...record, state: "uncertain", error: "Service stopped before the Plan reset acknowledgement." });
        continue;
      }
      if (count >= limit || Date.parse(record.reconcileAfter ?? "") > Date.now()) continue;
      count++;
      await this.runtime.lock(record.botId, async () => {
        const found = await findNativeTurn(this.runtime, record.threadId, { turnId: record.turnId,
          clientId: record.id, cursor: record.reconcileCursor ?? null });
        const current = this.store.get("planExecution", record.id);
        if (!["dispatching", "running"].includes(current.state)) return;
        this.store.put("planExecution", { ...current, reconcileCursor: found.nextCursor,
          reconcileAfter: new Date(Date.now() + 60000).toISOString() });
        if (found.turn) {
          this.bind(current, found.turn, true);
          await this.settle(record.botId);
        }
      }).catch(error => {
        const current = this.store.get("planExecution", record.id);
        if (!["dispatching", "running"].includes(current?.state)) return;
        this.store.put("planExecution", { ...current, reconcileAfter: new Date(Date.now() + 60000).toISOString(),
          reconciliationError: error.message });
      });
    }
  }
}
