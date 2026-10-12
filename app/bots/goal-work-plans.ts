import type { HistoryEntry } from '../../lib/bot-history-view';
import type { ThreadGoal } from '../../lib/codex-protocol/v2/ThreadGoal';

/** Loaded native plans in this conversation since the goal began. Native plans
 * have turn IDs, not goal IDs: never infer a goal milestone or completion. */
export function goalWorkPlans(goal: ThreadGoal, entries: HistoryEntry[], context: HistoryEntry[] = []) {
  if (!Number.isFinite(goal.createdAt) || goal.createdAt <= 0) return [];
  const turns = new Map<string, HistoryEntry>();
  for (const entry of [...context, ...entries]) {
    const start = entry.turnStartedAt ?? entry.startedAt;
    if (!entry.workPlan || entry.sourceThreadId !== goal.threadId ||
      typeof start !== 'number' || !Number.isFinite(start) || start > 8_640_000_000_000 || start < goal.createdAt) continue;
    const prior = turns.get(entry.turnId);
    if (!prior || (entry.updatedSeq ?? 0) >= (prior.updatedSeq ?? 0)) turns.set(entry.turnId, entry);
  }
  return [...turns.values()].sort((a, b) => (a.turnStartedAt ?? a.startedAt ?? 0) - (b.turnStartedAt ?? b.startedAt ?? 0) || a.turnId.localeCompare(b.turnId)).slice(-5);
}
