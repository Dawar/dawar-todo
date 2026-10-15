import { randomUUID } from "node:crypto";
import { InitiativeLedger, validateReviewResult, publicationText, classifyReply, OWNER_OUTCOMES } from "./initiative-ledger.mjs";

// Global review coordinator (hub). Decides which bot is reviewed, accepts or
// rejects finished reviews, and delivers proposals within spacing and daily
// limits. All native work goes through `executor`, implemented by the
// assigned node (portable) or a local runtime (tests, standalone bridge):
//   placement(botId) -> {nodeId, epoch} | null
//   probe(botId) / start(botId, p) / poll(botId, p) / cancel(botId, p) /
//   publish(botId, p) / reconcile(botId, p) -> node views (see initiative-node.mjs)

const ACTIVE = new Set(["starting", "running", "uncertain"]);
const DELIVERABLE = new Set(["pending", "held", "absent"]);
const LIMIT_BLOCKS = new Set(["spacing", "global-daily-limit", "bot-daily-limit"]);
const STALE_PUBLICATION_MS = 24 * 36e5;
const backoffMs = failures => Math.min(6 * 36e5, 5 * 6e4 * 2 ** Math.max(0, failures - 1));

export const INITIATIVE_TOOL = {
  name: "bots_initiative",
  description: "Your proactive initiative ledger. operation=list shows follow-ups and proposals you are responsible for or contributed to. operation=record saves Dawar's response to one of your proposals (approved, snoozed with an optional until date, dismissed, resolved) — call it when Dawar answers a proposal (for example “yes, proceed”, “next week”, “leave it”). Approved work then follows your normal path.",
  inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: {
    operation: { type: "string", enum: ["list", "record"] }, itemId: { type: "string" },
    outcome: { type: "string", enum: OWNER_OUTCOMES }, until: { type: "string" }, note: { type: "string" } } },
};

