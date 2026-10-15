import { createHash, randomUUID } from "node:crypto";

// Proactive initiative: the persistent, cross-bot ledger of follow-ups and
// opportunities, its owner settings, delivery limits and reply outcomes.
// Everything here is plain records in an existing Store (the hub's logical
// control store in portable deployments). No native authority is held here.

export const INITIATIVE_KINDS = ["follow-up", "opportunity", "update"];
// Statuses an owner decision sets. A private review can never set these.
export const OWNER_OUTCOMES = ["approved", "snoozed", "dismissed", "resolved"];
const REVIEW_STATUSES = new Set(["candidate", "resolved"]);
const OPEN = new Set(["candidate", "held", "published"]);

/** Approved defaults (October 13 plan, quiet hours removed by amendment). */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  enabled: false,
  scanMinutes: 25,
  baselineMinutes: 120,
  concurrency: 1,
  model: "gpt-6.1-sol",
  effort: "medium",
  fast: false,
  reviewTimeoutSeconds: 180,
  spacingMinMinutes: 3,
  spacingMaxMinutes: 5,
  perBotDaily: 2,
  globalDaily: 5,
  reminderHours: 72,
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
};
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
  return key === "concurrency" || key.endsWith("Daily") ? Math.round(value) : value;
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
    return { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}), bots: { ...(saved?.bots ?? {}) } };
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
        if (key === "enabled" || key === "fast") { if (typeof value !== "boolean") throw Error(`${key} must be true or false.`); next[key] = value; }
        else if (key in BOUNDS) next[key] = boundedNumber(key, value);
        else if (key === "model") { if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,80}$/.test(value)) throw Error("Invalid review model."); next.model = value; }
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
  /** Ledger slice supplied to a review: the bot's own items and open cross-bot items. */
  forReview(botId, limit = 40) {
    const rows = this.items().filter(item => item.responsibleBotId === botId || item.contributors?.some(c => c.botId === botId) || OPEN.has(item.status));
    return rows.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, limit).map(item => ({
      id: item.id, key: item.key, title: item.title, kind: item.kind, status: item.status, responsibleBot: item.responsibleBotId,
      yours: item.responsibleBotId === botId, lastPublishedAt: item.lastPublishedAt ?? null, reminderCount: item.reminderCount ?? 0,
      snoozedUntil: item.snoozedUntil ?? null, outcome: item.decision?.outcome ?? null, sources: (item.sources ?? []).slice(0, 6),
      nextReviewAt: item.nextReviewAt ?? null }));
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
          else if (OPEN.has(item.status) || item.status === "approved") item.status = "resolved", item.resolvedAt = at;
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
      for (const item of due) this.store.put("initiativeItem", { ...item, botId: item.responsibleBotId, status: "candidate", snoozedUntil: null, updatedAt: this.at() });
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
      if ((item.reminderCount ?? 0) >= 1 && !changedCircumstances) return "reminder-used";
    }
    if (sameDay.length >= settings.globalDaily) return "global-daily-limit";
    if (sameDay.filter(p => p.botId === botId).length >= settings.perBotDaily) return "bot-daily-limit";
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
    const reviews = this.store.list("initiativeReview");
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
      required: ["kind", "item_id", "key", "title", "why_now", "message", "evidence", "expected_value", "effort_estimate", "first_step", "changed_circumstances"],
      properties: { kind: { type: "string", enum: INITIATIVE_KINDS }, item_id: nullable(str), key: str, title: str, why_now: str, message: str,
        evidence: { type: "array", items: str }, expected_value: str, effort_estimate: str, first_step: str, changed_circumstances: { type: "boolean" } } }),
    ledger_updates: { type: "array", items: UPDATE_SCHEMA },
    next_review_hours: nullable({ type: "number" }),
  } };

const hoursFrom = (clock, hours) => Number.isFinite(hours) && hours > 0 ? new Date(clock + Math.min(hours, 24 * 30) * 36e5).toISOString() : null;
/** Strict validation of model output. Throws on anything malformed. */
export function validateReviewResult(raw, clock = Date.now()) {
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
    contribution = { kind: c.kind, itemId: typeof c.item_id === "string" ? c.item_id.slice(0, 120) : null, key, title, whyNow: text(c.why_now, 2000), message,
      evidence, expectedValue: text(c.expected_value, 1000), effortEstimate: text(c.effort_estimate, 500), firstStep: text(c.first_step, 1000),
      changedCircumstances: c.changed_circumstances === true };
  }
  return { decision: value.decision, contribution, ledgerUpdates, nextReviewAt: hoursFrom(clock, value.next_review_hours) };
}

/** The finished, ordinary bot message, with a short reference for later replies. */
export function publicationText(contribution, itemId) {
  return `${contribution.message.trim()}\n\n_Ref ${itemId}: reply “yes, proceed”, “next week” or “leave it”._`;
}
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
  if (/^(yes|yep|yeah|yup|sure|ok|okay|go ahead|go for it|proceed|do it|approved?|sounds good|please do)\b/.test(raw)) return { outcome: "approved" };
  return null;
}
export const ledgerDigest = items => hash(JSON.stringify(items));
