import type { Turn } from "../../lib/codex-protocol/v2/Turn";
import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";

export type ConversationTurn = Turn & {
  diff?: string;
  planSteps?: { step: string; status: string }[];
  planExplanation?: string | null;
};
export type NativeEvent = {
  method: string;
  params: {
    threadId?: string; turnId?: string; turn?: Turn; item?: ThreadItem;
    itemId?: string; delta?: string; summaryIndex?: number; contentIndex?: number;
    text?: string; diff?: string; plan?: unknown; explanation?: string | null;
    changes?: Extract<ThreadItem, { type: "fileChange" }>["changes"];
  };
};

/** Route only the protocol event belonging to this item. A suffix match can
 * corrupt text with output from a different channel. Final items replace the
 * streamed draft (plan deltas in particular are not a final-content contract). */
export function reduceItemEvent(item: ThreadItem, event: NativeEvent): ThreadItem {
  const p = event.params;
  if (p.itemId !== item.id) return item;
  if ((item.type === "agentMessage" || item.type === "plan") &&
      event.method === (item.type === "agentMessage" ? "item/agentMessage/delta" : "item/plan/delta"))
    return { ...item, text: item.text + (p.delta ?? "") };
  if (item.type === "commandExecution" && event.method === "item/commandExecution/outputDelta")
    return { ...item, aggregatedOutput: (item.aggregatedOutput ?? "") + (p.delta ?? "") };
  if (item.type === "fileChange" && event.method === "item/fileChange/patchUpdated" && p.changes)
    return { ...item, changes: p.changes };
  if (item.type === "reasoning") {
    const summaryEvent = event.method === "item/reasoning/summaryTextDelta" || event.method === "item/reasoning/summaryPartAdded";
    const contentEvent = event.method === "item/reasoning/textDelta";
    if (!summaryEvent && !contentEvent) return item;
    const index = (summaryEvent ? p.summaryIndex : p.contentIndex) ?? 0;
    // Malformed indices must not create huge sparse arrays or object properties.
    if (!Number.isSafeInteger(index) || index < 0 || index > 4096) return item;
    const parts = [...(summaryEvent ? item.summary : item.content)];
    parts[index] = (parts[index] ?? "") + (event.method === "item/reasoning/summaryPartAdded" ? "" : p.delta ?? "");
    return summaryEvent ? { ...item, summary: parts } : { ...item, content: parts };
  }
  return item;
}

function nativeItems(previous: ThreadItem[], turn: Turn) {
  if (turn.itemsView === "full") return turn.items;
  // Metadata-only turns must not erase streamed bodies. Summary payloads
  // replace the matching items while retaining items omitted by that view.
  if (!turn.items?.length) return previous;
  const incoming = new Map(turn.items.map(item => [item.id, item]));
  const merged = previous.map(item => incoming.get(item.id) ?? item);
  const known = new Set(previous.map(item => item.id));
  return [...merged, ...turn.items.filter(item => !known.has(item.id))];
}
export function reduceBotTurns(turns: ConversationTurn[], event: NativeEvent): ConversationTurn[] {
  const p = event.params, turnId = p.turnId ?? p.turn?.id;
  if (!turnId) return turns;
  const existing = turns.find(t => t.id === turnId);
  let turn: ConversationTurn = existing ?? {
    id: turnId, items: [], itemsView: "full", status: "inProgress", error: null,
    startedAt: null, completedAt: null, durationMs: null,
  };
  if ((event.method === "turn/started" || event.method === "turn/completed") && p.turn) {
    if (event.method === "turn/started" && existing && existing.status !== "inProgress") return turns;
    turn = { ...turn, ...p.turn, items: nativeItems(turn.items, p.turn) };
  } else if ((event.method === "item/started" || event.method === "item/completed") && p.item) {
    const index = turn.items.findIndex(i => i.id === p.item!.id ||
      i.type === "userMessage" && p.item!.type === "userMessage" && Boolean(i.clientId) && i.clientId === p.item!.clientId);
    const items = [...turn.items];
    if (index < 0) items.push(p.item); else items[index] = p.item;
    turn = { ...turn, items };
  } else if (event.method === "turn/diff/updated") turn = { ...turn, diff: p.diff };
  else if (event.method === "turn/plan/updated") turn = { ...turn, planSteps: p.plan as ConversationTurn["planSteps"], planExplanation: p.explanation ?? null };
  else {
    const items = turn.items.map(item => reduceItemEvent(item, event));
    if (items.every((item, index) => item === turn.items[index])) return turns;
    turn = { ...turn, items };
  }
  return existing ? turns.map(t => t.id === turnId ? turn : t) : [...turns, turn];
}
