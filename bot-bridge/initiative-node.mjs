import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { botProvider } from "./provider-router.mjs";
import { REVIEW_OUTPUT_SCHEMA } from "./initiative-ledger.mjs";
import { buildReviewPacket, ownProfile } from "./initiative-packet.mjs";
import { ROOM_SCHEMAS } from "./initiative-room.mjs";
import { readOwnerMessages, extractionPrompt, validateExtraction, EXTRACTION_OUTPUT_SCHEMA, EXTRACTION_INSTRUCTIONS } from "./initiative-mentions.mjs";

// Node side of the proactive initiative. The hub coordinator decides WHEN a
// bot is reviewed and WHAT is published; this executor owns the native work.
//
// Two kinds of private job, the same for Codex and Claude bots:
//   extract — read Dawar's new messages since a cursor and turn them into
//             loose threads (small model);
//   review  — judge a bounded packet of bridge-owned data and maybe propose.
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
  "initiative.node.cancel", "initiative.node.publish", "initiative.node.reconcile", "initiative.node.packet"]);
const ID = /^[a-zA-Z0-9:_-]{8,180}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "invalid"]);
// Native items that would be tool use: a tool-free job aborts on any of them.
const TOOL_ITEMS = new Set(["mcpToolCall", "fileChange", "commandExecution", "dynamicToolCall", "webSearch", "collabAgentToolCall", "imageGeneration"]);
const DELIVERY = "initiativeDelivery";
const now = () => new Date().toISOString();
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
export const REVIEW_INSTRUCTIONS = `This is a private initiative review for one of Dawar's persistent bots. Nothing you write here is shown to anyone; only a validated proposal may later be sent, as that bot's ordinary message.
You have no tools: you cannot send messages, change tasks, read files or act on external systems. Judge only the packet below. Answer with the requested JSON only.`;

export function reviewPrompt(brief, packet) {
  return `${REVIEW_INSTRUCTIONS}

${packet}

# Review
First, loose threads — things Dawar mentioned that never reached anything conclusive:
1. What did Dawar mention in the last hours or days that has not led to anything conclusive? (See "Loose threads"; "due": true marks ones whose time to come back has arrived.)
2. Which one is most valuable or time-sensitive to raise now?
3. What is the concrete next step to propose: create a todo, draft a message, schedule it, research it, or drop it?
If the recent conversation shows a loose thread was concluded (todo created, decision made, message sent, meeting scheduled, artifact delivered, or Dawar said done/dropped), mark it "resolved" in ledger_updates with the evidence in note.

Then, other initiative:
4. What existing work or decision needs attention?
5. What worthwhile opportunity could advance Dawar's priorities?

There is no quota. Choose "publish" only for one concrete, grounded contribution that is useful now, with its evidence, expected value, a clearly labelled effort estimate and a useful first step. Prefer a due loose thread over a new opportunity.
For a loose thread use kind "loose-thread", its item_id and key, and a proposed_action; the bridge itself opens the message with Dawar's original words and when he said them, so write "message" as what follows: why it matters now and what you suggest, in your normal voice, without repeating the quote. Never invent a loose thread; only Dawar's own mentions create them.
Reuse an existing item_id/key when your contribution concerns the same underlying thing, even if another bot owns it. Do not repeat an item that is awaiting Dawar's reply, snoozed or dismissed unless circumstances materially changed (then set changed_circumstances true).
Substantial research, implementation and external actions start only after Dawar approves.`;
}