/** Text of an owner message, without a quoted reply prefix. */
export function ownerReplyText(item) {
  const text = (item?.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
  const marker = text.lastIndexOf("New user message:\n");
  return marker >= 0 ? text.slice(marker + "New user message:\n".length) : text;
}

export class InitiativeCoordinator {
  constructor({ store, executor, bots, clock = Date.now, random = Math.random, emit = () => {}, fault = () => {} }) {
    Object.assign(this, { store, executor, bots, clock, emit, fault });
    this.ledger = new InitiativeLedger(store, { clock, random });
    this.backlog = [];
    this.nextScanAt = 0;
  }
  at() { return new Date(this.clock()).toISOString(); }
  botState(botId) { return this.store.get("initiativeBot", botId) ?? { id: botId, botId, failures: 0 }; }
  saveBotState(botId, patch) { return this.store.put("initiativeBot", { ...this.botState(botId), ...patch, id: botId, botId }); }
  reviews(states) { return this.store.list("initiativeReview").filter(r => states.has(r.state)); }
  eligibleBots(settings) {
    return this.bots().filter(b => !b.archived && !b.archiving && !b.deletedAt && b.threadId && b.provider !== "claude" &&
      this.ledger.botSettings(b.id, settings).enabled && this.executor.placement(b.id));
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.ledger.settings();
      this.ledger.wakeSnoozed();
      await this.pollReviews(settings);
      await this.reconcilePublications();
      if (!settings.enabled) { await this.cancelAll("Proactive initiative was disabled."); return; }
      await this.deliver(settings);
      if (this.clock() >= this.nextScanAt) { this.nextScanAt = this.clock() + settings.scanMinutes * 6e4; this.scan(settings); }
      await this.admit(settings);
    } finally { this.ticking = false; }
  }

  // ---- admission --------------------------------------------------------------
  /** Eligibility scan: due bots form the backlog in due order. */
  scan(settings) {
    const t = this.clock(), items = this.ledger.items();
    const due = [];
    for (const bot of this.eligibleBots(settings)) {
      const s = this.botState(bot.id), botSettings = this.ledger.botSettings(bot.id, settings);
      if (Date.parse(s.backoffUntil ?? "") > t) continue;
      const last = Date.parse(s.lastReviewAt ?? "") || 0;
      const baseline = !last || t >= (Date.parse(s.nextReviewAt ?? "") || last + botSettings.baselineMinutes * 6e4);
      const followUp = items.some(i => i.responsibleBotId === bot.id && ["candidate", "published", "approved"].includes(i.status) &&
        Date.parse(i.nextReviewAt ?? "") <= t && Date.parse(i.nextReviewAt) > last);
      const ownActivity = Date.parse(s.lastPublishedAt ?? "") || 0;
      const activity = last && Date.parse(bot.updatedAt ?? "") > Math.max(last, ownActivity) && t - last >= settings.scanMinutes * 6e4;
      if (baseline || followUp || activity) due.push({ botId: bot.id, dueAt: baseline ? (Date.parse(s.nextReviewAt ?? "") || 0) : t, trigger: baseline ? "baseline" : followUp ? "follow-up" : "activity" });
    }
    this.backlog = due.sort((a, b) => a.dueAt - b.dueAt);
    this.lastScanAt = this.at();
  }
  async admit(settings) {
    if (this.reviews(new Set(["uncertain", "starting"])).length) return; // reconcile first
    while (this.backlog.length && this.reviews(ACTIVE).length < settings.concurrency) {
      const entry = this.backlog.shift(), bot = this.bots().find(b => b.id === entry.botId);
      if (!bot || !this.eligibleBots(settings).some(b => b.id === bot.id)) continue;
      let probe;
      try { probe = await this.executor.probe(bot.id); }
      catch (error) {
        if (error.unsupported) this.saveBotState(bot.id, { lastError: "The assigned node does not support private reviews.", lastErrorAt: this.at() });
        continue;
      }
      if (!probe.supported) { this.saveBotState(bot.id, { lastError: `Private reviews are unavailable for ${probe.provider} bots.`, lastErrorAt: this.at() }); continue; }
      // Busy, stopped or unavailable bots keep their due review for a later scan.
      if (!probe.idle) { this.saveBotState(bot.id, { lastSkip: probe.reason, lastSkipAt: this.at() }); continue; }
      await this.startReview(bot, probe, settings, entry.trigger);
    }
  }
  brief(bot, settings) {
    const s = this.ledger.botSettings(bot.id, settings);
    return { role: `You are ${bot.name ?? "this bot"}; keep to your existing role and responsibilities from this conversation.`,
      priorities: s.priorities, ledger: this.ledger.forReview(bot.id) };
  }
  async startReview(bot, probe, settings, trigger) {
    const placement = this.executor.placement(bot.id), id = `initiative-review:${randomUUID()}`;
    const capture = { revision: probe.revision, ledgerVersion: this.ledger.version(), nodeId: placement?.nodeId ?? null, epoch: placement?.epoch ?? null, startedAt: this.at() };
    const review = this.store.put("initiativeReview", { id, botId: bot.id, state: "starting", trigger, capture, createdAt: this.at() });
    try {
      const v = await this.executor.start(bot.id, { reviewId: id, brief: this.brief(bot, settings), expectedRevision: probe.revision,
        settings: { model: settings.model, effort: settings.effort, fast: settings.fast, timeoutSeconds: settings.reviewTimeoutSeconds } });
      if (v.state === "refused") return this.endReview(review, "cancelled", { reason: v.reason });
      if (v.state === "failed") return this.failReview(review, v.error ?? "Review failed to start.");
      this.store.put("initiativeReview", { ...review, state: "running", nodeState: v.state });
    } catch (error) {
      // Unknown whether the node accepted it: reconcile by reviewId before another start.
      this.store.put("initiativeReview", { ...review, state: "uncertain", error: error.message });
    }
  }
  endReview(review, state, fields = {}) {
    return this.store.put("initiativeReview", { ...this.store.get("initiativeReview", review.id), ...fields, state, finishedAt: this.at() });
  }
  failReview(review, error, state = "failed") {
    const failures = (this.botState(review.botId).failures ?? 0) + 1;
    this.saveBotState(review.botId, { failures, lastError: String(error).slice(0, 500), lastErrorAt: this.at(), backoffUntil: new Date(this.clock() + backoffMs(failures)).toISOString() });
    // Failed, invalid and interrupted reviews never produce a message.
    return this.endReview(review, state, { error: String(error).slice(0, 2000) });
  }
  async pollReviews(settings) {
    for (const review of this.reviews(ACTIVE)) {
      let v;
      try { v = await this.executor.poll(review.botId, { reviewId: review.id }); } catch { continue; }
      if (v.state === "missing") { this.endReview(review, "cancelled", { reason: "not-started" }); continue; }
      if (["starting", "running"].includes(v.state)) {
        if (review.state !== "running") this.store.put("initiativeReview", { ...review, state: "running" });
        const deadline = Date.parse(review.capture.startedAt) + (settings.reviewTimeoutSeconds + 60) * 1000;
        if (this.clock() > deadline) {
          await this.executor.cancel(review.botId, { reviewId: review.id }).catch(() => {});
          this.failReview(review, "The private review exceeded its time bound.");
        }
        continue;
      }
      if (v.state === "completed") { await this.accept(review, v, settings); continue; }
      if (v.state === "cancelled") { this.endReview(review, "cancelled", { reason: v.error ?? "cancelled" }); continue; }
      this.failReview(review, v.error ?? `Review ${v.state}.`, v.state === "invalid" ? "invalid" : "failed");
    }
  }
  async cancelAll(reason) {
    for (const review of this.reviews(ACTIVE)) {
      await this.executor.cancel(review.botId, { reviewId: review.id }).catch(() => {});
      this.endReview(review, "cancelled", { reason });
    }
  }

  // ---- result acceptance -------------------------------------------------------
  async accept(review, v, settings) {
    const { capture } = review;
    let probe = null;
    try { probe = await this.executor.probe(review.botId); } catch { /* treated as stale below */ }
    const placement = this.executor.placement(review.botId);
    const stale = !probe ? "node-unavailable" : placement?.nodeId !== capture.nodeId || placement?.epoch !== capture.epoch ? "placement-changed" :
      probe.revision !== capture.revision ? "conversation-changed" : this.ledger.version() !== capture.ledgerVersion ? "ledger-changed" : null;
    const usage = v.usage ?? null;
    if (stale) {
      // Stale results are discarded; the bot stays due for a fresh review.
      this.saveBotState(review.botId, { lastOutcome: `rejected:${stale}` });
      return this.endReview(review, "rejected", { reason: stale, usage });
    }
    let result;
    try { result = validateReviewResult(v.output, this.clock()); }
    catch (error) { return this.failReview({ ...review, usage }, `Invalid review result: ${error.message}`, "invalid"); }
    const applied = this.ledger.applyReview(review.botId, result, { ...capture, reviewId: review.id });
    let publication = null, publicationBlock = null;
    if (result.decision === "publish" && applied.contribution) {
      const c = applied.contribution;
      publicationBlock = !c.responsible ? "not-responsible" : null;
      if (!publicationBlock) {
        const block = this.ledger.deliveryBlock(review.botId, c.itemId, { changedCircumstances: c.changedCircumstances }, settings);
        if (block && !LIMIT_BLOCKS.has(block)) publicationBlock = block;
      }
      if (!publicationBlock) {
        const id = `initiative-publication:${randomUUID()}`;
        publication = this.store.put("initiativePublication", { id, botId: review.botId, itemId: c.itemId, reviewId: review.id, kind: c.kind,
          text: publicationText(c, c.itemId), revision: capture.revision, changedCircumstances: c.changedCircumstances, whyNow: c.whyNow,
          state: "pending", attempts: 0, createdAt: this.at() });
      }
    }
    const baseline = this.ledger.botSettings(review.botId, settings).baselineMinutes * 6e4;
    const hinted = Date.parse(result.nextReviewAt ?? "") || 0;
    // Every completed review schedules another; two hours is the earliest.
    const next = Math.min(this.clock() + 7 * 864e5, Math.max(this.clock() + baseline, hinted));
    this.saveBotState(review.botId, { lastReviewAt: this.at(), nextReviewAt: new Date(next).toISOString(), failures: 0, backoffUntil: null,
      lastOutcome: result.decision, lastError: null, lastRevision: capture.revision });
    return this.endReview(review, "accepted", { usage, decision: result.decision, itemIds: applied.items.map(i => i.id),
      publicationId: publication?.id ?? null, publicationBlock, ignored: applied.ignored });
  }

  // ---- publication --------------------------------------------------------------
  async deliver(settings) {
    const rows = this.store.list("initiativePublication").filter(p => DELIVERABLE.has(p.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const p of rows) {
      const item = this.ledger.item(p.itemId);
      if (!item || !["candidate", "held", "published"].includes(item.status)) { this.setPublication(p, "abandoned", { reason: `item-${item?.status ?? "missing"}` }); continue; }
      if (this.clock() - Date.parse(p.createdAt) > STALE_PUBLICATION_MS) { this.stale(p, "expired"); continue; }
      const block = this.ledger.deliveryBlock(p.botId, p.itemId, { changedCircumstances: p.changedCircumstances }, settings);
      if (block === "spacing") { this.setPublication(p, "held", { reason: block }); return; }
      if (LIMIT_BLOCKS.has(block)) { this.setPublication(p, "held", { reason: block }); continue; }
      if (block) { this.setPublication(p, "abandoned", { reason: block }); continue; }
      let probe;
      try { probe = await this.executor.probe(p.botId); } catch { this.setPublication(p, "held", { reason: "node-unavailable" }); continue; }
      if (!probe.idle) { this.setPublication(p, "held", { reason: probe.reason ?? "busy" }); continue; }
      if (probe.revision !== p.revision) { this.stale(p, "conversation-changed"); continue; }
      await this.publishOne(p);
      return; // one delivery attempt per tick; spacing follows confirmation
    }
  }
  setPublication(p, state, fields = {}) {
    return this.store.put("initiativePublication", { ...this.store.get("initiativePublication", p.id), ...fields, state, updatedAt: this.at() });
  }
  /** Stale candidates are refreshed by a later private review, never resent as-is. */
  stale(p, reason) {
    this.setPublication(p, "abandoned", { reason: `stale-${reason}` });
    this.saveBotState(p.botId, { nextReviewAt: this.at() });
  }
  async publishOne(p) {
    // The durable record precedes the native attempt.
    const row = this.setPublication(p, "injecting", { attempts: (p.attempts ?? 0) + 1, attemptedAt: this.at() });
    let v;
    try { v = await this.executor.publish(p.botId, { publicationId: p.id, text: p.text, expectedRevision: p.revision }); }
    catch (error) { return this.setPublication(row, "uncertain", { error: error.message, reconcileAfter: this.at() }); }
    return this.settlePublication(row, v);
  }
  settlePublication(p, v) {
    if (v.state === "injected") {
      this.ledger.markPublished({ ...this.store.get("initiativePublication", p.id), publishedAt: v.injectedAt ?? this.at() });
      this.saveBotState(p.botId, { lastPublishedAt: this.at() });
      return this.store.get("initiativePublication", p.id);
    }
    if (v.state === "refused") return v.reason === "revision-changed" ? this.stale(p, "conversation-changed") : this.setPublication(p, "held", { reason: v.reason });
    if (v.state === "rejected") return this.setPublication(p, "failed", { error: v.error });
    if (v.state === "absent" || v.state === "missing")
      return (p.attempts ?? 0) >= 3 ? this.setPublication(p, "failed", { error: "Injection was not confirmed after three attempts." }) : this.setPublication(p, "pending", { reason: "not-injected" });
    const attempts = (p.reconcileAttempts ?? 0) + 1;
    return this.setPublication(p, "uncertain", { reconcileAttempts: attempts, reconcileAfter: new Date(this.clock() + Math.min(36e5, 3e4 * 2 ** attempts)).toISOString() });
  }
  /** Ambiguous injections are reconciled against native history before any retry. */
  async reconcilePublications() {
    for (const p of this.store.list("initiativePublication").filter(p => ["uncertain", "injecting"].includes(p.state))) {
      if (Date.parse(p.reconcileAfter ?? "") > this.clock()) continue;
      let v;
      try { v = await this.executor.reconcile(p.botId, { publicationId: p.id }); }
      catch { this.setPublication(p, "uncertain", { reconcileAfter: new Date(this.clock() + 6e4).toISOString() }); continue; }
      this.settlePublication(p, v);
    }
  }

  // ---- owner responses -------------------------------------------------------------
  /** First owner reply after a proposal; short clear replies update the ledger. */
  observeUserMessage(botId, item) {
    if (!item || item.type !== "userMessage" || /^(schedule:|peer:|peer-exchange:|manager-notice:|secure-receipt:|initiative)/.test(item.clientId ?? "")) return null;
    const p = this.ledger.awaitingReply(botId);
    if (!p || p.replyObservedAt || Date.parse(p.publishedAt) > this.clock()) return null;
    this.store.put("initiativePublication", { ...p, replyObservedAt: this.at() });
    const outcome = classifyReply(ownerReplyText(item), this.clock());
    if (!outcome) return null; // the bot interprets anything else with its tool
    return this.ledger.recordOutcome(p.itemId, outcome.outcome, { until: outcome.until ?? null, by: "owner", source: `reply:${item.id ?? "unknown"}` });
  }
  /** The bot's ordinary tool. */
  tool(botId, args = {}) {
    const mine = item => item.responsibleBotId === botId || item.contributors?.some(c => c.botId === botId);
    if (args.operation === "list") return { items: this.ledger.items().filter(mine).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
      .map(i => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, responsible: i.responsibleBotId === botId, lastPublishedAt: i.lastPublishedAt ?? null,
        snoozedUntil: i.snoozedUntil ?? null, outcome: i.decision?.outcome ?? null, sources: i.sources ?? [] })) };
    if (args.operation === "record") {
      const item = this.ledger.item(String(args.itemId ?? ""));
      if (!item || !mine(item)) throw Error("That initiative item is not yours.");
      const next = this.ledger.recordOutcome(item.id, args.outcome, { until: args.until ?? null, note: args.note ?? null, by: "bot-tool", source: botId });
      return { id: next.id, status: next.status, snoozedUntil: next.snoozedUntil ?? null };
    }
    throw Error("Use operation list or record.");
  }

  // ---- settings view ------------------------------------------------------------------
  status(botId) {
    const settings = this.ledger.settings(), s = this.botState(botId), bot = this.bots().find(b => b.id === botId);
    const reviews = this.store.list("initiativeReview", botId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { settings, metrics: this.ledger.metrics(settings), lastScanAt: this.lastScanAt ?? null,
      bot: { botId, enabled: this.ledger.botSettings(botId, settings).enabled, override: settings.bots[botId] ?? {},
        supported: bot?.provider !== "claude", lastReviewAt: s.lastReviewAt ?? null, nextReviewAt: s.nextReviewAt ?? null,
        lastOutcome: s.lastOutcome ?? null, failures: s.failures ?? 0, lastError: s.lastError ?? null, lastErrorAt: s.lastErrorAt ?? null,
        backoffUntil: s.backoffUntil ?? null, lastPublishedAt: s.lastPublishedAt ?? null,
        recentReviews: reviews.slice(0, 5).map(r => ({ id: r.id, state: r.state, reason: r.reason ?? null, decision: r.decision ?? null, createdAt: r.createdAt, finishedAt: r.finishedAt ?? null, error: r.error ?? null })),
        items: this.ledger.items().filter(i => i.responsibleBotId === botId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10)
          .map(i => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, lastPublishedAt: i.lastPublishedAt ?? null, snoozedUntil: i.snoozedUntil ?? null })) } };
  }
}

