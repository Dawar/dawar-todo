import type { Bot } from "../../lib/bots-types";
import type { BotAdmissionWork } from "../../lib/bot-work-view";

/** Classify an explicit fresh work.read; cached absence never proves idle. */
export function queueDestinationWork(work: BotAdmissionWork, bot: Bot | undefined) {
  if (!bot || !work || work.botId !== bot.id || work.threadId !== bot.threadId)
    return "unknown";
  if ((work.state === "working" || work.state === "needs-input") &&
      work.activeTurnId && work.activeTurnId === bot.activeTurnId)
    return "working";
  if (work.state === "ready" && work.activeTurnId === null && !bot.activeTurnId &&
      !work.paused && !bot.queuePaused)
    return "idle";
  return "unknown";
}
