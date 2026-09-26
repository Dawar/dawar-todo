import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { Turn } from "./codex-protocol/v2/Turn";
import type { BotAttachment, BotEvent } from "./bots-types";

/** A disposable, explicitly partial view. Native history remains authoritative. */
export type HistoryEntry = {
  id: string; turnId: string; type: ThreadItem["type"]; label: string;
  item: ThreadItem | null; complete: boolean; scheduled: boolean;
  startedAt: number | null; status: Turn["status"]; updatedSeq?: number;
};
export type HistoryPage = {
  entries: HistoryEntry[]; olderCursor: string | null; revision: string;
  eventCursor: number; attachments: BotAttachment[]; complete: boolean;
};
export type HistoryResponse =
  | ({ kind: "page" } & HistoryPage)
  | { kind: "unchanged"; revision: string; eventCursor: number }
  | { kind: "events"; revision: string; eventCursor: number; events: BotEvent[] };
export type HistoryDetail = { json: string; nextOffset: number | null; totalLength: number; version: string };
export type HistoryPosition = { anchor: string | null; offset: number; following: boolean };
export const HISTORY_WINDOW = 40;
export const HISTORY_TEXT_LIMIT = 4096;
export const historyKey = (turnId: string, itemId: string) => `${turnId}:${itemId}`;
export const historyBefore = (entry: HistoryEntry) => JSON.stringify({ native: null, before: historyKey(entry.turnId, entry.id) });

export function projectHistoryItem(turn: Pick<Turn, "id" | "startedAt" | "status">, source: ThreadItem, scheduled = false): HistoryEntry {
  let item: ThreadItem | null = null, complete = true;
  const clip = (text: string) => { if (text.length > HISTORY_TEXT_LIMIT) complete = false; return text.slice(0, HISTORY_TEXT_LIMIT); };
  let label = source.type.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (source.type === "agentMessage" || source.type === "plan") {
    item = { ...source, text: clip(source.text) };
    // Keep only fields consumed by the preview; detail retains the native object.
    if (source.type === "agentMessage") item = { type: source.type, id: source.id, text: clip(source.text), phase: source.phase, memoryCitation: null, delivery: null, questions: null };
  } else if (source.type === "userMessage") {
    let remaining = HISTORY_TEXT_LIMIT;
    item = { ...source, content: source.content.map((part) => {
      if (part.type === "text") { const text = part.text.slice(0, remaining); remaining -= text.length; if (text.length !== part.text.length) complete = false; return { type: "text" as const, text, text_elements: [] }; }
      if (part.type === "localImage") return { ...part, path: clip(part.path) };
      complete = false;
      return { type: "text" as const, text: "[Attachment or input available in full message]", text_elements: [] };
    }).slice(0, 32) };
    if (source.content.length > 32) complete = false;
  } else if (source.type === "contextCompaction") item = source;
  else {
    complete = false;
    if (source.type === "commandExecution") label = source.command.slice(0, 160);
    else if (source.type === "fileChange") label = `${source.changes.length} file changes`;
    else if (source.type === "webSearch") label = source.query.slice(0, 160);
    else if (source.type === "mcpToolCall") label = `${source.server} · ${source.tool}`.slice(0, 160);
  }
  return { id: source.id, turnId: turn.id, type: source.type, label, item, complete,
    scheduled, startedAt: turn.startedAt, status: turn.status };
}

/** Legacy caches can paint a useful tail without cloning/serializing their tool bodies. */
export function historyTail(turns: Turn[], limit = HISTORY_WINDOW): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (let t = turns.length - 1; t >= 0 && entries.length < limit; t--) {
    const turn = turns[t];
    const scheduled = turn.items.some((i) => i.type === "userMessage" && i.clientId?.startsWith("schedule:"));
    for (let i = turn.items.length - 1; i >= 0 && entries.length < limit; i--)
      entries.push(projectHistoryItem(turn, turn.items[i], scheduled));
  }
  return entries.reverse();
}
