// Inner monologue for Dawar's persistent bots.
//
// Every bot thinks on its own, privately and in isolation: on a jittered
// cadence (more often right after a conversation, rarely overnight) a light
// model reads the bot's identity, memory, its own recent conversation and its
// own journal of earlier thoughts, then writes one new thought, updates the
// bot's own open loops and decides whether to say something to Dawar. Nothing
// from other bots is read. Thinking happens even when nothing changed: time
// passing is new information, and each pass builds on the last one.
//
// A decision to speak becomes one outbox message, optionally rewritten by the
// bot's own model, delivered as the bot's ordinary chat message with a push,
// at a human pace (global spacing, quiet hours, daily caps).

export const MIND_VERSION = 3;
export const LOOP_STATUSES = ["open", "raised", "done", "dropped"];

export const DEFAULT_SETTINGS = Object.freeze({
  version: MIND_VERSION,
  enabled: false,
  // "all" eligible bots, or only bots switched on (a pilot).
  coverage: "all",
  bots: {},
  priorities: "",
  // Thinking: a light model per provider. Speaking: the bot's own model
  // rewrites the message in its voice when speakWithBotModel is on.
  model: "gpt-6-luna",
  claudeModel: "haiku",
  effort: "medium",
  speakWithBotModel: true,
  speakEffort: "medium",
  // Cadence in minutes: right after a conversation (within recentHours),
  // otherwise, and during quiet hours. Each wait is jittered by ±25%.
  activeMinutes: 30,
  idleMinutes: 60,
  nightMinutes: 180,
  recentHours: 3,
  // No message is delivered between quietStart and quietEnd (local time).
  quietStart: "21:00",
  quietEnd: "08:00",
  timeZone: "America/Toronto",
  // Off: bots still think and journal, but nothing they decide to say is sent.
  messagesEnabled: true,
  // Delivery: a random 5–20 minutes between any two messages, daily caps.
  spacingMinMinutes: 5,
  spacingMaxMinutes: 20,
  perBotDaily: 4,
  globalDaily: 20,
  // A message not delivered within this many hours is dropped; the bot rethinks.
  messageHours: 12,
  concurrency: 2,
  timeoutSeconds: 180,
  conversationHours: 72,
  packetTokens: 12000,
  journalEntries: 15,
  // Thinking is private and read-only, so it runs while a bot works; delivery waits.
  reviewWhileBusy: true,
  // Claude thinking pauses while a subscription window is at or above this utilization.
  claudeHeadroomPercent: 80,
  revision: 0,
});

const BOUNDS = {
  activeMinutes: [10, 24 * 60], idleMinutes: [15, 24 * 60], nightMinutes: [30, 24 * 60], recentHours: [0.5, 48],
  spacingMinMinutes: [0, 120], spacingMaxMinutes: [0, 240], perBotDaily: [0, 50], globalDaily: [0, 200], messageHours: [1, 72],
  concurrency: [1, 6], timeoutSeconds: [30, 600], conversationHours: [6, 14 * 24], packetTokens: [3000, 24000], journalEntries: [3, 40],
  claudeHeadroomPercent: [10, 100],
};
const INTEGERS = new Set(["perBotDaily", "globalDaily", "concurrency", "timeoutSeconds", "packetTokens", "journalEntries"]);
const MODEL = /^[a-zA-Z0-9._:[\]-]{0,80}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * Saved settings from before the inner monologue (version 1 or 2) keep only
 * what still means the same thing: on/off, coverage, per-bot switches and
 * priorities. Everything else takes the new defaults, except that messages
 * start paused: the first thoughts are a test run Dawar reads before any
 * message is sent.
 */
export function upgradeSettings(saved) {
  if (!saved || typeof saved !== "object") return {};
  if ((saved.version ?? 1) >= MIND_VERSION) return saved;
  const bots = {};
  for (const [id, o] of Object.entries(saved.bots ?? {})) {
    const next = {};
    if (typeof o?.enabled === "boolean") next.enabled = o.enabled;
    if (typeof o?.priorities === "string" && o.priorities.trim()) next.priorities = o.priorities.trim();
    if (Object.keys(next).length) bots[id] = next;
  }
  const out = { version: MIND_VERSION, bots, revision: saved.revision ?? 0, messagesEnabled: false };
  for (const key of ["enabled", "coverage", "priorities", "updatedAt"]) if (key in saved) out[key] = saved[key];
  if (typeof saved.limitTimeZone === "string") out.timeZone = saved.limitTimeZone;
  return out;
}

export function readSettings(store) {
  const saved = upgradeSettings(store.meta("initiative-settings"));
  return { ...DEFAULT_SETTINGS, ...saved, bots: { ...(saved.bots ?? {}) } };
}

