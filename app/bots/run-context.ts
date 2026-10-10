import type { BotRun, BotRunStateEvent } from "../../lib/bots-types";

/** Queued admission precedes both native IDs and optional activity metadata.
 * Unknown historical targets still go through the authoritative resolver. */
export const runNeedsBinding = (run: BotRun) => run.executionLane !== "main-legacy" && !run.threadId && !run.turnId &&
  (!!run.activity || ["queued", "starting", "provisioning"].includes(run.status));

/** A retained decision is not fresh permission. Native activity and terminal
 * history win; the server still revalidates positive unsubmitted authority. */
export const hasCurrentRunDecision = (run: BotRun) => run.status === "queued" && run.decision?.state === "required" &&
  !run.turnId && !run.startedAt && !run.finishedAt && !run.activity?.activeTurnId &&
  !["uncertain", "running", "waiting-workers"].includes(run.activity?.state ?? "") && (run.activity?.pendingCount ?? 0) === 0 &&
  (run.activity?.state !== "waiting-input" || run.activity.waitReason === "overdue-decision");
export function validRunState(data: Partial<BotRunStateEvent>, botId: string) {
  return !!data.runId && data.run?.id === data.runId && data.run.botId === botId && !!data.background && (!data.background.botId || data.background.botId === botId) &&
    (!!data.laneId && !!data.threadId || !data.threadId && runNeedsBinding(data.run) && data.run.activity?.activeTurnId === null);
}
