import { setAdmissionPause, unreservedRun } from "./run-admission.mjs";

export const SCHEDULE_GRACE_MS = 5 * 60 * 1000;
const now = () => new Date().toISOString();

// Queued is positive local pre-dispatch authority: runDispatch + dispatching
// commit before submitNative. Missing history/rollout is NEVER used as proof.
export function unsentRun(store, run) {
  if (!run || !["queued", "cancelled"].includes(run.status) || run.turnId || run.startedAt ||
      store.operation(run.operationId ?? `schedule:${run.id}`)) return false;
  if (run.executionLane === "main-single" && !run.laneId) {
    const input = store.get("primaryInbox", run.operationId);
    return input?.sourceId === run.id && input.botId === run.botId && input.kind === "schedule" &&
      ["queued", "cancelled"].includes(input.state) && !input.turnId && !input.nativeQueueId && (!input.attemptedAt || input.withdrawal?.removedAt);
  }
  if (!run.laneId) return run.status === "queued" ? unreservedRun(store, run) :
    !run.threadId && !run.executionLane;
  const lane = store.get("runLane", run.laneId);
  if (!lane || lane.runId !== run.id || lane.botId !== run.botId ||
      !["prepared", "bound"].includes(lane.provisioning) || lane.activeTurnId) return false;
  const activity = store.get("runActivity", lane.id);
  if (activity?.activeTurnId || activity?.dispatchOperationId || activity?.dispatchGeneration || activity?.unresolvedTurnId) return false;
  const intake = store.executionMetadata("runIntake", run.botId).filter(r => r.laneId === lane.id);
  if (!intake.some(r => r.primary && r.id === run.operationId) || intake.some(r => r.turnId || r.dispatchFence ||
      (r.state !== "queued" && !(r.state === "rejected" && r.disposition === "cancelled-before-start")))) return false;
  // Use indexed owner/kind metadata, never deserialize retained input bodies.
  for (const kind of ["runDispatch", "runIntakeAttempt", "runTurnEvidence", "runPending", "answerExecution", "answerAttempt", "runActive"])
    if (store.db.prepare("SELECT 1 FROM records WHERE kind=? AND bot_id=? AND json_extract(json,'$.laneId')=? LIMIT 1")
      .get(kind, run.botId, lane.id)) return false;
  for (const kind of ["managerTask", "managerNotice"])
    if (store.db.prepare("SELECT 1 FROM records WHERE kind=? AND bot_id=? AND json_extract(json,'$.destination.laneId')=? LIMIT 1")
      .get(kind, run.botId, lane.id)) return false;
  return true;
}

export const occurrenceTime = run => run.decision?.state === "start-approved" ? run.decision.decidedAt :
  run.decision?.state === "rescheduled" ? run.decision.notBefore : run.scheduledAt;

export function occurrenceReady(run, time = Date.now()) {
  if (!run) return false;
  const at = Date.parse(occurrenceTime(run));
  return run.status === "queued" && run.decision?.state !== "required" &&
    Number.isFinite(at) && at <= time && time - at <= SCHEDULE_GRACE_MS;
}

