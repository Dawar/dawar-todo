import type { ThreadItem } from "./codex-protocol/v2/ThreadItem";
import type { Turn } from "./codex-protocol/v2/Turn";
import { conversationItem, projectHistoryItem, type HistoryEntry } from "./bot-history-view.ts";

export type TurnAudience = { kind: "conversation" | "activity" | "mixed"; runId?: string; active?: boolean };
export const scheduleInput = (item: ThreadItem) => item.type === "userMessage" && Boolean(item.clientId?.startsWith("schedule:"));
export const humanInput = (item: ThreadItem) => item.type === "userMessage" && !scheduleInput(item) && !item.clientId?.startsWith("manager-notice:");

/** Inspect a full native turn, not an arbitrary tail of its projected items.
 * Without item-level provenance a mixed turn keeps all surrounding replies. */
export function turnAudience(items: ThreadItem[], knownRunId?: string): TurnAudience {
  const trigger = items.find(scheduleInput);
  const runId = trigger?.type === "userMessage" ? trigger.clientId!.slice(9) : knownRunId;
  if (!trigger && !knownRunId) return { kind: "conversation" };
  return { kind: items.some(humanInput) ? "mixed" : "activity", ...(runId ? { runId } : {}) };
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

export function projectConversationItem(turn: Pick<Turn, "id" | "startedAt" | "status">, item: ThreadItem, audience: TurnAudience): HistoryEntry | null {
  if (audience.kind === "activity") {
    const finding = reportedFinding(item);
    if (!finding) return null;
    return { ...projectHistoryItem(turn, { type: "agentMessage", id: item.id, text: finding.summary,
      phase: "final_answer", memoryCitation: null, delivery: null, questions: null }),
      audience: "finding", findingId: finding.key, runId: audience.runId };
  }
  if (scheduleInput(item) || item.type === "userMessage" && item.clientId?.startsWith("manager-notice:")) return null;
  if (turn.status !== "inProgress" && (!conversationItem(item.type) || item.type === "reasoning" && !item.summary.some(text => text.trim()))) return null;
  return { ...projectHistoryItem(turn, item), audience: audience.kind, runId: audience.runId };
}
