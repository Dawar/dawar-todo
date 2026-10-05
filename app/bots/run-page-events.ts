import { historyKey, projectHistoryItem, withTurnState, type HistoryPage } from "../../lib/bot-history-view";
import type { BotEvent } from "../../lib/bots-types";
import { reconcileHistory } from "./history-reconcile";
import { reduceBotTurns, type NativeEvent } from "./thread-state";
import { runHistoryRefresh } from "./run-history-refresh";
/** Apply ordered events only to this already-opened part. No main controller or store calls. */
export function updateRunPage(page: HistoryPage, events: BotEvent[], turnId?: string | null, append = true): HistoryPage {
  let entries = page.entries;
  let cursor = page.eventCursor;
  for (const event of events) {
    const data = event.data as { runId?: string; laneId?: string; threadId?: string; message?: NativeEvent };
    if (event.seq <= cursor || data.runId !== page.context?.runId || data.laneId !== page.context?.laneId || data.threadId !== page.context?.threadId) continue;
    cursor = event.seq;
    const refresh = runHistoryRefresh(event);
    if (refresh) {
      if (refresh.turnId !== (turnId ?? page.turnIds?.[0] ?? entries[0]?.turnId)) continue;
      const descriptor = refresh.entry;
      if (descriptor && descriptor.turnId === refresh.turnId && (!refresh.itemId || descriptor.id === refresh.itemId)) {
        const existing = entries.find(value => value.turnId === descriptor.turnId && value.id === descriptor.id || descriptor.item?.type === "userMessage" && descriptor.item.clientId && value.item?.type === "userMessage" && value.item.clientId === descriptor.item.clientId);
        const projected = { ...descriptor, startedAt: existing?.startedAt ?? descriptor.startedAt, turnStatus: existing?.turnStatus ?? descriptor.turnStatus, updatedSeq: event.seq };
        if (existing) entries = reconcileHistory(entries.map(value => value === existing ? projected : value)).entries;
        else if (append) entries = reconcileHistory([...entries, projected]).entries;
      } else entries = entries.map(value => value.turnId === refresh.turnId && (!refresh.itemId || value.id === refresh.itemId) ? { ...value, complete: false, updatedSeq: event.seq } : value);
      if (refresh.turn) entries = entries.map(value => value.turnId === refresh.turnId ? withTurnState(value, refresh.turn!) : value);
      continue;
    }
    const native = data.message;
    if (!native?.params || (native.params.turnId ?? native.params.turn?.id) !== (turnId ?? page.turnIds?.[0] ?? entries[0]?.turnId)) continue;
    const id = native.params.turnId ?? native.params.turn!.id;
    const turn = { id, items: entries.filter(entry => entry.turnId === id && entry.item).map(entry => entry.item!), itemsView: "full" as const,
      status: entries.find(entry => entry.turnId === id)?.turnStatus ?? "inProgress" as const, startedAt: entries.find(entry => entry.turnId === id)?.startedAt ?? null, completedAt: null, durationMs: null, error: null };
    // Only visible projected bodies are reduced. A completed tool produces a
    // descriptor; its native output is never retained in this page/cache.
    const next = reduceBotTurns([turn], native)[0];
    if (!next) continue;
    const byKey = new Map(entries.map(entry => [historyKey(entry.turnId, entry.id), entry]));
    for (const item of next.items) {
      const projected = projectHistoryItem(next, item);
      const key = historyKey(next.id, item.id), old = byKey.get(key) ?? (item.type === "userMessage" && item.clientId ? entries.find(entry => entry.item?.type === "userMessage" && entry.item.clientId === item.clientId) : undefined);
      if (!append && !old) continue; // Earlier pages never acquire later-page rows.
      byKey.set(key, { ...projected, complete: projected.complete && (old?.complete ?? true), updatedSeq: event.seq });
    }
    if (append && native.params.item && !next.items.some(item => item.id === native.params.item!.id)) {
      const projected = projectHistoryItem(next, native.params.item); byKey.set(historyKey(id, projected.id), projected);
    }
    entries = reconcileHistory([...byKey.values()]).entries;
    if (native.method === "turn/completed") entries = entries.map(entry => entry.turnId === id ? withTurnState(entry, next) : entry);
  }
  // Do not silently evict entries or invent a cursor. The existing bounded
  // native page and its explicit refresh affordance recover overflow exactly.
  if (entries.length > 40 || new TextEncoder().encode(JSON.stringify(entries)).length > 60 * 1024) throw Error("New output exceeds this page. Your current page is retained; refresh this part to load the latest bounded page.");
  return entries === page.entries && cursor === page.eventCursor ? page : { ...page, entries, eventCursor: cursor };
}
