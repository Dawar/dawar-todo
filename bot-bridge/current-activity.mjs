import { usableTurn } from "./native-turn.mjs";
import { nativeRecoveryKind } from '../lib/native-recovery.ts';
import { captureActivity, activityUnchanged, activityUnresolved, requireCurrentActivity,
  projectCurrentActive, projectCurrentIdle } from "./turn-state.mjs";
import { recoveryDelay } from './native-error-recovery.mjs';

// Called under the main bot lock (or before startup readiness). Receipt/history
// lookup cannot release this barrier: only current native status + a fence can.
export async function reconcileCurrentActivity(runtime, botId) {
  const bot = runtime.store.bot(botId);
  const before = runtime.store.get('botActivity', botId);
  const recovery = runtime.nativeErrorRecovery?.get(botId);
  // Admission, startup and the background reader share the same durable due
  // time. Repeated queue attempts cannot turn a cooldown into a retry storm.
  const due = recovery?.threadId === bot.threadId && recovery.nextRetryAt || before?.reconcileAfter;
  if (activityUnresolved(runtime,botId) && Date.parse(due ?? '') > Date.now()) return false;
  requireCurrentActivity(runtime, botId, null, "checking-current-native-state");
  const token = captureActivity(runtime, botId);
  const deadline=Date.now()+20000;
  const call=(method,params,tracking=null)=>{
    const left=deadline-Date.now();
    if(left<1)throw Object.assign(Error('The bounded recovery observation expired.'),{recoveryNotSubmitted:true});
    return runtime.codex.call(method,params,Math.min(12000,left),tracking);
  };
  call.remainingMs=()=>Math.max(0,deadline-Date.now());
  try {
    if (!bot.threadId || bot.archived) throw new Error("Restore a provisioned bot before checking native activity.");
    let resumed = false;
    if (!runtime.loaded.has(bot.threadId) && !runtime.nativeErrorRecovery?.waiting(botId)) {
      resumed = true;
      await runtime.load(bot);
    }
    const read = async () => {
      const { thread } = await call("thread/read", { threadId: bot.threadId, includeTurns: false });
      if (thread?.id !== bot.threadId || !["idle", "active", "notLoaded", "systemError"].includes(thread.status?.type))
        throw new Error("Native current activity is unavailable; no conflicting input was sent.");
      return thread;
    };
    await runtime.nativeErrorRecovery?.awaitUnload(botId,token,call);
    let initial = await read();
    if (initial.status.type === 'systemError') {
      if (runtime.nativeErrorRecovery) await runtime.nativeErrorRecovery.systemError(botId,token,read,call);
      throw new Error('Codex reports a thread system error; input remains contained until native recovery.');
    }
    if(runtime.nativeErrorRecovery?.waiting(botId) && initial.status.type==='active')
      throw new Error('Native work is active; recovery will wait for a safe same-thread resubscription.');
    if (runtime.nativeErrorRecovery?.waiting(botId) && ['notLoaded','idle'].includes(initial.status.type)) {
      await runtime.nativeErrorRecovery.resume(botId,token,read,initial.status.type,call);
      resumed = true;
      initial = await read();
    }
    if (initial.status.type === "notLoaded") {
      // A current notLoaded overrides the cache, but a stale response cannot
      // force a resume after a newer native start. At most one resume per pass.
      if (!activityUnchanged(runtime, botId, token)) {
        if (!activityUnresolved(runtime, botId)) return true;
        throw new Error("Native activity changed before load recovery. Containment was retained.");
      }
      runtime.loaded.delete(bot.threadId);
      if (!resumed) {
        await runtime.load(bot);
        initial = await read();
      }
    }
    if (initial.status.type === "notLoaded") {
      if (activityUnchanged(runtime, botId, token)) runtime.loaded.delete(bot.threadId);
      throw new Error("Native thread is still not loaded after resume; current-state recovery will retry.");
    }
    let page = null, pageError = null;
    try {
      // No full history/items hydration. One newest metadata page bounds work.
      page = await call("thread/turns/list", {
        threadId: bot.threadId, cursor: null, limit: 25, sortDirection: "desc", itemsView: "notLoaded",
      });
    } catch (error) { pageError = error; }
    // Read status again after the turn metadata. An explicit current idle is
    // sufficient even if historical metadata is temporarily unreadable.
    const current = await read();
    if (!activityUnchanged(runtime, botId, token)) {
      if (!activityUnresolved(runtime, botId)) return true; // A newer native start established identity.
      throw new Error("Native activity changed during the current-state read. Containment was retained.");
    }
    if (current.status.type === "notLoaded") {
      runtime.loaded.delete(bot.threadId);
      throw new Error("Native thread unloaded during reconciliation; current-state recovery will retry.");
    }
    const turns = Array.isArray(page?.data) ? page.data : [];
    if (current.status.type === "idle") {
      const settled=projectCurrentIdle(runtime, botId, token, turns[0]);
      if(settled)runtime.nativeErrorRecovery?.complete(botId);
      return settled;
    }
    if (initial.status.type !== "active" || pageError || turns[0]?.status !== "inProgress" ||
        !usableTurn(turns[0]) ||
        turns.filter(turn => turn?.status === "inProgress").length !== 1)
      throw new Error("Native thread is busy, but its current turn is not yet identified. Input remains contained.");
    const established = runtime.store.transaction(() => {
      if (!projectCurrentActive(runtime, botId, turns[0], token, current.status)) return false;
      runtime.recordScheduledEvidence(botId, turns[0]);
      return !activityUnresolved(runtime, botId);
    });
    if (!established && activityUnchanged(runtime, botId, token))
      throw new Error("Current native turn conflicts with retained terminal evidence. Input remains contained pending another read.");
    if(established && runtime.nativeErrorRecovery?.get(botId)?.failedTurnId!==turns[0].id)
      runtime.nativeErrorRecovery?.complete(botId);
    return established || !activityUnresolved(runtime, botId);
  } catch (error) {
    const state = runtime.store.get("botActivity", botId);
    if (!state?.unresolved) return true;
    const attempts = (state.attempts ?? 0) + 1;
    const checkedAt = new Date().toISOString();
    const recovery = runtime.nativeErrorRecovery?.failed(botId,error);
    runtime.store.put("botActivity", { ...state, attempts, reconciliationError: error.message,
      recoveryKind: nativeRecoveryKind(error), recoveryCheckedAt: checkedAt,
      reconcileAfter: recovery?.nextRetryAt ?? new Date(Date.now() + (runtime.currentActivityRetryDelay?.(attempts) ?? recoveryDelay(attempts))).toISOString() });
    runtime.primary?.publish(botId);
    return false;
  }
}

// The same durable due time reconcileCurrentActivity honours: a native error
// recovery's nextRetryAt for the current thread, else the activity backoff.
function dueAt(runtime, state) {
  const recovery = runtime.nativeErrorRecovery?.get(state.botId);
  return recovery?.threadId === runtime.store.bot(state.botId).threadId && recovery.nextRetryAt || state.reconcileAfter;
}

export async function recoverCurrentActivities(runtime, limit = 2, startup = false, eligible = () => true) {
  let checked = 0;
  const due = runtime.store.list("botActivity").filter(state => activityUnresolved(runtime, state.botId))
    .sort((a, b) => (dueAt(runtime, a) ?? "").localeCompare(dueAt(runtime, b) ?? "") || a.id.localeCompare(b.id));
  for (const state of due) {
    if (checked >= limit) break;
    if (runtime.locks.has(state.botId) || runtime.store.bot(state.botId).archived || !eligible(state.botId) ||
        (!startup && Date.parse(dueAt(runtime, state) ?? "") > Date.now())) continue;
    checked++;
    await runtime.lock(state.botId, () => activityUnresolved(runtime, state.botId)
      ? reconcileCurrentActivity(runtime, state.botId) : undefined);
  }
}
