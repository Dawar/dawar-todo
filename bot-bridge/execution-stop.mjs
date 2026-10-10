import { terminalTurn, usableTurnId } from "./native-turn.mjs";
import { unreservedRun, setAdmissionPause } from "./run-admission.mjs";

const now = () => new Date().toISOString();
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);

// A Stop receipt owns an immutable set of executions, never a reusable worker
// identity. Unknown IDs stay contained until that exact receipt is identified.
export async function stopExecutions(runtime, bot, operationId, scope, runId = null) {
  if (!["main", "all", "run"].includes(scope)) throw new Error("Choose main, run or all stop scope.");
  let stop = runtime.store.get("executionStop", operationId);
  if (!stop) stop = runtime.store.transaction(() => {
    const targets = [];
    const lanes = runtime.store.executionMetadata("runLane", bot.id).filter(l => scope === "all" || scope === "run" && l.runId === runId);
    if (scope === "run" && lanes.length !== 1) throw new Error("Run stop target is unavailable.");
    // Capture once, in the same commit as the stop receipt. This also sees a
    // queued run whose reservation is currently awaiting profile/filesystem IO.
    const runIds = new Set(lanes.map(lane => lane.runId));
    if (scope === "all") for (const run of runtime.store.list("run", bot.id))
      if (unreservedRun(runtime.store, run)) runIds.add(run.id);
    const runPauses = [...runIds].map(id => {
      const pause = setAdmissionPause(runtime.store, runtime.store.get("run", id), true, operationId);
      return { runId: id, revision: pause.revision };
    });
    if (scope !== "run") {
      const current = runtime.store.bot(bot.id), activity = runtime.store.get("botActivity", bot.id);
      runtime.saveBot(current, { queuePaused: true, ...(scope === "all" ? { managerPaused: true } : {}) });
      if (runtime.primary?.single(current)) {
        runtime.bursts.pause(bot.id);
        for (const item of runtime.primary.openItems(bot.id))
          if (["dispatching", "uncertain", "accepted"].includes(item.state) && !item.terminalStatus)
            targets.push({ kind: "main", threadId: bot.threadId, turnId: item.turnId ?? null, intakeId: item.id, state: "queued" });
        for (const item of runtime.store.list("promptQueue", bot.id))
          if (["dispatching", "uncertain", "native-queued"].includes(item.state))
            targets.push({ kind: "main", threadId: bot.threadId, turnId: item.turnId ?? null, promptId: item.id, operationId: item.operationId, state: "queued" });
      }
      if (current.activeTurnId || activity?.unresolved) targets.push({ kind: "main", threadId: bot.threadId,
        turnId: current.activeTurnId ?? null, operationId: activity?.dispatchOperationId ?? null,
        activityGeneration: activity?.generation ?? null, state: "queued" });
      for (const context of runtime.store.list('collaborationContext', bot.id)) {
        // Global bot Stop covers all newly registered room contexts. A room
        // hold alone only fences its mailbox and never recalls committed work.
        if (context.threadId || context.provisioning==='dispatching' || context.provisioning==='uncertain') targets.push({kind:'collaboration',contextId:context.id,
          threadId:context.threadId,turnId:context.activeTurnId ?? null,creationOperationId:context.creationOperationId,state:'queued'});
        for (const delivery of runtime.collaboration.deliveries(bot.id)) if (delivery.contextId===context.id &&
          ['dispatching','uncertain','accepted'].includes(delivery.state) && !delivery.terminalStatus)
          targets.push({kind:'collaboration',contextId:context.id,threadId:context.threadId,turnId:delivery.turnId,
            deliveryId:delivery.id,state:'queued'});
      }
    }
    for (const lane of lanes) {
      runtime.store.put("runLane", { ...runtime.store.get("runLane", lane.id), paused: true, pauseRevision: (lane.pauseRevision ?? 0) + 1 });
      for (const intake of runtime.store.executionMetadata("runIntake", bot.id)) if (intake.laneId === lane.id && ["dispatching", "uncertain"].includes(intake.state))
        targets.push({ kind: "run", laneId: lane.id, threadId: lane.threadId, turnId: intake.turnId, operationId: intake.id, state: "queued" });
      if (lane.activeTurnId) targets.push({ kind: "run", laneId: lane.id, threadId: lane.threadId, turnId: lane.activeTurnId, state: "queued" });
      const activity = runtime.store.get("runActivity", lane.id);
      if (!lane.activeTurnId && activity?.unresolved && !targets.some(t => t.laneId === lane.id))
        targets.push({ kind: "run", laneId: lane.id, threadId: lane.threadId, turnId: null,
          operationId: activity.dispatchOperationId ?? null, activityGeneration: activity.generation, state: "queued" });
      runtime.runs.publish(lane.id);
    }
    const matches = destination => scope === "all" || scope === "run" && destination?.runId === runId;
    for (const task of runtime.store.list("managerTask", bot.id)) if (matches(task.destination)) {
      if (["queued", "waiting"].includes(task.state)) runtime.manager?.finish(task, "cancelled", "Stopped by the human.");
      else if (!terminal.has(task.state)) targets.push({ kind: "worker", taskId: task.id,
        executionId: task.dispatchKey ?? task.id, threadId: runtime.store.get("managerWorker", task.workerId)?.threadId ?? null,
        turnId: task.turnId ?? null, state: "queued" });
    }
    for (const notice of runtime.store.list("managerNotice", bot.id)) if (matches(notice.destination) && notice.state === "queued")
      runtime.store.put("managerNotice", { ...notice, state: "held" });
    if (scope !== "run" && runtime.primary?.single(bot)) runtime.primary.reserveStop(bot, operationId);
    if (runPauses.length) runtime.emitEvent("schedules", {}, bot.id);
    return runtime.store.put("executionStop", { id: operationId, botId: bot.id, scope, runId, primaryMode: scope !== "run" && Boolean(runtime.primary?.single(bot)), runPauses, targets, state: "pending", createdAt: now() });
  });
  if (scope !== "run" && runtime.primary?.single(bot)) await runtime.primary.stop(bot, operationId);
  return reconcileStop(runtime, stop);
}

