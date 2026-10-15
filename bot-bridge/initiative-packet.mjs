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

/** Recent turns, newest last: Dawar, peers and the bot's final answers; tool use by name only. */
export async function recentConversation(runtime, bot, budget) {
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
          lines.push(`${who}: ${one(ownerText(item), 1200)}`);
        } else if (item.type === "agentMessage" && item.phase !== "commentary" && item.text?.trim()) lines.push(`You: ${one(item.text, 1500)}`);
        else if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") tools.set(item.tool, (tools.get(item.tool) ?? 0) + 1);
      }
      if (tools.size) lines.push(`(tools: ${[...tools].map(([k, v]) => v > 1 ? `${k}×${v}` : k).join(", ")})`);
      if (!lines.length) continue;
      const block = `[turn ${turn.id} ${at}${turn.status === "completed" ? "" : ` ${turn.status}`}]\n${lines.join("\n")}`;
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
function recentArtifacts(runtime, bot, limit = 8) {
  try {
    return runtime.store.db.prepare(`SELECT json FROM records WHERE kind='artifactPublication' AND bot_id=? ORDER BY rowid DESC LIMIT ?`).all(bot.id, limit)
      .map(row => JSON.parse(row.json)).map(a => `- ${a.createdAt ?? a.publishedAt ?? ""} ${a.name ?? a.title ?? a.fileName ?? a.id}`);
  } catch { return []; }
}

/**
 * The packet for one review. `brief` comes from the hub (ledger slice with
 * loose threads and their quotes, schedules, queue, bots, priorities).
 * Returns { text, tokens, sections } with tokens <= maxTokens.
 */
export async function buildReviewPacket(runtime, bot, brief, { maxTokens = 12000 } = {}) {
  const total = maxTokens * 4;
  const budget = key => Math.floor(total * SHARES[key]);
  const threads = (brief.ledger ?? []).filter(i => i.kind === "loose-thread"), other = (brief.ledger ?? []).filter(i => i.kind !== "loose-thread");
  const profile = await profileSections(bot);
  const pick = keys => keys.filter(k => profile.has(k)).map(k => profile.get(k)).join("\n\n");
  const hub = [
    brief.schedules?.length ? `Schedules:\n${brief.schedules.map(s => `- ${one(s, 300)}`).join("\n")}` : "",
    brief.queue?.length ? `Queued prompts:\n${brief.queue.map(q => `- ${one(q, 300)}`).join("\n")}` : "",
    brief.bots?.length ? `Other bots:\n${brief.bots.map(b => `- ${b.name}${b.role ? `: ${one(b.role, 120)}` : ""}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  // Stable sections first (role, identity, memory) so a provider's prompt
  // cache can reuse them; the changing ledger and conversation come last.
  const sections = [
    ["Your role", clip(`${brief.role ?? ""}${brief.priorities ? `\n\nDawar's priorities:\n${brief.priorities}` : ""}`, 6000)],
    ["Identity and user profile", clip(pick(PROFILE_KEYS.identity) || "(none)", budget("identity"))],
    ["Memory", clip(pick(PROFILE_KEYS.memory) || "(none)", budget("memory"))],
    ["Schedules, queue and other bots", clip(hub || "(none)", budget("hub"))],
    ["Recent artifacts", clip(recentArtifacts(runtime, bot).join("\n") || "(none)", budget("artifacts"))],
    ["Other ledger items (follow-ups and opportunities across bots)", clip(other.length ? JSON.stringify(other) : "(empty)", budget("ledger"))],
    ["Loose threads (Dawar's own unconcluded mentions; due ones are marked)", clip(threads.length ? JSON.stringify(threads, null, 1) : "(none)", budget("looseThreads"))],
  ];
  const used = sections.reduce((sum, [, v]) => sum + v.length, 0);
  // The conversation takes its share plus whatever earlier sections left unused.
  sections.push(["Recent conversation (oldest first)", await recentConversation(runtime, bot, Math.max(2000, total - used - 2000)) || "(no turns)"]);
  let text = sections.map(([title, body]) => `## ${title}\n${body}`).join("\n\n");
  if (estimateTokens(text) > maxTokens) text = clip(text, total);
  return { text, tokens: estimateTokens(text), sections: sections.map(([title, body]) => ({ title, tokens: estimateTokens(body) })) };
}
