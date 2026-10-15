import { botProvider } from "./provider-router.mjs";
import { REVIEW_OUTPUT_SCHEMA } from "./initiative-ledger.mjs";

// Node side of the proactive initiative. The hub coordinator decides WHEN a
// bot is reviewed and WHAT is published; this executor owns the native work:
// a disposable read-only fork of the idle main conversation, and the later
// injection of a finished assistant message without starting a main turn.
//
// Private review threads are never bot threads, so the runtime's ordinary
// routing already drops their events from chat, typing, unread and
// notifications. This class claims them first, only to collect the result
// and to refuse every tool or approval the fork asks for.

export const INITIATIVE_NODE_METHODS = new Set(["initiative.node.probe", "initiative.node.start", "initiative.node.poll",
  "initiative.node.cancel", "initiative.node.publish", "initiative.node.reconcile"]);
const ID = /^[a-zA-Z0-9:_-]{8,180}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted", "invalid"]);
const now = () => new Date().toISOString();
const disabledServer = { command: process.execPath, args: [], enabled: false };
// Read-only enforcement for external tools: every MCP server the bridge
// configures is disabled in the fork. Native dynamic tools and approval
// requests are refused below; an MCP call that still starts aborts the review.
export const PRIVATE_REVIEW_CONFIG = Object.freeze({
  "features.fast_mode": false,
  "features.multi_agent": false,
  "mcp_servers.codex_manager": disabledServer,
  "mcp_servers.bot_desktop": disabledServer,
  "mcp_servers.linux_computer_use": disabledServer,
  "mcp_servers.bot_desktop_linus": disabledServer,
});
const REVIEW_INSTRUCTIONS = `This is a private, read-only initiative review of your own conversation. Nothing you write here is shown to anyone.
You cannot send messages, change tasks, queue work, modify files or act on external systems; those tools are disabled and attempts are refused.
Bounded read-only investigation (reading files, read-only commands, searching) is allowed when it grounds a proposal.
Answer with the requested JSON only.`;

export function reviewPrompt(brief) {
  return `${REVIEW_INSTRUCTIONS}

# Your role and Dawar's priorities
${brief.role || "(Use your existing role from this conversation.)"}
${brief.priorities ? `\nOwner priorities:\n${brief.priorities}` : ""}

# Your initiative ledger (existing follow-ups and opportunities across bots)
${brief.ledger.length ? JSON.stringify(brief.ledger, null, 1) : "(empty)"}

# Review
Ask yourself:
1. What existing work or decision needs attention?
2. What changed in the relevant systems or environment?
3. What worthwhile opportunity could advance Dawar's priorities?
4. What concrete proposal or update would help now?

There is no quota. Choose "publish" only for one concrete, grounded contribution that is useful now: it must name the opportunity, its supporting evidence, expected value, a clearly labelled effort estimate and a useful first step. Substantial research, implementation and external actions start only after Dawar approves.
Reuse an existing ledger item_id/key when your contribution concerns the same underlying opportunity, even if another bot owns it. Do not repeat an item that is awaiting Dawar's reply, snoozed or dismissed unless circumstances materially changed (then set changed_circumstances true).
Write "message" as the finished, ordinary message you would send Dawar in this conversation, in your normal voice. Use ledger_updates to track candidates you are still considering, and mark items "resolved" when the work is evidently done.`;
}

