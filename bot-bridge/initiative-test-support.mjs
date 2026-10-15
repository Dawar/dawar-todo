// Test doubles for the proactive initiative: a Codex app-server fake with
// main conversations and private job threads that answer from a script.
import { EventEmitter } from "node:events";
import { managedExecutionParams, PRIVATE_REVIEW } from "./execution-access.mjs";

/** Which private job a structured-output schema belongs to. */
export function jobKind(schema) {
  const p = schema?.properties ?? {};
  return p.mentions ? "extract" : p.decision ? "review" : p.proposal ? "draft" : p.critiques ? "critique" : p.improvements ? "improve" : p.scores ? "judge" : "unknown";
}
export const sec = iso => Date.parse(iso) / 1000;
export const owner = (id, text, extra = {}) => ({ type: "userMessage", id, clientId: `owner-${id}`, content: [{ type: "text", text, text_elements: [] }], ...extra });
export const answer = (id, text) => ({ type: "agentMessage", id, text, phase: "final_answer" });

/** Codex fake: main conversations plus private job threads that answer from `reply(kind, params)`. */
export class InitiativeCodex extends EventEmitter {
  calls = []; answers = []; ready = true; jobs = 0;
  reply = () => null; // (kind, params) => output object/string, or null to finish manually
  usage = { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 };
  threads = new Map([["thread-main", { id: "thread-main", status: { type: "idle" }, turns: [
    { id: "turn-1", status: "completed", startedAt: sec("2026-10-13T15:00:00Z"), itemsView: "full", items: [
      owner("u1", "We should call Acme about their renewal before Friday."),
      answer("a1", "Noted.")] }] }]]);
  async start() {}
  startPrivateThread(params) { return this.call("thread/start", { ...params, [PRIVATE_REVIEW]: true }); }
  startPrivateReviewTurn(params) { return this.call("turn/start", { ...params, [PRIVATE_REVIEW]: true }); }
  async call(method, params = {}) {
    params = managedExecutionParams(method, params);
    this.calls.push({ method, params });
    const thread = this.threads.get(params.threadId);
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [
      { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
      { model: "gpt-6-luna", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] }], nextCursor: null };
    if (method === "thread/read") return { thread };
    if (method === "thread/resume") return { thread };
    if (method === "thread/turns/list") return { data: [...thread.turns].reverse().slice(0, params.limit ?? 50), nextCursor: null };
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/loaded/list") return { data: [...this.threads.keys()], nextCursor: null };
    if (method === "thread/start") {
      const job = { id: `job-${++this.jobs}`, status: { type: "idle" }, turns: [], private: params.ephemeral === true };
      this.threads.set(job.id, job);
      return { thread: job };
    }
    if (method === "turn/start") {
      const turn = { id: `turn-${this.calls.length}`, status: "inProgress", items: [] };
      thread.turns.push(turn);
      if (thread.private) {
        const kind = jobKind(params.outputSchema);
        const out = this.reply(kind, params);
        if (out !== null) setImmediate(() => this.finishJob(thread.id, turn.id, typeof out === "string" ? out : JSON.stringify(out)));
      }
      return { turn };
    }
    return {};
  }
  finishJob(threadId, turnId, text, status = "completed") {
    this.emit("notification", { method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "r", text, phase: "final_answer" } } });
    this.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: this.usage } } });
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [] } } });
  }
  respond(id, result) { this.answers.push({ id, result }); }
  reject(id, message) { this.answers.push({ id, error: message }); }
}

