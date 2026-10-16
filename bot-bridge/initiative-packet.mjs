import { profileContext, PROFILE_SECTIONS } from "./profiles.mjs";

// What a bot's inner monologue reads, built on the node from bridge-owned
// data: its identity and memory files and the high-level part of its own
// recent conversation. Nothing from other bots. Sections are bounded so a
// thought costs about the same however long the conversation gets.

export const estimateTokens = value => Math.ceil(String(value ?? "").length / 4);
const PROFILE_KEYS = { identity: ["IDENTITY.md", "SOUL.md", "USER.md"], memory: ["MEMORY.md"] };
// Native user messages that are not Dawar typing: schedules, peers, notices.
export const NON_OWNER_CLIENT = /^(schedule:|peer:|peer-exchange:|manager-notice:|secure-receipt:|initiative)/;
const BOT_SOURCE = /^\[Verified DawarTodo source \{"kind":"bot"/;

const clip = (value, max) => { const s = String(value ?? ""); return s.length > max ? `${s.slice(0, Math.max(0, max - 40))}\n… (${s.length - max + 40} characters omitted)` : s; };
/** The end of a long text (newest memory entries are usually last). */
const tail = (value, max) => { const s = String(value ?? ""); return s.length > max ? `(… ${s.length - max} earlier characters omitted)\n${s.slice(-max)}` : s; };
const one = (value, max) => clip(String(value ?? "").replace(/\s+/g, " ").trim(), max);
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

/**
 * The last `hours` of high-level exchange, newest last: Dawar's and peers'
 * messages and the bot's final answers (summary view: no reasoning, tool
 * calls or tool output). MEMORY.md carries anything older.
 */
export async function recentConversation(runtime, bot, budget, { hours = 72, clock = Date.now } = {}) {
  const rows = [], floor = clock() - hours * 36e5;
  let used = 0, page = null, reached = false;
  for (let n = 0; n < 6 && used < budget && !reached; n++) {
    page = await runtime.codex.call("thread/turns/list", { threadId: bot.threadId, cursor: page?.nextCursor ?? null, limit: 25, sortDirection: "desc", itemsView: "summary" });
    for (const turn of page?.data ?? []) {
      if (Number.isFinite(turn.startedAt) && turn.startedAt * 1000 < floor) { reached = true; break; }
      const at = Number.isFinite(turn.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : "";
      const lines = [], tools = new Map();
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") {
          const who = ownerAuthored(runtime, bot, item) ? "Dawar" : NON_OWNER_CLIENT.test(item.clientId ?? "") ? (item.clientId.split(":")[0] || "system") : "peer bot";
          lines.push(`${who}: ${one(ownerText(item), 1200)}`);
        } else if (item.type === "agentMessage" && item.phase !== "commentary" && item.text?.trim()) lines.push(`You: ${one(item.text, 1500)}`);
        else if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") tools.set(item.tool, (tools.get(item.tool) ?? 0) + 1);
      }
      if (tools.size) lines.push(`(tools: ${[...tools].map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(", ")})`);
      if (!lines.length) continue;
      const block = `[${at}${turn.status === "completed" ? "" : ` ${turn.status}`}]\n${lines.join("\n")}`;
      if (used + block.length > budget) { if (!rows.length) rows.push(clip(block, budget)); used = budget; break; }
      rows.push(block); used += block.length;
    }
    if (!page?.nextCursor) break;
  }
  return rows.reverse().join("\n\n");
}

async function profileSections(bot) {
  try {
    const context = await profileContext(bot, null, { threadPolicy: true });
    return new Map((context[PROFILE_SECTIONS]?.sections ?? []).map(s => [s.key, s.text]));
  } catch { return new Map(); }
}

/**
 * Identity, memory and recent conversation for one thought, within about
 * `maxTokens`: identity a sixth, memory (newest end) a quarter, and the
 * conversation whatever is left.
 */
export async function mindMaterials(runtime, bot, { maxTokens = 12000, conversationHours = 72 } = {}) {
  const total = maxTokens * 4, profile = await profileSections(bot);
  const pick = keys => keys.filter(k => profile.has(k)).map(k => profile.get(k)).join("\n\n");
  const identity = clip(pick(PROFILE_KEYS.identity), Math.floor(total / 6));
  const memory = tail(pick(PROFILE_KEYS.memory), Math.floor(total / 4));
  const conversation = await recentConversation(runtime, bot, Math.max(2000, total - identity.length - memory.length - 6000), { hours: conversationHours });
  return { identity, memory, conversation };
}