export class PrivateReviews {
  constructor(runtime, { clock = Date.now } = {}) {
    Object.assign(this, { runtime, store: runtime.store, clock });
    this.byThread = new Map(); // forkThreadId -> reviewId
    this.timers = new Map();
    // A process restart ends every native fork it owned; nothing is replayed.
    for (const r of this.store.list("privateReview")) if (!TERMINAL.has(r.state))
      this.store.put("privateReview", { ...r, state: "interrupted", error: "The bridge restarted during the private review.", finishedAt: now() });
    for (const p of this.store.list("initiativeInjection")) if (p.state === "injecting")
      this.store.put("initiativeInjection", { ...p, state: "uncertain", error: "The bridge restarted during injection." });
  }
  supported(bot) {
    // Claude bots have no native fork or injection yet: gated explicitly.
    return botProvider(bot) === "codex" && typeof this.runtime.codex.forkPrivateReview === "function";
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
    if (r.store.list("initiativeInjection", bot.id).some(p => ["injecting", "uncertain"].includes(p.state))) return { idle: false, reason: "publication-uncertain" };
    return { idle: true, reason: null };
  }
  /** Native current-state proof plus a revision of the visible conversation. */
  async nativeState(bot) {
    const { thread } = await this.runtime.codex.call("thread/read", { threadId: bot.threadId, includeTurns: false });
    if (thread?.id !== bot.threadId) throw Error("Native conversation identity changed.");
    const page = await this.runtime.codex.call("thread/turns/list", { threadId: bot.threadId, cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    const last = Array.isArray(page?.data) ? page.data[0] ?? null : null;
    const queue = await this.runtime.codex.call("thread/queue/list", { threadId: bot.threadId, cursor: null, limit: 1 });
    const goal = await this.runtime.codex.call("thread/goal/get", { threadId: bot.threadId }).catch(() => ({ goal: null }));
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

  // ---- private review ---------------------------------------------------------
  async start(bot, { reviewId, brief, settings = {}, expectedRevision } = {}) {
    if (!ID.test(reviewId ?? "")) throw Error("A stable review identity is required.");
    const prior = this.store.get("privateReview", reviewId);
    if (prior) { if (prior.botId !== bot.id) throw Error("Review belongs to another bot."); return this.view(prior); }
    if (!brief || typeof brief !== "object" || !Array.isArray(brief.ledger)) throw Error("A review brief is required.");
    // The bot's ordinary admission lock is held only for the admission check
    // and fork creation, never for the review: user input is not delayed.
    return this.runtime.lock(bot.id, async () => {
      const local = this.localIdle(this.store.bot(bot.id), { locked: true });
      if (!local.idle) return { id: reviewId, state: "refused", reason: local.reason };
      const state = await this.nativeState(bot);
      if (state.revision !== expectedRevision || !["idle", "notLoaded"].includes(state.status) || state.queued || state.goalActive)
        return { id: reviewId, state: "refused", reason: "revision-changed" };
      const record = { id: reviewId, botId: bot.id, threadId: bot.threadId, state: "starting", revision: state.revision,
        baseTurnId: state.lastTurnId, startedAt: now(), deadlineAt: new Date(this.clock() + (settings.timeoutSeconds ?? 180) * 1000).toISOString() };
      this.store.put("privateReview", record);
      try {
        const fork = await this.runtime.codex.forkPrivateReview({ threadId: bot.threadId, ...(state.lastTurnId ? { lastTurnId: state.lastTurnId } : {}),
          model: settings.model ?? null, cwd: bot.cwd ?? null, excludeTurns: true, deferGoalContinuation: true, config: PRIVATE_REVIEW_CONFIG,
          ...(settings.fast ? {} : { serviceTier: null }) });
        const forkThreadId = fork?.thread?.id;
        if (typeof forkThreadId !== "string" || forkThreadId === bot.threadId) throw Error("Native fork did not return a distinct private thread.");
        this.byThread.set(forkThreadId, reviewId);
        this.store.put("privateReview", { ...this.store.get("privateReview", reviewId), forkThreadId, state: "running" });
        // User activity may have arrived while the fork was created.
        if (this.store.get("privateReview", reviewId).state !== "running") return this.view(this.store.get("privateReview", reviewId));
        const turn = await this.runtime.codex.startPrivateReviewTurn({ threadId: forkThreadId, input: [{ type: "text", text: reviewPrompt(brief), text_elements: [] }],
          outputSchema: REVIEW_OUTPUT_SCHEMA, ...(settings.model ? { model: settings.model } : {}), ...(settings.effort ? { effort: settings.effort } : {}) });
        const current = this.store.get("privateReview", reviewId);
        this.store.put("privateReview", { ...current, turnId: turn?.turn?.id ?? current.turnId ?? null });
        if (current.state !== "running") await this.interrupt(this.store.get("privateReview", reviewId));
        const timer = setTimeout(() => void this.cancel(this.store.bot(bot.id), reviewId, "The private review exceeded its time bound.", "failed").catch(() => {}),
          Math.max(1000, Date.parse(record.deadlineAt) - this.clock()));
        timer.unref?.(); this.timers.set(reviewId, timer);
      } catch (error) {
        await this.finish(reviewId, "failed", { error: error.message });
      }
      return this.view(this.store.get("privateReview", reviewId));
    });
  }
  view(r) {
    return { id: r.id, botId: r.botId, state: r.state, reason: r.reason ?? null, revision: r.revision, startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null, error: r.error ?? null, output: TERMINAL.has(r.state) ? r.output ?? null : null, usage: r.usage ?? null };
  }
  poll(bot, reviewId) {
    const r = this.store.get("privateReview", String(reviewId ?? ""));
    if (!r || r.botId !== bot.id) return { id: reviewId, state: "missing" };
    return this.view(r);
  }
  async interrupt(r) {
    if (r?.forkThreadId && r.turnId) await this.runtime.codex.call("turn/interrupt", { threadId: r.forkThreadId, turnId: r.turnId }, 15000).catch(() => {});
  }
  async release(r) {
    if (!r?.forkThreadId) return;
    this.byThread.delete(r.forkThreadId);
    await this.runtime.codex.call("thread/unsubscribe", { threadId: r.forkThreadId }, 15000).catch(() => {});
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
  /** User activity always wins: cancel without touching the main conversation. */
  userActivity(botId) {
    const r = this.active(botId);
    if (r) void this.finish(r.id, "cancelled", { error: "Cancelled by user activity." }).catch(error => this.runtime.emit?.("fault", error));
  }

  // ---- hidden fork routing ------------------------------------------------------
  reviewFor(threadId) {
    const id = typeof threadId === "string" ? this.byThread.get(threadId) : null;
    return id ? this.store.get("privateReview", id) : null;
  }
  /** Returns true when the notification belongs to a private review. */
  notification(message) {
    const p = message.params ?? {}, r = this.reviewFor(p.threadId ?? p.thread?.id);
    if (!r) return false;
    if (message.method === "item/started" && ["mcpToolCall", "fileChange"].includes(p.item?.type)) {
      void this.finish(r.id, "invalid", { error: `Read-only violation: ${p.item.type} attempted.` });
      return true;
    }
    if (message.method === "item/completed" && p.item?.type === "agentMessage" && typeof p.item.text === "string")
      this.store.put("privateReview", { ...this.store.get("privateReview", r.id), output: p.item.text.slice(0, 64 * 1024) });
    if (message.method === "thread/tokenUsage/updated" && p.tokenUsage?.total)
      this.store.put("privateReview", { ...this.store.get("privateReview", r.id), usage: p.tokenUsage.total });
    if (message.method === "turn/completed") {
      const status = p.turn?.status;
      void this.finish(r.id, status === "completed" ? "completed" : "failed", status === "completed" ? {} : { error: p.turn?.error?.message ?? `Review turn ${status}.` });
    }
    return true;
  }
  /** Every server request from a private review is refused: no tools, no approvals. */
  request(message) {
    const r = this.reviewFor(message.params?.threadId ?? message.params?.conversationId);
    if (!r) return false;
    if (message.method === "item/tool/call")
      this.runtime.codex.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: "This private review is read-only; tools are unavailable." }] });
    else this.runtime.codex.reject(message.id, "This private review is read-only; approvals and input requests are refused.");
    return true;
  }

