import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { Turn } from "./codex-protocol/v2/Turn";
import type { BotAttachment, BotEvent } from "./bots-types";

/** A disposable, explicitly partial view. Native history remains authoritative. */
export type HistoryEntry = {
  /** Summary-backed chat: exact commentary and tools load only on disclosure. */
  deferredTurn?: boolean;
  turnError?: string;
  questionNotice?: string;
  reply?: import("./bot-replies").BotReplyReference;
  replyMessages?: (import("./bots-types").BotBurstMessage & { textTruncated?: boolean })[];
  operatorSegmentId?: string;
  id: string; turnId: string; type: ThreadItem["type"]; label: string;
  item: ThreadItem | null; complete: boolean; scheduled: boolean;
  audience?: "conversation" | "mixed" | "finding"; runId?: string; findingId?: string; legacyContext?: boolean;
  messageAt?: number | null; timeBasis?: "received" | "turn-start" | "turn-end";
  startedAt: number | null; turnStatus?: Turn["status"]; itemStatus?: string; status: Turn["status"]; updatedSeq?: number;
};
export type HistoryContext = { laneId: string; runId: string | null; threadId: string };
export type HistoryPage = {
  context?: HistoryContext;
  /** Routine turns inspected and excluded before filling the conversation page. */
  activityTurns?: { turnId: string; runId?: string; active?: boolean }[];
  entries: HistoryEntry[]; turnIds?: string[]; newerCursor?: string | null; partialTurn?: boolean; contextEntries?: HistoryEntry[]; olderCursor: string | null; revision: string;
  eventCursor: number; attachments: BotAttachment[]; complete: boolean;
};
export type HistoryResponse =
  | ({ kind: "page" } & HistoryPage)
  | { kind: "unchanged"; context?: HistoryContext; revision: string; eventCursor: number }
  | { kind: "events"; context?: HistoryContext; revision: string; eventCursor: number; events: BotEvent[] };
/** Attachments refresh independently, including when notModified reuses text. */
export type HistoryDetail = { context?: HistoryContext; json: string; nextOffset: number | null; totalLength: number; version: string; eventCursor?: number; notModified?: boolean; attachments?: BotAttachment[] };
export type HistoryGap = { before: string; stop: string; cursor: string };
/** tailContext identifies the supplementary readable preview, whose canonical
 * item may also exist outside the mounted native window. It is display state. */
export type HistoryPosition = { anchor: string | null; offset: number; following: boolean; tailContext?: boolean };
export const HISTORY_WINDOW = 40; // Legacy diagnostic item view.
export const CONVERSATION_TURNS = 25;
export const conversationItem = (type: string) => ["userMessage", "agentMessage", "plan", "reasoning"].includes(type);
export const HISTORY_TEXT_LIMIT = 16384;
export const historyKey = (turnId: string, itemId: string) => `${turnId}:${itemId}`;
export const historyBefore = (entry: HistoryEntry) => JSON.stringify({ native: null, before: historyKey(entry.turnId, entry.id) });

/** A tool's own terminal result survives failure/interruption of its parent.
 * Sparse native turn metadata still settles retained rows outside this page. */
export function withTurnState(entry: HistoryEntry, turn: Pick<Turn, "status"> & { error?: { message: string } | null }): HistoryEntry {
  return { ...entry, turnStatus: turn.status,
    status: entry.itemStatus === "completed" || entry.itemStatus === "failed" ? entry.itemStatus :
      entry.itemStatus === "inProgress" && turn.status === "inProgress" ? "inProgress" : turn.status,
    ...(turn.error?.message ? { turnError: turn.error.message } : {}) };
}

export function projectHistoryItem(turn: Pick<Turn, "id" | "startedAt" | "status"> & Partial<Pick<Turn, "completedAt">>, source: ThreadItem, scheduled = false): HistoryEntry {
  let item: ThreadItem | null = null, complete = true;
  const clip = (text: string) => { if (text.length > HISTORY_TEXT_LIMIT) complete = false; return text.slice(0, HISTORY_TEXT_LIMIT); };
  let label = source.type.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (source.type === "agentMessage" || source.type === "plan") {
    item = { ...source, text: clip(source.text) };
    // Keep only fields consumed by the preview; detail retains the native object.
    if (source.type === "agentMessage" && (source.memoryCitation || source.delivery || source.questions)) complete = false;
    if (source.type === "agentMessage") item = { type: source.type, id: source.id, text: clip(source.text), phase: source.phase, memoryCitation: null, delivery: null, questions: null };
  } else if (source.type === "userMessage") {
    let remaining = HISTORY_TEXT_LIMIT;
    item = { ...source, content: source.content.slice(0, 32).map((part) => {
      if (part.type === "text") { const text = part.text.slice(0, remaining); remaining -= text.length; if (text.length !== part.text.length) complete = false; return { type: "text" as const, text, text_elements: [] }; }
      if (part.type === "localImage") { if (part.path.length > 512) complete = false; return { ...part, path: part.path.slice(0, 512) }; }
      complete = false;
      return { type: "text" as const, text: "[Attachment or input available in full message]", text_elements: [] };
    }).slice(0, 32) };
    if (source.content.length > 32) complete = false;
  } else if (source.type === "reasoning") {
    let remaining = HISTORY_TEXT_LIMIT;
    const summary = source.summary.slice(0, 64).map((text) => { const value = text.slice(0, remaining); remaining -= value.length; if (value.length !== text.length) complete = false; return value; });
    if (source.summary.length > 64) complete = false;
    item = { type: "reasoning", id: source.id, summary, content: [] };
  } else if (source.type === "contextCompaction") item = source;
  else {
    complete = false;
    if (source.type === "commandExecution") label = source.command.slice(0, 160);
    else if (source.type === "fileChange") label = `${source.changes.length} file changes`;
    else if (source.type === "webSearch") label = source.query.slice(0, 160);
    else if (source.type === "mcpToolCall") label = `${source.server} · ${source.tool}`.slice(0, 160);
    else if (source.type === "dynamicToolCall") label = source.tool === "bots_report_result" ? "Reported finding" : source.tool === "bots_publish_artifact" ? "Saved file" : "Tool result";
  }
  return withTurnState({ id: source.id, turnId: turn.id, type: source.type, label, item, complete,
    ...(source.type === "agentMessage" && !source.text.trim() && source.questions?.length ? { questionNotice: source.questions.slice(0, 16).map(q => q.title).join("\n\n").slice(0, HISTORY_TEXT_LIMIT) } : {}),
    scheduled, messageAt: source.type === "agentMessage" && source.phase === "final_answer" ? turn.completedAt ?? null : turn.startedAt, timeBasis: source.type === "agentMessage" && source.phase === "final_answer" ? "turn-end" : "turn-start", startedAt: turn.startedAt, turnStatus: turn.status, ...("status" in source ? { itemStatus: String(source.status) } : {}), status: turn.status }, turn);
}

/** Legacy caches can paint a useful tail without cloning/serializing their tool bodies. */
export function historyTail(turns: Turn[], limit = HISTORY_WINDOW): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (let t = turns.length - 1; t >= 0 && entries.length < limit; t--) {
    const turn = turns[t];
    const scheduled = turn.items.some((i) => i.type === "userMessage" && i.clientId?.startsWith("schedule:"));
    for (let i = turn.items.length - 1; i >= 0 && entries.length < limit; i--)
      if (turn.status === "inProgress" || conversationItem(turn.items[i].type)) entries.push(projectHistoryItem(turn, turn.items[i], scheduled));
  }
  return entries.reverse();
}
