import { randomUUID } from "node:crypto";
import { findNativeTurn } from "./native-reconcile.mjs";
import { retainAcceptedActivity } from "./turn-state.mjs";

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
      record.state === "dispatching" ||
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
    if (message.method === "turn/completed") this.store.afterCommit(() => this.schedule(botId));
  }
  schedule(botId) {
    // Notification callbacks may run inside an awaited mutation. Serialize the
    // consumption behind it; startTurn also checks this barrier before dispatch.
    void this.runtime.lock(botId, () => this.settle(botId)).catch(error => this.runtime.emit("fault", error));
  }
  async settle(botId) {
    for (let record of this.store.list("planExecution", botId)) {
      if (["consumed", "superseded", "finished"].includes(record.state)) continue;
      if (record.resetOperationId && !record.legacyNativeReset) {
        record = { ...record, legacyNativeReset: { operationId: record.resetOperationId, state: record.state,
          outcome: record.state === "blocked" ? "rejected" : "unconfirmed" } };
        this.store.put("planExecution", record);
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
      if (this.store.unconfirmedModeIntent(botId, record.createdAt)) {
        // A later explicit choice owns this intent even when its native save
        // is unconfirmed. Do not consume it or resolve that save by inference.
        this.store.put("planExecution", { ...record, state: "superseded", finishedAt: now(),
          reason: "A later explicit mode operation retains ownership of the future-turn intent." });
        continue;
      }
      // App-owned intent only: every managed turn/start supplies an explicit
      // collaborationMode. No automatic settings RPC, active-turn mutation,
      // native-default readback, or native receipt resolution occurs here.
      this.store.transaction(() => {
        const current = this.store.bot(botId);
        const matches = current.modeIntentId === record.intentId && current.mode === "plan";
        if (matches) this.runtime.saveBot(current, { mode: "default" });
        this.store.put("planExecution", { ...record, state: matches ? "consumed" : "superseded",
          consumption: "app-intent-v1", consumedAt: now(),
          // The unpublished prior candidate could emit a native reset. Keep
          // its receipt explicitly unresolved; local consumption is not proof.
          ...(record.resetOperationId ? { legacyNativeReset: record.legacyNativeReset ?? {
            operationId: record.resetOperationId, state: record.state, outcome: "unconfirmed",
          } } : {}) });
      });
    }
  }
  async recover(limit = 2) {
    let count = 0;
    for (const record of this.store.list("planExecution")) {
      if (!["dispatching", "running", "resetting", "uncertain", "blocked"].includes(record.state)) continue;
      if (this.runtime.locks.has(record.botId)) continue;
      if (count >= limit || Date.parse(record.reconcileAfter ?? "") > Date.now()) continue;
      count++;
      await this.runtime.lock(record.botId, async () => {
        const found = await findNativeTurn(this.runtime, record.threadId, { turnId: record.turnId,
          clientId: record.id, cursor: record.reconcileCursor ?? null });
        const current = this.store.get("planExecution", record.id);
        if (["consumed", "superseded", "finished"].includes(current.state)) return;
        this.store.put("planExecution", { ...current, reconcileCursor: found.nextCursor,
          ...(current.resetOperationId ? { legacyNativeReset: current.legacyNativeReset ?? {
            operationId: current.resetOperationId, state: current.state, outcome: "unconfirmed",
          } } : {}),
          reconcileAfter: new Date(Date.now() + 60000).toISOString() });
        if (found.turn) {
          this.bind(this.store.get("planExecution", current.id), found.turn, true);
          retainAcceptedActivity(this.runtime, record.botId, found.turn);
          this.runtime.projectTerminalTurn(record.botId, found.turn, true);
          await this.settle(record.botId);
        }
      }).catch(error => {
        const current = this.store.get("planExecution", record.id);
        if (!current || ["consumed", "superseded", "finished"].includes(current.state)) return;
        this.store.put("planExecution", { ...current, reconcileAfter: new Date(Date.now() + 60000).toISOString(),
          reconciliationError: error.message });
      });
    }
  }
}