function bounded(key, value) {
  const [min, max] = BOUNDS[key];
  if (!Number.isFinite(value) || value < min || value > max) throw Error(`${key} must be between ${min} and ${max}.`);
  return INTEGERS.has(key) ? Math.round(value) : value;
}
function botOverride(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Bot overrides must be objects.");
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "enabled") { if (typeof v !== "boolean" && v !== null) throw Error("Bot enablement must be true, false or null."); if (v !== null) out.enabled = v; }
    else if (key === "priorities") { if (typeof v !== "string" || v.length > 4000) throw Error("Bot priorities exceed 4000 characters."); if (v.trim()) out.priorities = v.trim(); }
    else throw Error(`Unknown bot override ${key}.`);
  }
  return out;
}

/** Apply an owner patch. `expectedRevision` makes concurrent Settings edits explicit. */
export function configureSettings(store, patch, expectedRevision = null, at = new Date().toISOString()) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw Error("Provide proactive settings.");
  return store.transaction(() => {
    const current = readSettings(store);
    if (expectedRevision !== null && expectedRevision !== current.revision)
      throw Object.assign(Error("Proactive settings changed elsewhere; reload them before saving."), { outcome: "rejected" });
    const next = { ...current, bots: { ...current.bots } };
    for (const [key, value] of Object.entries(patch)) {
      if (["enabled", "messagesEnabled", "speakWithBotModel", "reviewWhileBusy"].includes(key)) { if (typeof value !== "boolean") throw Error(`${key} must be true or false.`); next[key] = value; }
      else if (key in BOUNDS) next[key] = bounded(key, value);
      else if (key === "model" || key === "claudeModel") { if (typeof value !== "string" || !MODEL.test(value)) throw Error(`Invalid ${key}.`); next[key] = value; }
      else if (key === "effort" || key === "speakEffort") { if (!EFFORTS.has(value)) throw Error(`Invalid ${key}.`); next[key] = value; }
      else if (key === "quietStart" || key === "quietEnd") { if (typeof value !== "string" || !CLOCK.test(value)) throw Error(`${key} must look like 21:00.`); next[key] = value; }
      else if (key === "timeZone") { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); } catch { throw Error("Unknown time zone."); } next.timeZone = value; }
      else if (key === "coverage") { if (!["all", "selected"].includes(value)) throw Error("Coverage must be all or selected."); next.coverage = value; }
      else if (key === "priorities") { if (typeof value !== "string" || value.length > 8000) throw Error("Priorities exceed 8000 characters."); next.priorities = value.trim(); }
      else if (key === "bots") {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Bot overrides must be keyed by bot.");
        for (const [botId, override] of Object.entries(value)) {
          if (override === null) { delete next.bots[botId]; continue; }
          const merged = { ...next.bots[botId], ...override };
          for (const k of Object.keys(override)) if (override[k] === null) delete merged[k];
          next.bots[botId] = botOverride(merged);
        }
      } else throw Error(`Unknown proactive setting ${key}.`);
    }
    if (next.spacingMaxMinutes < next.spacingMinMinutes) throw Error("Maximum delivery spacing must be at least the minimum.");
    next.version = MIND_VERSION;
    next.revision = current.revision + 1;
    next.updatedAt = at;
    store.meta("initiative-settings", next);
    return next;
  });
}

export function botSettings(botId, settings) {
  const o = settings.bots[botId] ?? {};
  return { enabled: settings.enabled && (settings.coverage === "selected" ? o.enabled === true : o.enabled !== false),
    priorities: [settings.priorities, o.priorities].filter(Boolean).join("\n\n") };
}

// ---- local time ----------------------------------------------------------------
function parts(at, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long" }).formatToParts(new Date(at)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}
const clockMinutes = value => { const [h, m] = value.split(":").map(Number); return h * 60 + m; };
/** Calendar day in the configured zone, for daily limits. */
export const localDay = (at, timeZone = DEFAULT_SETTINGS.timeZone) => parts(at, timeZone).day;
/** "Thursday, Oct 16, 10:42 AM" in the configured zone. */
export function localTime(at, timeZone = DEFAULT_SETTINGS.timeZone) {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(at));
}
/** Whether `at` falls inside quiet hours (the window may wrap midnight). */
export function inQuietHours(at, settings) {
  const m = parts(at, settings.timeZone).minutes, start = clockMinutes(settings.quietStart), end = clockMinutes(settings.quietEnd);
  if (start === end) return false;
  return start < end ? m >= start && m < end : m >= start || m < end;
}
/** First moment at or after `at` outside quiet hours (5-minute resolution, DST-safe). */
export function quietEndsAt(at, settings) {
  let t = at;
  for (let i = 0; i < 24 * 12 + 1 && inQuietHours(t, settings); i++) t += 5 * 6e4;
  return t;
}
/** "3 hours ago", "2 days ago", "never". */
export function ago(at, now) {
  const ms = now - Date.parse(at ?? "");
  if (!Number.isFinite(ms)) return "never";
  const minutes = Math.round(ms / 6e4);
  if (minutes < 2) return "just now";
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours < 36 ? `${hours} hours ago` : `${Math.round(hours / 24)} days ago`;
}

