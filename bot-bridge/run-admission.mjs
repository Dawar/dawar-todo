// Admission intent is independent of main pause and exists before a run lane.
// Only Stop/Resume change its revision. Awaited preparation cannot cross one
// of those transitions using an earlier authority token.
export function unreservedRun(store, run) {
  return run?.status === "queued" && !run.executionLane && !run.laneId &&
    !run.threadId && !run.turnId && !store.operation(`schedule:${run.id}`);
}

export const admissionRevision = (store, runId) => store.get("runAdmission", runId)?.revision ?? 0;
export const admissionPaused = (store, runId) => store.get("runAdmission", runId)?.paused === true;
export const admissionOpen = (store, runId, revision) =>
  !admissionPaused(store, runId) && admissionRevision(store, runId) === revision;

export function setAdmissionPause(store, run, paused, operationId) {
  const prior = store.get("runAdmission", run.id);
  const revision = (prior?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error("Run admission revision exhausted.");
  return store.put("runAdmission", { ...prior, id: run.id, botId: run.botId,
    revision, paused, operationId, updatedAt: new Date().toISOString() });
}

export function beginPreparation(store, run, revision) {
  if (!unreservedRun(store, store.get("run", run.id)) || !admissionOpen(store, run.id, revision)) return false;
  store.put("runAdmission", { ...store.get("runAdmission", run.id), id: run.id, botId: run.botId,
    revision, paused: false, preparingRevision: revision });
  return true;
}

export function finishPreparation(store, runId, revision) {
  const current = store.get("runAdmission", runId);
  if (current?.preparingRevision === revision)
    store.put("runAdmission", { ...current, preparingRevision: null });
}