export async function reconcileStop(runtime, stop) {
  const targets = stop.targets.map(t => ({ ...t }));
  const goalSettled = !stop.primaryMode ||
    await runtime.primary.stoppedGoal(stop.botId, stop.id);
  for (const target of targets) {
    if (target.state === "done") continue;
    if (target.kind === 'collaboration') {
      const c = runtime.store.get('collaborationContext', target.contextId);
      const d = target.deliveryId && runtime.store.get('collaborationDelivery',target.deliveryId);
      if (!c || c.botId !== stop.botId || target.threadId && c.threadId !== target.threadId || target.creationOperationId && c.creationOperationId !== target.creationOperationId) continue;
      target.threadId ??= c.threadId;
      if (!target.threadId || !await runtime.collaboration.stopGoal(c,stop.id)) continue;
      if (d) {
        if (d.botId !== stop.botId || d.contextId !== c.id) continue;
        if (d.terminalStatus || d.state==='rejected') { target.state='done'; continue; }
        target.turnId ??= d.turnId;
      }
      if (!target.turnId && !d) {
        try { const fresh=await runtime.collaboration.current(c,false); if (fresh.status==='idle') {target.state='done';continue;} target.turnId=fresh.activeTurnId; }
        catch { continue; }
      }
      const evidence=target.turnId && runtime.store.get('collaborationTurn',`${c.id}:${target.turnId}`);
      if (evidence && ['completed','failed','interrupted'].includes(evidence.status)) {target.state='done';continue;}
    }
    if (!target.turnId && (target.intakeId || target.promptId)) {
      const input = runtime.store.get(target.intakeId ? "primaryInbox" : "promptQueue", target.intakeId ?? target.promptId);
      if (input?.withdrawal?.operationId === stop.id && input.withdrawal.removedAt) { target.state = "done"; continue; }
      target.turnId = input?.turnId ?? null;
      if (!target.turnId) continue;
    }
    if (!target.turnId) {
      if (["main", "run"].includes(target.kind) && !target.operationId && !target.intakeId && !target.promptId) {
        const activity = runtime.store.get(target.kind === "main" ? "botActivity" : "runActivity",
          target.kind === "main" ? stop.botId : target.laneId);
        if (activity && !activity.unresolved && !activity.activeTurnId && activity.generation > target.activityGeneration) {
          target.state = "done"; // Current idle, not a historical execution outcome.
          continue;
        }
      }
      if (target.kind === "worker") {
        const receipt = runtime.store.get("managerExecution", target.executionId);
        if (receipt?.taskId === target.taskId) {
          if (terminal.has(receipt.state)) { target.state = "done"; continue; }
          target.turnId = receipt.turnId;
          target.threadId ??= receipt.threadId;
        }
        const task = runtime.store.get("managerTask", target.taskId);
        if ((task?.dispatchKey ?? task?.id) !== target.executionId) continue;
        if (terminal.has(task.state)) { target.state = "done"; continue; }
        target.turnId = task.turnId;
        target.threadId ??= runtime.store.get("managerWorker", task.workerId)?.threadId ?? null;
      } else {
        const record = target.kind === "run" ? runtime.store.get("runIntake", target.operationId) : runtime.store.operation(target.operationId);
        if (record?.outcome === "rejected" || record?.state === "rejected") { target.state = "done"; continue; }
        target.turnId = record?.turnId ?? record?.result?.turn?.id ?? record?.result?.turnId ?? null;
        target.threadId ??= record?.threadId ?? null;
      }
    }
    if (!usableTurnId(target.turnId) || !usableTurnId(target.threadId)) continue;
    const evidence = target.kind === "run" ? runtime.runs.port(target.laneId).store.get("planTurnEvidence", target.turnId) :
      target.kind === "main" ? runtime.store.get("planTurnEvidence", target.turnId) : null;
    if (terminalTurn(evidence)) { target.state = "done"; continue; }
    if (target.kind === "worker") {
      const receipt = runtime.store.get("managerExecution", target.executionId);
      if (receipt?.taskId === target.taskId && receipt.turnId === target.turnId && terminal.has(receipt.state)) {
        target.state = "done"; continue;
      }
      const task = runtime.store.get("managerTask", target.taskId);
      if ((task?.dispatchKey ?? task?.id) === target.executionId && task.turnId === target.turnId && terminal.has(task.state)) {
        target.state = "done"; continue;
      }
    }
    if (target.state !== "queued") continue; // Lost interrupt ACK is not retried blindly.
    target.state = "dispatching";
    runtime.store.put("executionStop", { ...stop, targets, reconcileAfter: new Date(Date.now() + 30000).toISOString() });
    try {
      await runtime.codex.call("turn/interrupt", { threadId: target.threadId, turnId: target.turnId });
      target.state = "done";
    } catch (error) { target.state = "uncertain"; target.error = error.message; }
    runtime.store.put("executionStop", { ...stop, targets });
  }
  const done = goalSettled && targets.every(t => t.state === "done");
  runtime.store.put("executionStop", { ...stop, targets, state: done ? "done" : "uncertain",
    reconcileAfter: new Date(Date.now() + 30000).toISOString() });
  if (!done) throw Object.assign(new Error("Stop is retained for its original executions. Some native acknowledgements or turn identities remain unconfirmed; newer turns were not targeted."), { outcome: "uncertain" });
  return { stopped: true, scope: stop.scope, runId: stop.runId };
}
