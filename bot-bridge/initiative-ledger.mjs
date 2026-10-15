import { createHash, randomUUID } from "node:crypto";

// Proactive initiative: the persistent, cross-bot ledger of follow-ups and
// opportunities, its owner settings, delivery limits and reply outcomes.
// Everything here is plain records in an existing Store (the hub's logical
// control store in portable deployments). No native authority is held here.

export const INITIATIVE_KINDS = ["follow-up", "opportunity", "update", "loose-thread"];
// Kinds a review may create. Loose threads come only from Dawar's own words
// (mention extraction); a review can propose, update or resolve them.
const REVIEW_CREATABLE = new Set(["follow-up", "opportunity", "update"]);
export const LOOSE_THREAD = "loose-thread";
export const MENTION_CATEGORIES = ["client", "person", "company", "idea", "intention", "question", "commitment", "decision"];
export const IMPORTANCE = ["high", "medium", "low"];
export const RESOLUTION_KINDS = ["todo", "task-completed", "decision", "message-sent", "meeting-scheduled", "artifact", "owner-done", "owner-dropped", "concluded"];
export const PROPOSED_ACTIONS = ["todo", "draft-message", "schedule", "research", "drop", "other"];
// Statuses an owner decision sets. A private review can never set these.
export const OWNER_OUTCOMES = ["approved", "snoozed", "dismissed", "resolved"];
const REVIEW_STATUSES = new Set(["candidate", "resolved"]);
const OPEN = new Set(["candidate", "held", "published"]);
// Loose threads not yet concluded (approved work is in progress, not lost).
const UNCONCLUDED = new Set(["candidate", "held", "published", "approved", "snoozed"]);

/** Approved defaults (October 13 plan, quiet hours removed by amendment). */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 2,
  enabled: false,
  scanMinutes: 25,
  // Reviews run when something changed; this is the longest a bot goes
  // without a fresh look for new opportunities anyway.
  baselineMinutes: 360,
  concurrency: 1,
  // Review model per provider (empty = the bot's own model). Cheap pinned
  // models keep always-on reviews affordable.
  model: "gpt-6-luna",
  claudeModel: "haiku",
  effort: "medium",
  fast: false,
  // Loose threads: cheap extraction of Dawar's own mentions, then resurfacing.
  looseThreads: true,
  extractionModel: "gpt-6-luna",
  claudeExtractionModel: "haiku",
  extractionEffort: "medium",
  extractionBatch: 40,
  extractionChars: 24000,
  mentionLookbackHours: 72,
  // One global daily slot is kept for due loose threads.
  looseThreadReserve: 1,
  // Review packet bound (estimated tokens) and the conversation window it reads:
  // high-level messages only; MEMORY.md and the ledger carry anything older.
  packetTokens: 12000,
  conversationHours: 72,
  // Reviews run while a bot is busy (they are read-only); delivery still waits.
  reviewWhileBusy: true,
  // A time-sensitive item whose bot stays busy this long moves to a bot that can deliver it.
  handoffHours: 12,
  // Claude reviews pause while any subscription window is at or above this utilization.
  claudeHeadroomPercent: 80,
  // Optional zero-token triage: review only bots with signals, at most N per scan.
  triage: false,
  triageMaxReviews: 4,
  reviewTimeoutSeconds: 180,
  // Messages from any bot arrive at a human pace: a random 5–20 minutes apart.
  spacingMinMinutes: 5,
  spacingMaxMinutes: 20,
  perBotDaily: 4,
  globalDaily: 20,
  // Each bot nudges about one unanswered proposal at most every reminderHours
  // (no model call), rotating through its open items until Dawar answers;
  // 0 = no cap on how often one item comes back.
  reminderHours: 12,
  maxReminders: 0,
  // Calendar day used for notification limits only; no delivery hold.
  limitTimeZone: "America/Toronto",
  priorities: "",
  // "all" eligible bots (approved default) or only bots explicitly selected
  // with a per-bot override, for a pilot.
  coverage: "all",
  bots: {},
  revision: 0,
});
const BOUNDS = {
  scanMinutes: [5, 24 * 60], baselineMinutes: [30, 7 * 24 * 60], concurrency: [1, 4], reviewTimeoutSeconds: [30, 600],
  spacingMinMinutes: [0, 120], spacingMaxMinutes: [0, 240], perBotDaily: [0, 20], globalDaily: [0, 100], reminderHours: [1, 24 * 30],
  extractionBatch: [5, 100], extractionChars: [2000, 60000], mentionLookbackHours: [1, 14 * 24], looseThreadReserve: [0, 5],
  packetTokens: [3000, 20000], triageMaxReviews: [1, 32], maxReminders: [0, 50], conversationHours: [6, 14 * 24], handoffHours: [1, 7 * 24],
  claudeHeadroomPercent: [10, 100],
};
const INTEGER_SETTINGS = new Set(["concurrency", "extractionBatch", "extractionChars", "looseThreadReserve", "packetTokens", "triageMaxReviews", "maxReminders"]);
// Version 1 defaults: a saved value still equal to one of these was never chosen
// by Dawar, so it follows the version 2 default instead.
const V1_DEFAULTS = { model: "", claudeModel: "", extractionEffort: "low", baselineMinutes: 120, reminderHours: 72, perBotDaily: 2, globalDaily: 5,
  spacingMinMinutes: 3, spacingMaxMinutes: 5 };
function upgradeSettings(saved) {
  if ((saved.version ?? 1) >= 2) return saved;
  const out = { ...saved, version: 2 };
  for (const [key, old] of Object.entries(V1_DEFAULTS)) if (out[key] === old) delete out[key];
  return out;
}
const MODEL = /^[a-zA-Z0-9._:[\]-]{0,80}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

export function normalizeKey(value) {
  return text(String(value ?? ""), 400).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}