/** Normalized usage across providers: { totalTokens, inputTokens, cachedInputTokens, outputTokens, costUsd }. */
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
    // A process restart ends every job it owned; nothing is replayed.
    for (const r of this.store.list("privateReview")) if (!TERMINAL.has(r.state))
      this.store.put("privateReview", { ...r, state: "interrupted", error: "The bridge restarted during the private review.", finishedAt: now() });
  }
  get codex() { return this.runtime.codex; }
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
      case "initiative.node.packet": return this.packet(bot, params);
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
  /** A room's shared packet, built from this bot's bridge-owned data (no model call). */
  async packet(bot, { brief, maxTokens = 12000 } = {}) {
    if (!brief || typeof brief !== "object" || !Array.isArray(brief.ledger)) throw Error("A packet brief is required.");
    const packet = await buildReviewPacket(this.runtime, bot, brief, { maxTokens: Math.min(20000, Math.max(3000, Number(maxTokens) || 12000)) });
    return { text: packet.text, tokens: packet.tokens, refs: packet.refs };
  }
  async start(bot, { reviewId, kind = "review", brief, settings = {}, expectedRevision, cursor = null, room = null } = {}) {
    if (!ID.test(reviewId ?? "")) throw Error("A stable review identity is required.");
    if (!["review", "extract", "room"].includes(kind)) throw Error("Unknown private job kind.");
    if (kind === "room" && (!room || !ROOM_SCHEMAS[room.stage] || [room.instructions, room.packet, room.task].some(v => typeof v !== "string" || v.length > 160000)))
      throw Error("Invalid room step.");
    const prior = this.store.get("privateReview", reviewId);
    if (prior) { if (prior.botId !== bot.id) throw Error("Review belongs to another bot."); return this.view(prior); }
    if (!brief || typeof brief !== "object" || !Array.isArray(brief.ledger)) throw Error("A review brief is required.");
    // The bot's ordinary admission lock is held only for the admission check
    // and job creation, never for the run: user input is not delayed.
    return this.runtime.lock(bot.id, async () => {
      const local = this.localIdle(this.store.bot(bot.id), { locked: true });
      if (!local.idle) return { id: reviewId, state: "refused", reason: local.reason };
      const state = await this.nativeState(bot);
      if (!["idle", "notLoaded"].includes(state.status) || state.queued || state.goalActive || kind === "review" && state.revision !== expectedRevision)
        return { id: reviewId, state: "refused", reason: "revision-changed" };
      const record = { id: reviewId, botId: bot.id, threadId: bot.threadId, kind, provider: botProvider(bot), state: "starting", revision: state.revision,
        baseTurnId: state.lastTurnId, startedAt: now(), deadlineAt: new Date(this.clock() + (settings.timeoutSeconds ?? 180) * 1000).toISOString() };
      this.store.put("privateReview", record);
      try {
        let prompt, schema, instructions;
        if (kind === "room") {
          // One room step: the shared packet, this member's own role and memory, the stage task.
          const own = settings.withProfile ? await ownProfile(bot).catch(() => "") : "";
          prompt = [room.instructions, room.packet, own ? `## Your own role and memory\n${own}` : "", room.task].filter(Boolean).join("\n\n");
          schema = ROOM_SCHEMAS[room.stage]; instructions = room.instructions;
          this.store.put("privateReview", { ...this.store.get("privateReview", reviewId), stage: room.stage, promptChars: prompt.length });
        } else if (kind === "extract") {
          const batch = await readOwnerMessages(this.runtime, bot, cursor, { limit: settings.batch ?? 40, chars: settings.chars ?? 24000,
            lookbackMs: (settings.lookbackHours ?? 72) * 36e5, clock: this.clock });
          this.store.put("privateReview", { ...this.store.get("privateReview", reviewId), batch, cursor: batch.cursor, more: batch.more, knownItems: brief.ledger.map(t => t.id) });
          // Nothing new from Dawar: advance the cursor without a model call.
          if (!batch.messages.length && !(batch.actions.length && brief.ledger.length))
            return this.view(await this.finish(reviewId, "completed", { output: { mentions: [], resolutions: [] }, usage: null, skippedModel: true }));
          prompt = extractionPrompt({ bot, messages: batch.messages, actions: batch.actions, threads: brief.ledger, bots: brief.bots ?? [] });
          schema = EXTRACTION_OUTPUT_SCHEMA; instructions = EXTRACTION_INSTRUCTIONS;
        } else {
          const packet = await buildReviewPacket(this.runtime, bot, brief, { maxTokens: settings.packetTokens ?? 12000 });
          this.store.put("privateReview", { ...this.store.get("privateReview", reviewId), packetTokens: packet.tokens, packetSections: packet.sections });
          prompt = reviewPrompt(brief, packet.text); schema = REVIEW_OUTPUT_SCHEMA; instructions = REVIEW_INSTRUCTIONS;
        }
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
    void this.privateDirectory().then(cwd => this.codex.privateRun({ provider: "claude", model, effort, prompt, schema, instructions, cwd, signal: abort.signal }))
      .then(({ output, usage }) => this.finish(reviewId, "completed", { output, usage: normalizeUsage(usage) }),
        error => this.finish(reviewId, abort.signal.aborted ? "cancelled" : error.invalid ? "invalid" : "failed", { error: error.message }))
      .catch(error => this.runtime.emit?.("fault", error));
  }
  view(r) {
    let output = TERMINAL.has(r.state) ? r.output ?? null : null, state = r.state, error = r.error ?? null;
    // Extraction is validated here, against the exact batch it came from.
    if (r.kind === "extract" && state === "completed") {
      try { output = { extraction: validateExtraction(r.output, r.batch ?? { messages: [], actions: [] }, { clock: this.clock(), knownItems: new Set(r.knownItems ?? []) }) }; }
      catch (e) { output = null; state = "invalid"; error = e.message; }
    }
    return { id: r.id, botId: r.botId, kind: r.kind ?? "review", state, reason: r.reason ?? null, revision: r.revision, startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null, error, output, usage: r.usage ?? null, packetTokens: r.packetTokens ?? null,
      ...(r.kind === "extract" ? { cursor: r.cursor ?? null, more: r.more === true, messages: r.batch?.messages?.length ?? 0 } : {}) };
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
    const next = { ...r, ...fields, state, finishedAt: now() };
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
  /** User activity always wins over a review; extraction of past messages may finish. */
  userActivity(botId) {
    const r = this.active(botId);
    if (r && (r.kind ?? "review") === "review") void this.finish(r.id, "cancelled", { error: "Cancelled by user activity." }).catch(error => this.runtime.emit?.("fault", error));
  }

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
      void this.finish(r.id, "invalid", { error: `Tool-free violation: ${p.item.type} attempted.` });
      return true;
    }
    if (message.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string")
      this.store.put("privateReview", { ...this.store.get("privateReview", r.id), output: p.item.text.slice(0, 64 * 1024) });
    if (message.method === "thread/tokenUsage/updated" && p.tokenUsage?.total)
      this.store.put("privateReview", { ...this.store.get("privateReview", r.id), usage: normalizeUsage(p.tokenUsage.total) });
    if (message.method === "turn/completed") {
      const status = p.turn?.status;
      void this.finish(r.id, status === "completed" ? "completed" : "failed", status === "completed" ? {} : { error: p.turn?.error?.message ?? `Review turn ${status}.` });
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
      const at = now(), record = { id: publicationId, botId: bot.id, threadId: bot.threadId, itemId: typeof itemId === "string" ? itemId : null, text,
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
    this.runtime.notify?.(bot, `initiative:${record.id}`, `${bot.name ?? "A bot"} has a proposal for you.`);
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
    const at = now();
    for (const id of ids) { const r = this.store.get(DELIVERY, id); if (r && !r.contextDeliveredAt) this.store.put(DELIVERY, { ...r, contextDeliveredAt: at }); }
  }
}
export const initiativeItem = r => ({ type: "agentMessage", id: `initiative:${r.id}`, text: r.text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });

/** Context the next turn carries so the bot knows what "it" sent while idle. */
export function proposalContext(records) {
  return records.map(r => `At ${r.deliveredAt}, while you were idle, the bridge sent Dawar this proposal in this conversation as your message${r.itemId ? ` (initiative item ${r.itemId})` : ""}:\n<<<\n${r.text}\n>>>`).join("\n\n")
    + `\n\nIt is part of this conversation even though you did not write it in a turn. Dawar's message may answer it; when he decides (yes, later, leave it, done), record that with bots_initiative operation=record and the item id, then follow your normal path for approved work.`;
}
