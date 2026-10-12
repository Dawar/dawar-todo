'use client';
import type { ThreadGoal } from '../../lib/codex-protocol/v2/ThreadGoal';
import type { TimelineState } from './timeline-controller';
import { goalWorkPlans } from './goal-work-plans';
import { WorkPlanMessage } from './message';
import { useBotTimelineSnapshot } from './use-timeline';

export function GoalWorkPlansView({ goal, state, botId, activeTurnId, online }: {
  goal: ThreadGoal; state: TimelineState; botId: string; activeTurnId?: string | null; online: boolean;
}) {
  const plans = goalWorkPlans(goal, state.entries, state.contextEntries);
  return <section className="bots-goal-progress" aria-label="Conversation work plans">
    <h4>Work plans</h4>
    <p className="bots-goal-description">Recent conversation plans since this goal began. Steps describe individual turns.</p>
    {!online && <p className="bots-goal-observation">Offline · saved plans</p>}
    {!plans.length ? <p className="bots-goal-description">{state.loading ? 'Loading conversation…' : 'No work plan available in the loaded conversation.'}</p> : plans.map((entry, index) => {
      const plan = entry.workPlan!;
      const status = entry.turnStatus ?? entry.status;
      const current = online && entry.turnId === activeTurnId && status === 'inProgress';
      const start = entry.turnStartedAt ?? entry.startedAt;
      return <details key={entry.turnId} className="bots-goal-plan" open={index === plans.length - 1 ? true : undefined}>
        <summary><span>{current ? 'Current turn' : status === 'completed' ? 'Finished turn' : status === 'failed' ? 'Failed turn' : status === 'interrupted' ? 'Interrupted turn' : 'Last recorded plan'}</span><small>{plan.completedSteps} of {plan.totalSteps} steps completed</small></summary>
        {start !== null && start !== undefined && <time className="bots-goal-observation" dateTime={new Date(start * 1000).toISOString()}>{new Date(start * 1000).toLocaleString()}</time>}
        <WorkPlanMessage plan={plan} botId={botId} attachments={state.attachments} turnStatus={status}/>
      </details>;
    })}
    {!!plans.length && <p className="bots-goal-observation">Up to five loaded plans. Goal completion is tracked separately.</p>}
  </section>;
}

export function GoalWorkPlans({ owner, botId, ...props }: Omit<Parameters<typeof GoalWorkPlansView>[0], 'state'> & { owner: string }) {
  // Subscribe to the conversation's existing store. Opening Goals adds no
  // history requests, polling, model turns, or second cache/hydration path.
  const state = useBotTimelineSnapshot(owner, botId);
  return <GoalWorkPlansView {...props} botId={botId} state={state}/>;
}