/** Toronto (or configured) calendar day for daily notification limits. */
export function limitDay(at, timeZone = DEFAULT_SETTINGS.limitTimeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

function boundedNumber(key, value) {
  const [min, max] = BOUNDS[key];
  if (!Number.isFinite(value) || value < min || value > max) throw Error(`${key} must be between ${min} and ${max}.`);
  return INTEGER_SETTINGS.has(key) || key.endsWith("Daily") ? Math.round(value) : value;
}
function botOverride(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Bot overrides must be objects.");
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "enabled") { if (typeof v !== "boolean" && v !== null) throw Error("Bot enablement must be true, false or null."); if (v !== null) out.enabled = v; }
    else if (key === "priorities") { if (typeof v !== "string" || v.length > 4000) throw Error("Bot priorities exceed 4000 characters."); if (v.trim()) out.priorities = v.trim(); }
    else if (key === "baselineMinutes") { if (v !== null) out.baselineMinutes = boundedNumber("baselineMinutes", v); }
    else throw Error(`Unknown bot override ${key}.`);
  }
  return out;
}

export class InitiativeLedger {
  constructor(store, { clock = Date.now, random = Math.random } = {}) {
    Object.assign(this, { store, clock, random });
  }
  at() { return new Date(this.clock()).toISOString(); }

