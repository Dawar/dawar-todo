import { MENTION_CATEGORIES, IMPORTANCE, RESOLUTION_KINDS, normalizeKey } from "./initiative-ledger.mjs";

// Loose threads, step 1: capture what Dawar himself mentioned (clients,
// people, ideas, intentions, open questions, commitments, decisions in
// progress) so nothing he said gets lost. The node reads only the owner's new
// messages since a per-conversation cursor; a small model turns that bounded
// batch into ledger items with exact quotes. Bot and peer text is never a
// source; bot tool actions are listed only as resolution evidence.

// Native user messages that are not Dawar typing: schedules, peers, notices.
export const NON_OWNER_CLIENT = /^(schedule:|peer:|peer-exchange:|manager-notice:|secure-receipt:|initiative)/;
const BOT_SOURCE = /^\[Verified DawarTodo source \{"kind":"bot"/;
// At most 200 turns are walked back to the cursor; extraction runs every idle scan, so a gap that long is far beyond observed volume.
const PAGE = 10, MAX_PAGES = 20;
// Tool calls that can conclude a loose thread (todo, message, schedule, artifact).
const EVIDENCE_TOOL = /todo|task|schedule|calendar|event|meeting|message|mail|send|draft|publish_artifact|queue|reminder|invite/i;

const messageText = item => (item?.content ?? []).filter(part => part?.type === "text").map(part => part.text).join("\n");
/** The owner's words only, without a quoted reply prefix. */
export function ownerText(item) {
  const value = messageText(item), marker = value.lastIndexOf("New user message:\n");
  return (marker >= 0 ? value.slice(marker + "New user message:\n".length) : value).trim();
}
/**
 * True only for messages Dawar authored: not a schedule/peer/notice client
 * identity, not a verified bot source, and not attributed to a non-user
 * submission source.
 */
export function ownerAuthored(runtime, bot, item) {
  if (item?.type !== "userMessage") return false;
  if (NON_OWNER_CLIENT.test(item.clientId ?? "")) return false;
  if (BOT_SOURCE.test(messageText(item).trimStart())) return false;
  let source = null;
  try { source = item.clientId ? runtime.sources?.row?.(bot.id, bot.threadId, item.clientId)?.source ?? null : null; } catch { source = null; }
  return !source || source.kind === "user";
}
const compact = (value, max) => { const s = typeof value === "string" ? value : JSON.stringify(value ?? null); return s.length > max ? `${s.slice(0, max)}…` : s; };

/**
 * New owner messages (and evidence actions) after `cursor`, oldest first,
 * bounded by `limit` messages and `chars`. A missing or foreign cursor starts
 * from `lookbackMs` ago, never from the whole history.
 * Returns { messages, actions, cursor, more }.
 */
export async function readOwnerMessages(runtime, bot, cursor, { limit = 40, chars = 24000, lookbackMs = 72 * 36e5, clock = Date.now } = {}) {
  const own = cursor?.threadId === bot.threadId ? cursor : null;
  const floor = own ? Date.parse(own.at ?? "") || 0 : clock() - lookbackMs;
  const turns = [];
  let page = null, reached = false;
  for (let n = 0; n < MAX_PAGES && !reached; n++) {
    page = await runtime.codex.call("thread/turns/list", { threadId: bot.threadId, cursor: page?.nextCursor ?? null, limit: PAGE, sortDirection: "desc", itemsView: "full" });
    for (const turn of page?.data ?? []) {
      if (own && turn.id === own.turnId) { turns.push(turn); reached = true; break; }
      if (Number.isFinite(turn.startedAt) && turn.startedAt * 1000 < floor - 6e4) { reached = true; break; }
      turns.push(turn);
    }
    if (!page?.nextCursor) break;
  }
  turns.reverse();
  const messages = [], actions = [];
  let used = 0, more = false, next = own, skipping = Boolean(own?.itemId);
  for (const turn of turns) {
    const at = Number.isFinite(turn.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : new Date(clock()).toISOString();
    for (const item of turn.items ?? []) {
      if (skipping) { if (turn.id !== own.turnId) skipping = false; else { if (item.id === own.itemId) skipping = false; continue; } }
      if (more) break;
      if (item.type === "userMessage" && ownerAuthored(runtime, bot, item)) {
        const body = ownerText(item);
        if (!body) { next = { threadId: bot.threadId, turnId: turn.id, itemId: item.id, at }; continue; }
        const piece = body.length > 4000 ? `${body.slice(0, 4000)}…` : body;
        if (messages.length >= limit || (messages.length && used + piece.length > chars)) { more = true; break; }
        used += piece.length;
        messages.push({ id: item.id, turnId: turn.id, threadId: bot.threadId, at, text: piece });
      } else if ((item.type === "dynamicToolCall" || item.type === "mcpToolCall") && EVIDENCE_TOOL.test(`${item.server ?? ""} ${item.tool}`) && item.status !== "failed" && item.success !== false) {
        if (actions.length < 30) actions.push({ turnId: turn.id, at, tool: item.server ? `${item.server}.${item.tool}` : item.tool, arguments: compact(item.arguments, 240) });
      }
      if (turn.status !== "inProgress") next = { threadId: bot.threadId, turnId: turn.id, itemId: item.id, at };
      else if (item.type === "userMessage") next = { threadId: bot.threadId, turnId: turn.id, itemId: item.id, at };
    }
    if (more) break;
  }
  return { messages, actions, cursor: next ?? { threadId: bot.threadId, turnId: null, itemId: null, at: new Date(floor).toISOString() }, more };
}

// ---- extraction model run ---------------------------------------------------
const nullable = schema => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" };
export const EXTRACTION_OUTPUT_SCHEMA = { type: "object", additionalProperties: false, required: ["mentions", "resolutions"], properties: {
  mentions: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["message_id", "quote", "item_id", "key", "title", "category", "entity", "importance", "time_sensitive", "due_in_hours", "summary", "better_bot_id"],
    properties: { message_id: str, quote: str, item_id: nullable(str), key: str, title: str, category: { type: "string", enum: MENTION_CATEGORIES },
      entity: nullable(str), importance: { type: "string", enum: IMPORTANCE }, time_sensitive: { type: "boolean" }, due_in_hours: nullable({ type: "number" }),
      summary: str, better_bot_id: nullable(str) } } },
  resolutions: { type: "array", items: { type: "object", additionalProperties: false, required: ["item_id", "kind", "evidence", "message_id"],
    properties: { item_id: str, kind: { type: "string", enum: RESOLUTION_KINDS }, evidence: str, message_id: nullable(str) } } },
} };

export const EXTRACTION_INSTRUCTIONS = `You extract loose threads from Dawar's own chat messages so nothing he mentions gets lost. You have no tools. Answer with the requested JSON only.`;
/** Prompt for one bounded batch. `threads` is the cross-bot open loose-thread catalog. */
export function extractionPrompt({ bot, messages, actions, threads, bots }) {
  return `${EXTRACTION_INSTRUCTIONS}

These are Dawar's messages to ${bot.name ?? "a bot"} (bot id ${bot.id}), oldest first. Only Dawar's words are shown.
# Dawar's new messages
${messages.map(m => `[${m.id}] ${m.at}\n${m.text}`).join("\n\n")}

# Actions the bot took meanwhile (resolution evidence only)
${actions.length ? actions.map(a => `- ${a.at} ${a.tool} ${a.arguments}`).join("\n") : "(none)"}

# Open loose threads already tracked (all bots)
${threads.length ? threads.map(t => `- ${t.id} | ${t.key} | ${t.category} | ${t.title}${t.entity ? ` | entity: ${t.entity}` : ""}`).join("\n") : "(none)"}

# Bots (for responsibility)
${bots.map(b => `- ${b.id}: ${b.name}${b.role ? ` — ${b.role}` : ""}`).join("\n")}

# Task
1. mentions: things worth tracking that Dawar raised and that are not yet concluded in these messages: clients, people or companies he wants to act on, new ideas, intentions ("we should…", "remind me", "I'm thinking about…"), open questions, commitments and decisions in progress. Skip routine instructions the bot is carrying out right now, small talk, and anything already concluded. Fewer, real items beat many weak ones.
   - quote: copy Dawar's exact words (one sentence or phrase, at most 200 characters) from message_id.
   - If it is the same underlying thing as a tracked thread (even from another bot), set item_id to that thread's id and keep its key.
   - key: short stable kebab-case identity (for example "client-acme-renewal"); entity: the client, person or company name when there is one.
   - better_bot_id: only when another bot's role clearly fits better (for example a client follow-up and a sales or communications bot); otherwise null.
   - due_in_hours: only when he named a time; time_sensitive when delay would cost something.
2. resolutions: tracked threads these messages or actions clearly concluded: a todo or task created or completed, a decision stated, a message sent or meeting scheduled, an artifact delivered, or Dawar saying it is done or dropped. Name the evidence briefly.`;
}

const parse = raw => {
  if (raw && typeof raw === "object") return raw;
  const body = String(raw ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(body); } catch { throw Error("Extraction result is not JSON."); }
};
const squash = value => String(value ?? "").replace(/\s+/g, " ").trim();
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";

/**
 * Strict validation against the batch it was produced from: every mention
 * must cite a message in the batch, and its quote must be Dawar's own words
 * from that message (otherwise the message's opening is used instead).
 */
export function validateExtraction(raw, batch, { clock = Date.now(), knownItems = new Set() } = {}) {
  const value = parse(raw);
  if (!value || !Array.isArray(value.mentions) || !Array.isArray(value.resolutions)) throw Error("Extraction result is malformed.");
  if (value.mentions.length > 40 || value.resolutions.length > 40) throw Error("Extraction result exceeds its bounds.");
  const byId = new Map(batch.messages.map(m => [m.id, m]));
  const mentions = [];
  for (const m of value.mentions) {
    const source = byId.get(m?.message_id);
    if (!source || !MENTION_CATEGORIES.includes(m.category) || !IMPORTANCE.includes(m.importance)) continue;
    const key = text(m.key, 120), title = text(m.title, 200);
    if (!normalizeKey(key || title)) continue;
    let quote = squash(m.quote).slice(0, 240);
    if (!quote || !squash(source.text).toLowerCase().includes(quote.toLowerCase())) quote = squash(source.text).slice(0, 200);
    const due = Number(m.due_in_hours);
    mentions.push({ messageId: source.id, turnId: source.turnId, threadId: source.threadId, messageAt: source.at, quote,
      itemId: typeof m.item_id === "string" && knownItems.has(m.item_id) ? m.item_id : null, key, title, category: m.category,
      entity: text(m.entity, 120) || null, importance: m.importance, timeSensitive: m.time_sensitive === true,
      dueAt: Number.isFinite(due) && due > 0 ? new Date(Date.parse(source.at) + Math.min(due, 24 * 60) * 36e5).toISOString() : null,
      summary: text(m.summary, 600), betterBotId: typeof m.better_bot_id === "string" ? m.better_bot_id : null });
  }
  const lastAt = batch.messages.at(-1)?.at ?? batch.actions.at(-1)?.at ?? new Date(clock).toISOString();
  const resolutions = value.resolutions.filter(r => r && typeof r.item_id === "string" && knownItems.has(r.item_id) && RESOLUTION_KINDS.includes(r.kind) && text(r.evidence, 500))
    .map(r => { const source = byId.get(r.message_id); return { itemId: r.item_id, kind: r.kind, evidence: text(r.evidence, 500), at: source?.at ?? lastAt,
      source: source ? `message:${source.id}` : "bot-actions" }; });
  return { mentions, resolutions };
}