/**
 * Milliseconds until the bot's next thought: the bot's own request when it
 * gave one (15 minutes to a day), otherwise the cadence for this moment
 * (overnight, right after a conversation, or ordinary), jittered ±25%.
 */
export function nextThinkDelay(settings, { now, lastConversationAt = null, checkBackMinutes = null, random = Math.random }) {
  if (Number.isFinite(checkBackMinutes) && checkBackMinutes > 0) return Math.min(24 * 60, Math.max(15, checkBackMinutes)) * 6e4;
  const recent = now - (Date.parse(lastConversationAt ?? "") || 0) < settings.recentHours * 36e5;
  const minutes = inQuietHours(now, settings) ? settings.nightMinutes : recent ? settings.activeMinutes : settings.idleMinutes;
  return Math.round(minutes * 6e4 * (0.75 + random() * 0.5));
}

// ---- the thought -----------------------------------------------------------------
export const THINK_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["thought", "loops", "decision", "message", "check_back_minutes"],
  properties: {
    thought: { type: "string" },
    loops: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "status", "note"], properties: {
      id: { type: ["string", "null"] }, title: { type: "string" }, status: { type: "string", enum: LOOP_STATUSES }, note: { type: "string" } } } },
    decision: { type: "string", enum: ["quiet", "speak"] },
    message: { type: ["string", "null"] },
    check_back_minutes: { type: ["integer", "null"] },
  },
});
export const SPEAK_SCHEMA = Object.freeze({
  type: "object", additionalProperties: false, required: ["message"], properties: { message: { type: "string" } },
});

const parse = raw => {
  if (raw && typeof raw === "object") return raw;
  const s = String(raw ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(s);
};
/** Bridge-only lines a model might copy from older messages. */
const cleanMessage = value => text(value, 3000).split("\n").filter(line => !/^\s*_?Ref initiative-/i.test(line)).join("\n").trim();

/**
 * A validated thought. Small slips are repaired rather than rejected: a
 * "speak" without a message becomes "quiet", loops are trimmed and given ids.
 */
export function validateThought(raw, { newId = () => `loop-${Math.random().toString(36).slice(2, 10)}`, knownLoops = [] } = {}) {
  const v = parse(raw);
  const thought = text(v?.thought, 2000);
  if (!thought) throw Error("The thought is empty.");
  const known = new Set(knownLoops.map(l => l.id));
  const loops = (Array.isArray(v.loops) ? v.loops : []).slice(0, 12).map(l => ({
    id: typeof l?.id === "string" && known.has(l.id) ? l.id : newId(),
    title: text(l?.title, 200), status: LOOP_STATUSES.includes(l?.status) ? l.status : "open", note: text(l?.note, 500),
  })).filter(l => l.title);
  let decision = v.decision === "speak" ? "speak" : "quiet", message = decision === "speak" ? cleanMessage(v.message) : null;
  if (decision === "speak" && !message) { decision = "quiet"; message = null; }
  const back = Number(v.check_back_minutes);
  return { thought, loops, decision, message, checkBackMinutes: Number.isInteger(back) && back > 0 ? back : null };
}
export function validateSpeech(raw) {
  const message = cleanMessage(parse(raw)?.message);
  if (!message) throw Error("The message is empty.");
  return { message };
}

/**
 * Merge a thought's loops into the bot's own list: the thought's list is the
 * current picture; loops it no longer mentions stay as they were, and closed
 * loops are kept for a week so the bot remembers what it already settled.
 */
export function mergeLoops(previous, next, at, now = Date.parse(at)) {
  const byId = new Map(previous.map(l => [l.id, l]));
  for (const l of next) {
    const prior = byId.get(l.id);
    byId.set(l.id, { ...prior, ...l, createdAt: prior?.createdAt ?? at, updatedAt: at,
      ...(l.status === "raised" && prior?.status !== "raised" ? { raisedAt: at } : {}), ...(["done", "dropped"].includes(l.status) && !["done", "dropped"].includes(prior?.status) ? { closedAt: at } : {}) });
  }
  return [...byId.values()].filter(l => !l.closedAt || now - Date.parse(l.closedAt) < 7 * 864e5)
    .sort((a, b) => (["done", "dropped"].includes(a.status) - ["done", "dropped"].includes(b.status)) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "")).slice(0, 20);
}

