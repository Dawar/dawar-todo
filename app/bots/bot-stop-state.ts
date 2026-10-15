import type { Bot } from "../../lib/bots-types";

export const botWorking = (bot: Bot) => Boolean(bot.activeTurnId || bot.status === "running" || bot.workerTasks?.active);

/**
 * Stopped is the bridge's own queue/work pause (set by Stop, cleared by
 * Resume), never inferred. Active work wins; idle, errored, interrupted
 * history and a paused native Goal alone are not stopped.
 */
export const botStopped = (bot: Bot) => !botWorking(bot) && !bot.archived && bot.queuePaused === true;
