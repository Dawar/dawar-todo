import type { BotEvent } from "../../lib/bots-types";
import type { HistoryEntry } from "../../lib/bot-history-view";
import type { NativeEvent } from "./thread-state";

export type RunHistoryRefresh = { reason: "large-native-event"; method: string; turnId: string; itemId?: string; entry?: HistoryEntry; turn?: NativeEvent["params"]["turn"] };
/** The fixed backend envelope carries event sequence, not a separate version. */
export function runHistoryRefresh(event: BotEvent): RunHistoryRefresh | null {
  if (event.type !== "run.state") return null;
  const value = (event.data as { historyRefresh?: RunHistoryRefresh })?.historyRefresh;
  return value?.reason === "large-native-event" && typeof value.method === "string" && typeof value.turnId === "string" && value.turnId ? value : null;
}
export const refreshMatches = (value: RunHistoryRefresh, entry: Pick<HistoryEntry, "turnId" | "id">) => value.turnId === entry.turnId && (!value.itemId || value.itemId === entry.id);
