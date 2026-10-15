import { randomUUID } from "node:crypto";
import { InitiativeLedger, validateReviewResult, publicationText, classifyReply, OWNER_OUTCOMES, LOOSE_THREAD, ledgerDigest, looseThreadPriority } from "./initiative-ledger.mjs";
import { stagedQueue } from "./prompt-queue.mjs";

// Global review coordinator (hub). Decides which bot runs which private job,
// accepts or rejects finished jobs, and delivers proposals within spacing and
// daily limits. All native work goes through `executor`, implemented by the
// assigned node (portable) or a local runtime (tests, standalone bridge):
//   placement(botId) -> {nodeId, epoch} | null
//   probe(botId) / start(botId, p) / poll(botId, p) / cancel(botId, p) /
//   publish(botId, p) / reconcile(botId, p) -> node views (see initiative-node.mjs)
//
// Jobs per bot, both providers:
//   extract — Dawar's new messages since the bot's mention cursor become loose
//             threads (small model); runs whenever there is new activity.
//   review  — a bounded packet is judged; may propose one contribution.

const ACTIVE = new Set(["starting", "running", "uncertain"]);
const DELIVERABLE = new Set(["pending", "held", "absent"]);
const LIMIT_BLOCKS = new Set(["spacing", "global-daily-limit", "bot-daily-limit", "reserved-for-loose-threads"]);
const STALE_PUBLICATION_MS = 24 * 36e5;
const backoffMs = failures => Math.min(6 * 36e5, 5 * 6e4 * 2 ** Math.max(0, failures - 1));
const TRIGGER_ORDER = { extract: 0, "loose-thread": 1, "follow-up": 2, activity: 3, baseline: 4 };

export const INITIATIVE_TOOL = {
  name: "bots_initiative",
  description: "Your proactive initiative ledger, including loose threads: things Dawar mentioned (clients, ideas, intentions, open questions) that have not reached a conclusion yet, with his original words. operation=list shows items you are responsible for or contributed to. operation=record saves Dawar's decision on one of them (approved, snoozed with an optional until date, dismissed, resolved) — call it when Dawar answers a proposal (for example “yes, proceed”, “next week”, “leave it”, “done”) or when you conclude a loose thread (resolved, with a note naming the evidence). Approved work then follows your normal path.",
  inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: {
    operation: { type: "string", enum: ["list", "record"] }, itemId: { type: "string" },
    outcome: { type: "string", enum: OWNER_OUTCOMES }, until: { type: "string" }, note: { type: "string" } } },
};
/** Settings actions on one loose thread. */
export const THREAD_ACTIONS = { dismiss: "dismissed", snooze: "snoozed", resolve: "resolved" };

