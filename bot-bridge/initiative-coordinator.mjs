import { randomUUID } from "node:crypto";
import { readSettings, configureSettings, botSettings, validateThought, validateSpeech, mergeLoops, nextThinkDelay, inQuietHours, quietEndsAt,
  localDay, localTime, ago } from "./mind.mjs";

// Hub coordinator for the bots' inner monologue (mind.mjs). It decides when
// each bot thinks, keeps each bot's journal and open loops, and delivers what
// a bot decided to say at a human pace. All native work goes through
// `executor`, implemented by the assigned node (portable) or a local runtime
// (tests, standalone bridge):
//   placement(botId) -> {nodeId, epoch} | null
//   probe(botId) / start(botId, p) / poll(botId, p) / cancel(botId, p) /
//   publish(botId, p) / reconcile(botId, p) -> node views (see initiative-node.mjs)
//
// Records (hub store):
//   initiativeBot         per-bot mind state: next/last thought, loops, problems
//   mindEntry             one journal entry per thought (or a note the bot made)
//   initiativeReview      one private job (kind think | speak)
//   initiativePublication one outbox message, from drafting to delivery

const ACTIVE = new Set(["starting", "running", "uncertain"]);
const DELIVERABLE = new Set(["pending", "held"]);
// A bot that is merely working can still think (read-only); stopped,
// maintenance and unsupported states cannot.
const BUSY_REASONS = new Set(["not-idle", "busy", "native-busy"]);
const JOURNAL_KEEP = 150, JOBS_KEEP = 3000;
const backoffMs = failures => Math.min(6 * 36e5, 5 * 6e4 * 2 ** Math.max(0, failures - 1));
/** Held-state budget for skipped thoughts (bot-bridge/HELD_STATES.md). */
export const INITIATIVE_SKIP_BUDGET_MS = 24 * 36e5;
/** A bot whose due thoughts have kept being skipped past the budget, in plain language. */
export function initiativeSkipHold(state, now = Date.now()) {
  const since = Date.parse(state?.skippedSince ?? "");
  if (!Number.isFinite(since) || now - since < INITIATIVE_SKIP_BUDGET_MS) return null;
  const hours = Math.floor((now - since) / 36e5), age = hours < 48 ? `${hours} hours` : `${Math.floor(hours / 24)} days`;
  return { since: state.skippedSince, reason: `Thinking has been skipped for ${age}${state.lastSkip ? `: ${String(state.lastSkip).replace(/\.$/, "")}` : ""}.` };
}

export const INITIATIVE_TOOL = {
  name: "bots_initiative",
  description: "Your inner monologue: the private thoughts you have between conversations and the open loops you track for Dawar. operation=read shows your recent thoughts and loops. operation=note adds a note to your journal and can update one loop (loopId with status open, raised, done or dropped) — use it when Dawar answers something you raised on your own, or when a loop is settled in conversation.",
  inputSchema: { type: "object", additionalProperties: false, required: ["operation"], properties: {
    operation: { type: "string", enum: ["read", "note"] }, note: { type: "string" }, loopId: { type: "string" },
    status: { type: "string", enum: ["open", "raised", "done", "dropped"] } } },
};

