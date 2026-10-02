import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { Turn } from "./codex-protocol/v2/Turn";
import { conversationItem, projectHistoryItem, type HistoryEntry } from "./bot-history-view.ts";

export type TurnAudience = { kind: "conversation" | "activity" | "mixed"; runId?: string; active?: boolean };
export const scheduleInput = (item: ThreadItem) => item.type === "userMessage" && Boolean(item.clientId?.startsWith("schedule:"));
export const peerInput = (item: ThreadItem) => item.type === "userMessage" && Boolean(item.clientId?.startsWith("peer:") || item.clientId?.startsWith("peer-exchange:"));
export const humanInput = (item: ThreadItem) => item.type === "userMessage" && !scheduleInput(item) && !peerInput(item) && !item.clientId?.startsWith("secure-receipt:") && !item.clientId?.startsWith("manager-notice:");

/** Inspect a full native turn, not an arbitrary tail of its projected items.
 * Without item-level provenance a mixed turn keeps all surrounding replies. */
export function turnAudience(items: ThreadItem[], knownRunId?: string, conversation = false): TurnAudience {
  const trigger = items.find(scheduleInput);
  const runId = trigger?.type === "userMessage" ? trigger.clientId!.slice(9) : knownRunId;
  // Peer-triggered work belongs to this same conversation. Hide the incoming
  // peer envelope, but retain the bot's visible progress and reasoning summaries.
  if (!trigger && !knownRunId) return { kind: "conversation" };
  return { kind: items.some(humanInput) ? "mixed" : conversation ? "conversation" : "activity", ...(runId ? { runId } : {}) };
}

/** Only the explicit successful reporting tool is an actionable scheduled
 * finding. Ordinary final prose is not guessed to be a human notification. */
export function reportedFinding(item: ThreadItem) {
  if (item.type !== "dynamicToolCall" || item.tool !== "bots_report_result" || item.status !== "completed" || item.success !== true) return null;
  const args = item.arguments;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const key = typeof args.key === "string" ? args.key.slice(0, 200) : "";
  const summary = typeof args.summary === "string" ? args.summary.trim().slice(0, 1000) : "";
  return key && summary ? { key: JSON.stringify([key, summary]), summary } : null;
}

export function projectConversationItem(turn: Pick<Turn, "id" | "startedAt" | "status"> & Partial<Pick<Turn, "completedAt">>, item: ThreadItem, audience: TurnAudience): HistoryEntry | null {
  if (audience.kind === "activity") {
    if (item.type === "agentMessage" && item.questions?.length)
      return { ...projectHistoryItem(turn, item), audience: "conversation", runId: audience.runId };
    const finding = reportedFinding(item);
    if (!finding) return null;
    return { ...projectHistoryItem(turn, { type: "agentMessage", id: item.id, text: finding.summary,
      phase: "final_answer", memoryCitation: null, delivery: null, questions: null }),
      audience: "finding", findingId: finding.key, runId: audience.runId };
  }
  if (scheduleInput(item) || peerInput(item) || item.type === "userMessage" && item.clientId?.startsWith("secure-receipt:") || item.type === "userMessage" && item.clientId?.startsWith("manager-notice:")) return null;
  if (turn.status !== "inProgress" && (!conversationItem(item.type) || item.type === "reasoning" && !item.summary.some(text => text.trim()))) return null;
  return { ...projectHistoryItem(turn, item, Boolean(audience.runId)), audience: audience.kind, runId: audience.runId };
}
