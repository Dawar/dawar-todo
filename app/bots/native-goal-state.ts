import type { ThreadGoal } from '../../lib/codex-protocol/v2/ThreadGoal';
import type { BotSnapshot, Bot } from './single-thread-contract';
import type { BotAdmissionWork } from '../../lib/bot-work-view';

export const goalLabels = { active: 'Active', paused: 'Paused', blocked: 'Blocked', usageLimited: 'Usage limited', budgetLimited: 'Budget limited', complete: 'Complete' };
export const GOAL_STALE_MS = 5 * 60_000;
export function validGoal(value: unknown, threadId: string): value is ThreadGoal {
  if (!value || typeof value !== 'object') return false;
  const goal = value as ThreadGoal;
  return goal.threadId === threadId && typeof goal.objective === 'string' && !!goal.objective.trim() && Object.hasOwn(goalLabels, goal.status) &&
    (goal.tokenBudget === undefined || goal.tokenBudget === null || Number.isSafeInteger(goal.tokenBudget) && goal.tokenBudget > 0) &&
    ['tokensUsed', 'timeUsedSeconds', 'createdAt', 'updatedAt'].every(key => goal[key as keyof ThreadGoal] === undefined || typeof goal[key as keyof ThreadGoal] === 'number' && Number.isFinite(goal[key as keyof ThreadGoal]) && Number(goal[key as keyof ThreadGoal]) >= 0);
}
export function scopedGoalWork(bot: Bot, work?: BotAdmissionWork) {
  // Older snapshots omit the additive work thread binding. An existing native
  // goal carries its own exact thread identity; an empty unbound observation
  // cannot establish that a replacement thread has no goal.
  return work?.botId === bot.id && (work.threadId === bot.threadId || !work.threadId && work.goal?.threadId === bot.threadId) ? work : undefined;
}
export function goalObservation(bot: Bot, work?: BotAdmissionWork, now = Date.now()) {
  const scoped = scopedGoalWork(bot, work), observed = Date.parse(scoped?.goalObservedAt ?? '');
  const known = Boolean(scoped && Number.isFinite(observed) && observed <= now + 60_000 && (scoped.goal === null || validGoal(scoped.goal, bot.threadId ?? '')));
  return { goal: known ? scoped!.goal : null, known, observedAt: known ? scoped!.goalObservedAt : null, stale: !known || now - observed > GOAL_STALE_MS };
}
/** A local dispatch fence; no native load or goal mutation to discover state. */
export function goalControlBlock(snapshot: BotSnapshot | null | undefined, bot: Bot, online: boolean, now = Date.now()) {
  if (!online) return 'Reconnect to manage this goal.';
  if (snapshot?.capabilities?.nativeGoals !== 1 || bot.executionMode !== 'single-thread') return 'Native goal controls are unavailable on this service.';
  if (!bot.threadId || bot.archived || bot.deletedAt || ['provisioning', 'error'].includes(bot.status)) return 'Confirm this conversation is ready before changing its goal.';
  const work = scopedGoalWork(bot, snapshot.workByBot?.find(value => value.botId === bot.id));
  if (!work || ['unconfirmed', 'starting'].includes(work.state)) return 'Confirm current execution before changing its goal.';
  if (bot.queuePaused || work.paused) return 'Automatic work is paused. Native goal Resume does not resume automatic intake.';
  if (bot.mode === 'plan') return 'Finish or leave Plan before changing the goal.';
  if (work.state === 'needs-input' || snapshot.pending.some(item => item.botId === bot.id)) return 'Resolve the current input request before changing the goal.';
  if (goalObservation(bot, work, now).stale) return 'Refresh the native goal before changing it.';
  return null;
}
export function goalScope(threadId: string | null | undefined) { return `native-goal:${threadId ?? ''}`; }
export function goalFingerprint(bot: Bot, work?: BotAdmissionWork) { return JSON.stringify([bot.threadId, scopedGoalWork(bot, work)?.goal, scopedGoalWork(bot, work)?.goalObservedAt]); }
export function goalTime(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return 'Unavailable';
  const value = Math.floor(seconds);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
}
