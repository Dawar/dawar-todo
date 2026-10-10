import type { Bot } from "../../lib/bots-types";
import type { BotAdmissionWork } from "../../lib/bot-work-view";

/** Classify an explicit fresh work.read; cached absence never proves idle. */
export function queueDestinationWork(work: BotAdmissionWork, bot: Bot | undefined) {
  if (!bot || bot.archived || !bot.threadId || !work || !work.threadId || work.botId !== bot.id || work.threadId !== bot.threadId)
    return "unknown";
  if (!work.paused && !bot.queuePaused && (work.state === "working" || work.state === "needs-input") &&
      work.activeTurnId && work.activeTurnId === bot.activeTurnId)
    return "working";
  if (work.state === "ready" && work.activeTurnId === null && !bot.activeTurnId &&
      !work.paused && !bot.queuePaused && bot.status === "idle")
    return "idle";
  return "unknown";
}