/** Text of an owner message, without a quoted reply prefix. */
export function ownerReplyText(item) {
  const text = (item?.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
  const marker = text.lastIndexOf("New user message:\n");
  return marker >= 0 ? text.slice(marker + "New user message:\n".length) : text;
}
const inputText = input => (Array.isArray(input) ? input : []).filter(p => p?.type === "text").map(p => p.text).join(" ");
const short = (value, max) => { const s = String(value ?? "").replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };

export class InitiativeCoordinator {
  constructor({ store, executor, bots, clock = Date.now, random = Math.random, emit = () => {}, fault = () => {} }) {
    Object.assign(this, { store, executor, bots, clock, random, emit, fault });
    // Settings access kept under the name the hub and tests use.
    this.ledger = { settings: () => this.settings(), configure: (patch, revision = null) => configureSettings(store, patch, revision, this.at()),
      botSettings: (botId, settings = this.settings()) => botSettings(botId, settings) };
  }
  at() { return new Date(this.clock()).toISOString(); }
  settings() { return readSettings(this.store); }
  botState(botId) { return this.store.get("initiativeBot", botId) ?? { id: botId, botId, failures: 0 }; }
  saveBotState(botId, patch) { return this.store.put("initiativeBot", { ...this.botState(botId), ...patch, id: botId, botId }); }
  // A due thought the node refused (stopped, maintenance) waits; skippedSince
  // makes a long run of such skips visible (initiativeSkipHold), not silent.
  skip(botId, reason) {
    const at = this.at(), s = this.botState(botId);
    this.saveBotState(botId, { lastSkip: reason ?? "busy", lastSkipAt: at, skippedSince: s.skippedSince ?? at, nextThinkAt: new Date(this.clock() + 15 * 6e4).toISOString() });
  }
  jobs(states) { return this.store.list("initiativeReview").filter(r => states.has(r.state)); }
  names() { return Object.fromEntries(this.bots().map(b => [b.id, b.name ?? b.slug ?? b.id])); }
  /** Both providers are eligible; the node reports what it can actually run. */
  eligibleBots(settings) {
    return this.bots().filter(b => !b.archived && !b.archiving && !b.deletedAt && b.threadId &&
      botSettings(b.id, settings).enabled && this.executor.placement(b.id));
  }
  journal(botId, limit = 40) {
    return this.store.list("mindEntry", botId).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const settings = this.settings();
      if (!this.migrated) { this.retireLegacy(); this.migrated = true; }
      await this.pollJobs(settings);
      await this.reconcilePublications();
      if (!settings.enabled) { await this.cancelAll("Proactive bots were turned off."); return; }
      if (settings.messagesEnabled) await this.deliver(settings);
      await this.admit(settings);
    } finally { this.ticking = false; }
  }
  /** Messages queued by the earlier review system are never sent by the inner monologue. */
  retireLegacy() {
    for (const p of this.store.list("initiativePublication")) if (!p.mind && (DELIVERABLE.has(p.state) || p.state === "absent"))
      this.store.put("initiativePublication", { ...p, state: "abandoned", reason: "replaced-by-inner-monologue", updatedAt: this.at() });
  }

  // ---- thinking ----------------------------------------------------------------
  /** Start a thought for every due bot, earliest first, within the concurrency limit. */
  async admit(settings) {
    if (this.jobs(new Set(["uncertain", "starting"])).length) return; // reconcile first
    const t = this.clock(), running = new Set(this.jobs(ACTIVE).map(r => r.botId));
    const due = this.eligibleBots(settings).map(bot => ({ bot, s: this.botState(bot.id) }))
      .filter(({ bot, s }) => !running.has(bot.id) && !(Date.parse(s.backoffUntil ?? "") > t) && (Date.parse(s.nextThinkAt ?? "") || 0) <= t)
      .sort((a, b) => (Date.parse(a.s.nextThinkAt ?? "") || 0) - (Date.parse(b.s.nextThinkAt ?? "") || 0));
    for (const { bot } of due) {
      if (this.jobs(ACTIVE).length >= settings.concurrency) return;
      let probe;
      try { probe = await this.executor.probe(bot.id); }
      catch (error) {
        if (error.unsupported) this.saveBotState(bot.id, { lastError: "The assigned node does not support private thinking.", lastErrorAt: this.at() });
        this.skip(bot.id, "node-unavailable");
        continue;
      }
      if (!probe.supported) { this.saveBotState(bot.id, { lastError: `Private thinking is unavailable for ${probe.provider} bots on this node.`, lastErrorAt: this.at() }); this.skip(bot.id, "unsupported"); continue; }
      const busy = !probe.idle && settings.reviewWhileBusy && BUSY_REASONS.has(probe.reason);
      if (!probe.idle && !busy) { this.skip(bot.id, probe.reason); continue; }
      await this.think(bot, settings, { busy });
    }
  }
  /** Everything the bot's private thought gets from the hub: its own journal, loops, messages and the time. */
  brief(bot, settings) {
    const t = this.clock(), s = this.botState(bot.id), zone = settings.timeZone;
    const journal = this.journal(bot.id, settings.journalEntries).reverse()
      .map(e => ({ when: `${localTime(e.at, zone)} (${ago(e.at, t)})`, thought: e.thought, said: e.messageState === "delivered" ? short(e.message, 600) : null }));
    const sent = this.store.list("initiativePublication", bot.id).filter(p => p.mind && p.state === "published").sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 8).reverse()
      .map(p => ({ when: `${localTime(p.publishedAt, zone)} (${ago(p.publishedAt, t)})`, text: short(p.text, 600) }));
    const schedules = this.store.list("schedule", bot.id).filter(x => x.enabled !== false).slice(0, 12)
      .map(x => short(`${x.title ?? inputText(x.input) ?? x.prompt ?? x.id} · ${x.cron ?? x.scheduledAt ?? ""}${x.nextRunAt ? ` · next ${x.nextRunAt}` : ""}`, 300));
    const quiet = inQuietHours(t, settings);
    return { now: localTime(t, zone), sinceOwner: ago(s.lastOwnerMessageAt, t), priorities: botSettings(bot.id, settings).priorities, paused: !settings.messagesEnabled,
      quiet: { now: quiet, until: quiet ? localTime(quietEndsAt(t, settings), zone) : null }, remaining: this.remaining(bot.id, settings),
      journal, sent, schedules, loops: (s.loops ?? []).map(l => ({ ...l, raisedAgo: l.raisedAt ? ago(l.raisedAt, t) : null })) };
  }
  /** Messages this bot may still send today under both caps. */
  remaining(botId, settings) {
    const today = localDay(this.clock(), settings.timeZone);
    const sent = this.store.list("initiativePublication").filter(p => p.mind && p.state === "published" && localDay(p.publishedAt, settings.timeZone) === today);
    return Math.max(0, Math.min(settings.perBotDaily - sent.filter(p => p.botId === botId).length, settings.globalDaily - sent.length));
  }
  async think(bot, settings, { busy = false } = {}) {
    const claude = bot.provider === "claude";
    return this.startJob(bot, "think", this.brief(bot, settings), { model: claude ? settings.claudeModel : settings.model, effort: settings.effort,
      timeoutSeconds: settings.timeoutSeconds, packetTokens: settings.packetTokens, conversationHours: settings.conversationHours, allowBusy: busy,
      ...(claude ? { claudeHeadroomPercent: settings.claudeHeadroomPercent } : {}) }, { busy });
  }
  async startJob(bot, kind, brief, jobSettings, extra = {}) {
    const placement = this.executor.placement(bot.id), id = `initiative-review:${randomUUID()}`;
    const job = this.store.put("initiativeReview", { id, botId: bot.id, kind, provider: bot.provider === "claude" ? "claude" : "codex", state: "starting", ...extra,
      capture: { nodeId: placement?.nodeId ?? null, epoch: placement?.epoch ?? null, startedAt: this.at(), busy: extra.busy === true }, createdAt: this.at() });
    try {
      const v = await this.executor.start(bot.id, { reviewId: id, kind, brief, settings: jobSettings });
      if (v.state === "refused") {
        this.endJob(job, "cancelled", { reason: v.reason });
        if (kind === "think") this.skip(bot.id, v.reason); else this.speechFailed(job, v.reason);
        return;
      }
      if (v.state === "failed") return this.failJob(job, v.error ?? "The private job failed to start.");
      if (v.state === "completed") return this.accept(job, v, this.settings());
      this.store.put("initiativeReview", { ...job, state: "running", nodeState: v.state });
    } catch (error) {
      // Unknown whether the node accepted it: reconcile by id before another start.
      this.store.put("initiativeReview", { ...job, state: "uncertain", error: error.message });
    }
  }
  endJob(job, state, fields = {}) {
    return this.store.put("initiativeReview", { ...this.store.get("initiativeReview", job.id), ...fields, state, finishedAt: this.at() });
  }
  failJob(job, error, state = "failed") {
    if (job.kind === "speak") { this.speechFailed(job, error); return this.endJob(job, state, { error: String(error).slice(0, 2000) }); }
    const failures = (this.botState(job.botId).failures ?? 0) + 1, retry = new Date(this.clock() + backoffMs(failures)).toISOString();
    this.saveBotState(job.botId, { failures, lastError: String(error).slice(0, 500), lastErrorAt: this.at(), backoffUntil: retry, nextThinkAt: retry });
    return this.endJob(job, state, { error: String(error).slice(0, 2000), ...(job.usage ? { usage: job.usage } : {}) });
  }
  async pollJobs(settings) {
    for (const job of this.jobs(ACTIVE)) {
      let v;
      try { v = await this.executor.poll(job.botId, { reviewId: job.id }); } catch { continue; }
      if (v.state === "missing") { this.endJob(job, "cancelled", { reason: "not-started" }); if (job.kind === "speak") this.speechFailed(job, "not-started"); continue; }
      if (["starting", "running"].includes(v.state)) {
        if (job.state !== "running") this.store.put("initiativeReview", { ...job, state: "running" });
        if (this.clock() > Date.parse(job.capture.startedAt) + (settings.timeoutSeconds + 60) * 1000) {
          await this.executor.cancel(job.botId, { reviewId: job.id }).catch(() => {});
          this.failJob(job, "The private job exceeded its time bound.");
        }
        continue;
      }
      if (v.state === "completed") { await this.accept(job, v, settings); continue; }
      if (v.state === "cancelled") { this.endJob(job, "cancelled", { reason: v.error ?? "cancelled", usage: v.usage ?? null }); if (job.kind === "speak") this.speechFailed(job, "cancelled"); continue; }
      this.failJob({ ...job, usage: v.usage ?? null }, v.error ?? `Private job ${v.state}.`, v.state === "invalid" ? "invalid" : "failed");
    }
  }
  async cancelAll(reason) {
    for (const job of this.jobs(ACTIVE)) {
      await this.executor.cancel(job.botId, { reviewId: job.id }).catch(() => {});
      this.endJob(job, "cancelled", { reason });
    }
    for (const p of this.store.list("initiativePublication").filter(p => p.mind && (DELIVERABLE.has(p.state) || p.state === "drafting")))
      this.setPublication(p, "abandoned", { reason: "turned-off" });
  }

  // ---- results --------------------------------------------------------------------
  async accept(job, v, settings) {
    if (job.kind === "speak") return this.acceptSpeech(job, v);
    const usage = v.usage ?? null, state = this.botState(job.botId);
    let thought;
    try { thought = validateThought(v.output, { knownLoops: state.loops ?? [] }); }
    catch (error) { return this.failJob({ ...job, usage }, `Invalid thought: ${error.message}`, "invalid"); }
    const at = this.at(), bot = this.bots().find(b => b.id === job.botId);
    // Dawar wrote while it was thinking: the thought stands, but it speaks
    // only after thinking again with his message in view.
    const spokeSince = this.ownerSpokeSince(job.botId, job.capture.startedAt);
    const withheld = thought.decision !== "speak" ? null : spokeSince ? "owner-spoke" : !settings.messagesEnabled ? "paused" : !bot ? "bot-missing" : null;
    const speak = thought.decision === "speak" && !withheld;
    const entry = this.store.put("mindEntry", { id: `mind:${randomUUID()}`, botId: job.botId, at, kind: "thought", thought: thought.thought, decision: thought.decision,
      message: thought.message, messageState: speak ? "drafting" : withheld ? "withheld" : null, reason: withheld,
      loops: thought.loops.map(l => `${l.title} (${l.status})`), jobId: job.id, model: job.provider === "claude" ? settings.claudeModel : settings.model,
      tokens: Number(usage?.totalTokens) || 0 });
    const delay = spokeSince ? 5 * 6e4 : nextThinkDelay(settings, { now: this.clock(), lastConversationAt: bot?.updatedAt ?? null, checkBackMinutes: thought.checkBackMinutes, random: this.random });
    this.saveBotState(job.botId, { loops: mergeLoops(state.loops ?? [], thought.loops, at), lastThinkAt: at, lastThought: thought.thought,
      nextThinkAt: new Date(this.clock() + delay).toISOString(), failures: 0, backoffUntil: null, skippedSince: null, lastSkip: null, lastError: null });
    this.prune(job.botId);
    if (speak) {
      const p = this.store.put("initiativePublication", { id: `initiative-publication:${randomUUID()}`, botId: job.botId, entryId: entry.id, mind: true, text: thought.message,
        state: "drafting", attempts: 0, createdAt: at });
      if (settings.speakWithBotModel) await this.startJob(bot, "speak", { thought: thought.thought, draft: thought.message, now: localTime(this.clock(), settings.timeZone) },
        { model: bot.model ?? null, effort: settings.speakEffort, timeoutSeconds: settings.timeoutSeconds, conversationHours: 24, allowBusy: true,
          ...(bot.provider === "claude" ? { claudeHeadroomPercent: settings.claudeHeadroomPercent } : {}) }, { publicationId: p.id });
      else this.setPublication(p, "pending");
    }
    return this.endJob(job, "accepted", { usage, packetTokens: v.packetTokens ?? null, decision: thought.decision, entryId: entry.id });
  }
  /** The bot's own model rewrote the message: it replaces the draft. */
  acceptSpeech(job, v) {
    const p = this.store.get("initiativePublication", job.publicationId);
    let speech;
    try { speech = validateSpeech(v.output); } catch (error) { this.speechFailed(job, error.message); return this.endJob(job, "invalid", { error: error.message, usage: v.usage ?? null }); }
    if (p?.state === "drafting") {
      this.setPublication(p, "pending", { text: speech.message, draft: p.text });
      const e = this.store.get("mindEntry", p.entryId);
      if (e) this.store.put("mindEntry", { ...e, message: speech.message, messageState: "queued" });
    }
    return this.endJob(job, "accepted", { usage: v.usage ?? null });
  }
  /** Rewriting failed: the thought's own draft goes out instead. */
  speechFailed(job, reason) {
    const p = job.publicationId ? this.store.get("initiativePublication", job.publicationId) : null;
    if (p?.state !== "drafting") return;
    this.setPublication(p, "pending", { draftError: String(reason ?? "").slice(0, 300) });
    const e = this.store.get("mindEntry", p.entryId);
    if (e) this.store.put("mindEntry", { ...e, messageState: "queued" });
  }
  /** Bounded history: the newest journal entries per bot and the newest jobs overall. */
  prune(botId) {
    const entries = this.store.list("mindEntry", botId);
    if (entries.length > JOURNAL_KEEP) for (const e of entries.sort((a, b) => b.at.localeCompare(a.at)).slice(JOURNAL_KEEP)) this.store.remove("mindEntry", e.id);
    const jobs = this.store.list("initiativeReview");
    if (jobs.length > JOBS_KEEP) for (const j of jobs.filter(j => !ACTIVE.has(j.state)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(JOBS_KEEP)) this.store.remove("initiativeReview", j.id);
  }

  // ---- delivery ----------------------------------------------------------------------
  /** Dawar wrote to this bot after `at` (recorded from the hub's own message stream). */
  ownerSpokeSince(botId, at) { return Date.parse(this.botState(botId).lastOwnerMessageAt ?? "") > Date.parse(at ?? ""); }
  /**
   * One delivery per tick, oldest first: nothing during quiet hours, a random
   * spacing between any two messages, daily caps, and only to an idle bot.
   * A message overtaken by Dawar writing to that bot, or too old, is dropped
   * and the bot thinks again soon.
   */
  async deliver(settings) {
    const t = this.clock();
    const rows = this.store.list("initiativePublication").filter(p => p.mind && DELIVERABLE.has(p.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const p of rows) {
      if (this.ownerSpokeSince(p.botId, p.createdAt)) { this.drop(p, "owner-spoke", 5); continue; }
      if (t - Date.parse(p.createdAt) > settings.messageHours * 36e5) { this.drop(p, "expired", 1); continue; }
    }
    const pending = this.store.list("initiativePublication").filter(p => p.mind && DELIVERABLE.has(p.state)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!pending.length) return;
    if (inQuietHours(t, settings)) { for (const p of pending) if (p.reason !== "quiet-hours") this.setPublication(p, "held", { reason: "quiet-hours" }); return; }
    const nextAt = Date.parse(this.store.meta("initiative-next-delivery-at") ?? "") || 0;
    if (nextAt > t) { for (const p of pending) if (p.reason !== "spacing") this.setPublication(p, "held", { reason: "spacing" }); return; }
    for (const p of pending) {
      if (this.remaining(p.botId, settings) <= 0) { if (p.reason !== "daily-limit") this.setPublication(p, "held", { reason: "daily-limit" }); continue; }
      let probe;
      try { probe = await this.executor.probe(p.botId); } catch { this.setPublication(p, "held", { reason: "node-unavailable" }); continue; }
      if (!probe.idle) { if (p.reason !== (probe.reason ?? "busy")) this.setPublication(p, "held", { reason: probe.reason ?? "busy" }); continue; }
      await this.publishOne(p, probe.revision, settings);
      return;
    }
  }
  drop(p, reason, rethinkMinutes) {
    this.setPublication(p, "abandoned", { reason });
    const e = this.store.get("mindEntry", p.entryId);
    if (e) this.store.put("mindEntry", { ...e, messageState: "dropped", reason });
    const s = this.botState(p.botId), soon = this.clock() + rethinkMinutes * 6e4;
    if ((Date.parse(s.nextThinkAt ?? "") || Infinity) > soon) this.saveBotState(p.botId, { nextThinkAt: new Date(soon).toISOString() });
  }
  setPublication(p, state, fields = {}) {
    return this.store.put("initiativePublication", { ...this.store.get("initiativePublication", p.id), ...fields, state, updatedAt: this.at() });
  }
  async publishOne(p, expectedRevision, settings = this.settings()) {
    // The durable record precedes the node's projection.
    const row = this.setPublication(p, "delivering", { attempts: (p.attempts ?? 0) + 1, attemptedAt: this.at() });
    let v;
    try { v = await this.executor.publish(p.botId, { publicationId: p.id, text: p.text, expectedRevision }); }
    catch (error) { return this.setPublication(row, "uncertain", { error: error.message, reconcileAfter: this.at() }); }
    return this.settlePublication(row, v, settings);
  }
  settlePublication(p, v, settings = this.settings()) {
    if (v.state === "delivered") {
      const at = v.deliveredAt ?? this.at();
      const gap = (settings.spacingMinMinutes + this.random() * (settings.spacingMaxMinutes - settings.spacingMinMinutes)) * 6e4;
      this.store.meta("initiative-next-delivery-at", new Date(this.clock() + gap).toISOString());
      this.saveBotState(p.botId, { lastPublishedAt: at });
      const e = this.store.get("mindEntry", p.entryId);
      if (e) this.store.put("mindEntry", { ...e, message: p.text, messageState: "delivered", deliveredAt: at });
      return this.setPublication(p, "published", { publishedAt: at, reason: null });
    }
    if (v.state === "refused") return this.setPublication(p, "held", { reason: v.reason });
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

  // ---- Dawar and the bot ---------------------------------------------------------------
  /** Dawar wrote to a bot: anything it queued is reconsidered, and it reflects again once the conversation settles. */
  observeUserMessage(botId, item) {
    if (!item || item.type !== "userMessage" || /^(schedule:|peer:|peer-exchange:|manager-notice:|secure-receipt:|initiative)/.test(item.clientId ?? "")) return null;
    const settings = this.settings();
    return this.saveBotState(botId, { lastOwnerMessageAt: this.at(), nextThinkAt: new Date(this.clock() + settings.activeMinutes * 6e4).toISOString() });
  }
  /** The bot's ordinary tool: read its own mind, or note something in it. */
  tool(botId, args = {}) {
    const s = this.botState(botId);
    if (args.operation === "read" || args.operation === "list") return {
      thoughts: this.journal(botId, 10).map(e => ({ at: e.at, thought: e.thought, said: e.messageState === "delivered" ? e.message : null })),
      loops: (s.loops ?? []).map(l => ({ id: l.id, title: l.title, status: l.status, note: l.note ?? "", raisedAt: l.raisedAt ?? null })) };
    if (args.operation === "note" || args.operation === "record") {
      const at = this.at(), note = short(args.note, 1000);
      let loops = s.loops ?? [];
      if (args.loopId) {
        const loop = loops.find(l => l.id === args.loopId);
        if (!loop) throw Error("That loop is not in your mind.");
        if (!["open", "raised", "done", "dropped"].includes(args.status)) throw Error("Give the loop a status: open, raised, done or dropped.");
        loops = mergeLoops(loops, [{ ...loop, status: args.status, note: note || loop.note }], at);
      } else if (!note) throw Error("Write a note, or give a loopId and status.");
      this.saveBotState(botId, { loops });
      if (note) this.store.put("mindEntry", { id: `mind:${randomUUID()}`, botId, at, kind: "note", thought: note, decision: "quiet", message: null, messageState: null });
      return { ok: true, loops: loops.map(l => ({ id: l.id, title: l.title, status: l.status })) };
    }
    throw Error("Use operation read or note.");
  }
  /** "Think now" from the bot's Mind panel. */
  thinkNow(botId) {
    this.saveBotState(botId, { nextThinkAt: this.at(), backoffUntil: null });
    return this.status(botId);
  }

  // ---- status ------------------------------------------------------------------------------
  metrics(settings) {
    const today = localDay(this.clock(), settings.timeZone), ofToday = at => at && localDay(at, settings.timeZone) === today;
    const jobs = this.store.list("initiativeReview").filter(r => ofToday(r.createdAt));
    return { thoughtsToday: jobs.filter(r => r.kind === "think" && r.state === "accepted").length,
      messagesToday: this.store.list("initiativePublication").filter(p => p.mind && p.state === "published" && ofToday(p.publishedAt)).length,
      tokensToday: jobs.reduce((sum, r) => sum + (Number(r.usage?.totalTokens) || 0), 0),
      waiting: this.store.list("initiativePublication").filter(p => p.mind && DELIVERABLE.has(p.state)).length };
  }
  status(botId) {
    const settings = this.settings(), s = this.botState(botId), t = this.clock();
    return { settings, metrics: this.metrics(settings), quietNow: inQuietHours(t, settings),
      // Every bot's state, for the global Proactive bots status table.
      bots: this.bots().filter(b => !b.archived && !b.archiving && !b.deletedAt).map(b => {
        const state = this.botState(b.id);
        return { botId: b.id, name: b.name ?? b.slug ?? b.id, included: botSettings(b.id, settings).enabled, lastThinkAt: state.lastThinkAt ?? null,
          nextThinkAt: state.nextThinkAt ?? null, lastThought: state.lastThought ? short(state.lastThought, 240) : null, failures: state.failures ?? 0,
          lastError: state.lastError ?? null, lastErrorAt: state.lastErrorAt ?? null, skipped: initiativeSkipHold(state, t) };
      }),
      bot: { botId, enabled: botSettings(botId, settings).enabled, override: settings.bots[botId] ?? {}, lastThinkAt: s.lastThinkAt ?? null,
        nextThinkAt: s.nextThinkAt ?? null, lastError: s.lastError ?? null, lastErrorAt: s.lastErrorAt ?? null, skipped: initiativeSkipHold(s, t),
        loops: (s.loops ?? []).map(l => ({ id: l.id, title: l.title, status: l.status, note: l.note ?? "", raisedAt: l.raisedAt ?? null, updatedAt: l.updatedAt ?? null })),
        journal: this.journal(botId, 40).map(e => ({ id: e.id, at: e.at, kind: e.kind ?? "thought", thought: e.thought, decision: e.decision ?? "quiet",
          message: e.message ?? null, messageState: e.messageState ?? null, reason: e.reason ?? null, tokens: e.tokens ?? 0 })) } };
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
