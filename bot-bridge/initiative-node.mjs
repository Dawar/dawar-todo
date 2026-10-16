import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { botProvider } from "./provider-router.mjs";
import { THINK_SCHEMA, SPEAK_SCHEMA, THINK_INSTRUCTIONS, SPEAK_INSTRUCTIONS, thinkPrompt, speakPrompt } from "./mind.mjs";
import { mindMaterials } from "./initiative-packet.mjs";

// Node side of the bots' inner monologue (mind.mjs). The hub coordinator
// decides WHEN a bot thinks and WHAT is delivered; this executor owns the
// native work.
//
// Two kinds of private job, the same for Codex and Claude bots:
//   think — the bot's identity, memory, own recent conversation and the
//           hub's brief (its journal, loops, time) become one new thought
//           and a decision to stay quiet or speak (light model);
//   speak — the bot's own model writes the message a thought decided on.
// Each runs once, tool-free and read-only, in a fresh disposable session on
// the bot's own provider: Codex an ephemeral thread/start + one turn with an
// outputSchema and no MCP or dynamic tools; Claude an Agent SDK query with
// persistSession false, no tools and schema-validated JSON. The bot's main
// conversation is never forked, read into the model whole, or written to.
//
// A Codex job thread is never a bot thread, so ordinary routing would drop
// its events from chat, typing, unread and notifications anyway; this class
// claims them first to collect the result and refuse every request. While it
// runs (at most the time bound) it counts as a loaded active thread for
// restart-maintenance idle proofs, which then wait for it. A Claude job has
// no thread at all: no ClaudeStore turn, notification or loaded session.
//
// Publication is a bridge projection, not a native write: the confirmed
// message appears live, in reconnect history and in preview/unread, and the
// bot is told about its own proposal in the next turn's context.

export const INITIATIVE_NODE_METHODS = new Set(["initiative.node.probe", "initiative.node.start", "initiative.node.poll",
  "initiative.node.cancel", "initiative.node.publish", "initiative.node.reconcile"]);
