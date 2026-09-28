import { requireTurn, usableTurnId, terminalTurn } from "./native-turn.mjs";
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
      record.state === "dispatching" ||
      (record.state === "running" && terminal.has(this.store.get("planTurnEvidence", record.turnId)?.status)));
  }
  async prepare(bot, operationId, run, preparationId) {
    await this.settle(bot.id);
    bot = this.store.bot(bot.id);
    if (this.blocked(bot.id)) throw new Error("The previous Plan transition needs reconciliation before another turn can start.");
    if (run || operationId.startsWith("manager-notice:") || bot.mode !== "plan") return null;
    if ((await this.runtime.nativeQueueList(bot)).length)
      throw new Error("Let the legacy native queue finish before starting a Plan turn. New Queue next prompts are safely staged.");
    const existing = this.store.get("planExecution", operationId);
    if (existing && !(existing.state === "finished" && !existing.turnId &&
        ["not-submitted", "rejected"].includes(existing.preparationOutcome)))
      throw new Error("This Plan execution already has a retained receipt. Reconcile its original operation instead of submitting it again.");
    return this.store.transaction(() => {
      const intentId = bot.modeIntentId ?? `legacy:${randomUUID()}`;
      if (!bot.modeIntentId) this.runtime.saveBot(this.store.bot(bot.id), { modeIntentId: intentId });
      return this.store.put("planExecution", { ...existing, id: operationId, botId: bot.id, threadId: bot.threadId,
        intentId, preparationId, preparationOutcome: null, dispatchFence: null, state: "dispatching", turnId: null,
        finishedAt: null, reconcileAfter: null, createdAt: now() });
    });
  }
  dispatching(record, fence) {
    if (!record) return;
    const current = this.store.get("planExecution", record.id);
    if (current?.preparationId !== record.preparationId || current.state !== "dispatching" || current.turnId)
      throw new Error("Plan preparation changed before native submission.");
    // In the same transaction as beginTurnDispatch, before submitNative.
    // Presence means an effect may have happened, never that it succeeded.
    this.store.put("planExecution", { ...current, dispatchFence: fence });
  }
  bind(record, turn, completeEvidence = false) {
    requireTurn(turn);
    if (!record) return;
    const current = this.store.get("planExecution", record.id);
    if (!current || ["consumed", "superseded", "finished"].includes(current.state)) return;
    this.store.put("planExecution", { ...current, turnId: turn.id, state: "running", reconcileCursor: null });
    if (terminal.has(turn.status)) this.note(record.botId, { method: "turn/completed", params: { turn } }, completeEvidence);
    const outcome = this.store.get("planTurnEvidence", turn.id);
    if (terminal.has(outcome?.status)) this.schedule(record.botId);
  }
  rejected(operationId, preparationId, attempt) {
    if (attempt.started && !attempt.rejected) return;
    const record = this.store.get("planExecution", operationId);
    // Only this invocation's still-unbound preparation can be retired. A
    // failed prepare of an older uncertain operation must not retire that ID.
    if (!record || record.preparationId !== preparationId || record.state !== "dispatching" || record.turnId) return;
    this.store.put("planExecution", { ...record, state: "finished", finishedAt: now(),
      preparationOutcome: attempt.started ? "rejected" : "not-submitted" });
    // Unknown/accepted dispatch remains identifiable by its original ID.
  }
  note(botId, message, completeEvidence = false) {
    const p = message.params ?? {};
    const turnId = p.turnId ?? p.turn?.id;
    if (!usableTurnId(turnId)) return;
    if (message.method === "turn/completed" && !terminalTurn(p.turn)) return;
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
        const prepared = this.store.get("planExecution", record.id);
        if (prepared?.state === "dispatching" && prepared.preparationId && !prepared.dispatchFence && !prepared.turnId) {
          // Only the new preparation format proves the submit boundary was
          // never reserved. Legacy records and reserved/lost ACKs stay unknown.
          this.rejected(prepared.id, prepared.preparationId, { started: false, rejected: false });
          return;
        }
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
