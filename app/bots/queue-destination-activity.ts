"use client";
import { useSyncExternalStore } from "react";
import type { BotAdmissionWork } from "../../lib/bot-work-view";
import { botsClient as client } from "./client";
import { queueDestinationWork } from "./queue-destination-work";

export type QueueActivityScope = {owner: string; botId: string; threadId?: string | null};
/** Observe scope/activity changes without polling or loading a native thread. */
export function queueActivityKey(scope: QueueActivityScope) {
  const bot = client.snapshot?.bots.find(value => value.id === scope.botId);
  const work = client.snapshot?.workByBot?.find(value => value.botId === scope.botId) as BotAdmissionWork | undefined;
  return JSON.stringify([client.owner, client.online, scope.owner, scope.botId, scope.threadId,
    bot?.threadId, bot?.status, bot?.activeTurnId, bot?.queuePaused,
    work?.threadId, work?.state, work?.activeTurnId, work?.paused]);
}
export function useQueueActivity(scope: QueueActivityScope) {
  return useSyncExternalStore(client.subscribe, () => queueActivityKey(scope), () => "");
}
/** A changed snapshot invalidates a read; one bounded reread contains its race. */
export async function readQueueActivity(scope: QueueActivityScope, current: () => boolean) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!current()) throw Error("The account, conversation or draft changed. Nothing new was queued.");
    const key = queueActivityKey(scope);
    const work = await client.rpc<BotAdmissionWork>("work.read", scope.botId, {}, undefined, {owner: scope.owner});
    if (!current()) throw Error("The account, conversation or draft changed. Nothing new was queued.");
    if (key !== queueActivityKey(scope)) continue;
    const bot = client.snapshot?.bots.find(value => value.id === scope.botId);
    return {activity: queueDestinationWork(work, bot), key};
  }
  throw Error("This bot's activity is changing. Nothing new was queued; try Queue again.");
}
