import { createHash } from "node:crypto";
import { boundedReplyText, replyableText } from "../lib/bot-replies.ts";
import { projectConversationItem, turnAudience } from "../lib/bot-conversation.ts";
import { projectHistoryItem, HISTORY_TEXT_LIMIT } from "../lib/bot-history-view.ts";
import { findNativeTurn } from "./native-reconcile.mjs";

const identity = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/.test(value);
export function ownedReply(runtime, bot, value) {
  if (value == null) return null;
  if (!identity(value.id)) throw Error("This reply reference is invalid. Your draft is retained.");
  const row = runtime.store.get("replyReference", value.id);
  if (!row || row.botId !== bot.id || row.threadId !== bot.threadId || value.botId !== row.botId || value.threadId !== row.threadId ||
      value.turnId !== row.turnId || value.itemId !== row.itemId || value.partId !== row.partId || value.role !== row.role || value.text !== row.text || value.truncated !== row.truncated)
    throw Error("This reply belongs to another conversation or has changed. Remove it or return to its original bot; your draft is retained.");
  return row;
}
export function rememberReply(runtime, bot, clientId, text, reply) {
  const reference = ownedReply(runtime, bot, reply);
  // A null marker also replaces a reply removed by a positively unstarted queue edit.
  return runtime.store.put("messageReply", { id: clientId, botId: bot.id, threadId: bot.threadId, text: String(text ?? "").trim(), reply: reference });
}
export function copyReplyReceipt(runtime, bot, from, to) {
  const row = runtime.store.get("messageReply", from);
  if (row?.botId === bot.id && row.threadId === bot.threadId) runtime.store.put("messageReply", { ...row, id: to });
}
export function displayReplyItem(runtime, bot, threadId, item) {
  if (item?.type !== "userMessage") return item;
  const row = runtime.store.get("messageReply", item.clientId);
  if (row?.botId !== bot.id || row.threadId !== threadId || !row.reply && !row.parts) return item;
  const text = row.parts ? row.parts.map(part => part.text).join("\n\n") : row.text;
  return { ...item, content: [{ type: "text", text, text_elements: [] }, ...item.content.filter(part => part.type !== "text" || part.text.startsWith("Attached file: "))] };
}
export function replyMetadata(runtime, bot, threadId, item) {
  if (item?.type !== "userMessage") return {};
  const row = runtime.store.get("messageReply", item.clientId);
  if (row?.botId !== bot.id || row.threadId !== threadId) return {};
  let remaining = HISTORY_TEXT_LIMIT;
  return row.parts ? { replyMessages: row.parts.map(part => {
    const text = part.text.slice(0, remaining); remaining -= text.length;
    return { ...part, text, textTruncated: text.length !== part.text.length };
  }) } : row.reply ? { reply: row.reply } : {};
}
export function projectReplyEntry(runtime, bot, threadId, turn, item, audience) {
  const source = displayReplyItem(runtime, bot, threadId, item);
  const entry = audience ? projectConversationItem(turn, source, audience) : projectHistoryItem(turn, source);
  return entry && { ...entry, ...replyMetadata(runtime, bot, threadId, item) };
}
async function source(runtime, bot, p) {
  if (p.threadId !== bot.threadId || !identity(p.turnId) || !identity(p.itemId) || p.cursor != null && (typeof p.cursor !== "string" || p.cursor.length > 8192))
    throw Error("Reply source is not in this bot's current conversation.");
  if (p.itemId.startsWith("finding:")) {
    if (p.partId != null) throw Error("Invalid reply message part.");
    const finding = runtime.store.get("runFinding", p.itemId.slice(8));
    if (finding?.botId !== bot.id || finding.threadId !== bot.threadId || finding.turnId !== p.turnId) return { entry: null, nextCursor: null, unavailable: true };
    const item = { type: "agentMessage", id: p.itemId, text: finding.summary, phase: "final_answer", memoryCitation: null, delivery: null, questions: null };
    const at = Date.parse(finding.createdAt) / 1000;
    return { item, entry: { ...projectHistoryItem({ id: finding.turnId, startedAt: at, status: "completed" }, item, true), audience: "finding", runId: finding.runId, messageAt: at, timeBasis: "received" }, nextCursor: null, unavailable: false };
  }
  let found;
  const hint = p.cursor == null && runtime.historyReads?.location(bot.threadId, p.turnId);
  if (hint) {
    try { const page = await runtime.historyPage(bot.threadId, hint.cursor, hint.pageLimit); const turn = page.data.find(turn => turn.id === p.turnId); if (turn) found = { turn, nextCursor: null }; }
    catch { /* Verify through bounded fresh discovery when a cursor hint expired. */ }
  }
  if (!found && runtime.historyReads) {
    let cursor = p.cursor ?? null; const seen = new Set();
    for (let count = 0; count < 4; count++) {
      if (seen.has(cursor)) throw Error("Native history pagination made no progress."); seen.add(cursor);
      const page = await runtime.historyReads.page(bot.threadId, cursor, 20, "notLoaded");
      if (page.data.some(turn => turn.id === p.turnId)) {
        const full = await runtime.historyPage(bot.threadId, cursor, 20);
        const turn = full.data.find(turn => turn.id === p.turnId);
        if (!turn) throw Error("History changed while locating this message. Try again.");
        found = { turn, nextCursor: null }; break;
      }
      cursor = page.nextCursor;
      if (!cursor || count === 3) { found = { turn: null, nextCursor: cursor ?? null }; break; }
    }
  }
  found ??= await findNativeTurn(runtime, bot.threadId, { turnId: p.turnId, cursor: p.cursor ?? null });
  if (!found.turn) return { entry: null, nextCursor: found.nextCursor, unavailable: !found.nextCursor };
  const turn = found.turn;
  const item = turn.items.find(item => item.id === p.itemId || item.type === "userMessage" && p.itemId === `client:${item.clientId}`);
  // Projection supplies the same visibility policy as the conversation, including legacy scheduled turns.
  const run = runtime.scheduledContext?.(bot.id, turn.id);
  const audience = turnAudience(turn.items, run?.runId, (run && runtime.store.get("run", run.runId)?.conversation === true));
  const projected = item && projectReplyEntry(runtime, bot, bot.threadId, turn, item, audience);
  const visible = item && replyableText(item) !== null ? displayReplyItem(runtime, bot, bot.threadId, item) : projected?.item;
  if (!projected || !visible || replyableText(visible) === null)
    return { entry: null, nextCursor: null, unavailable: true };
  if (p.partId != null) {
    if (!identity(p.partId) || item.type !== "userMessage") throw Error("Invalid reply message part.");
    const part = runtime.store.get("burstMessage", p.partId), batch = part && runtime.store.get("messageBurst", part.batchId);
    if (part?.botId !== bot.id || part.state !== "sent" || part.turnId !== turn.id || batch?.botId !== bot.id ||
        batch.threadId !== bot.threadId || batch.id !== item.clientId || !batch.messageIds.includes(part.id))
      throw Error("This message part is not in the selected conversation message.");
    return { entry: projected, item: { ...visible, content: [{ type: "text", text: part.text || "[Message with attachments]", text_elements: [] }] }, nextCursor: null, unavailable: false };
  }
  return { entry: projected, item: visible, nextCursor: null, unavailable: false };
}
export async function prepareReply(runtime, bot, p) {
  const result = await source(runtime, bot, p);
  if (!result.item) return { reply: null, nextCursor: result.nextCursor, unavailable: result.unavailable };
  const reply = { botId: bot.id, threadId: bot.threadId, turnId: result.entry.turnId, itemId: result.item.id,
    ...(p.partId ? { partId: p.partId } : {}), role: result.item.type === "userMessage" ? "user" : "assistant", ...boundedReplyText(replyableText(result.item)) };
  const id = `reply:${createHash("sha256").update(JSON.stringify(reply)).digest("hex")}`;
  const existing = runtime.store.get("replyReference", id);
  return { reply: existing ?? runtime.store.put("replyReference", { id, ...reply }), nextCursor: null, unavailable: false };
}
export async function resolveReply(runtime, bot, p) {
  const reply = ownedReply(runtime, bot, p.reply);
  if (!reply) throw Error("Select a reply reference.");
  const result = await source(runtime, bot, { ...reply, cursor: p.cursor });
  const { item, ...value } = result; void item;
  return value;
}