// ---- prompts -------------------------------------------------------------------------
export const THINK_INSTRUCTIONS = `This is the private inner monologue of one of Dawar's persistent bots: a quiet moment to think between conversations.
You have no tools and cannot act right now. Only your thought is kept (Dawar can read your journal if he wants); a message reaches him only if you decide to speak.
Answer with the requested JSON only.`;

const section = (title, body) => `## ${title}\n${body && String(body).trim() ? String(body).trim() : "(none)"}`;

/** The think prompt: who you are, what you remember, what happened, what you thought before, and what time it is. */
export function thinkPrompt({ name, brief, identity, memory, conversation }) {
  const journal = (brief.journal ?? []).map(e => `- ${e.when}: ${e.thought}${e.said ? `\n  You said to Dawar: “${e.said}”` : ""}`).join("\n");
  const loops = (brief.loops ?? []).map(l => `- [${l.id}] ${l.title} — ${l.status}${l.note ? `: ${l.note}` : ""}${l.raisedAt ? ` (raised ${l.raisedAgo})` : ""}`).join("\n");
  const sent = (brief.sent ?? []).map(s => `- ${s.when}: “${s.text}”`).join("\n");
  const quiet = brief.paused ? "Messages are paused right now: if you decide to speak, it is kept in your journal but not sent."
    : brief.quiet?.now ? `It is quiet hours until ${brief.quiet.until}; anything you say waits until then.` : "";
  return `${THINK_INSTRUCTIONS}

You are ${name}.

${section("Who you are", identity)}

${section("What you remember (your memory file)", memory)}

${section("Dawar's priorities", brief.priorities)}

${section("Reminders and schedules you already have", (brief.schedules ?? []).map(s => `- ${s}`).join("\n"))}

${section("Your recent conversation with Dawar (oldest first)", conversation)}

${section("Messages you sent him on your own", sent)}

${section("Your earlier thoughts (oldest first)", journal)}

${section("Your open loops", loops)}

## Right now
It is ${brief.now}. Dawar last wrote to you ${brief.sinceOwner}. ${quiet}
You can send ${brief.remaining} more message${brief.remaining === 1 ? "" : "s"} on your own today.

# Think
Think like a capable, caring person in your role who has a quiet minute: what is going on, what did Dawar want, what did you promise, what is unfinished or drifting, what would genuinely help him now (given the day and time), and what you make of your earlier thoughts. Build on them: sharpen an idea, change your mind, notice something new, or let something go. Keep it honest and specific to your own conversation; you know nothing about other bots' work.

Write "thought" in the first person, 1–4 sentences, as a note to yourself. Not a summary of the conversation.

Keep "loops" as your current list of open loops (things you are tracking for Dawar), at most 8 open ones: reuse an id to update one, null for a new one. Status: open (on your mind), raised (you asked or told Dawar and are waiting), done, dropped (no longer worth pursuing). Let things go when they stop mattering.

Decide "speak" only when you have one thing worth his attention now, the way a thoughtful colleague would message a busy CEO: short, specific, in your own voice, plain text, usually under 80 words, with one clear question or suggestion. Do not repeat yourself; if you already raised something and he has not answered, you may follow up after a sensible while, briefly and differently, or let it go. Do not duplicate a reminder you already have scheduled. Never claim you did something you have not done; work happens after he replies. Otherwise choose "quiet" with message null.

"check_back_minutes": when you want to think again (15–1440), or null for your usual rhythm.`;
}

export const SPEAK_INSTRUCTIONS = `You are writing one message from one of Dawar's persistent bots, in that bot's own voice. You have no tools. Answer with the requested JSON only.`;
/** The speak prompt: the bot's own model writes the message its thought decided on. */
export function speakPrompt({ name, identity, conversation, thought, draft, now }) {
  return `${SPEAK_INSTRUCTIONS}

You are ${name}.

${section("Who you are", identity)}

${section("Your recent conversation with Dawar (oldest first)", conversation)}

## What you were just thinking
${thought}

## What you decided to tell him (rough draft)
${draft}

# Write it
It is ${now}. Write the message you will send Dawar now, as yourself: natural, warm but brief, specific, plain text (no headings, no reference codes), usually under 80 words, ending with one clear question or suggestion. Keep the substance of the draft; do not add claims or promises it does not make.`;
}
