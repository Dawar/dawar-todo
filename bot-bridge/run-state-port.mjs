import { AnswerExecutions } from "./answer-execution.mjs";
import { captureActivity, requireCurrentActivity } from "./turn-state.mjs";

// An explicit storage/event port for the existing activity and logical-answer
// algorithms. No mutable Bot is cloned, swapped or saved through this port.
// All execution state and pending requests belong to the retained lane.
const privateKinds = { botActivity: "runActivity", activeRun: "runActive", turnWatch: "runWatch", pending: "runPending", planTurnEvidence: "runTurnEvidence" };
const singleton = new Set(["botActivity", "activeRun", "turnWatch"]);
export class RunStatePort {
  constructor(lanes, laneId, validateResponse) {
    this.lanes = lanes;
    this.runtime = lanes.runtime;
    this.laneId = laneId;
    this.codex = this.runtime.codex;
    this.loaded = this.runtime.loaded;
    const store = this.runtime.store;
    const key = (kind, id) => singleton.has(kind) ? laneId : kind === "planTurnEvidence" ? `${laneId}:${id}` : id;
    this.store = {
      bot: () => this.state(),
      get: (kind, id) => {
        const row = store.get(privateKinds[kind] ?? kind, key(kind, id));
        return kind === "planTurnEvidence" && row ? { ...row, id: row.nativeTurnId } : row;
      },
      put: (kind, record) => store.put(privateKinds[kind] ?? kind,
        { ...record, ...(privateKinds[kind] || ["answerExecution", "answerAttempt"].includes(kind)
          ? { id: key(kind, record.id), laneId, runId: this.lane().runId,
            ...(kind === "planTurnEvidence" ? { nativeTurnId: record.id } : {}) } : {}) }),
      remove: (kind, id) => store.remove(privateKinds[kind] ?? kind, key(kind, id)),
      list: (kind, botId) => store.list(privateKinds[kind] ?? kind, botId).filter(row => row.laneId === laneId),
      transaction: fn => store.transaction(fn),
      operation: id => store.operation(id),
      retainedAnswerOperation: (...args) => store.retainedAnswerOperation(...args),
    };
    this.plans = {
      note: (botId, message, complete) => {
        if (message.method !== "turn/completed") return;
        const turn = message.params.turn;
        const previous = this.store.get("planTurnEvidence", turn.id);
        this.store.put("planTurnEvidence", { ...previous, id: turn.id, botId, laneId,
          status: turn.status, error: turn.error?.message ?? null, complete: complete || previous?.complete || false });
      },
      bind: () => { throw new Error("Background answers must not bind main Plan intent."); },
    };
    this.answers = new AnswerExecutions(this, validateResponse);
  }
  lane() { return this.runtime.store.get("runLane", this.laneId); }
  state() {
    const lane = this.lane(), bot = this.runtime.store.bot(lane.botId);
    return { id: bot.id, name: bot.name, cwd: bot.cwd, threadId: lane.threadId,
      archived: bot.archived || lane.archived === true, mode: "default",
      activeTurnId: lane.activeTurnId ?? null, status: lane.status,
      queuePaused: lane.paused === true, queuePauseRevision: lane.pauseRevision ?? 0 };
  }
  saveBot(_state, changes) {
    const lane = this.lane();
    // A closed whitelist prevents profile/settings/main preview publication.
    const patch = {};
    for (const key of ["activeTurnId", "status", "error", "updatedAt"]) if (key in changes) patch[key] = changes[key];
    if (changes.activeTurnId) patch.admitted = true;
    if (changes.queuePaused !== undefined) {
      patch.paused = changes.queuePaused;
      patch.pauseRevision = (lane.pauseRevision ?? 0) + 1;
    }
    this.runtime.store.put("runLane", { ...lane, ...patch });
    this.lanes.publish(this.laneId);
    return this.state();
  }
  emitEvent(type, data) { return this.lanes.event(this.laneId, type, data); }
  emit(type, data) { return this.runtime.emit(type, data); }
  load() { return this.lanes.load(this.laneId); }
  currentActivityRetryDelay(attempts) {
    return attempts === 1 ? 5000 : attempts === 2 ? 15000 : attempts < 6 ? 60000 : attempts < 10 ? 300000 : 900000;
  }
  historyPage(...args) { return this.runtime.historyPage(...args); }
  recordScheduledEvidence(_botId, turn) { return this.lanes.recordEvidence(this.laneId, turn); }
  initialize() {
    const state = this.state();
    captureActivity(this, state.id);
    if (state.threadId && !state.archived) requireCurrentActivity(this, state.id, state.activeTurnId, "startup-run-current-state-required");
  }
}