/** Executor over a local BotRuntime (standalone bridge and tests). */
export function localExecutor(runtime) {
  const call = (method, botId, params = {}) => Promise.resolve(runtime.privateReviews.handle(method, botId, params));
  return {
    placement: botId => runtime.store.bots().some(b => b.id === botId) ? { nodeId: "local", epoch: runtime.epoch } : null,
    probe: botId => call("initiative.node.probe", botId),
    start: (botId, p) => call("initiative.node.start", botId, p),
    poll: (botId, p) => call("initiative.node.poll", botId, p),
    cancel: (botId, p) => call("initiative.node.cancel", botId, p),
    publish: (botId, p) => call("initiative.node.publish", botId, p),
    reconcile: (botId, p) => call("initiative.node.reconcile", botId, p),
  };
}
/** Executor over the hub's assigned-node RPC (portable). */
export function hubExecutor(hub, router, owner) {
  const call = (method, timeout) => (botId, p = {}) => router.nodeCall(owner, botId, method, p, timeout);
  return {
    placement: botId => { try { const p = hub.placement(owner, botId); return p && !p.stopped && router.connection(p) ? { nodeId: p.node_id, epoch: p.epoch } : null; } catch { return null; } },
    probe: call("initiative.node.probe", 20000), start: call("initiative.node.start", 60000), poll: call("initiative.node.poll", 10000),
    cancel: call("initiative.node.cancel", 20000), publish: call("initiative.node.publish", 60000), reconcile: call("initiative.node.reconcile", 30000),
  };
}