export class ScheduleDecisions {
  constructor(runtime) { this.runtime = runtime; this.store = runtime.store; }
  publish(run) {
    this.runtime.emitEvent("schedules", {}, run.botId);
    if (run.laneId) this.runtime.runs.publish(run.laneId);
    else this.runtime.emitEvent("run.state", { runId: run.id, laneId: null, threadId: null,
      run: this.runtime.publicRun(run), background: this.runtime.runs.counts(run.botId) }, run.botId);
  }
  ensure(runId, time = Date.now()) {
    let run = this.store.get("run", runId);
    if (!run || run.status !== "queued") return run;
    const at = Date.parse(occurrenceTime(run));
    if (run.decision?.state === "required" || at > time) {
      const lane = run.laneId && this.store.get("runLane", run.laneId);
      // Repair an earlier stale admission once, without changing the decision
      // revision/receipt or claiming native idle. Real execution is excluded.
      if (lane && lane.admitted !== false && unsentRun(this.store, run)) this.store.transaction(() => {
        this.store.put("runLane", { ...lane, admitted: false });
        this.publish(run);
      });
      return run;
    }
    if (!unsentRun(this.store, run)) return run;
    if (Number.isFinite(at) && time - at <= SCHEDULE_GRACE_MS) return run;
    this.store.transaction(() => {
      run = this.store.get("run", runId);
      if (!unsentRun(this.store, run) || run.status !== "queued") return;
      const revision = (run.decision?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error("Schedule decision revision exhausted.");
      run = this.store.put("run", { ...run, decision: { id: `overdue:${run.id}`, revision, state: "required",
        reason: "missed-start", scheduledAt: run.scheduledAt, requestedAt: now(), graceMs: SCHEDULE_GRACE_MS,
        notBefore: null, decidedAt: null, operationId: null } });
      if (run.laneId) this.store.put("runLane", { ...this.store.get("runLane", run.laneId), admitted: false });
      this.publish(run);
    });
    return run;
  }
  retireCancelled(runId) {
    const run = this.store.get("run", runId);
    if (run?.status !== "cancelled" || !unsentRun(this.store, run)) return false;
    const lane = run.laneId && this.store.get("runLane", run.laneId);
    if (run.cancelledPreparationAt) return true;
    this.store.transaction(() => {
      this.store.put("run", { ...run, cancelledPreparationAt: now() });
      if (run.executionLane === "main-single") {
        const input = this.store.get("primaryInbox", run.operationId);
        if (input) this.store.put("primaryInbox", { ...input, state: "cancelled", error: null });
      }
      setAdmissionPause(this.store, run, true, run.decision?.operationId ?? `cancelled:${run.id}`);
      if (lane) {
        for (const input of this.store.executionMetadata("runIntake", run.botId).filter(r => r.laneId === lane.id && r.state === "queued")) {
          this.store.put("runIntake", { ...this.store.get("runIntake", input.id), state: "rejected",
            disposition: "cancelled-before-start", error: "Cancelled before native submission; original input retained." });
          if (!input.primary) {
            const receipt = this.store.get("runTurn", input.id);
            if (receipt) this.store.put("runTurn", { ...receipt, status: "cancelled", finishedAt: now() });
          }
        }
        this.store.put("runLane", { ...lane, paused: true, pauseRevision: (lane.pauseRevision ?? 0) + 1,
          admitted: false, retiredBeforeStartAt: now(), reconcileAfter: null });
      }
      this.publish(this.store.get("run", run.id));
    });
    return true;
  }
  refresh() {
    for (const run of this.store.list("run")) {
      if (run.status === "cancelled") this.retireCancelled(run.id);
      else if (run.status === "queued") this.ensure(run.id);
    }
  }
  decide(bot, params, operationId) {
    let run = this.runtime.owned("run", params.runId, bot.id);
    if (run.status !== "queued" || !Number.isSafeInteger(params.expectedRevision) || params.expectedRevision !== run.decision?.revision ||
        run.decision.state !== "required") throw new Error("This schedule decision changed. Refresh before choosing again.");
    if (!unsentRun(this.store, run)) throw new Error("This occurrence may already have been dispatched. Its original execution must reconcile; nothing was restarted.");
    if (!["start", "reschedule", "cancel"].includes(params.choice)) throw new Error("Choose Start now, Reschedule, or Cancel.");
    const at = Date.parse(params.at);
    if (params.choice === "reschedule" && (typeof params.at !== "string" || !/(?:Z|[+-]\d{2}:\d{2})$/.test(params.at) ||
        !Number.isFinite(at) || at < Date.now() + 60000 || at > Date.now() + 366 * 86400000))
      throw new Error("Choose a time at least one minute ahead and within the next year.");
    const decision = { ...run.decision, revision: run.decision.revision + 1, operationId, decidedAt: now(),
      state: params.choice === "start" ? "start-approved" : params.choice === "cancel" ? "cancelled" : "rescheduled",
      notBefore: params.choice === "reschedule" ? new Date(at).toISOString() : null };
    if (!Number.isSafeInteger(decision.revision)) throw new Error("Schedule decision revision exhausted.");
    run = this.store.put("run", { ...run, decision, ...(params.choice === "cancel" ? { status: "cancelled", finishedAt: now() } : {}) });
    if (params.choice === "cancel") this.retireCancelled(run.id);
    else if (run.laneId) this.store.put("runLane", { ...this.store.get("runLane", run.laneId), reconcileAfter: null });
    this.publish(run);
    return { operationId, run: this.runtime.publicRun(run) };
  }
  list(bot, params) {
    const limit = params.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid schedule decision page size.");
    let before = Number.MAX_SAFE_INTEGER;
    if (params.cursor != null) {
      try {
        if (typeof params.cursor !== "string" || params.cursor.length > 2048) throw new Error();
        const c = JSON.parse(Buffer.from(params.cursor, "base64url").toString());
        if (c.botId !== bot.id || !Number.isSafeInteger(c.before) || c.before < 1) throw new Error();
        before = c.before;
      } catch { throw new Error("Invalid schedule decision cursor."); }
    }
    const rows = this.store.db.prepare("SELECT rowid,json FROM records WHERE kind='run' AND bot_id=? AND json_extract(json,'$.status')='queued' AND json_extract(json,'$.decision.state')='required' AND rowid<? ORDER BY rowid DESC LIMIT ?")
      .all(bot.id, before, limit + 1);
    return { runs: rows.slice(0, limit).map(row => {
      const run = this.runtime.publicRun(JSON.parse(row.json));
      delete run.prompt;
      delete run.selectedContext;
      return run;
    }), nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ botId: bot.id, before: rows[limit - 1].rowid })).toString("base64url") : null };
  }
}
