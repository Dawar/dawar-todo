import { createHash } from "node:crypto";

const now = () => new Date().toISOString();
export const terminalTaskStates = new Set(["completed", "failed", "interrupted", "cancelled"]);
const noticeId = (botId, key) => createHash("sha256").update(`${botId}:${key}`).digest("hex");

export function ensureNotice(manager, botId, key, text, runId = null, source = {}) {
  const id = noticeId(botId, key);
  const existing = manager.store.get("managerNotice", id);
  if (existing) return existing;
  const run = runId && manager.store.get("run", runId);
  const lane = run?.executionLane === "run-v1" && manager.store.get("runLane", run.laneId);
  const destination = lane ? { botId, runId, laneId: lane.id, threadId: lane.threadId } : null;
  return manager.store.put("managerNotice", {
    id, botId, key, operationId: `manager-notice:${id}`,
    state: (lane ? lane.paused : manager.store.bot(botId).managerPaused) ? "held" : "queued",
    destination,
    text, runId, source, createdAt: now(), deliveredAt: null,
  });
}

export function finishTask(manager, task, state, error, turn, repair = false) {
  const { store } = manager;
  return store.transaction(() => {
    const current = store.get("managerTask", task.id) ?? task;
    // A duplicate/late completion cannot finish a newer continuation.
    if ((current.dispatchKey ?? current.id) !== (task.dispatchKey ?? task.id) ||
        (current.turnId && turn?.id && current.turnId !== turn.id)) return current;
    const finishedTurn = turn?.id ?? task.turnId ?? current.turnId;
    const executionId = current.dispatchKey ?? current.id;
    const execution = store.get("managerExecution", executionId);
    if (execution && execution.taskId === current.id) store.put("managerExecution", { ...execution,
      turnId: finishedTurn ?? execution.turnId, state, error: error ?? null });
    const legacy = store.get("managerNotice", noticeId(task.botId, `task:${task.id}:${state}`));
    const key = `task:${task.id}:${executionId}:${finishedTurn ?? "no-turn"}:${state}`;
    const priorNotice = current.completionNoticeId && store.get("managerNotice", current.completionNoticeId);
    // Keep already published legacy notices. New continuations have a distinct
    // execution ID and never reuse another completion's delivery operation.
    const notice = priorNotice?.source?.executionId === executionId && priorNotice.source.outcome === state &&
      priorNotice.source.turnId === finishedTurn ? priorNotice :
      (legacy && (!current.dispatchKey || (current.finishedAt && legacy.createdAt >= current.finishedAt)) ? legacy : ensureNotice(manager, task.botId, key,
        `Worker task ${task.name} (${task.id}) is ${state}. ${error ?? ""} Use codex_tasks collectResult to inspect native evidence, review it and continue the human's request.`,
        current.scheduledRunId, { kind: "worker-task", taskId: task.id, workerId: current.workerId,
          executionId, turnId: finishedTurn, outcome: state }));
    const sameTerminal = current.state === state && current.turnId === finishedTurn && current.finishedAt;
    const summary = turn?.items?.filter((item) => item.type === "agentMessage")
      .map((item) => item.text).join("\n\n").slice(-24000);
    const saved = manager.put("managerTask", { ...current, turnId: finishedTurn, state, error,
      resultSummary: summary || current.resultSummary || "", finishedAt: sameTerminal || now(),
      completionNoticeId: notice.id, executionId });
    const worker = store.get("managerWorker", current.workerId);
    const newerTask = store.list("managerTask", current.botId).some((entry) => entry.id !== current.id &&
      entry.workerId === current.workerId && ["starting", "running", "uncertain"].includes(entry.state));
    if (worker && !["archived", "deleted"].includes(worker.state) && !newerTask &&
        (!(repair || terminalTaskStates.has(current.state)) || !worker.lastTaskId || worker.lastTaskId === current.id ||
          (finishedTurn && worker.activeTurnId === finishedTurn)) &&
        (!worker.activeTurnId || worker.activeTurnId === finishedTurn))
      manager.put("managerWorker", { ...worker, activeTurnId: null,
        state: state === "completed" ? "completed" : "waiting", lastTaskId: current.id });
    if (state !== "completed") for (const pending of store.list("managerRequest", current.botId))
      if (pending.workerId === current.workerId && pending.request.params.turnId === finishedTurn)
        store.remove("managerRequest", pending.id);
    return saved;
  });
}

export function repairTerminalNotices(manager) {
  for (const task of manager.store.list("managerTask")) {
    if (!terminalTaskStates.has(task.state)) continue;
    if (task.completionNoticeId && manager.store.get("managerNotice", task.completionNoticeId)) continue;
    finishTask(manager, task, task.state, task.error ?? null, undefined, true);
  }
}

