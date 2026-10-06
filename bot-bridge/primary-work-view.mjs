import { observedActiveTurn, nativeWaiting, pendingQuestions } from './turn-state.mjs';

// Display metadata only. Native execution and the original intake ledger remain
// authoritative; these reads never load a thread or submit/replay its input.
export function primaryWorkView(runtime, bot) {
  const store = runtime.store, progress = store.get('botWork', bot.id), goal = store.get('nativeGoal', bot.id);
  const activity = store.get('botActivity', bot.id);
  const inflight = activity?.unresolved && activity.reason === 'native-start-in-flight' &&
    [...runtime.codex.pending.values()].some(call => call.threadId === bot.threadId && ['turn/start', 'turn/steer', 'thread/queue/add'].includes(call.method));
  // One aggregate row, no message bodies or unbounded inbox array in snapshots.
  const intake = store.db.prepare(`SELECT
    COALESCE(MAX(json_extract(json,'$.state')='uncertain'),0) AS uncertain,
    COALESCE(MAX(json_extract(json,'$.state')='dispatching'),0) AS dispatching,
    COALESCE(MAX(json_extract(json,'$.state')='accepted' AND
      COALESCE(json_extract(json,'$.threadId'),'')<>?),0) AS bindingUnconfirmed,
    COALESCE(SUM(json_extract(json,'$.state')='accepted'
      AND json_extract(json,'$.turnId') IS NULL),0) AS waitingCount
    FROM records WHERE kind='primaryInbox' AND bot_id=?
      AND json_extract(json,'$.state') NOT IN ('cancelled','failed')
      AND json_extract(json,'$.terminalStatus') IS NULL`).get(bot.threadId, bot.id);
  const unconfirmed = runtime.activityUnresolved(bot.id) && !inflight || Boolean(intake.bindingUnconfirmed || intake.uncertain || intake.dispatching && !inflight);
  const active = observedActiveTurn(runtime, bot.id, bot.activeTurnId);
  const nativeInput = nativeWaiting(runtime, bot.id), questions = pendingQuestions(runtime, bot.id);
  const needsInput = nativeInput || questions.length > 0;
  const paused = Boolean(bot.queuePaused);
  const state = needsInput ? 'needs-input' : active ? 'working' : unconfirmed ? 'unconfirmed' : inflight ? 'starting' : paused ? 'paused' : intake.waitingCount ? 'waiting' : 'ready';
  const reason = needsInput ? 'Waiting for input before automatic work can start.' : unconfirmed ? 'Execution or original delivery needs confirmation.' :
    paused ? 'Automatic work is paused.' : active ? 'Waiting for the current turn to finish.' : inflight ? 'A native submission is awaiting confirmation.' :
      'Native turn start is not yet confirmed.';
  return { botId: bot.id, threadId: bot.threadId, executionMode: bot.executionMode ?? 'legacy', state,
    activeTurnId: bot.activeTurnId, activeNeedsInput: Boolean(active && (nativeInput || questions.some(p => p.request.params.turnId === bot.activeTurnId))),
    paused, summary: progress?.summary ?? goal?.goal?.objective ?? null,
    remaining: progress?.remaining ?? null, waitingFor: progress?.waitingFor ?? [], goal: goal?.goal ?? null,
    goalObservedAt: goal?.observedAt ?? null, migrationReason: bot.migrationReason ?? null,
    admission: { waitingCount: intake.waitingCount, reason: intake.waitingCount ? reason : null } };
}

export function primaryInboxItemView(runtime, row) {
  const { id, botId, threadId, kind, sourceId, summary, createdAt, turnId, state } = row;
  const bot = runtime.store.bot(botId);
  let waitReason = row.error ?? (state === 'uncertain' ? 'Original native delivery is unconfirmed.' : null);
  if (state === 'accepted') {
    if (threadId !== bot.threadId) waitReason = 'Original thread binding needs confirmation.';
    else if (turnId && observedActiveTurn(runtime, botId, turnId)) {
      const needsInput = nativeWaiting(runtime, botId) || pendingQuestions(runtime, botId).some(p => p.request.params.turnId === turnId);
      waitReason = needsInput ? 'Needs your input' : 'Working';
    } else if (turnId || runtime.activityUnresolved(botId)) waitReason ??= 'Execution needs confirmation.';
    else if (bot.queuePaused) waitReason ??= 'Accepted · automatic work is paused.';
    else waitReason ??= 'Accepted · waiting to start.';
  } else if (state === 'dispatching') waitReason ??= 'Original delivery is awaiting confirmation.';
  return { id, botId, threadId, kind, sourceId, summary, createdAt, turnId, state, waitReason };
}
