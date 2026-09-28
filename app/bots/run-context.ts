import type { BotRun, BotRunStateEvent } from "../../lib/bots-types";

/** A retained initial run has metadata before it has a native conversation. */
export const runNeedsBinding = (run: BotRun) => run.executionLane !== "main-legacy" && !run.threadId && !run.turnId && !!run.activity;
export function validRunState(data: Partial<BotRunStateEvent>, botId: string) {
  return !!data.runId && data.run?.id === data.runId && data.run.botId === botId && !!data.background && (!data.background.botId || data.background.botId === botId) &&
    (!!data.laneId && !!data.threadId || !data.threadId && runNeedsBinding(data.run) && data.run.activity?.activeTurnId === null);
}
