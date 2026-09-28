import type { BotRun, BotRunStateEvent } from "../../lib/bots-types";

/** Queued admission precedes both native IDs and optional activity metadata.
 * Unknown historical targets still go through the authoritative resolver. */
export const runNeedsBinding = (run: BotRun) => run.executionLane !== "main-legacy" && !run.threadId && !run.turnId &&
  (!!run.activity || ["queued", "starting", "provisioning"].includes(run.status));
export function validRunState(data: Partial<BotRunStateEvent>, botId: string) {
  return !!data.runId && data.run?.id === data.runId && data.run.botId === botId && !!data.background && (!data.background.botId || data.background.botId === botId) &&
    (!!data.laneId && !!data.threadId || !data.threadId && runNeedsBinding(data.run) && data.run.activity?.activeTurnId === null);
}