  // ---- publication --------------------------------------------------------------
  /**
   * Inject one finished assistant message into the main conversation without a
   * model turn. Idempotent by publicationId; ambiguous outcomes stay
   * uncertain until reconciled against native history.
   */
  async publish(bot, { publicationId, text, expectedRevision }) {
    if (!ID.test(publicationId ?? "") || typeof text !== "string" || !text.trim() || text.length > 8000) throw Error("Invalid publication.");
    const prior = this.store.get("initiativeInjection", publicationId);
    if (prior) {
      if (prior.botId !== bot.id || prior.text !== text) throw Error("Publication identity was reused with different content.");
      // Only a reconciled absence may be attempted again.
      if (prior.state !== "absent") return this.injectionView(prior);
    }
    return this.runtime.lock(bot.id, async () => {
      const current = this.store.get("initiativeInjection", publicationId);
      if (current && current.state !== "absent") return this.injectionView(current);
      const local = this.localIdle(this.store.bot(bot.id), { locked: true });
      if (!local.idle) return { id: publicationId, state: "refused", reason: local.reason };
      const state = await this.nativeState(bot);
      if (state.revision !== expectedRevision || !["idle", "notLoaded"].includes(state.status) || state.queued || state.goalActive)
        return { id: publicationId, state: "refused", reason: "revision-changed" };
      const record = { id: publicationId, botId: bot.id, threadId: bot.threadId, text, anchorTurnId: state.lastTurnId, state: "injecting", attemptedAt: now() };
      this.store.put("initiativeInjection", record);
      try {
        await this.runtime.load?.(bot);
        await this.runtime.codex.call("thread/inject_items", { threadId: bot.threadId,
          items: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }, 30000);
      } catch (error) {
        const definite = error.definite === true;
        this.store.put("initiativeInjection", { ...record, state: definite ? "rejected" : "uncertain", error: error.message });
        return this.injectionView(this.store.get("initiativeInjection", publicationId));
      }
      return this.injectionView(this.project(this.store.get("initiativeInjection", publicationId)));
    });
  }
  /** Confirmed publication becomes visible: live chat, reconnect history, unread. */
  project(record) {
    const at = now(), next = { ...record, state: "injected", injectedAt: record.injectedAt ?? at };
    this.store.put("initiativeInjection", next);
    const bot = this.store.bot(record.botId);
    if (next.anchorTurnId) this.runtime.emitEvent?.("codex", { method: "item/completed", params: { threadId: bot.threadId, turnId: next.anchorTurnId,
      item: initiativeItem(next) } }, bot.id);
    this.runtime.saveBot?.(this.store.bot(bot.id), { preview: next.text.slice(0, 160), updatedAt: at });
    this.runtime.notify?.(bot, `initiative:${next.id}`, `${bot.name ?? "A bot"} has a proposal for you.`);
    return next;
  }
  injectionView(r) { return { id: r.id, state: r.state, reason: r.reason ?? null, error: r.error ?? null, injectedAt: r.injectedAt ?? null, anchorTurnId: r.anchorTurnId ?? null }; }
  /** Settle an ambiguous injection against native history before any retry. */
  async reconcile(bot, publicationId) {
    const r = this.store.get("initiativeInjection", String(publicationId ?? ""));
    if (!r || r.botId !== bot.id) return { id: publicationId, state: "missing" };
    if (r.state !== "uncertain") return this.injectionView(r);
    let cursor = null;
    for (let page = 0; page < 3; page++) {
      const turns = await this.runtime.codex.call("thread/turns/list", { threadId: bot.threadId, cursor, limit: 10, sortDirection: "desc", itemsView: "full" });
      for (const turn of turns?.data ?? []) for (const item of turn.items ?? [])
        if (item.type === "agentMessage" && item.text?.trim() === r.text.trim()) return this.injectionView(this.project({ ...r, nativeTurnId: turn.id }));
      if (!turns?.nextCursor) break;
      cursor = turns.nextCursor;
    }
    // Native history does not contain the message. Only once the original call
    // can no longer complete is it safe to report "not injected" for a retry.
    const settled = this.clock() - Date.parse(r.attemptedAt) > 120000;
    if (!settled) return this.injectionView(r);
    this.store.put("initiativeInjection", { ...r, state: "absent", reconciledAt: now() });
    return this.injectionView(this.store.get("initiativeInjection", r.id));
  }
  /** Projected rows for reconnect history, anchored after their native turn. */
  projected(botId, turnId) {
    return this.store.db.prepare(`SELECT json FROM records WHERE kind='initiativeInjection' AND bot_id=? AND json_extract(json,'$.anchorTurnId')=?
      AND json_extract(json,'$.state')='injected' LIMIT 10`).all(botId, turnId).map(row => initiativeItem(JSON.parse(row.json)));
  }
}
export const initiativeItem = r => ({ type: "agentMessage", id: `initiative:${r.id}`, text: r.text, phase: "final_answer", memoryCitation: null, delivery: null, questions: null });