const ID = /^[a-zA-Z0-9:_-]{8,180}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "invalid"]);
// Native items that would be tool use: a tool-free job aborts on any of them.
const TOOL_ITEMS = new Set(["mcpToolCall", "fileChange", "commandExecution", "dynamicToolCall", "webSearch", "collabAgentToolCall", "imageGeneration"]);
const DELIVERY = "initiativeDelivery";
const disabledServer = { command: process.execPath, args: [], enabled: false };
// Every MCP server the bridge configures is disabled in a Codex job thread.
export const PRIVATE_REVIEW_CONFIG = Object.freeze({
  "features.fast_mode": false,
  "features.multi_agent": false,
  "mcp_servers.codex_manager": disabledServer,
  "mcp_servers.bot_desktop": disabledServer,
  "mcp_servers.linux_computer_use": disabledServer,
  "mcp_servers.bot_desktop_linus": disabledServer,
});
/** Normalized usage across providers: { totalTokens, inputTokens, cachedInputTokens, outputTokens, costUsd }. */
/** First line of a proposal for a push body: markdown and the reply reference removed. */
export function pushPreview(text, max = 180) {
  const line = String(text ?? "").split("\n\n").map(part => part.replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim()).find(part => part && !/^Ref initiative-/.test(part)) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
/** A Claude subscription window is rejected or at/above `percent` utilization: Claude reviews wait. */
export function claudeNearLimit(router, percent = 80) {
  try {
    const windows = router?.claude?.usage?.().rateLimits ?? [];
    return windows.some(w => w.status === "rejected" || (typeof w.utilization === "number" && w.utilization * 100 >= percent));
  } catch { return false; }
}
export function normalizeUsage(usage) {
  if (!usage) return null;
  if ("totalTokens" in usage) return { totalTokens: usage.totalTokens ?? 0, inputTokens: usage.inputTokens ?? 0, cachedInputTokens: usage.cachedInputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0, costUsd: null };
  const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  return { totalTokens: input + (usage.outputTokens ?? 0), inputTokens: input, cachedInputTokens: usage.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0, costUsd: usage.costUsd ?? null };
}

export class PrivateReviews {
  constructor(runtime, { clock = Date.now } = {}) {
    Object.assign(this, { runtime, store: runtime.store, clock });
    this.byThread = new Map(); // Codex job threadId -> reviewId
    this.aborts = new Map();   // Claude job reviewId -> AbortController
    this.timers = new Map();
    // Background work (Claude runs, finishes triggered by notifications), so
    // callers and tests can await a settled state instead of guessing.
    this.inflight = new Set();
    // A process restart ends every job it owned; nothing is replayed.
    for (const r of this.store.list("privateReview")) if (!TERMINAL.has(r.state))
      this.store.put("privateReview", { ...r, state: "interrupted", error: "The bridge restarted during the private review.", finishedAt: this.at() });
  }
  get codex() { return this.runtime.codex; }
  /** Every timestamp comes from the injected clock, like the hub's. */
  at() { return new Date(this.clock()).toISOString(); }
  track(work) {
    const promise = Promise.resolve(work).catch(error => this.runtime.emit?.("fault", error)).finally(() => this.inflight.delete(promise));
    this.inflight.add(promise);
    return promise;
  }
  /** Resolves once no background job work is pending. */
  async settled() { while (this.inflight.size) await Promise.allSettled([...this.inflight]); }
  supported(bot) {
    return botProvider(bot) === "claude" ? typeof this.codex.privateRun === "function" && this.codex.claudeReady !== false
      : typeof this.codex.startPrivateThread === "function";
  }
  handle(method, botId, params = {}) {
    if (!INITIATIVE_NODE_METHODS.has(method)) throw Error("Unsupported private review method.");
    if (!params || typeof params !== "object" || Array.isArray(params)) throw Error("Invalid private review parameters.");
    const bot = this.store.bot(String(botId));
    switch (method) {
      case "initiative.node.probe": return this.probe(bot);
      case "initiative.node.start": return this.start(bot, params);
      case "initiative.node.poll": return this.poll(bot, params.reviewId);
      case "initiative.node.cancel": return this.cancel(bot, params.reviewId, "Cancelled by the coordinator.");
      case "initiative.node.publish": return this.publish(bot, params);
      case "initiative.node.reconcile": return this.reconcile(bot, params.publicationId);
    }
  }
  active(botId) { return this.store.list("privateReview", botId).find(r => !TERMINAL.has(r.state)) ?? null; }

  // ---- admission ------------------------------------------------------------
  /** Idle only: no user input, queue, writer, review or maintenance hold. */
  localIdle(bot, { locked = false } = {}) {
    const r = this.runtime;
    if (!this.supported(bot)) return { idle: false, reason: "provider-unsupported" };
    if (!r.ready || r.maintenance?.holding()) return { idle: false, reason: "maintenance" };
    // Inside the admission lock, only another holder queued behind us counts.
    if (!locked && r.locks.has(bot.id)) return { idle: false, reason: "busy" };
    if (this.active(bot.id)) return { idle: false, reason: "review-active" };
    if (r.memoryMaintenance && !r.memoryMaintenance.idle(bot)) return { idle: false, reason: "not-idle" };
    return { idle: true, reason: null };
  }
  /** Native current-state proof plus a revision of the visible conversation (both providers). */
  async nativeState(bot) {
    const { thread } = await this.codex.call("thread/read", { threadId: bot.threadId, includeTurns: false });
    if (thread?.id !== bot.threadId) throw Error("Native conversation identity changed.");
    const page = await this.codex.call("thread/turns/list", { threadId: bot.threadId, cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    const last = Array.isArray(page?.data) ? page.data[0] ?? null : null;
    const queue = await this.codex.call("thread/queue/list", { threadId: bot.threadId, cursor: null, limit: 1 });
    const goal = await this.codex.call("thread/goal/get", { threadId: bot.threadId }).catch(() => ({ goal: null }));
    const generation = this.store.get("botActivity", bot.id)?.generation ?? 0;
    return { status: thread.status?.type ?? null, lastTurnId: last?.id ?? null, lastTurnStatus: last?.status ?? null,
      queued: Boolean(queue?.data?.length || queue?.nextCursor), goalActive: goal?.goal?.status === "active",
      revision: `${last?.id ?? "none"}:${last?.status ?? "none"}:${generation}` };
  }
  async probe(bot) {
    const local = this.localIdle(bot), base = { botId: bot.id, threadId: bot.threadId, provider: botProvider(bot), supported: this.supported(bot) };
    if (!local.idle && local.reason !== "review-active") return { ...base, idle: false, reason: local.reason, revision: null };
    const state = await this.nativeState(bot);
    const idle = local.idle && ["idle", "notLoaded"].includes(state.status) && !state.queued && !state.goalActive && state.lastTurnStatus !== "inProgress";
    return { ...base, idle, reason: idle ? null : local.reason ?? "native-busy", revision: state.revision, lastTurnId: state.lastTurnId };
  }

  // ---- private jobs -----------------------------------------------------------
  async start(bot, { reviewId, kind = "think", brief, settings = {} } = {}) {
    if (!ID.test(reviewId ?? "")) throw Error("A stable review identity is required.");
    if (!["think", "speak"].includes(kind)) throw Error("Unknown private job kind.");
    const prior = this.store.get("privateReview", reviewId);
    if (prior) { if (prior.botId !== bot.id) throw Error("Review belongs to another bot."); return this.view(prior); }
    if (!brief || typeof brief !== "object" || Array.isArray(brief)) throw Error("A brief is required.");
    // The bot's ordinary admission lock is held only for the admission check
    // and job creation, never for the run: user input is not delayed.
    return this.runtime.lock(bot.id, async () => {
      // A busy bot may still think (read-only, private): only stopped,
      // maintenance, unsupported and already-thinking states refuse it.
      const busyOk = settings.allowBusy === true;
      const local = this.localIdle(this.store.bot(bot.id), { locked: true });
      if (!local.idle && !(busyOk && local.reason === "not-idle")) return { id: reviewId, state: "refused", reason: local.reason };
      if (botProvider(bot) === "claude" && claudeNearLimit(this.codex, settings.claudeHeadroomPercent))
        return { id: reviewId, state: "refused", reason: "claude-limit" };
      const state = await this.nativeState(bot);
      if (!busyOk && (!["idle", "notLoaded"].includes(state.status) || state.queued || state.goalActive))
        return { id: reviewId, state: "refused", reason: "native-busy" };
      const record = { id: reviewId, botId: bot.id, threadId: bot.threadId, kind, provider: botProvider(bot), state: "starting", revision: state.revision,
        baseTurnId: state.lastTurnId, startedAt: this.at(), deadlineAt: new Date(this.clock() + (settings.timeoutSeconds ?? 180) * 1000).toISOString() };
      this.store.put("privateReview", record);
      try {
        const name = bot.name ?? "this bot";
        const materials = await mindMaterials(this.runtime, bot, { maxTokens: kind === "speak" ? 6000 : settings.packetTokens ?? 12000,
          conversationHours: settings.conversationHours ?? 72 });
        const prompt = kind === "think" ? thinkPrompt({ name, brief, ...materials })
          : speakPrompt({ name, identity: materials.identity, conversation: materials.conversation, thought: String(brief.thought ?? ""), draft: String(brief.draft ?? ""), now: String(brief.now ?? "") });
        const schema = kind === "think" ? THINK_SCHEMA : SPEAK_SCHEMA, instructions = kind === "think" ? THINK_INSTRUCTIONS : SPEAK_INSTRUCTIONS;
        this.store.put("privateReview", { ...this.store.get("privateReview", reviewId), packetTokens: Math.ceil(prompt.length / 4) });
        const model = settings.model || bot.model || null, effort = settings.effort ?? null;
        if (botProvider(bot) === "claude") this.runClaude(bot, reviewId, { model, effort, prompt, schema, instructions });
        else await this.runCodex(bot, reviewId, { model, effort, fast: settings.fast === true, prompt, schema, instructions });
        const timer = setTimeout(() => void this.cancel(this.store.bot(bot.id), reviewId, "The private review exceeded its time bound.", "failed").catch(() => {}),
          Math.max(1000, Date.parse(record.deadlineAt) - this.clock()));
        timer.unref?.(); this.timers.set(reviewId, timer);
      } catch (error) {
        await this.finish(reviewId, "failed", { error: error.message });
      }
      return this.view(this.store.get("privateReview", reviewId));
    });
  }
  async privateDirectory() {
    const dir = join(this.runtime.root ?? process.cwd(), ".initiative-private");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  /** Codex: ephemeral read-only thread, one structured turn, no tools. */
  async runCodex(bot, reviewId, { model, effort, fast, prompt, schema, instructions }) {
    const started = await this.codex.startPrivateThread({ cwd: await this.privateDirectory(), ...(model ? { model } : {}), config: PRIVATE_REVIEW_CONFIG,
      developerInstructions: instructions, ...(fast ? {} : { serviceTier: null }) });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string" || threadId === bot.threadId) throw Error("Codex did not return a distinct private thread.");
    this.byThread.set(threadId, reviewId);
    this.store.put("privateReview", { ...this.store.get("privateReview", reviewId), jobThreadId: threadId, state: "running" });
    const turn = await this.codex.startPrivateReviewTurn({ threadId, input: [{ type: "text", text: prompt, text_elements: [] }], outputSchema: schema,
      ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    const current = this.store.get("privateReview", reviewId);
    this.store.put("privateReview", { ...current, turnId: turn?.turn?.id ?? current.turnId ?? null });
    if (current.state !== "running") await this.interrupt(this.store.get("privateReview", reviewId));
  }
  /** Claude: a standalone SDK query (no session file, no tools), settled in the background. */
  runClaude(bot, reviewId, { model, effort, prompt, schema, instructions }) {
    const abort = new AbortController();
    this.aborts.set(reviewId, abort);
    this.store.put("privateReview", { ...this.store.get("privateReview", reviewId), state: "running" });
    this.track(this.privateDirectory().then(cwd => this.codex.privateRun({ provider: "claude", model, effort, prompt, schema, instructions, cwd, signal: abort.signal }))
      .then(({ output, usage }) => this.finish(reviewId, "completed", { output, usage: normalizeUsage(usage) }),
        error => this.finish(reviewId, abort.signal.aborted ? "cancelled" : error.invalid ? "invalid" : "failed", { error: error.message })));
  }
  view(r) {
    return { id: r.id, botId: r.botId, kind: r.kind ?? "think", state: r.state, reason: r.reason ?? null, revision: r.revision, startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null, error: r.error ?? null, output: TERMINAL.has(r.state) ? r.output ?? null : null, usage: r.usage ?? null, packetTokens: r.packetTokens ?? null };
  }
  poll(bot, reviewId) {
    const r = this.store.get("privateReview", String(reviewId ?? ""));
    if (!r || r.botId !== bot.id) return { id: reviewId, state: "missing" };
    return this.view(r);
  }
  async interrupt(r) {
    if (r?.jobThreadId && r.turnId) await this.codex.call("turn/interrupt", { threadId: r.jobThreadId, turnId: r.turnId }, 15000).catch(() => {});
    this.aborts.get(r?.id)?.abort();
  }
  async release(r) {
    this.aborts.delete(r?.id);
    if (!r?.jobThreadId) return;
    this.byThread.delete(r.jobThreadId);
    await this.codex.call("thread/unsubscribe", { threadId: r.jobThreadId }, 15000).catch(() => {});
  }
  async finish(reviewId, state, fields = {}) {
    const r = this.store.get("privateReview", reviewId);
    if (!r || TERMINAL.has(r.state)) return r;
    clearTimeout(this.timers.get(reviewId)); this.timers.delete(reviewId);
    const next = { ...r, ...fields, state, finishedAt: this.at() };
    this.store.put("privateReview", next);
    if (state !== "completed") await this.interrupt(next);
    await this.release(next);
    return next;
  }
  async cancel(bot, reviewId, reason, state = "cancelled") {
    const r = this.store.get("privateReview", String(reviewId ?? ""));
    if (!r || r.botId !== bot.id) return { id: reviewId, state: "missing" };
    return this.view(await this.finish(r.id, state, { error: reason }) ?? r);
  }
  /** Thinking is private and read-only, so user activity lets it finish; the hub decides whether a message still fits. */
  userActivity() {}

  // ---- hidden Codex job routing ---------------------------------------------------
  reviewFor(threadId) {
    const id = typeof threadId === "string" ? this.byThread.get(threadId) : null;
    return id ? this.store.get("privateReview", id) : null;
  }
  /** Returns true when the notification belongs to a private job. */
  notification(message) {
    const p = message.params ?? {}, r = this.reviewFor(p.threadId ?? p.thread?.id);
    if (!r) return false;
    if (message.method === "item/started" && TOOL_ITEMS.has(p.item?.type)) {
      this.track(this.finish(r.id, "invalid", { error: `Tool-free violation: ${p.item.type} attempted.` }));
      return true;
    }
    if (message.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string")
      this.store.put("privateReview", { ...this.store.get("privateReview", r.id), output: p.item.text.slice(0, 64 * 1024) });
    if (message.method === "thread/tokenUsage/updated" && p.tokenUsage?.total)
      this.store.put("privateReview", { ...this.store.get("privateReview", r.id), usage: normalizeUsage(p.tokenUsage.total) });
    if (message.method === "turn/completed") {
      const status = p.turn?.status;
      this.track(this.finish(r.id, status === "completed" ? "completed" : "failed", status === "completed" ? {} : { error: p.turn?.error?.message ?? `Review turn ${status}.` }));
    }
    return true;
  }
  /** Every server request from a private job is refused: no tools, no approvals. */
  request(message) {
    const r = this.reviewFor(message.params?.threadId ?? message.params?.conversationId);
    if (!r) return false;
    if (message.method === "item/tool/call")
      this.codex.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: "This private review has no tools." }] });
    else this.codex.reject(message.id, "This private review is read-only; approvals and input requests are refused.");
    return true;
  }

  // ---- publication ----------------------------------------------------------------
  /**
   * Deliver one finished proposal as the bot's ordinary message, by bridge
   * projection only (no native write, no model turn). Idempotent by
   * publicationId; serialized with the bot's admission lock, so a reconcile
   * after an ambiguous RPC sees the final answer.
   */
  async publish(bot, { publicationId, text, expectedRevision, itemId = null }) {
    if (!ID.test(publicationId ?? "") || typeof text !== "string" || !text.trim() || text.length > 8000) throw Error("Invalid publication.");
    const prior = this.store.get(DELIVERY, publicationId);
    if (prior) {
      if (prior.botId !== bot.id || prior.text !== text) throw Error("Publication identity was reused with different content.");
      return this.deliveryView(prior);
    }
    return this.runtime.lock(bot.id, async () => {
      const current = this.store.get(DELIVERY, publicationId);
      if (current) return this.deliveryView(current);
      const local = this.localIdle(this.store.bot(bot.id), { locked: true });
      if (!local.idle) return { id: publicationId, state: "refused", reason: local.reason };
      const state = await this.nativeState(bot);
      if (state.revision !== expectedRevision || !["idle", "notLoaded"].includes(state.status) || state.queued || state.goalActive)
        return { id: publicationId, state: "refused", reason: "revision-changed" };
      if (!state.lastTurnId) return { id: publicationId, state: "refused", reason: "empty-conversation" };
      const at = this.at(), record = { id: publicationId, botId: bot.id, threadId: bot.threadId, itemId: typeof itemId === "string" ? itemId : null, text,
        anchorTurnId: state.lastTurnId, state: "delivered", deliveredAt: at, contextDeliveredAt: null };
      this.store.put(DELIVERY, record);
      this.project(record);
      return this.deliveryView(record);
    });
  }
  /** Confirmed publication becomes visible: live chat, reconnect history, unread. */
  project(record) {
    const bot = this.store.bot(record.botId);
    this.runtime.emitEvent?.("codex", { method: "item/completed", params: { threadId: bot.threadId, turnId: record.anchorTurnId, item: initiativeItem(record) } }, bot.id);
    this.runtime.saveBot?.(this.store.bot(bot.id), { preview: record.text.slice(0, 160), updatedAt: record.deliveredAt });
    // A push that reads like a message from a person: the bot's name and its opening line.
    this.runtime.notify?.(bot, `initiative:${record.id}`, pushPreview(record.text) || `${bot.name ?? "A bot"} has something for you.`);
  }
  deliveryView(r) { return { id: r.id, state: r.state, reason: r.reason ?? null, error: r.error ?? null, deliveredAt: r.deliveredAt ?? null, anchorTurnId: r.anchorTurnId ?? null }; }
  /** Settle an ambiguous publish RPC: the local record is the whole truth. */
  reconcile(bot, publicationId) {
    return this.runtime.lock(bot.id, async () => {
      const r = this.store.get(DELIVERY, String(publicationId ?? ""));
      if (r && r.botId !== bot.id) return { id: publicationId, state: "missing" };
      return r ? this.deliveryView(r) : { id: publicationId, state: "absent" };
    });
  }
  /** Projected rows for reconnect history, anchored after their native turn. */
  projected(botId, turnId) {
    return this.store.db.prepare(`SELECT json FROM records WHERE kind='${DELIVERY}' AND bot_id=? AND json_extract(json,'$.anchorTurnId')=?
      AND json_extract(json,'$.state')='delivered' LIMIT 10`).all(botId, turnId).map(row => initiativeItem(JSON.parse(row.json)));
  }

  // ---- next-turn awareness ------------------------------------------------------------
  /** Proposals the bot's model has not yet been told about, in this conversation. */
  unseen(bot) {
    return this.store.list(DELIVERY, bot.id).filter(r => r.state === "delivered" && !r.contextDeliveredAt && r.threadId === bot.threadId)
      .sort((a, b) => a.deliveredAt.localeCompare(b.deliveredAt)).slice(-5);
  }
  markSeen(ids) {
    const at = this.at();
    for (const id of ids) { const r = this.store.get(DELIVERY, id); if (r && !r.contextDeliveredAt) this.store.put(DELIVERY, { ...r, contextDeliveredAt: at }); }
  }
}
export const initiativeItem = r => ({ type: "agentMessage", id: `initiative:${r.id}`, text: r.text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });

/** Context the next turn carries so the bot knows what it said on its own while idle. */
export function proposalContext(records) {
  return records.map(r => `At ${r.deliveredAt}, between conversations, you sent Dawar this message on your own (from your inner monologue):\n<<<\n${r.text}\n>>>`).join("\n\n")
    + `\n\nIt is part of this conversation even though you did not write it in a turn; Dawar's message may be answering it. If it closes or changes something you were tracking, note that with bots_initiative operation=note.`;
}
