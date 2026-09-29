import { captureActivity, activityUnchanged, requireCurrentActivity } from './turn-state.mjs';

// Resume rejoins a subscribed native session without applying overrides. Only
// the native idle/no-subscriber rebuild (or a cold resume) applies this config.
// Session IDs survive that rebuild and are deliberately NOT used as evidence.
export async function configurePrimary(primary, bot) {
  const runtime = primary.runtime;
  return runtime.lock(`load:${bot.threadId}`, async () => {
    const token = captureActivity(runtime, bot.id);
    const cursor = primary.migrationCursor(bot.id);
    const queue = await runtime.codex.call('thread/queue/list', { threadId: bot.threadId, limit: 100, cursor: null });
    const goalResult = await runtime.codex.call('thread/goal/get', { threadId: bot.threadId });
    if (!goalResult || !Object.hasOwn(goalResult, 'goal') || goalResult.goal && (goalResult.goal.threadId !== bot.threadId || !['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'].includes(goalResult.goal.status)))
      return 'Native goal state is not confirmed for the original thread.';
    const { goal } = goalResult;
    const { thread } = await runtime.codex.call('thread/read', { threadId: bot.threadId, includeTurns: false });
    if (!Array.isArray(queue?.data) || queue.data.length || queue.nextCursor !== null || goal?.status === 'active') return 'Native queued work or an active goal must settle before configuration migration.';
    if (thread?.id !== bot.threadId || thread.status?.type !== 'idle' || thread.canAcceptDirectInput !== true)
      return 'The original native thread is not confirmed idle and directly configurable.';
    if (!activityUnchanged(runtime, bot.id, token) || primary.migrationCursor(bot.id) !== cursor || primary.migrationBlock(runtime.store.bot(bot.id)))
      return 'Activity changed before native configuration migration.';

    const proof = { threadId: bot.threadId, unloaded: false };
    primary.configuring.set(bot.id, proof);
    runtime.loaded.delete(bot.threadId);
    try {
      const detached = await runtime.codex.call('thread/unsubscribe', { threadId: bot.threadId });
      if (!['unsubscribed', 'notSubscribed', 'notLoaded'].includes(detached?.status)) throw new Error('Native subscription release was not acknowledged.');
      // An unsubscribe ACK alone is never evidence of unloading. NotLoaded is
      // affirmative native evidence; ordinary unsubscribe needs the separate
      // notLoaded/closed notification emitted by idle teardown during resume.
      proof.unloaded ||= detached.status === 'notLoaded';
      const before = await runtime.codex.call('thread/read', { threadId: bot.threadId, includeTurns: false });
      if (before.thread?.id !== bot.threadId || !['idle', 'notLoaded'].includes(before.thread.status?.type))
        throw new Error('Native activity changed while releasing the subscription.');
      proof.unloaded ||= before.thread.status.type === 'notLoaded';
      if (!activityUnchanged(runtime, bot.id, token) || primary.migrationBlock(runtime.store.bot(bot.id)))
        throw new Error('Activity changed before native reconfiguration.');
      const response = await runtime.codex.call('thread/resume', runtime.resumeParams(bot, 'single-thread'));
      if (response?.thread?.id !== bot.threadId) throw new Error('Native resume did not confirm the original thread.');
      runtime.loaded.add(bot.threadId);
      if (!proof.unloaded) return 'Native session stayed loaded: another subscriber, active work, or incomplete shutdown prevented applying direct configuration. Migration will retry when idle.';

      // Confirm the loaded thread's session feature layers, not the process
      // default. Bound pagination and fail closed on missing/partial evidence.
      let feature = null, featureCursor = null;
      const cursors = new Set();
      for (let page = 0; page < 4; page++) {
        const result = await runtime.codex.call('experimentalFeature/list', { threadId: bot.threadId, limit: 100, cursor: featureCursor });
        if (!Array.isArray(result?.data) || result.nextCursor !== null && typeof result.nextCursor !== 'string') throw new Error('Native feature evidence is incomplete.');
        feature = result.data.find(f => f.name === 'multi_agent') ?? feature;
        if (!result.nextCursor) break;
        if (cursors.has(result.nextCursor) || page === 3) throw new Error('Native feature evidence did not finish within its bound.');
        cursors.add(result.nextCursor); featureCursor = result.nextCursor;
      }
      if (feature?.enabled !== false) return 'Native anonymous-worker capability is not confirmed disabled; direct mode remains unavailable.';
      const final = await runtime.codex.call('thread/read', { threadId: bot.threadId, includeTurns: false });
      if (final.thread?.id !== bot.threadId || final.thread.status?.type !== 'idle' || !activityUnchanged(runtime, bot.id, token) || primary.migrationBlock(runtime.store.bot(bot.id)))
        return 'Activity changed during native configuration migration; mode remains legacy.';
      runtime.store.put('executionMigration', { ...runtime.store.get('executionMigration', bot.id), id: bot.id, botId: bot.id,
        nativeConfiguredAt: new Date().toISOString(), threadId: bot.threadId, evidence: 'idle-teardown-resume-feature-confirmation' });
      return token;
    } catch (error) {
      // Restore the original subscription through ordinary bounded current
      // recovery. Never create a replacement thread or repeat an input.
      runtime.loaded.delete(bot.threadId);
      requireCurrentActivity(runtime, bot.id, null, 'configuration-migration-needs-current-state');
      return `Original native configuration is not confirmed: ${error.message}`;
    } finally { primary.configuring.delete(bot.id); }
  });
}