  // ---- settings -------------------------------------------------------------
  settings() {
    const saved = this.store.meta("initiative-settings");
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? upgradeSettings(saved) : {}), bots: { ...(saved?.bots ?? {}) } };
  }
  /** Owner patch. `expectedRevision` makes concurrent Settings edits explicit. */
  configure(patch, expectedRevision = null) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw Error("Provide initiative settings.");
    return this.store.transaction(() => {
      const current = this.settings();
      if (expectedRevision !== null && expectedRevision !== current.revision)
        throw Object.assign(Error("Initiative settings changed elsewhere; reload them before saving."), { outcome: "rejected" });
      const next = { ...current, bots: { ...current.bots } };
      for (const [key, value] of Object.entries(patch)) {
        if (["enabled", "fast", "looseThreads", "triage", "reviewWhileBusy"].includes(key)) { if (typeof value !== "boolean") throw Error(`${key} must be true or false.`); next[key] = value; }
        else if (key in BOUNDS) next[key] = boundedNumber(key, value);
        else if (["model", "claudeModel", "extractionModel", "claudeExtractionModel"].includes(key)) { if (typeof value !== "string" || !MODEL.test(value)) throw Error(`Invalid ${key}.`); next[key] = value; }
        else if (key === "extractionEffort") { if (!EFFORTS.has(value)) throw Error("Invalid extraction reasoning effort."); next.extractionEffort = value; }
        else if (key === "coverage") { if (!["all", "selected"].includes(value)) throw Error("Coverage must be all or selected."); next.coverage = value; }
        else if (key === "effort") { if (!EFFORTS.has(value)) throw Error("Invalid review reasoning effort."); next.effort = value; }
        else if (key === "priorities") { if (typeof value !== "string" || value.length > 8000) throw Error("Priorities exceed 8000 characters."); next.priorities = value.trim(); }
        else if (key === "bots") {
          if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Bot overrides must be keyed by bot.");
          for (const [botId, override] of Object.entries(value)) {
            if (override === null) delete next.bots[botId];
            else { const merged = { ...next.bots[botId], ...override }; for (const k of Object.keys(override)) if (override[k] === null) delete merged[k]; next.bots[botId] = botOverride(merged); }
          }
        } else throw Error(`Unknown initiative setting ${key}.`);
      }
      if (next.spacingMaxMinutes < next.spacingMinMinutes) throw Error("Maximum delivery spacing must be at least the minimum.");
      next.revision = current.revision + 1;
      next.updatedAt = this.at();
      this.store.meta("initiative-settings", next);
      return next;
    });
  }
  botSettings(botId, settings = this.settings()) {
    const o = settings.bots[botId] ?? {};
    return { enabled: settings.enabled && (settings.coverage === "selected" ? o.enabled === true : o.enabled !== false), baselineMinutes: o.baselineMinutes ?? settings.baselineMinutes,
      priorities: [settings.priorities, o.priorities].filter(Boolean).join("\n\n") };
  }

  // ---- ledger ---------------------------------------------------------------
  version() { return Number(this.store.meta("initiative-ledger-version")) || 0; }
  bump() { const v = this.version() + 1; this.store.meta("initiative-ledger-version", v); return v; }
  items() { return this.store.list("initiativeItem"); }
  item(id) { return this.store.get("initiativeItem", id); }
  findByKey(key) {
    const k = normalizeKey(key);
    return k ? this.items().find(item => item.key === k || item.aliases?.includes(k)) ?? null : null;
  }
  /**
   * Ledger slice supplied to a review: the bot's own items and open cross-bot
   * items, plus every unconcluded loose thread this bot is responsible for or
   * contributed to, with the quotes of Dawar's original mentions.
   */
  forReview(botId, limit = 20, { names = {}, settings = this.settings() } = {}) {
    const mine = item => item.responsibleBotId === botId || item.contributors?.some(c => c.botId === botId);
    const threads = this.looseThreads().filter(item => UNCONCLUDED.has(item.status) && mine(item))
      .map(item => ({ item, priority: looseThreadPriority(item, this.clock()) }))
      .sort((a, b) => b.priority - a.priority).slice(0, 25)
      .map(({ item, priority }) => this.threadView(item, botId, { names, priority, settings }));
    const rows = this.items().filter(item => item.kind !== LOOSE_THREAD && (mine(item) || OPEN.has(item.status)));
    return [...threads, ...rows.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, limit).map(item => ({
      id: item.id, key: item.key, title: item.title, kind: item.kind, status: item.status, responsibleBot: item.responsibleBotId,
      yours: item.responsibleBotId === botId, lastPublishedAt: item.lastPublishedAt ?? null, reminderCount: item.reminderCount ?? 0,
      snoozedUntil: item.snoozedUntil ?? null, outcome: item.decision?.outcome ?? null, sources: (item.sources ?? []).slice(0, 6),
      nextReviewAt: item.nextReviewAt ?? null }))];
  }
  /** Compact review/Settings view of one loose thread. */
  threadView(item, botId = null, { names = {}, priority = looseThreadPriority(item, this.clock()), settings = this.settings() } = {}) {
    const t = this.clock(), due = this.threadDue(item, settings);
    return { id: item.id, key: item.key, title: item.title, kind: LOOSE_THREAD, category: item.category, entity: item.entity ?? null,
      importance: item.importance, timeSensitive: item.timeSensitive === true, status: item.status, responsibleBot: item.responsibleBotId,
      yours: botId ? item.responsibleBotId === botId : undefined, due, priority: Math.round(priority * 100) / 100,
      firstMentionedAt: item.firstMentionedAt, lastTouchedAt: item.lastTouchedAt, resurfaceAt: item.resurfaceAt ?? null,
      ageHours: Math.round((t - Date.parse(item.firstMentionedAt ?? item.createdAt)) / 36e5),
      lastPublishedAt: item.lastPublishedAt ?? null, reminderCount: item.reminderCount ?? 0, snoozedUntil: item.snoozedUntil ?? null,
      summary: item.summary ?? null,
      mentions: (item.mentions ?? []).slice(-3).map(m => ({ bot: names[m.botId] ?? m.botId, botId: m.botId, at: m.at, quote: m.quote, ref: mentionRef(m) })) };
  }

  // ---- loose threads -------------------------------------------------------
  looseThreads() { return this.items().filter(item => item.kind === LOOSE_THREAD); }
  /** Due to be raised now: open and past its resurfacing time, or an unanswered proposal due a reminder. */
  threadDue(item, settings = this.settings()) {
    const t = this.clock();
    if (item.kind !== LOOSE_THREAD) return false;
    if (item.status === "candidate") return Date.parse(item.resurfaceAt ?? "") <= t;
    if (item.status === "published") return this.reminderAllowed(item, settings) && Date.parse(item.lastPublishedAt ?? "") + settings.reminderHours * 36e5 <= t;
    return false;
  }
  reminderAllowed(item, settings = this.settings()) { return settings.maxReminders === 0 || (item.reminderCount ?? 0) < settings.maxReminders; }
  /** Unanswered proposals (any kind) whose reminder interval has passed. */
  remindersDue(settings = this.settings()) {
    const t = this.clock();
    return this.items().filter(item => item.status === "published" && this.reminderAllowed(item, settings) &&
      Date.parse(item.lastPublishedAt ?? "") + settings.reminderHours * 36e5 <= t)
      .sort((a, b) => (a.lastPublishedAt ?? "").localeCompare(b.lastPublishedAt ?? ""));
  }
  /** Moves an open item to another bot that can deliver it; the original bot stays a contributor. */
  handOff(itemId, toBotId, note) {
    return this.store.transaction(() => {
      const item = this.item(itemId);
      if (!item || item.responsibleBotId === toBotId || !OPEN.has(item.status)) return null;
      const contributors = [...new Set([...(item.contributors ?? []), item.responsibleBotId])].filter(id => id && id !== toBotId);
      const next = { ...item, botId: toBotId, responsibleBotId: toBotId, contributors, handedOffAt: this.at(), handedOffFrom: item.responsibleBotId,
        notes: [...(item.notes ?? []), { botId: item.responsibleBotId, at: this.at(), text: note }].slice(-20), updatedAt: this.at() };
      this.store.put("initiativeItem", next);
      this.bump();
      return next;
    });
  }
  dueThreads(botId = null, settings = this.settings()) {
    return this.looseThreads().filter(item => (!botId || item.responsibleBotId === botId) && this.threadDue(item, settings))
      .sort((a, b) => looseThreadPriority(b, this.clock()) - looseThreadPriority(a, this.clock()));
  }
  /** The open loose thread a mention refers to (id, key/alias, then same entity and similar title). */
  matchThread(m) {
    const threads = this.looseThreads();
    if (m.itemId) { const byId = threads.find(i => i.id === m.itemId); if (byId) return byId; }
    const key = normalizeKey(m.key || m.title);
    const byKey = key && threads.find(i => i.key === key || i.aliases?.includes(key));
    if (byKey) return byKey;
    const entity = normalizeKey(m.entity);
    if (!entity) return null;
    const words = tokens(m.title);
    return threads.filter(i => normalizeKey(i.entity) === entity && UNCONCLUDED.has(i.status))
      .map(i => ({ i, score: jaccard(words, tokens(i.title)) })).filter(x => x.score >= 0.4).sort((a, b) => b.score - a.score)[0]?.i ?? null;
  }
  /**
   * Apply one validated extraction batch from `botId`. Mentions open or touch
   * loose threads (deduplicated across bots: one item, every source kept);
   * resolutions conclude them unless a newer owner decision exists.
   * `responsible(mention)` returns a better-fitting bot id or null.
   */
  applyMentions(botId, extraction, { responsible = () => null } = {}) {
    return this.store.transaction(() => {
      const touched = new Map(), ignored = [], at = this.at();
      for (const m of extraction.mentions) {
        const mention = { botId, threadId: m.threadId, turnId: m.turnId, itemId: m.messageId, at: m.messageAt, quote: m.quote };
        const existing = this.matchThread(m);
        if (!existing) {
          const key = normalizeKey(m.key || m.title);
          if (!key) continue;
          const owner = responsible(m) ?? botId;
          const item = { id: `initiative-${randomUUID()}`, key, aliases: [], title: text(m.title, 200) || key, kind: LOOSE_THREAD, category: m.category,
            entity: text(m.entity, 120) || null, importance: m.importance, timeSensitive: m.timeSensitive, summary: text(m.summary, 600) || null,
            dueAt: m.dueAt ?? null, responsibleBotId: owner, mentionedBotId: botId,
            contributors: owner === botId ? [] : [{ botId, at, note: "mentioned here" }],
            sources: [mentionRef(mention)], mentions: [mention], notes: [], status: "candidate",
            firstMentionedAt: m.messageAt, lastTouchedAt: m.messageAt, createdAt: at, updatedAt: at, reminderCount: 0, publicationCount: 0 };
          item.resurfaceAt = resurfaceAt(item);
          this.store.put("initiativeItem", { ...item, botId: owner });
          touched.set(item.id, item);
          continue;
        }
        const item = { ...existing };
        if ((item.mentions ?? []).some(x => x.itemId === mention.itemId && x.botId === botId)) { touched.set(item.id, item); continue; }
        item.mentions = [...(item.mentions ?? []), mention].sort((a, b) => a.at.localeCompare(b.at)).slice(-12);
        item.sources = [...new Set([...(item.sources ?? []), mentionRef(mention)])].slice(-24);
        if (item.responsibleBotId !== botId && !(item.contributors ?? []).some(c => c.botId === botId))
          item.contributors = [...(item.contributors ?? []), { botId, at, note: "mentioned here" }].slice(-12);
        const alias = normalizeKey(m.key);
        if (alias && alias !== item.key && !(item.aliases ?? []).includes(alias)) item.aliases = [...(item.aliases ?? []), alias].slice(-12);
        if (IMPORTANCE.indexOf(m.importance) < IMPORTANCE.indexOf(item.importance)) item.importance = m.importance;
        item.timeSensitive = item.timeSensitive || m.timeSensitive;
        if (m.dueAt && (!item.dueAt || m.dueAt < item.dueAt)) item.dueAt = m.dueAt;
        if (m.messageAt > (item.lastTouchedAt ?? "")) item.lastTouchedAt = m.messageAt;
        // Dawar raised a concluded or dropped thread again himself: it is live again.
        const closedAt = item.status === "resolved" ? item.resolvedAt ?? item.updatedAt : item.status === "dismissed" ? item.decision?.at : null;
        if (closedAt && m.messageAt > closedAt) Object.assign(item, { status: "candidate", reopenedAt: at, resolution: null });
        if (item.status === "candidate") item.resurfaceAt = resurfaceAt(item);
        item.updatedAt = at;
        this.store.put("initiativeItem", { ...item, botId: item.responsibleBotId });
        touched.set(item.id, item);
      }
      for (const r of extraction.resolutions) {
        const item = this.item(r.itemId);
        if (!item || item.kind !== LOOSE_THREAD || !UNCONCLUDED.has(item.status)) { ignored.push({ itemId: r.itemId, reason: "not-open" }); continue; }
        if (item.decision && item.decision.at > r.at) { ignored.push({ itemId: item.id, reason: "newer-owner-decision" }); continue; }
        const next = { ...item, status: "resolved", resolvedAt: at, updatedAt: at, lastTouchedAt: r.at > (item.lastTouchedAt ?? "") ? r.at : item.lastTouchedAt,
          resolution: { kind: r.kind, evidence: r.evidence, at: r.at, source: r.source ?? `bot:${botId}` } };
        this.store.put("initiativeItem", { ...next, botId: next.responsibleBotId });
        touched.set(item.id, next);
      }
      if (touched.size) this.bump();
      return { items: [...touched.values()], ignored };
    });
  }

  /**
   * Apply a validated review result. `capture` is what the review saw when it
   * started; any decision recorded after that wins over the review.
   * Returns { items, contribution, ignored }.
   */
  applyReview(botId, result, capture) {
    return this.store.transaction(() => {
      const touched = new Map(), ignored = [];
      const upsert = (update, { contributionKind = null } = {}) => {
        const existing = (update.itemId && this.item(update.itemId)) || this.findByKey(update.key) || this.findByKey(update.title);
        const at = this.at();
        if (!existing) {
          if (update.status === "resolved") return null; // nothing to resolve
          // Loose threads only come from Dawar's own mentions.
          if (!REVIEW_CREATABLE.has(contributionKind ?? update.kind ?? "opportunity")) { ignored.push({ key: update.key, reason: "unknown-loose-thread" }); return null; }
          const key = normalizeKey(update.key || update.title);
          if (!key) return null;
          const item = { id: `initiative-${randomUUID()}`, key, aliases: [], title: text(update.title, 200) || key, kind: contributionKind ?? update.kind ?? "opportunity",
            responsibleBotId: botId, contributors: [], sources: update.sources.slice(0, 12), notes: update.note ? [{ botId, at, text: update.note }] : [],
            status: "candidate", createdAt: at, updatedAt: at, createdByReview: capture.reviewId, nextReviewAt: update.nextReviewAt ?? null,
            reminderCount: 0, publicationCount: 0 };
          this.store.put("initiativeItem", { ...item, botId });
          touched.set(item.id, item);
          return item;
        }
        let item = { ...existing };
        // Cross-bot deduplication: one responsible bot; others are linked contributors.
        if (item.responsibleBotId !== botId) {
          const contributors = (item.contributors ?? []).filter(c => c.botId !== botId);
          item.contributors = [...contributors, { botId, at, note: text(update.note, 1000) || null }].slice(-12);
        }
        const alias = normalizeKey(update.key);
        if (alias && alias !== item.key && !(item.aliases ?? []).includes(alias)) item.aliases = [...(item.aliases ?? []), alias].slice(-12);
        item.sources = [...new Set([...(item.sources ?? []), ...update.sources])].slice(-24);
        if (update.note) item.notes = [...(item.notes ?? []), { botId, at, text: update.note }].slice(-12);
        const decidedAfterCapture = item.decision && (item.decision.ledgerVersion > capture.ledgerVersion || item.decision.at > capture.startedAt);
        if (update.status === "resolved" && item.responsibleBotId === botId) {
          if (decidedAfterCapture) ignored.push({ itemId: item.id, reason: "newer-owner-decision" });
          else if (OPEN.has(item.status) || item.status === "approved") {
            item.status = "resolved"; item.resolvedAt = at;
            if (item.kind === LOOSE_THREAD) item.resolution = { kind: "concluded", evidence: text(update.note, 1000) || update.sources.join("; ").slice(0, 1000) || null, at, source: `review:${capture.reviewId}` };
          }
        }
        if (update.nextReviewAt && item.responsibleBotId === botId) item.nextReviewAt = update.nextReviewAt;
        item.updatedAt = at;
        this.store.put("initiativeItem", { ...item, botId: item.responsibleBotId });
        touched.set(item.id, item);
        return item;
      };
      for (const update of result.ledgerUpdates) upsert(update);
      let contribution = null;
      if (result.contribution) {
        const c = result.contribution;
        const item = upsert({ itemId: c.itemId, key: c.key, title: c.title, kind: c.kind, sources: c.evidence, note: null, status: "candidate", nextReviewAt: null },
          { contributionKind: c.kind });
        if (item) contribution = { ...c, itemId: item.id, responsible: item.responsibleBotId === botId };
      }
      if (touched.size) this.bump();
      return { items: [...touched.values()], contribution, ignored };
    });
  }

  /** Owner outcome from a reply or the bot's ordinary tool. Always newest wins. */
  recordOutcome(itemId, outcome, { until = null, note = null, by = "owner", source = null } = {}) {
    if (!OWNER_OUTCOMES.includes(outcome)) throw Error("Outcome must be approved, snoozed, dismissed or resolved.");
    return this.store.transaction(() => {
      const item = this.item(itemId);
      if (!item) throw Error("Initiative item not found.");
      const at = this.at();
      let snoozedUntil = null;
      if (outcome === "snoozed") {
        const parsed = Date.parse(until ?? "");
        snoozedUntil = new Date(Number.isFinite(parsed) && parsed > this.clock() ? parsed : this.clock() + 7 * 864e5).toISOString();
      }
      const ledgerVersion = this.bump();
      const next = { ...item, status: outcome, snoozedUntil, updatedAt: at,
        ...(outcome === "resolved" ? { resolvedAt: at, ...(item.kind === LOOSE_THREAD ? { resolution: { kind: "owner-done", evidence: note ? text(note, 1000) : null, at, source: source ?? by } } : {}) } : {}),
        decision: { outcome, at, by, note: note ? text(note, 1000) : null, source, ledgerVersion, revision: (item.decision?.revision ?? 0) + 1 },
        outcomes: [...(item.outcomes ?? []), { outcome, at, by, source }].slice(-20) };
      this.store.put("initiativeItem", { ...next, botId: next.responsibleBotId });
      // A held message about a decided item is never delivered later.
      for (const p of this.store.list("initiativePublication")) if (p.itemId === itemId && ["pending", "held"].includes(p.state))
        this.store.put("initiativePublication", { ...p, state: "abandoned", reason: `owner-${outcome}`, updatedAt: at });
      return next;
    });
  }
  /** Snoozes expire into ordinary candidates for later reconsideration. */
  wakeSnoozed() {
    const due = this.items().filter(item => item.status === "snoozed" && Date.parse(item.snoozedUntil ?? "") <= this.clock());
    if (!due.length) return 0;
    this.store.transaction(() => {
      // A woken loose thread is due again now, then follows its usual cadence.
      for (const item of due) this.store.put("initiativeItem", { ...item, botId: item.responsibleBotId, status: "candidate", snoozedUntil: null, updatedAt: this.at(),
        ...(item.kind === LOOSE_THREAD ? { resurfaceAt: this.at() } : {}) });
      this.bump();
    });
    return due.length;
  }

  // ---- delivery policy ------------------------------------------------------
  confirmed() { return this.store.list("initiativePublication").filter(p => p.state === "published" && p.publishedAt); }
  /** Spacing, daily limits and repeated-message rules. Returns null when allowed. */
  deliveryBlock(botId, itemId, { changedCircumstances = false } = {}, settings = this.settings()) {
    const today = limitDay(this.clock(), settings.limitTimeZone);
    const published = this.confirmed(), sameDay = published.filter(p => limitDay(p.publishedAt, settings.limitTimeZone) === today);
    const item = this.item(itemId);
    if (!item) return "item-missing";
    if (item.responsibleBotId !== botId) return "not-responsible";
    if (!OPEN.has(item.status)) return `item-${item.status}`;
    if (item.lastPublishedAt) {
      const hours = (this.clock() - Date.parse(item.lastPublishedAt)) / 36e5;
      if (hours < settings.reminderHours) return "awaiting-reply";
      if (!this.reminderAllowed(item, settings) && !changedCircumstances) return "reminder-used";
    }
    if (sameDay.length >= settings.globalDaily) return "global-daily-limit";
    if (sameDay.filter(p => p.botId === botId).length >= settings.perBotDaily) return "bot-daily-limit";
    // Loose threads get priority within the limits: the last global slots are
    // kept for them while any is due.
    if (item.kind !== LOOSE_THREAD && settings.globalDaily - sameDay.length <= settings.looseThreadReserve && this.dueThreads(null, settings).length)
      return "reserved-for-loose-threads";
    const spacing = this.store.meta("initiative-next-delivery");
    if (spacing && Date.parse(spacing) > this.clock()) return "spacing";
    return null;
  }
  /** Called only after confirmed publication. */
  markPublished(publication, settings = this.settings()) {
    return this.store.transaction(() => {
      const at = this.at(), item = this.item(publication.itemId);
      this.store.put("initiativePublication", { ...publication, state: "published", publishedAt: publication.publishedAt ?? at, updatedAt: at });
      if (item) {
        const reminder = Boolean(item.lastPublishedAt);
        this.store.put("initiativeItem", { ...item, botId: item.responsibleBotId, status: "published", lastPublishedAt: at, lastPublicationId: publication.id,
          publicationCount: (item.publicationCount ?? 0) + 1, reminderCount: (item.reminderCount ?? 0) + (reminder ? 1 : 0), updatedAt: at });
      }
      const minutes = settings.spacingMinMinutes + this.random() * (settings.spacingMaxMinutes - settings.spacingMinMinutes);
      this.store.meta("initiative-next-delivery", new Date(this.clock() + minutes * 6e4).toISOString());
      this.bump();
    });
  }
  /** The newest confirmed publication still awaiting a reply in a conversation. */
  awaitingReply(botId) {
    return this.confirmed().filter(p => p.botId === botId && this.item(p.itemId)?.status === "published")
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ?? null;
  }
  metrics(settings = this.settings()) {
    const today = limitDay(this.clock(), settings.limitTimeZone), items = this.items(), publications = this.store.list("initiativePublication");
    const confirmed = publications.filter(p => p.state === "published");
    const runs = this.store.list("initiativeReview"), reviews = runs.filter(r => (r.kind ?? "review") === "review"), extractions = runs.filter(r => r.kind === "extract");
    const tokens = rows => rows.reduce((sum, r) => sum + (Number(r.usage?.totalTokens) || 0), 0);
    const ofToday = rows => rows.filter(r => limitDay(r.createdAt, settings.limitTimeZone) === today);
    const threads = items.filter(i => i.kind === LOOSE_THREAD);
    return {
      publishedToday: confirmed.filter(p => limitDay(p.publishedAt, settings.limitTimeZone) === today).length,
      published: confirmed.length,
      accepted: items.filter(i => i.decision?.outcome === "approved").length,
      dismissed: items.filter(i => i.decision?.outcome === "dismissed").length,
      completed: items.filter(i => i.status === "resolved" && i.outcomes?.some(o => o.outcome === "approved")).length,
      held: publications.filter(p => p.state === "held").length,
      uncertain: publications.filter(p => p.state === "uncertain").length,
      reviews: reviews.length,
      reviewTokens: reviews.reduce((sum, r) => sum + (Number(r.usage?.totalTokens) || 0), 0),
      cachedTokens: reviews.reduce((sum, r) => sum + (Number(r.usage?.cachedInputTokens) || 0), 0),
      reviewTokensToday: tokens(ofToday(reviews)),
      extractions: extractions.length,
      extractionTokens: tokens(extractions),
      extractionTokensToday: tokens(ofToday(extractions)),
      costUsd: Math.round(runs.reduce((sum, r) => sum + (Number(r.usage?.costUsd) || 0), 0) * 1e4) / 1e4,
      openLooseThreads: threads.filter(i => UNCONCLUDED.has(i.status)).length,
      dueLooseThreads: threads.filter(i => this.threadDue(i, settings)).length,
      resolvedLooseThreads: threads.filter(i => i.status === "resolved").length,
      meanDeliveryLatencySeconds: confirmed.length ? Math.round(confirmed.reduce((sum, p) => sum + Math.max(0, Date.parse(p.publishedAt) - Date.parse(p.createdAt)), 0) / confirmed.length / 1000) : null,
      nextDeliveryNotBefore: this.store.meta("initiative-next-delivery") ?? null,
    };
  }
}