/** Text of an owner message, without a quoted reply prefix. */
export function ownerReplyText(item) {
  const text = (item?.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
  const marker = text.lastIndexOf("New user message:\n");
  return marker >= 0 ? text.slice(marker + "New user message:\n".length) : text;
}
const inputText = input => (Array.isArray(input) ? input : []).filter(p => p?.type === "text").map(p => p.text).join(" ");

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
  names() { return Object.fromEntries(this.bots().map(b => [b.id, b.name ?? b.slug ?? b.id])); }
  /** Both providers are eligible; the node reports what it can actually run. */
  eligibleBots(settings) {
    return this.bots().filter(b => !b.archived && !b.archiving && !b.deletedAt && b.threadId &&
      this.ledger.botSettings(b.id, settings).enabled && this.executor.placement(b.id));
  }
  directory(settings) {
    return this.eligibleBots(settings).slice(0, 40).map(b => ({ id: b.id, name: b.name ?? b.slug ?? b.id, role: b.role ?? b.description ?? null }));
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
  /** Eligibility scan: due jobs form the backlog, extraction and loose threads first. */
  scan(settings) {
    const t = this.clock(), items = this.ledger.items();
    const due = [];
    for (const bot of this.eligibleBots(settings)) {
      const s = this.botState(bot.id), botSettings = this.ledger.botSettings(bot.id, settings);
      if (Date.parse(s.backoffUntil ?? "") > t) continue;
      const activityAt = Date.parse(bot.updatedAt ?? "") || 0;
      // Mention capture: any new activity (or a batch that did not fit) since the last extraction.
      if (settings.looseThreads && (s.extractMore || !s.lastExtractionAt || activityAt > Date.parse(s.lastExtractionAt)))
        due.push({ botId: bot.id, kind: "extract", trigger: "extract", dueAt: 0, score: 100 });
      const last = Date.parse(s.lastReviewAt ?? "") || 0;
      const baseline = !last || t >= (Date.parse(s.nextReviewAt ?? "") || last + botSettings.baselineMinutes * 6e4);
      const followUp = items.some(i => i.responsibleBotId === bot.id && ["candidate", "published", "approved"].includes(i.status) &&
        Date.parse(i.nextReviewAt ?? "") <= t && Date.parse(i.nextReviewAt) > last);
      // A loose thread whose time came after the last review.
      const threads = this.ledger.dueThreads(bot.id, settings).filter(i =>
        (i.status === "candidate" ? Date.parse(i.resurfaceAt) : Date.parse(i.lastPublishedAt) + settings.reminderHours * 36e5) > last);
      const ownActivity = Date.parse(s.lastPublishedAt ?? "") || 0;
      const activity = last && activityAt > Math.max(last, ownActivity) && t - last >= settings.scanMinutes * 6e4;
      const trigger = threads.length ? "loose-thread" : followUp ? "follow-up" : activity ? "activity" : baseline ? "baseline" : null;
      if (!trigger) continue;
      const open = items.filter(i => i.responsibleBotId === bot.id && ["candidate", "published", "approved"].includes(i.status)).length;
      const score = threads.reduce((sum, i) => sum + looseThreadPriority(i, t), 0) * 10 + (followUp ? 3 : 0) + (activity ? 5 : 0) + Math.min(open, 5) * 0.5 + (baseline ? 1 : 0);
      due.push({ botId: bot.id, kind: "review", trigger, dueAt: trigger === "baseline" ? (Date.parse(s.nextReviewAt ?? "") || 0) : t, score });
    }
    let reviews = due.filter(e => e.kind === "review");
    // Optional zero-token triage: review only bots with a signal beyond the
    // baseline timer, at most `triageMaxReviews` per scan, best first.
    if (settings.triage) {
      const kept = reviews.filter(e => e.score > 1).sort((a, b) => b.score - a.score).slice(0, settings.triageMaxReviews);
      for (const e of reviews) if (!kept.includes(e)) this.saveBotState(e.botId, { lastSkip: "triage", lastSkipAt: this.at(), skippingSince: this.botState(e.botId).skippingSince ?? this.at() });
      reviews = kept;
    }
    this.backlog = [...due.filter(e => e.kind === "extract"), ...reviews]
      .sort((a, b) => TRIGGER_ORDER[a.trigger] - TRIGGER_ORDER[b.trigger] || b.score - a.score || a.dueAt - b.dueAt);
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
      if (!probe.supported) { this.saveBotState(bot.id, { lastError: `Private reviews are unavailable for ${probe.provider} bots on this node.`, lastErrorAt: this.at() }); continue; }
      // Busy, stopped or unavailable bots keep their due job for a later scan.
      if (!probe.idle) { this.saveBotState(bot.id, { lastSkip: probe.reason, lastSkipAt: this.at(), skippingSince: this.botState(bot.id).skippingSince ?? this.at() }); continue; }
      await this.startJob(bot, probe, settings, entry);
    }
  }
  /** Hub-side review input: role, priorities, ledger (with loose-thread quotes), schedules, queue, bots. */
  brief(bot, settings) {
    const s = this.ledger.botSettings(bot.id, settings);
    const schedules = this.store.list("schedule", bot.id).filter(x => x.enabled !== false).slice(0, 12)
      .map(x => `${x.title ?? inputText(x.input) ?? x.prompt ?? x.id} · ${x.cron ?? x.scheduledAt ?? ""}${x.nextRunAt ? ` · next ${x.nextRunAt}` : ""}`);
    let queue = [];
    try { queue = stagedQueue(this.store, bot.id).slice(0, 10).map(q => inputText(q.input) || q.text || q.id); } catch { queue = []; }
    return { role: `You are ${bot.name ?? "this bot"}; keep to your existing role and responsibilities.`, priorities: s.priorities,
      ledger: this.ledger.forReview(bot.id, 20, { names: this.names(), settings }), schedules, queue,
      bots: this.directory(settings).filter(b => b.id !== bot.id) };
  }
  /** The open loose-thread catalog an extraction deduplicates against (all bots). */
  catalog() {
    return this.ledger.looseThreads().filter(i => !["resolved", "dismissed"].includes(i.status))
      .sort((a, b) => (b.lastTouchedAt ?? "").localeCompare(a.lastTouchedAt ?? "")).slice(0, 80)
      .map(i => ({ id: i.id, key: i.key, title: i.title, category: i.category, entity: i.entity ?? null }));
  }
  /** Fingerprint of the ledger items a review saw: a later change to any of them makes its result stale. */
  sliceDigest(ids) {
    return ledgerDigest(ids.map(id => { const i = this.ledger.item(id); return i ? [i.id, i.status, i.decision?.revision ?? 0, i.lastPublishedAt ?? null] : [id, "missing"]; }));
  }
  async startJob(bot, probe, settings, entry) {
    const placement = this.executor.placement(bot.id), id = `initiative-review:${randomUUID()}`, claude = bot.provider === "claude";
    const extract = entry.kind === "extract";
    const brief = extract ? { ledger: this.catalog(), bots: this.directory(settings) } : this.brief(bot, settings);
    const capture = { revision: probe.revision, ledgerVersion: this.ledger.version(), ledgerDigest: extract ? null : this.sliceDigest(brief.ledger.map(i => i.id)),
      itemIds: extract ? [] : brief.ledger.map(i => i.id), nodeId: placement?.nodeId ?? null, epoch: placement?.epoch ?? null, startedAt: this.at() };
    const review = this.store.put("initiativeReview", { id, botId: bot.id, kind: entry.kind, provider: claude ? "claude" : "codex", state: "starting", trigger: entry.trigger, capture, createdAt: this.at() });
    const jobSettings = extract
      ? { model: claude ? settings.claudeExtractionModel : settings.extractionModel, effort: settings.extractionEffort, timeoutSeconds: Math.min(settings.reviewTimeoutSeconds, 120),
          batch: settings.extractionBatch, chars: settings.extractionChars, lookbackHours: settings.mentionLookbackHours }
      : { model: claude ? settings.claudeModel : settings.model, effort: settings.effort, fast: settings.fast, timeoutSeconds: settings.reviewTimeoutSeconds, packetTokens: settings.packetTokens };
    try {
      const v = await this.executor.start(bot.id, { reviewId: id, kind: entry.kind, brief, expectedRevision: probe.revision, settings: jobSettings,
        ...(extract ? { cursor: this.botState(bot.id).mentionCursor ?? null } : {}) });
      if (v.state === "refused") return this.endReview(review, "cancelled", { reason: v.reason });
      if (v.state === "failed") return this.failReview(review, v.error ?? "Review failed to start.");
      if (v.state === "completed") return this.accept(review, v, settings);
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
    // Failed, invalid and interrupted jobs never produce a message.
    return this.endReview(review, state, { error: String(error).slice(0, 2000), ...(review.usage ? { usage: review.usage } : {}) });
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
      if (v.state === "cancelled") { this.endReview(review, "cancelled", { reason: v.error ?? "cancelled", usage: v.usage ?? null }); continue; }
      this.failReview({ ...review, usage: v.usage ?? null }, v.error ?? `Review ${v.state}.`, v.state === "invalid" ? "invalid" : "failed");
    }
  }
  async cancelAll(reason) {
    for (const review of this.reviews(ACTIVE)) {
      await this.executor.cancel(review.botId, { reviewId: review.id }).catch(() => {});
      this.endReview(review, "cancelled", { reason });
    }
  }

  // ---- result acceptance -------------------------------------------------------
  /** Extraction: apply mentions and resolutions, then advance the cursor. Never stale: it reads past messages. */
  acceptExtraction(review, v, settings) {
    const extraction = v.output?.extraction;
    if (!extraction) return this.failReview({ ...review, usage: v.usage ?? null }, "Extraction returned no result.", "invalid");
    const eligible = new Set(this.eligibleBots(settings).map(b => b.id));
    const applied = this.ledger.applyMentions(review.botId, extraction, {
      responsible: m => m.betterBotId && m.betterBotId !== review.botId && eligible.has(m.betterBotId) ? m.betterBotId : null });
    this.saveBotState(review.botId, { mentionCursor: v.cursor ?? this.botState(review.botId).mentionCursor ?? null, lastExtractionAt: this.at(),
      extractMore: v.more === true, failures: 0, backoffUntil: null, lastError: null });
    // A batch that did not fit continues on the next admission.
    if (v.more) this.backlog.unshift({ botId: review.botId, kind: "extract", trigger: "extract", dueAt: 0, score: 100 });
    return this.endReview(review, "accepted", { usage: v.usage ?? null, messages: v.messages ?? 0, mentions: extraction.mentions.length,
      resolutions: extraction.resolutions.length, itemIds: applied.items.map(i => i.id), ignored: applied.ignored });
  }
  async accept(review, v, settings) {
    if (review.kind === "extract") return this.acceptExtraction(review, v, settings);
    const { capture } = review;
    let probe = null;
    try { probe = await this.executor.probe(review.botId); } catch { /* treated as stale below */ }
    const placement = this.executor.placement(review.botId);
    const stale = !probe ? "node-unavailable" : placement?.nodeId !== capture.nodeId || placement?.epoch !== capture.epoch ? "placement-changed" :
      probe.revision !== capture.revision ? "conversation-changed" :
      (capture.ledgerDigest ? this.sliceDigest(capture.itemIds ?? []) !== capture.ledgerDigest : this.ledger.version() !== capture.ledgerVersion) ? "ledger-changed" : null;
    const usage = v.usage ?? null;
    if (stale) {
      // Stale results are discarded; the bot stays due for a fresh review.
      this.saveBotState(review.botId, { lastOutcome: `rejected:${stale}` });
      return this.endReview(review, "rejected", { reason: stale, usage, packetTokens: v.packetTokens ?? null });
    }
    let result;
    try { result = validateReviewResult(v.output, this.clock()); }
    catch (error) { return this.failReview({ ...review, usage }, `Invalid review result: ${error.message}`, "invalid"); }
    const applied = this.ledger.applyReview(review.botId, result, { ...capture, reviewId: review.id });
    let publication = null, publicationBlock = null;
    if (result.decision === "publish" && !applied.contribution) publicationBlock = "unknown-item";
    if (result.decision === "publish" && applied.contribution) {
      const c = applied.contribution, item = this.ledger.item(c.itemId);
      publicationBlock = !c.responsible ? "not-responsible" : c.kind === LOOSE_THREAD && item?.kind !== LOOSE_THREAD ? "unknown-loose-thread" : null;
      if (!publicationBlock) {
        const block = this.ledger.deliveryBlock(review.botId, c.itemId, { changedCircumstances: c.changedCircumstances }, settings);
        if (block && !LIMIT_BLOCKS.has(block)) publicationBlock = block;
      }
      if (!publicationBlock) {
        const id = `initiative-publication:${randomUUID()}`;
        publication = this.store.put("initiativePublication", { id, botId: review.botId, itemId: c.itemId, reviewId: review.id, kind: item?.kind ?? c.kind,
          text: publicationText({ ...c, kind: item?.kind ?? c.kind }, c.itemId, { item, publisherBotId: review.botId, names: this.names(), clock: this.clock(), timeZone: settings.limitTimeZone }),
          revision: capture.revision, changedCircumstances: c.changedCircumstances, whyNow: c.whyNow, proposedAction: c.proposedAction ?? null,
          state: "pending", attempts: 0, createdAt: this.at() });
      }
    }
    const baseline = this.ledger.botSettings(review.botId, settings).baselineMinutes * 6e4;
    const hinted = Date.parse(result.nextReviewAt ?? "") || 0;
    // Every completed review schedules another; the baseline is the earliest.
    const next = Math.min(this.clock() + 7 * 864e5, Math.max(this.clock() + baseline, hinted));
    this.saveBotState(review.botId, { lastReviewAt: this.at(), skippingSince: null, nextReviewAt: new Date(next).toISOString(), failures: 0, backoffUntil: null,
      lastOutcome: result.decision, lastError: null, lastRevision: capture.revision });
    return this.endReview(review, "accepted", { usage, packetTokens: v.packetTokens ?? null, decision: result.decision, itemIds: applied.items.map(i => i.id),
      publicationId: publication?.id ?? null, publicationBlock, ignored: applied.ignored });
  }

  // ---- publication --------------------------------------------------------------
  async deliver(settings) {
    // Loose threads first, then oldest.
    const rows = this.store.list("initiativePublication").filter(p => DELIVERABLE.has(p.state))
      .sort((a, b) => (b.kind === LOOSE_THREAD) - (a.kind === LOOSE_THREAD) || a.createdAt.localeCompare(b.createdAt));
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
    // The durable record precedes the node's projection.
    const row = this.setPublication(p, "delivering", { attempts: (p.attempts ?? 0) + 1, attemptedAt: this.at() });
    let v;
    try { v = await this.executor.publish(p.botId, { publicationId: p.id, text: p.text, expectedRevision: p.revision, itemId: p.itemId }); }
    catch (error) { return this.setPublication(row, "uncertain", { error: error.message, reconcileAfter: this.at() }); }
    return this.settlePublication(row, v);
  }
  settlePublication(p, v) {
    if (v.state === "delivered") {
      this.ledger.markPublished({ ...this.store.get("initiativePublication", p.id), publishedAt: v.deliveredAt ?? this.at() });
      this.saveBotState(p.botId, { lastPublishedAt: this.at() });
      return this.store.get("initiativePublication", p.id);
    }
    if (v.state === "refused") return v.reason === "revision-changed" ? this.stale(p, "conversation-changed") : this.setPublication(p, "held", { reason: v.reason });
    if (v.state === "rejected") return this.setPublication(p, "failed", { error: v.error });
    if (v.state === "absent" || v.state === "missing")
      return (p.attempts ?? 0) >= 3 ? this.setPublication(p, "failed", { error: "Delivery was not confirmed after three attempts." }) : this.setPublication(p, "pending", { reason: "not-delivered" });
    const attempts = (p.reconcileAttempts ?? 0) + 1;
    return this.setPublication(p, "uncertain", { reconcileAttempts: attempts, reconcileAfter: new Date(this.clock() + Math.min(36e5, 3e4 * 2 ** attempts)).toISOString() });
  }
  /** Ambiguous publish calls are settled against the node's delivery record before any retry. */
  async reconcilePublications() {
    for (const p of this.store.list("initiativePublication").filter(p => ["uncertain", "delivering"].includes(p.state))) {
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
    const names = this.names();
    if (args.operation === "list") return { items: this.ledger.items().filter(mine).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
      .map(i => ({ id: i.id, title: i.title, kind: i.kind, status: i.status, responsible: i.responsibleBotId === botId, lastPublishedAt: i.lastPublishedAt ?? null,
        snoozedUntil: i.snoozedUntil ?? null, outcome: i.decision?.outcome ?? null, sources: i.sources ?? [],
        ...(i.kind === LOOSE_THREAD ? { category: i.category, lastTouchedAt: i.lastTouchedAt,
          mentions: (i.mentions ?? []).slice(-3).map(m => ({ bot: names[m.botId] ?? m.botId, at: m.at, quote: m.quote })) } : {}) })) };
    if (args.operation === "record") {
      const item = this.ledger.item(String(args.itemId ?? ""));
      if (!item || !mine(item)) throw Error("That initiative item is not yours.");
      const next = this.ledger.recordOutcome(item.id, args.outcome, { until: args.until ?? null, note: args.note ?? null, by: "bot-tool", source: botId });
      return { id: next.id, status: next.status, snoozedUntil: next.snoozedUntil ?? null };
    }
    throw Error("Use operation list or record.");
  }
  /** Owner action from Settings on one loose thread: dismiss, snooze (until) or resolve. */
  threadAction(itemId, action, { until = null } = {}) {
    const outcome = THREAD_ACTIONS[action];
    if (!outcome) throw Error("Use dismiss, snooze or resolve.");
    const item = this.ledger.item(String(itemId ?? ""));
    if (!item || item.kind !== LOOSE_THREAD) throw Error("Loose thread not found.");
    return this.ledger.recordOutcome(item.id, outcome, { until, by: "owner", source: "settings" });
  }

  // ---- settings view ------------------------------------------------------------------
  looseThreadList(settings = this.ledger.settings()) {
    const names = this.names(), t = this.clock();
    const open = this.ledger.looseThreads().filter(i => !["resolved", "dismissed"].includes(i.status))
      .sort((a, b) => looseThreadPriority(b, t) - looseThreadPriority(a, t)).slice(0, 50);
    const closed = this.ledger.looseThreads().filter(i => ["resolved", "dismissed"].includes(i.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10);
    return [...open, ...closed].map(i => ({ ...this.ledger.threadView(i, null, { names, settings }), responsibleName: names[i.responsibleBotId] ?? i.responsibleBotId,
      resolution: i.resolution ?? null }));
  }
  status(botId) {
    const settings = this.ledger.settings(), s = this.botState(botId);
    const reviews = this.store.list("initiativeReview", botId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { settings, metrics: this.ledger.metrics(settings), lastScanAt: this.lastScanAt ?? null, looseThreads: this.looseThreadList(settings),
      // Every bot's state, for the global Proactive bots status table.
      bots: this.bots().filter(b => !b.archived && !b.archiving && !b.deletedAt).map(b => {
        const state = this.botState(b.id);
        return { botId: b.id, name: b.name ?? b.slug ?? b.id, included: this.ledger.botSettings(b.id, settings).enabled, lastReviewAt: state.lastReviewAt ?? null,
          nextReviewAt: state.nextReviewAt ?? null, failures: state.failures ?? 0, lastError: state.lastError ?? null, lastErrorAt: state.lastErrorAt ?? null };
      }),
      bot: { botId, enabled: this.ledger.botSettings(botId, settings).enabled, override: settings.bots[botId] ?? {},
        supported: true, lastReviewAt: s.lastReviewAt ?? null, nextReviewAt: s.nextReviewAt ?? null, lastExtractionAt: s.lastExtractionAt ?? null,
        lastOutcome: s.lastOutcome ?? null, failures: s.failures ?? 0, lastError: s.lastError ?? null, lastErrorAt: s.lastErrorAt ?? null,
        backoffUntil: s.backoffUntil ?? null, lastPublishedAt: s.lastPublishedAt ?? null,
        recentReviews: reviews.slice(0, 5).map(r => ({ id: r.id, kind: r.kind ?? "review", state: r.state, reason: r.reason ?? null, decision: r.decision ?? null, createdAt: r.createdAt,
          finishedAt: r.finishedAt ?? null, error: r.error ?? null, tokens: Number(r.usage?.totalTokens) || 0, packetTokens: r.packetTokens ?? null })),
        items: this.ledger.items().filter(i => i.responsibleBotId === botId && i.kind !== LOOSE_THREAD).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10)
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
