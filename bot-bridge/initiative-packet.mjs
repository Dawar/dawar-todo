import { profileContext, PROFILE_SECTIONS } from "./profiles.mjs";
import { ownerAuthored, ownerText, NON_OWNER_CLIENT } from "./initiative-mentions.mjs";

// Review input for both providers: a bounded packet built from bridge-owned
// data instead of a fork of the whole conversation. Sections are filled in
// priority order and trimmed to fit `maxTokens` (estimated at 4 characters
// per token), so a review costs the same whatever the conversation's length.

export const estimateTokens = value => Math.ceil(String(value ?? "").length / 4);
// Character budgets per section, as shares of the whole packet.
const SHARES = { looseThreads: 0.2, ledger: 0.08, conversation: 0.3, memory: 0.22, identity: 0.06, hub: 0.08, artifacts: 0.03 };
const PROFILE_KEYS = { identity: ["IDENTITY.md", "SOUL.md", "USER.md"], memory: ["MEMORY.md"] };

const clip = (value, max) => { const s = String(value ?? ""); return s.length > max ? `${s.slice(0, Math.max(0, max - 40))}\n… (${s.length - max + 40} characters omitted)` : s; };
const one = (value, max) => clip(String(value ?? "").replace(/\s+/g, " ").trim(), max);

/**
 * Recent turns, newest last: Dawar, peers and the bot's final answers; tool
 * use by name only. Every turn and message carries a citable ref
 * (`turn:<id>`, `msg:<itemId>`) added to `refs`.
 */