// ---- review results ---------------------------------------------------------
const nullable = schema => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" };
const UPDATE_SCHEMA = { type: "object", additionalProperties: false,
  required: ["item_id", "key", "title", "kind", "status", "note", "sources", "next_review_hours"],
  properties: { item_id: nullable(str), key: str, title: str, kind: { type: "string", enum: INITIATIVE_KINDS },
    status: { type: "string", enum: ["candidate", "resolved", "unchanged"] }, note: nullable(str),
    sources: { type: "array", items: str }, next_review_hours: nullable({ type: "number" }) } };
/** Native structured output for the single private review turn. */
export const REVIEW_OUTPUT_SCHEMA = { type: "object", additionalProperties: false,
  required: ["decision", "contribution", "ledger_updates", "next_review_hours"],
  properties: {
    decision: { type: "string", enum: ["publish", "hold", "none"] },
    contribution: nullable({ type: "object", additionalProperties: false,
      required: ["kind", "item_id", "key", "title", "why_now", "message", "evidence", "expected_value", "effort_estimate", "first_step", "proposed_action", "changed_circumstances"],
      properties: { kind: { type: "string", enum: INITIATIVE_KINDS }, item_id: nullable(str), key: str, title: str, why_now: str, message: str,
        evidence: { type: "array", items: str }, expected_value: str, effort_estimate: str, first_step: str,
        proposed_action: nullable({ type: "object", additionalProperties: false, required: ["type", "detail"],
          properties: { type: { type: "string", enum: PROPOSED_ACTIONS }, detail: str } }),
        changed_circumstances: { type: "boolean" } } }),
    ledger_updates: { type: "array", items: UPDATE_SCHEMA },
    next_review_hours: nullable({ type: "number" }),
  } };

