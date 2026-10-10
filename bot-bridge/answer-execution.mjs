import { createHash, randomUUID } from "node:crypto";
import { findNativeTurn } from "./native-reconcile.mjs";
import { requireTurn, usableTurnId } from "./native-turn.mjs";
import { settledInputStatus } from "./turn-state.mjs";

const now = () => new Date().toISOString();
const nextCheck = () => new Date(Date.now() + 60000).toISOString();
const uncertain = () => new Error("This question's original answer is still unconfirmed. Its retained ID/input are being checked; no answer was sent again.");

// Logical answer identity is independent of browser request IDs and Plan mode.
// Records contain private input already held by pending/operations, never logs.
export class AnswerExecutions {
  constructor(runtime, validate) { this.runtime = runtime; this.store = runtime.store; this.validate = validate; }
  get(bot, key) {
    const record = this.store.get("answerExecution", `answer:${key}`);
    if (record && (record.botId !== bot.id || record.threadId !== bot.threadId))
      throw new Error("Answer execution is not owned by this bot/thread.");
    return record;
  }
  payload(request, response) {
    const result = this.validate(request, response);
    const text = request.params.questions.map(q => `${q.question}\n${result.answers[q.id].answers.join("\n")}`).join("\n\n").trim();
    return { response: result, text, fingerprint: createHash("sha256").update(JSON.stringify({ request, result })).digest("hex") };
  }
  importLegacy(bot, pending, outerId = null) {
    const existing = this.get(bot, pending.id);
    if (existing) return existing;
    const id = `answer:${pending.id}`;
    const plan = this.store.get("planExecution", id);
    if (plan && (plan.botId !== bot.id || plan.threadId !== bot.threadId)) throw new Error("Answer Plan receipt is not owned by this bot/thread.");
    const op = this.store.retainedAnswerOperation(bot.id, pending.id, outerId);
    const safePlan = plan?.state === "finished" && !plan.turnId && ["not-submitted", "rejected"].includes(plan.preparationOutcome);
    if (!op && (!plan || safePlan)) return null;
    // Never seed old execution with a new retry's input. A legacy Plan alone
    // has no answer payload; exact native client-ID evidence can recover it.
    let payload = { response: null, text: null, fingerprint: null };
    if (op) try { payload = this.payload(pending.request, op.params.result); } catch { /* Keep opaque legacy uncertainty. */ }
    return this.store.put("answerExecution", { id, botId: bot.id, threadId: bot.threadId, key: pending.id,
      request: pending.request, ...payload, revision: randomUUID(), state: "dispatching", legacy: true,
      originalOuterId: op?.id ?? null, planTurnId: usableTurnId(plan?.turnId) ? plan.turnId : null,
      createdAt: now(), reconcileAfter: null });
  }
  // Must run under the bot lock, before send can select steer/default/Plan.
  async prepare(bot, pending, response, outerId, boundary) {
    let record = this.importLegacy(bot, pending, outerId);
    const payload = this.payload(record?.request ?? pending.request, response);
    if (record && record.state !== "rejected") {
      // Prepared without a boundary is positive no-submit evidence after a
      // crash. Bot locking means no live sender owns it at this point.
      if (record.state === "prepared") {
        this.reject(record, { started: false }, "not-submitted");
        record = this.get(bot, pending.id);
      } else {
        if (record.fingerprint && record.fingerprint !== payload.fingerprint)
          throw new Error("This question already has a different retained answer. The original input was preserved; the changed answer was not sent.");
        boundary.started = true; // This call references an already possible effect.
        await this.reconcile(record);
        record = this.get(bot, pending.id);
        if (record.state === "accepted") {
          // A legacy payload recovered from native evidence is comparable by
          // its exact text, without inventing the lost structured response.
          if (record.fingerprint ? record.fingerprint !== payload.fingerprint : record.text !== payload.text) {
            boundary.started = false; // This different payload never crossed a boundary.
            throw new Error("This question's original answer was accepted. The changed answer was not sent.");
          }
          this.finish(record);
          return { accepted: true };
        }
        if (record.state !== "rejected") throw uncertain();
        boundary.started = false;
        boundary.rejected = false;
      }
    }
    const next = { id: `answer:${pending.id}`, botId: bot.id, threadId: bot.threadId, key: pending.id,
      request: pending.request, ...payload, revision: randomUUID(), state: "prepared",
      originalOuterId: outerId, createdAt: now(), reconcileAfter: null };
    this.store.transaction(() => {
      if (record) this.store.put("answerAttempt", { ...record, id: record.revision, logicalId: record.id });
      this.store.put("answerExecution", next);
    });
    return { token: { id: next.id, revision: next.revision }, text: next.text };
  }
  assertPrepared(bot, id, token) {
    if (!id.startsWith("answer:")) return;
    const record = this.store.get("answerExecution", id);
    if (!token || token.id !== id || record?.revision !== token.revision || record.state !== "prepared" ||
        record.botId !== bot.id || record.threadId !== bot.threadId)
      throw new Error("A retained logical answer must be reconciled before submission.");
  }
  dispatch(bot, id, token, method, params, fence = null) {
    this.assertPrepared(bot, id, token);
    if (!token) return;
    const record = this.store.get("answerExecution", id);
    // Immutable bytes/parameters are committed before RPC. A crash after this
    // point is unknown, including a crash before the write actually reaches native.
    this.store.put("answerExecution", { ...record, state: "dispatching", method,
      nativeParams: params, dispatchFence: fence, reconcileAfter: nextCheck() });
  }
  accept(token, receipt) {
    if (!token) return;
    const record = this.store.get("answerExecution", token.id);
    if (record?.revision !== token.revision || !["dispatching", "accepted"].includes(record.state))
      throw new Error("Answer receipt no longer matches its reserved execution.");
    if (!usableTurnId(receipt.turnId)) throw new Error("Answer receipt has no usable turn identity.");
    this.store.put("answerExecution", { ...record, state: "accepted", receipt, acceptedAt: now(), reconciliationError: null });
  }
  reject(token, boundary, reason) {
    if (boundary.started && !boundary.rejected) return;
    const record = this.store.get("answerExecution", token.id);
    if (record?.revision !== token.revision || record.state === "accepted" || record.state === "rejected") return;
    this.store.put("answerExecution", { ...record, state: "rejected",
      outcome: boundary.started ? "rejected" : "not-submitted", error: reason, finishedAt: now() });
  }
  finish(record) {
    if (record.state !== "accepted") return;
    this.store.transaction(() => {
      const pending = this.store.get("pending", record.key);
      if (pending && pending.botId !== record.botId) throw new Error("Question ownership changed.");
      if (pending) {
        this.store.remove("pending", record.key);
        this.runtime.emitEvent("request.resolved", { key: record.key }, record.botId);
        const bot = this.store.bot(record.botId);
        this.runtime.saveBot(bot, { status: settledInputStatus(this.runtime, bot.id) });
      }
      this.store.put("answerExecution", { ...record, settledAt: now() });
    });
  }
  async reconcile(record) {
    if (record.state === "accepted") { this.finish(record); return; }
    if (record.state === "prepared") { this.reject(record, { started: false }, "not-submitted"); return; }
    if (record.state !== "dispatching") return;
    // A failed local receipt write can leave dispatching beside a later saved
    // definite rejection. Only the original outer receipt is such evidence.
    const original = record.originalOuterId && this.store.operation(record.originalOuterId);
    if (original?.outcome === "rejected" && original.botId === record.botId &&
        original.method === "requests.respond" && original.params?.key === record.key && record.fingerprint) {
      const payload = this.payload(record.request, original.params.result);
      if (payload.fingerprint === record.fingerprint) {
        this.reject(record, { started: true, rejected: true }, "Original response operation was definitively rejected.");
        return;
      }
    }
    if (Date.parse(record.reconcileAfter ?? "") > Date.now()) return;
    const bot = this.store.bot(record.botId);
    if (bot.threadId !== record.threadId || bot.archived) return;
    // Persist backoff before any await. Failures/absence never permit replay.
    this.store.put("answerExecution", { ...record, reconcileAfter: nextCheck() });
    try {
      await this.runtime.load(bot);
      // A turnId alone cannot prove that a steer/answer reached that turn.
      const found = await findNativeTurn(this.runtime, record.threadId, { clientId: record.id, cursor: record.reconcileCursor ?? null });
      record = this.store.get("answerExecution", record.id);
      this.store.put("answerExecution", { ...record, reconcileCursor: found.nextCursor });
      if (!found.turn) return;
      const turn = requireTurn(found.turn);
      const item = turn.items.find(item => item.type === "userMessage" && item.clientId === record.id);
      const content = item?.content;
      if (!Array.isArray(content) || !content.length || content.some(part => part.type !== "text" || typeof part.text !== "string"))
        throw new Error("Exact answer evidence has unsupported input; the original answer remains retained.");
      const text = content.map(part => part.text).join("\n");
      if (record.text !== null && record.text !== text)
        throw new Error("Exact answer evidence differs from the retained input; no replacement was sent.");
      if (record.text === null) record = this.store.put("answerExecution", { ...record, text, recoveredInput: content });
      this.accept(record, { turnId: turn.id, status: turn.status, source: "exact-client-history" });
      // Receipt evidence is not current execution authority. In particular,
      // do not project/retain/reblock old inProgress activity here.
      const plan = this.store.get("planExecution", record.id);
      if (plan?.botId === record.botId) this.runtime.plans.bind(plan, turn, true);
      this.finish(this.store.get("answerExecution", record.id));
    } catch (error) {
      const current = this.store.get("answerExecution", record.id);
      this.store.put("answerExecution", { ...current, reconciliationError: error.message, reconcileAfter: nextCheck() });
    }
  }
  async recover(limit = 2) {
    // Lazy additive migration of still-visible old questions; no original row
    // is removed until acceptance is actually established.
    for (const pending of this.store.list("pending")) {
      if (pending.laneId) continue;
      if (!pending.async || this.runtime.locks.has(pending.botId)) continue;
      const bot = this.store.bot(pending.botId);
      if (!bot.archived) this.importLegacy(bot, pending);
    }
    const due = this.store.list("answerExecution").filter(record => {
      if (record.laneId) return false;
      if (record.state === "rejected") return false;
      if (record.state === "accepted" && record.settledAt && !this.store.get("pending", record.key)) return false;
      return !(Date.parse(record.reconcileAfter ?? "") > Date.now());
    })
      .sort((a, b) => (a.reconcileAfter ?? "").localeCompare(b.reconcileAfter ?? "") || a.id.localeCompare(b.id));
    let count = 0;
    for (const record of due) {
      if (count >= limit) break;
      if (this.runtime.locks.has(record.botId) || this.store.bot(record.botId).archived) continue;
      count++;
      await this.runtime.lock(record.botId, () => this.reconcile(this.store.get("answerExecution", record.id)))
        .catch(error => {
          const current = this.store.get("answerExecution", record.id);
          this.store.put("answerExecution", { ...current, reconcileAfter: nextCheck(), reconciliationError: error.message });
          this.runtime.emit("fault", error);
        });
    }
  }
}