export async function deliverNotices(manager) {
  const { store, runtime } = manager;
  let reconciled = 0, delivered = 0;
  // Read recovery has its own rotating, backoff-bounded budget. Already
  // admitted run input is never charged against new notice delivery again.
  const notices = store.list("managerNotice").sort((a, b) =>
    (a.reconcileAfter ?? "").localeCompare(b.reconcileAfter ?? "") || a.createdAt.localeCompare(b.createdAt));
  for (const original of notices) {
    if (["delivered", "rejected"].includes(original.state)) continue;
    if (original.destination?.laneId) {
      const operationId = original.operationId;
      const existing = store.get("runIntake", operationId);
      if (existing) {
        if (existing.botId !== original.botId || existing.runId !== original.runId || existing.laneId !== original.destination.laneId) {
          store.put("managerNotice", { ...original, state: "uncertain", error: "Worker notice destination changed; original input was retained." });
          continue;
        }
        if (reconciled >= 2 || Date.parse(original.reconcileAfter ?? "") > Date.now()) continue;
        reconciled++;
        store.transaction(() => {
          const notice = store.get("managerNotice", original.id), intake = store.get("runIntake", operationId);
          store.put("managerNotice", { ...notice,
            state: intake.state === "accepted" ? "delivered" : intake.state === "rejected" ? "rejected" :
              notice.state === "held" ? "held" : intake.state === "queued" ? "queued" : "uncertain",
            deliveryTurnId: intake.turnId ?? null,
            ...(intake.state === "accepted" ? { deliveredAt: notice.deliveredAt ?? now() } : {}),
            reconcileAfter: new Date(Date.now() + 30000).toISOString() });
        });
        continue;
      }
      // Unknown legacy dispatch without intake is not positive no-send proof.
      if (delivered >= 2 || ["held", "uncertain", "dispatching"].includes(original.state) ||
          runtime.locks.has(original.destination.laneId)) continue;
      await runtime.lock(original.destination.laneId, () => {
        const lane = store.get("runLane", original.destination.laneId), bot = store.bot(original.botId);
        const notice = store.get("managerNotice", original.id);
        if (!lane || lane.botId !== notice.botId || lane.runId !== notice.runId || lane.threadId !== notice.destination.threadId ||
            bot.archived || bot.archiving || lane.paused || notice.state !== "queued" || store.get("runIntake", operationId)) return;
        // Local queue acceptance and notice transition commit together. A
        // lost native ACK remains in runIntake, never main operation recovery.
        let accepted = false;
        try { store.transaction(() => {
            runtime.runs.accept(lane, operationId,
              { text: `[Manager update]\n${notice.text}`, input: [{ type: "text", text: `[Manager update]\n${notice.text}`, text_elements: [] }], attachments: [] },
              { kind: "worker-notice", sourceExecutionId: notice.source?.executionId ?? null, noticeId: notice.id });
            accepted = true;
            store.put("managerNotice", { ...notice, state: "queued", deliveryTurnId: null });
          });
        } finally {
          // afterCommit publication may throw after durable acceptance.
          if (accepted && store.get("runIntake", operationId)) delivered++;
        }
      }).catch(error => runtime.emit("fault", error));
      continue;
    }
    const operationId = original.operationId ?? `manager-notice:${original.id}`;
    let prior = store.operation(operationId);
    if (prior && prior.status !== "done" && prior.outcome !== "rejected") {
      if (reconciled >= 2 || Date.parse(original.reconcileAfter ?? "") > Date.now()) continue;
      reconciled++;
      store.put("managerNotice", { ...original, operationId, reconcileAfter: new Date(Date.now() + 30000).toISOString() });
      await runtime.lock(original.botId, async () => {
        const latest = store.operation(operationId);
        if (latest && latest.status !== "done" && latest.outcome !== "rejected") await runtime.reconcileOperation(latest);
      }).catch(error => {
        store.put("managerNotice", { ...store.get("managerNotice", original.id), error: error.message });
      });
      prior = store.operation(operationId);
    }
    if (prior) {
      const done = prior.status === "done";
      store.put("managerNotice", { ...store.get("managerNotice", original.id), operationId,
        state: done ? "delivered" : prior.outcome === "rejected" ? "rejected" : "uncertain",
        ...(done ? { deliveredAt: original.deliveredAt ?? now(), deliveryTurnId: prior.result?.turn?.id ?? prior.result?.turnId ?? null } : {}),
        error: done ? null : prior.error ?? "Native delivery is still unconfirmed." });
      continue;
    }
    // For old uncertain records without an operation row, absence cannot prove
    // non-delivery. New dispatching records are written before handle(), which
    // itself must persist an operation before crossing the native boundary.
    if (["uncertain", "held"].includes(original.state)) continue;
    const bot = store.bot(original.botId);
    if (delivered >= 2 || bot.archived || bot.archiving || bot.managerPaused || bot.queuePaused || bot.activeTurnId || runtime.activityUnresolved(bot.id) ||
        runtime.locks.has(bot.id) || store.list("pending", bot.id).length) continue;
    delivered++;
    store.put("managerNotice", { ...original, operationId, state: "dispatching", attemptedAt: now() });
    try {
      const result = await runtime.handle({ method: "turn.send", botId: bot.id, operationId,
        params: { text: `[Manager update]\n${original.text}` } });
      store.put("managerNotice", { ...store.get("managerNotice", original.id),
        state: result?.deferred ? "queued" : "delivered",
        ...(result?.deferred ? {} : { deliveredAt: now(), deliveryTurnId: result?.turn?.id ?? result?.turnId ?? null }) });
    } catch (error) {
      const operation = store.operation(operationId);
      store.put("managerNotice", { ...store.get("managerNotice", original.id),
        state: operation ? operation.outcome === "rejected" ? "rejected" : "uncertain" : "queued", error: error.message });
      runtime.notify(bot, `manager-notice:${original.id}`, "Worker results need review; open this bot to continue.");
    }
  }
}