export async function recentConversation(runtime, bot, budget, refs = new Set()) {
  const rows = [];
  let used = 0, page = null;
  for (let n = 0; n < 3 && used < budget; n++) {
    page = await runtime.codex.call("thread/turns/list", { threadId: bot.threadId, cursor: page?.nextCursor ?? null, limit: 8, sortDirection: "desc", itemsView: "full" });
    for (const turn of page?.data ?? []) {
      const at = Number.isFinite(turn.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : "";
      const lines = [], tools = new Map();
      for (const item of turn.items ?? []) {
        if (item.type === "userMessage") {
          const who = ownerAuthored(runtime, bot, item) ? "Dawar" : NON_OWNER_CLIENT.test(item.clientId ?? "") ? (item.clientId.split(":")[0] || "system") : "peer bot";
          lines.push(`[msg:${item.id}] ${who}: ${one(ownerText(item), 1200)}`);
        } else if (item.type === "agentMessage" && item.phase !== "commentary" && item.text?.trim()) lines.push(`[msg:${item.id}] You: ${one(item.text, 1500)}`);
        else if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") tools.set(item.tool, (tools.get(item.tool) ?? 0) + 1);
      }
      if (tools.size) lines.push(`(tools: ${[...tools].map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(", ")})`);
      if (!lines.length) continue;
      const block = `[turn:${turn.id} ${at}${turn.status === "completed" ? "" : ` ${turn.status}`}]\n${lines.join("\n")}`;
      const cite = () => { refs.add(`turn:${turn.id}`); for (const line of lines) { const m = /^\[msg:([^\]]+)\]/.exec(line); if (m) refs.add(`msg:${m[1]}`); } };
      if (used + block.length > budget) { if (!rows.length) { rows.push(clip(block, budget)); cite(); } used = budget; break; }
      rows.push(block); used += block.length; cite();
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
function recentArtifacts(runtime, bot, refs, limit = 8) {
  try {
    return runtime.store.db.prepare(`SELECT json FROM records WHERE kind='artifactPublication' AND bot_id=? ORDER BY rowid DESC LIMIT ?`).all(bot.id, limit)
      .map(row => JSON.parse(row.json)).map(a => { refs.add(`artifact:${a.id}`); return `- [artifact:${a.id}] ${a.createdAt ?? a.publishedAt ?? ""} ${a.name ?? a.title ?? a.fileName ?? a.id}`; });
  } catch { return []; }
}
/** Hub-brief entries may be plain strings or { id, text }; the latter are citable. */
const entry = (prefix, value, refs) => {
  if (value && typeof value === "object") { refs.add(`${prefix}:${value.id}`); return `- [${prefix}:${value.id}] ${one(value.text, 300)}`; }
  return `- ${one(value, 300)}`;
};

/**
 * The packet for one review. `brief` comes from the hub (ledger slice with
 * loose threads and their quotes, schedules, queue, bots, priorities).
 * Returns { text, tokens, sections, refs } with tokens <= maxTokens; `refs`
 * are the source references a room critique may cite.
 */
/** A member's own role and memory for a room step (IDENTITY, SOUL, USER, then MEMORY), bounded. */
export async function ownProfile(bot, maxChars = 8000) {
  const profile = await profileSections(bot);
  const identity = PROFILE_KEYS.identity.filter(k => profile.has(k)).map(k => profile.get(k)).join("\n\n");
  const memory = profile.get("MEMORY.md") ?? "";
  return [clip(identity, Math.floor(maxChars * 0.4)), clip(memory, Math.floor(maxChars * 0.6))].filter(Boolean).join("\n\n");
}
export async function buildReviewPacket(runtime, bot, brief, { maxTokens = 12000 } = {}) {
  const total = maxTokens * 4, refs = new Set();
  for (const item of brief.ledger ?? []) {
    refs.add(`item:${item.id}`);
    for (const m of item.mentions ?? []) if (m.ref) refs.add(m.ref);
  }
  const budget = key => Math.floor(total * SHARES[key]);
  const threads = (brief.ledger ?? []).filter(i => i.kind === "loose-thread"), other = (brief.ledger ?? []).filter(i => i.kind !== "loose-thread");
  const profile = brief.shared ? new Map() : await profileSections(bot);
  const pick = keys => keys.filter(k => profile.has(k)).map(k => profile.get(k)).join("\n\n");
  const hub = [
    brief.schedules?.length ? `Schedules:\n${brief.schedules.map(s => entry("schedule", s, refs)).join("\n")}` : "",
    brief.queue?.length ? `Queued prompts:\n${brief.queue.map(q => entry("queue", q, refs)).join("\n")}` : "",
    brief.bots?.length ? `Other bots:\n${brief.bots.map(b => `- ${b.name}${b.role ? `: ${one(b.role, 120)}` : ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  // Stable sections first (role, identity, memory) so a provider's prompt
  // cache can reuse them; the changing ledger and conversation come last.
  const sections = [
    ["Your role", clip(`${brief.role ?? ""}${brief.priorities ? `\n\nDawar's priorities:\n${brief.priorities}` : ""}`, 6000)],
    // A room's shared packet carries no bot's identity or memory: each member adds its own.
    ...(brief.shared ? [] : [["Identity and user profile", clip(pick(PROFILE_KEYS.identity) || "(none)", budget("identity"))],
      ["Memory", clip(pick(PROFILE_KEYS.memory) || "(none)", budget("memory"))]]),
    ["Schedules, queue and other bots", clip(hub || "(none)", budget("hub"))],
    ["Recent artifacts", clip(recentArtifacts(runtime, bot, refs).join("\n") || "(none)", budget("artifacts"))],
    ["Other ledger items (follow-ups and opportunities across bots)", clip(other.length ? JSON.stringify(other) : "(empty)", budget("ledger"))],
    ["Loose threads (Dawar's own unconcluded mentions; due ones are marked)", clip(threads.length ? JSON.stringify(threads, null, 1) : "(none)", budget("looseThreads"))],
  ];
  const used = sections.reduce((sum, [, v]) => sum + v.length, 0);
  // The conversation takes its share plus whatever earlier sections left unused.
  sections.push(["Recent conversation (oldest first)", await recentConversation(runtime, bot, Math.max(2000, total - used - 2000), refs) || "(no turns)"]);
  let text = sections.map(([title, body]) => `## ${title}\n${body}`).join("\n\n");
  if (estimateTokens(text) > maxTokens) text = clip(text, total);
  // A ref clipped out of the final text is not citable.
  return { text, tokens: estimateTokens(text), sections: sections.map(([title, body]) => ({ title, tokens: estimateTokens(body) })),
    refs: [...refs].filter(ref => text.includes(ref.startsWith("item:") ? ref.slice(5) : ref)) };
}