const hoursFrom = (clock, hours) => Number.isFinite(hours) && hours > 0 ? new Date(clock + Math.min(hours, 24 * 30) * 36e5).toISOString() : null;
/** Strict validation of model output. Throws on anything malformed. */
export function validateReviewResult(raw, clock = Date.now(), { looseThreadIds = [] } = {}) {
  let value = raw;
  if (typeof raw === "string") {
    const body = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try { value = JSON.parse(body); } catch { throw Error("Review result is not JSON."); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Review result must be an object.");
  if (!["publish", "hold", "none"].includes(value.decision)) throw Error("Review decision is invalid.");
  if (!Array.isArray(value.ledger_updates) || value.ledger_updates.length > 20) throw Error("Review ledger updates are invalid.");
  const sources = list => Array.isArray(list) ? list.filter(s => typeof s === "string" && s.trim()).map(s => s.trim().slice(0, 500)).slice(0, 12) : [];
  const ledgerUpdates = value.ledger_updates.map(u => {
    if (!u || typeof u !== "object") throw Error("Ledger update must be an object.");
    const status = u.status === "unchanged" ? null : u.status;
    if (status !== null && !REVIEW_STATUSES.has(status)) throw Error("A review cannot record an owner decision.");
    if (!INITIATIVE_KINDS.includes(u.kind)) throw Error("Ledger update kind is invalid.");
    const key = text(u.key, 200), title = text(u.title, 200);
    if (!normalizeKey(key || title) && !u.item_id) throw Error("Ledger update needs a stable identity.");
    return { itemId: typeof u.item_id === "string" ? u.item_id.slice(0, 120) : null, key, title, kind: u.kind, status,
      note: text(u.note, 1000) || null, sources: sources(u.sources), nextReviewAt: hoursFrom(clock, u.next_review_hours) };
  });
  let contribution = null;
  if (value.decision === "publish") {
    const c = value.contribution;
    if (!c || typeof c !== "object") throw Error("A publish decision needs a contribution.");
    if (!INITIATIVE_KINDS.includes(c.kind)) throw Error("Contribution kind is invalid.");
    const message = text(c.message, 6000), title = text(c.title, 200), key = text(c.key, 200);
    // Grounded, actionable proposal: evidence, value, effort and first step.
    if (message.length < 40) throw Error("Contribution message is too short to be useful.");
    if (!normalizeKey(key || title)) throw Error("Contribution needs a stable identity.");
    const evidence = sources(c.evidence);
    if (!evidence.length) throw Error("Contribution needs supporting evidence.");
    for (const field of ["why_now", "expected_value", "effort_estimate", "first_step"]) if (!text(c[field], 2000)) throw Error(`Contribution ${field} is required.`);
    let action = c.proposed_action && typeof c.proposed_action === "object" && PROPOSED_ACTIONS.includes(c.proposed_action.type) && text(c.proposed_action.detail, 1000)
      ? { type: c.proposed_action.type, detail: text(c.proposed_action.detail, 1000) } : null;
    let itemId = typeof c.item_id === "string" ? c.item_id.slice(0, 120) : null;
    // A resurfaced loose thread names its existing item and one concrete action.
    // Repair instead of discarding: the required first step is the action, and
    // the bot's only open loose thread is the item. Otherwise hold, not fail.
    if (c.kind === LOOSE_THREAD) {
      if (!action) action = { type: "other", detail: text(c.first_step, 1000) };
      if (!itemId && looseThreadIds.length === 1) itemId = looseThreadIds[0];
      if (!itemId) return { decision: "hold", contribution: null, ledgerUpdates, nextReviewAt: hoursFrom(clock, value.next_review_hours), repaired: "loose-thread-without-item" };
    }
    contribution = { kind: c.kind, itemId, key, title, whyNow: text(c.why_now, 2000), message,
      evidence, expectedValue: text(c.expected_value, 1000), effortEstimate: text(c.effort_estimate, 500), firstStep: text(c.first_step, 1000),
      proposedAction: action, changedCircumstances: c.changed_circumstances === true };
  }
  return { decision: value.decision, contribution, ledgerUpdates, nextReviewAt: hoursFrom(clock, value.next_review_hours) };
}

/**
 * The finished, ordinary bot message, with a short reference for later replies.
 * A loose thread always opens with Dawar's original words, where and when he
 * said them, and closes with the one concrete next step it proposes.
 */
export function publicationText(contribution, itemId, { item = null, publisherBotId = null, names = {}, clock = Date.now(), timeZone = DEFAULT_SETTINGS.limitTimeZone } = {}) {
  if (contribution.kind !== LOOSE_THREAD || !item?.mentions?.length)
    return `${contribution.message.trim()}\n\n_Ref ${itemId}: reply “yes, proceed”, “next week” or “leave it”._`;
  const mention = item.mentions.find(m => m.botId === publisherBotId) ?? item.mentions[0];
  const where = mention.botId === publisherBotId ? "" : ` to ${names[mention.botId] ?? "another bot"}`;
  const action = contribution.proposedAction;
  return [`${mentionWhen(mention.at, clock, timeZone)} you mentioned${where}: “${mention.quote}”`, contribution.message.trim(),
    ...(action ? [`**Proposed next step (${ACTION_LABELS[action.type]}):** ${action.detail}`] : []),
    `_Ref ${itemId}: reply “yes, proceed”, “next week”, “leave it” or “done”._`].join("\n\n");
}
/**
 * A natural nudge about one unanswered proposal, in the bot's voice: no model
 * call, varied wording, the item's own words, and a mention (not a list) of
 * anything else still waiting.
 */
export function nudgeText(item, others = 0, { clock = Date.now(), timeZone = DEFAULT_SETTINGS.limitTimeZone } = {}) {
  const title = item.title, summary = (item.summary ?? "").trim().replace(/\s+/g, " ");
  const said = item.kind === LOOSE_THREAD && item.mentions?.length ? item.mentions[0] : null;
  const when = said ? mentionWhen(said.at, clock, timeZone) : null;
  const variants = [
    () => `Quick nudge on **${title}**${summary ? ` — ${summary}` : ""}. Want me to go ahead?`,
    () => `Circling back on **${title}**.${summary ? ` ${summary}` : ""} Should I take care of it?`,
    () => `Still on my list: **${title}**.${summary ? ` ${summary}` : ""} Happy to handle it whenever you say.`,
    () => said ? `${when} you mentioned “${said.quote}”. Still want me to move on **${title}**?` : `Checking in on **${title}** — still worth doing?${summary ? ` ${summary}` : ""}`,
  ];
  const pick = [...`${item.id}:${item.reminderCount ?? 0}`].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % variants.length;
  const more = others > 0 ? [`There ${others === 1 ? "is one other thing" : `are ${others} other things`} waiting on you too; I'll bring ${others === 1 ? "it" : "them"} up separately.`] : [];
  return [variants[pick](), ...more, `_Ref ${item.id}: reply “yes, proceed”, “next week”, “leave it” or “done”._`].join("\n\n");
}
const ACTION_LABELS = { todo: "create a todo", "draft-message": "draft a message", schedule: "schedule it", research: "research it", drop: "drop it", other: "next step" };
/** "Earlier today", "Yesterday", "On Tuesday" or "On Oct 3", in the limit time zone. */
export function mentionWhen(at, clock = Date.now(), timeZone = DEFAULT_SETTINGS.limitTimeZone) {
  const day = value => limitDay(value, timeZone), then = Date.parse(at);
  const days = Math.round((Date.parse(`${day(clock)}T12:00:00Z`) - Date.parse(`${day(then)}T12:00:00Z`)) / 864e5);
  if (days <= 0) return "Earlier today";
  if (days === 1) return "Yesterday";
  const format = options => new Intl.DateTimeFormat("en-US", { timeZone, ...options }).format(new Date(then));
  return days < 7 ? `On ${format({ weekday: "long" })}` : `On ${format({ month: "short", day: "numeric" })}`;
}
export const mentionRef = m => `mention:${m.botId}:${m.turnId ?? "?"}:${m.itemId}`;

// ---- loose-thread timing ----------------------------------------------------
// Hours from the last touch until a loose thread is raised: [high, medium, low].
// A client can come back within hours; an idea after a day or two.
const RESURFACE_HOURS = {
  client: [2, 6, 24], commitment: [2, 6, 24], person: [3, 8, 24], company: [3, 8, 24],
  question: [4, 12, 36], intention: [4, 12, 36], decision: [4, 12, 36], idea: [12, 36, 72],
};
const CATEGORY_WEIGHT = { client: 1.5, commitment: 1.5, person: 1.3, company: 1.3, question: 1.1, intention: 1.1, decision: 1.1, idea: 1 };
export function resurfaceDelayHours(item) {
  const hours = (RESURFACE_HOURS[item.category] ?? RESURFACE_HOURS.idea)[Math.max(0, IMPORTANCE.indexOf(item.importance))] ?? 24;
  return item.timeSensitive ? Math.min(hours, 2) : hours;
}
export function resurfaceAt(item) {
  let at = Date.parse(item.lastTouchedAt ?? item.firstMentionedAt) + resurfaceDelayHours(item) * 36e5;
  // Something due soon comes back a few hours before it is due.
  const due = Date.parse(item.dueAt ?? "");
  if (Number.isFinite(due)) at = Math.min(at, Math.max(Date.parse(item.lastTouchedAt ?? item.firstMentionedAt) + 36e5, due - 6 * 36e5));
  return new Date(at).toISOString();
}
/** Ordering among loose threads (and bots): importance × category, rising once overdue. */
export function looseThreadPriority(item, clock = Date.now()) {
  const importance = { high: 3, medium: 2, low: 1 }[item.importance] ?? 1;
  const overdueHours = Math.max(0, (clock - Date.parse(item.resurfaceAt ?? "")) / 36e5) || 0;
  return importance * (CATEGORY_WEIGHT[item.category] ?? 1) * (1 + Math.min(overdueHours, 72) / 24) + (item.timeSensitive ? 2 : 0);
}
const tokens = value => new Set(normalizeKey(value).split("-").filter(w => w.length > 2));
const jaccard = (a, b) => { const union = new Set([...a, ...b]).size; return union ? [...a].filter(w => b.has(w)).length / union : 0; };
export const publicationMarker = publicationId => `initiative-publication:${publicationId}`;

// ---- owner replies ----------------------------------------------------------
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
/**
 * Deterministic classification of short, unambiguous owner replies. Anything
 * longer or unclear is left to the bot, which records it with its tool.
 */
export function classifyReply(value, clock = Date.now()) {
  const raw = text(String(value ?? ""), 400).toLowerCase().replace(/[“”"'.!]/g, "").replace(/\s+/g, " ").trim();
  if (!raw || raw.length > 80) return null;
  if (/^(no|nope|nah|leave it|leave this|skip( it)?|drop it|not interested|dismiss( it)?|ignore( it)?|never mind|dont bother)\b/.test(raw)) return { outcome: "dismissed" };
  if (/^(done|already done|already did( it)?|handled|resolved|its done|all done)\b/.test(raw)) return { outcome: "resolved" };
  const day = 864e5;
  let m;
  if (/\bnext week\b/.test(raw)) return { outcome: "snoozed", until: new Date(clock + 7 * day).toISOString() };
  if (/\bnext month\b/.test(raw)) return { outcome: "snoozed", until: new Date(clock + 30 * day).toISOString() };
  if (/\btomorrow\b/.test(raw)) return { outcome: "snoozed", until: new Date(clock + day).toISOString() };
  if ((m = /\bin (\d{1,2}) (day|days|week|weeks)\b/.exec(raw))) return { outcome: "snoozed", until: new Date(clock + Number(m[1]) * (m[2].startsWith("week") ? 7 : 1) * day).toISOString() };
  if ((m = new RegExp(`\\b(?:on |next )?(${WEEKDAYS.join("|")})\\b`).exec(raw)) && /^(later|not now|ask me|remind me|maybe|on|next|(${WEEKDAYS.join("|")}))/.test(raw)) {
    const today = new Date(clock).getUTCDay(), target = WEEKDAYS.indexOf(m[1]);
    return { outcome: "snoozed", until: new Date(clock + (((target - today + 7) % 7) || 7) * day).toISOString() };
  }
  if (/^(later|not now|remind me later|maybe later)\b/.test(raw)) return { outcome: "snoozed", until: new Date(clock + 3 * day).toISOString() };
  if (/^(make (it|this) a todo|add (it )?(as )?a todo|create a todo|todo it|draft (it|the message|a message)|schedule it|research it|look into it)\b/.test(raw))
    return { outcome: "approved" };
  if (/^(yes|yep|yeah|yup|sure|ok|okay|go ahead|go for it|proceed|do it|approved?|sounds good|please do)\b/.test(raw)) return { outcome: "approved" };
  return null;
}
export const ledgerDigest = items => hash(JSON.stringify(items));
