import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { RunStatePort } from "./run-state-port.mjs";
import { MANAGER_TOOLS, MANAGER_INSTRUCTIONS } from "./manager-tools.mjs";
import { RUN_INSTRUCTIONS, profileContext, containedPath } from "./profiles.mjs";
import { requireTurn, usableTurn, usableTurnId, terminalTurn, requireSteer } from "./native-turn.mjs";
import { beginTurnDispatch, acknowledgeTurnDispatch, requireDispatchReconciliation,
  observeStartedTurn, observedActiveTurn, projectTerminalTurn, activityUnresolved, requireCurrentActivity,
  captureActivity, activityUnchanged } from "./turn-state.mjs";
import { reconcileCurrentActivity } from "./current-activity.mjs";
import { findNativeTurn } from "./native-reconcile.mjs";
import { registerNativeItem, rememberInputProvenance } from "./artifact-outputs.mjs";
import { boundHistoryEvent } from "./history-events.mjs";
import { reconcileStop } from "./execution-stop.mjs";
import { unreservedRun, admissionRevision, admissionPaused, admissionOpen,
  setAdmissionPause, beginPreparation, finishPreparation } from "./run-admission.mjs";

const now = () => new Date().toISOString();
const hash = value => createHash("sha256").update(value).digest("hex");
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
const pauseError = () => new Error("This run is paused. Resume its queued work explicitly; no input was dispatched.");
const textInput = text => ({ type: "text", text, text_elements: [] });
const due = row => !(Date.parse(row.reconcileAfter ?? "") > Date.now());
const retryAt = attempts => new Date(Date.now() + (attempts === 1 ? 5000 : attempts === 2 ? 15000 : 60000)).toISOString();
const privateInput = new Set(["queued", "dispatching", "uncertain"]);

export class BackgroundRuns {
  constructor(runtime, tools, validateResponse, interactions) {
    Object.assign(this, { runtime, store: runtime.store, tools, validateResponse, interactions });
    this.ports = new Map();
  }
  port(id) {
    if (!this.ports.has(id)) {
      if (this.ports.size >= 32) this.ports.delete(this.ports.keys().next().value);
      this.ports.set(id, new RunStatePort(this, id, this.validateResponse));
    }
    return this.ports.get(id);
  }
  lane(botId, runId) {
    const run = this.runtime.owned("run", runId, botId);
    const lane = run.laneId && this.store.get("runLane", run.laneId);
    if (!lane || lane.botId !== botId || lane.runId !== run.id) throw new Error("This run uses the legacy conversation or has not provisioned an isolated lane.");
    return lane;
  }
  byThread(threadId) {
    if (typeof threadId !== "string") return null;
    const row = this.store.db.prepare("SELECT json FROM records WHERE kind='runLane' AND json_extract(json,'$.threadId')=? LIMIT 1").get(threadId);
    return row ? JSON.parse(row.json) : null;
  }
  isolated(runId) { return Boolean(runId && this.store.get("run", runId)?.executionLane === "run-v1"); }
  context(lane, turnId = null) { return { botId: lane.botId, runId: lane.runId, laneId: lane.id, threadId: lane.threadId, turnId }; }
  unreservedMetadata(run) {
    if (!unreservedRun(this.store, run) || !admissionPaused(this.store, run.id)) return null;
    return { id: run.id, botId: run.botId, scheduleId: run.scheduleId, title: run.title, status: run.status,
      scheduledAt: run.scheduledAt, startedAt: null, finishedAt: null, turnId: null,
      operationId: run.operationId ?? `schedule:${run.id}`,
      activity: { state: "paused", activeTurnId: null, waitReason: "stopped-before-start", paused: true,
        unresolved: false, error: null, pendingCount: 0, queuedCount: 1 } };
  }
  publicRun(lane) {
    const run = this.store.get("run", lane.runId);
    const pendingCount = this.store.list("runPending", lane.botId).filter(p => p.laneId === lane.id).length;
    const queuedCount = this.store.executionMetadata("runIntake", lane.botId).filter(p => p.laneId === lane.id && p.state === "queued").length;
    const unresolved = activityUnresolved(this.port(lane.id), lane.botId);
    const waitingWorkers = this.store.list("managerTask", lane.botId).some(t => t.destination?.laneId === lane.id && !terminal.has(t.state));
    const state = lane.provisioning === "prepared" && lane.paused ? "paused" : lane.provisioning !== "bound" ? lane.provisioning === "uncertain" ? "uncertain" : "provisioning" :
      unresolved ? "uncertain" : lane.paused ? "paused" : pendingCount ? "waiting-input" :
        lane.activeTurnId ? "running" : waitingWorkers ? "waiting-workers" : queuedCount ? "queued" : "idle";
    return { id: run.id, botId: run.botId, scheduleId: run.scheduleId, title: run.title, status: run.status,
      scheduledAt: run.scheduledAt, startedAt: run.startedAt, finishedAt: run.finishedAt, turnId: run.turnId ?? null,
      error: run.error?.slice(0, 2048) ?? null, contextWarning: run.contextWarning ?? null, operationId: run.operationId,
      laneId: lane.id, threadId: lane.threadId, executionLane: "run-v1",
      activity: { state, activeTurnId: lane.activeTurnId ?? null, waitReason: state === "queued" && lane.admitted === false ? "capacity" : ["running", "idle"].includes(state) ? null : state,
        paused: !!lane.paused, unresolved, error: lane.error?.slice(0, 2048) ?? null,
        provisioning: lane.provisioning, pendingCount, queuedCount } };
  }
  unfinished(lane) {
    if (lane.provisioning !== "bound" || lane.activeTurnId || activityUnresolved(this.port(lane.id), lane.botId)) return true;
    if (this.store.list("runPending", lane.botId).some(p => p.laneId === lane.id)) return true;
    if (this.store.executionMetadata("runIntake", lane.botId).some(p => p.laneId === lane.id && privateInput.has(p.state))) return true;
    if (this.store.list("managerTask", lane.botId).some(t => t.destination?.laneId === lane.id && !terminal.has(t.state))) return true;
    return this.store.list("managerNotice", lane.botId).some(n => n.destination?.laneId === lane.id && !["delivered", "rejected"].includes(n.state));
  }
  occupies(lane) { return lane.admitted !== false && this.unfinished(lane); }
  counts(botId) {
    const lanes = this.store.executionMetadata("runLane", botId);
    const unreserved = this.store.list("run", botId).filter(r => this.unreservedMetadata(r));
    return { botId, unfinished: lanes.filter(l => this.unfinished(l)).length + unreserved.length,
      running: lanes.filter(l => l.activeTurnId).length,
      needsInput: this.store.list("runPending", botId).length,
      unconfirmed: lanes.filter(l => l.provisioning === "uncertain" || activityUnresolved(this.port(l.id), botId)).length };
  }
  publish(id) {
    const lane = this.store.get("runLane", id);
    this.runtime.emitEvent("run.state", { ...this.context(lane), run: this.publicRun(lane), background: this.counts(lane.botId) }, lane.botId);
  }
  event(id, type, data) {
    const lane = this.store.get("runLane", id), context = this.context(lane);
    this.store.put("runLane", { ...lane, updatedAt: now() });
    if (type === "codex") {
      const bounded = boundHistoryEvent("codex", data);
      const event = bounded.type === "codex" ? this.runtime.emitEvent("run.codex", { ...context, message: data }, lane.botId) :
        this.runtime.emitEvent("run.state", { ...context, run: this.publicRun(lane), background: this.counts(lane.botId), historyRefresh: bounded.data }, lane.botId);
      this.runtime.historyVersions ??= new Map(); this.runtime.historyContentVersions ??= new Map();
      this.runtime.historyVersions.set(id, event.seq); this.runtime.historyContentVersions.set(id, event.seq);
      return event;
    }
    if (type === "request" || type === "request.resolved")
      return this.runtime.emitEvent(type === "request" ? "run.request" : "run.request.resolved", { ...data, ...context }, lane.botId);
    this.publish(id);
  }
  snapshot() {
    const metadata = this.store.executionMetadata("runLane").map(l => ({
      unfinished: this.unfinished(l), date: l.createdAt, lane: l }));
    for (const run of this.store.list("run")) {
      const publicRun = this.unreservedMetadata(run);
      if (publicRun) metadata.push({ unfinished: true, date: run.scheduledAt, run: publicRun });
    }
    return { backgroundByBot: this.store.bots().map(bot => this.counts(bot.id)),
      // Raw requests may contain secrets. Older clients persist unknown
      // snapshot fields; selected runs.requests/live events are the only reads.
      backgroundRuns: metadata.sort((a, b) => Number(b.unfinished) - Number(a.unfinished) || b.date.localeCompare(a.date))
        .slice(0, 100).map(entry => entry.run ?? this.publicRun(entry.lane)) };
  }
  start() {
    // Preparation contains no native effects before its lane reservation.
    // Restart retires the dead async frame, never its pause or execution IDs.
    for (const admission of this.store.list("runAdmission"))
      if (Number.isSafeInteger(admission.preparingRevision)) finishPreparation(this.store, admission.id, admission.preparingRevision);
    for (const pending of this.store.list("runPending")) if (!pending.async) this.store.remove("runPending", pending.id);
    for (const lane of this.store.executionMetadata("runLane")) {
      // Do not resume the historical library on restart. A quiescent old lane
      // must reacquire admission and a fresh current proof for new input.
      if (this.occupies(lane)) this.port(lane.id).initialize();
      else this.store.put("runLane", { ...this.store.get("runLane", lane.id), admitted: false });
      if (lane.provisioning === "dispatching") this.store.put("runLane", { ...this.store.get("runLane", lane.id), provisioning: "uncertain" });
    }
  }
  config() {
    return this.runtime.manager?.workerConfig() ?? { "features.fast_mode": true,
      "mcp_servers.codex_manager": { command: process.execPath, args: [], enabled: false } };
  }
  instructions(lane) {
    return `${RUN_INSTRUCTIONS}\n${MANAGER_INSTRUCTIONS}\nRun ID: ${lane.runId}. Bot home: ${lane.home}. All questions and worker completion notices belong to this run. Main conversation is independent.`;
  }
  async loadedCapacity(threadId = null) {
    // Unsubscribe acknowledges subscription removal, NOT resource release.
    // Observe complete native loaded identity pages before admitting capacity.
    let cursor = null; const ids = new Set();
    for (let pageNo = 0; pageNo < 20; pageNo++) {
      const page = await this.runtime.codex.call("thread/loaded/list", { cursor, limit: 100 });
      if (!Array.isArray(page.data)) throw new Error("Loaded native thread observation is unavailable.");
      page.data.forEach(id => ids.add(id));
      cursor = page.nextCursor;
      if (!cursor) {
        const lanes = this.store.executionMetadata("runLane");
        for (const lane of lanes) if (lane.threadId && !ids.has(lane.threadId)) {
          this.runtime.loaded.delete(lane.threadId);
          if (lane.releaseRequestedAt) this.store.put("runLane", { ...this.store.get("runLane", lane.id), releasedAt: now() });
        }
        return ids.has(threadId) || lanes.filter(l => l.threadId && ids.has(l.threadId)).length < 8;
      }
    }
    throw new Error("Native loaded-thread observation exceeded its bounded page budget; admission retained.");
  }
  async load(id) {
    const lane = this.store.get("runLane", id);
    if (!lane?.threadId || lane.provisioning !== "bound") throw new Error("Run thread provisioning is unconfirmed; no replacement was created.");
    if (this.runtime.loaded.has(lane.threadId)) return;
    if (!await this.loadedCapacity(lane.threadId)) throw new Error("Background threads are awaiting native resource release. Recovery will retry automatically.");
    const result = await this.runtime.codex.call("thread/resume", {
      threadId: lane.threadId, cwd: lane.home, model: lane.settings.model, serviceTier: lane.settings.serviceTier,
      approvalPolicy: lane.permission.approvalPolicy, sandbox: lane.permission.sandbox,
      developerInstructions: this.instructions(lane), config: this.config(), excludeTurns: true,
    });
    if (result?.thread?.id !== lane.threadId) throw new Error("Native resume did not confirm this run's thread identity.");
    if (result.thread.canAcceptDirectInput === false) throw new Error("Native thread currently refuses direct input. This run was not submitted or replaced.");
    // Native persists thread/start dynamicTools in rollout metadata. Resume
    // intentionally supplies no undocumented dynamicTools override.
    this.runtime.loaded.add(lane.threadId);
    this.store.put("runLane", { ...this.store.get("runLane", id), releasePending: false, releaseRequestedAt: null, releasedAt: null });
  }
  async provision(bot, run) {
    const id = `run:${hash(`${bot.id}:${run.id}`)}`;
    if (this.store.get("runLane", id)) return;
    const revision = admissionRevision(this.store, run.id);
    if (!beginPreparation(this.store, run, revision)) return;
    try {
      const context = await profileContext(bot);
      if (!admissionOpen(this.store, run.id, revision)) return;
      if (run.selectedContext != null) {
        const selected = run.selectedContext;
        if (Buffer.byteLength(JSON.stringify(selected)) > 16 * 1024 ||
            typeof selected !== "string" && (typeof selected !== "object" || Array.isArray(selected) ||
              (selected.references != null && (!Array.isArray(selected.references) || selected.references.length > 20 ||
                selected.references.some(ref => ref?.botId !== bot.id)))))
          throw new Error("Saved selected context is too large or has unsupported ownership. The schedule prompt was retained without dispatch.");
      }
      const lane = { id, botId: bot.id, runId: run.id, threadId: null, marker: `dawar-run:${hash(id)}`,
        markerPath: join(bot.cwd, ".dawar-runs", hash(id)), home: bot.cwd,
        settings: this.runtime.settings(bot), permission: { approvalPolicy: "never", sandbox: "danger-full-access" },
        contextId: id, profileVersion: hash(JSON.stringify(context)), scheduleOrigin: run.origin ?? null,
        provisioning: "prepared", status: "provisioning", admitted: true, activeTurnId: null, paused: false, pauseRevision: 0, createdAt: now() };
      await mkdir(lane.markerPath, { recursive: true, mode: 0o700 });
      if (!admissionOpen(this.store, run.id, revision)) return;
      await containedPath(bot.cwd, lane.markerPath);
      if (!admissionOpen(this.store, run.id, revision) || !unreservedRun(this.store, this.store.get("run", run.id))) return;
      if (this.store.bot(bot.id).archived || this.store.bot(bot.id).archiving) throw new Error("Bot archival began before run reservation.");
      this.store.transaction(() => {
        this.store.put("runContext", { id, botId: bot.id, profile: context, selectedContext: run.selectedContext ?? null });
        this.store.put("runLane", lane);
        this.store.put("run", { ...this.store.get("run", run.id), laneId: id, executionLane: "run-v1", operationId: `schedule:${run.id}`,
          contextWarning: run.origin ? null : "This legacy schedule has no saved conversational context. Only its prompt and bot profile are available." });
        this.accept(lane, `schedule:${run.id}`, { text: run.prompt, input: [textInput(run.prompt)], attachments: [] },
          { kind: "schedule", scheduleId: run.scheduleId, sourceExecutionId: run.id }, true);
      });
    } catch (error) {
      // A superseded preparation cannot turn a stopped original prompt into
      // failed work, nor replace a newer explicit resume's admission intent.
      if (admissionOpen(this.store, run.id, revision)) throw error;
      return;
    } finally { finishPreparation(this.store, run.id, revision); }
    await this.createThread(id);
  }
  async createThread(id) {
    let lane = this.store.get("runLane", id);
    if (lane.provisioning !== "prepared") return this.recoverCreation(id);
    const revision = admissionRevision(this.store, lane.runId);
    if (!await this.loadedCapacity()) throw new Error("Background capacity is waiting for native idle-thread release.");
    lane = this.store.get("runLane", id);
    if (!admissionOpen(this.store, lane.runId, revision) || this.store.bot(lane.botId).archived || this.store.bot(lane.botId).archiving || lane.paused)
      throw new Error("Run provisioning is paused; no native creation was submitted.");
    this.store.put("runLane", { ...lane, provisioning: "dispatching", creationOperationId: `lane-create:${hash(id)}` });
    try {
      const result = await this.runtime.codex.call("thread/start", {
        cwd: lane.markerPath, threadSource: lane.marker, ephemeral: false,
        model: lane.settings.model, serviceTier: lane.settings.serviceTier,
        approvalPolicy: lane.permission.approvalPolicy, sandbox: lane.permission.sandbox,
        developerInstructions: this.instructions(lane), config: this.config(),
        dynamicTools: [...this.tools, ...MANAGER_TOOLS.map(tool => ({ type: "function", ...tool }))],
      });
      if (!usableTurnId(result?.thread?.id)) throw new Error("Run creation acknowledgement has no usable thread identity.");
      this.bind(id, result.thread.id);
    } catch (error) {
      lane = this.store.get("runLane", id);
      if (lane.provisioning !== "bound") this.store.put("runLane", { ...this.store.get("runLane", lane.id), provisioning: "uncertain", error: error.message });
      throw error;
    }
  }
  bind(id, threadId) {
    const lane = this.store.get("runLane", id);
    if (lane.threadId && lane.threadId !== threadId) throw new Error("Run thread identity cannot be replaced.");
    if (this.byThread(threadId)?.id && this.byThread(threadId).id !== id || this.store.bots().some(b => b.threadId === threadId) ||
        this.store.list("managerWorker").some(w => w.threadId === threadId))
      throw new Error("Native thread is already owned by another execution.");
    this.store.transaction(() => {
      this.store.put("runLane", { ...lane, threadId, provisioning: "bound", error: null, status: "idle" });
      this.store.put("run", { ...this.store.get("run", lane.runId), threadId });
      requireCurrentActivity(this.port(id), lane.botId, null, "new-run-current-state-required");
    });
  }
  async recoverCreation(id) {
    let lane = this.store.get("runLane", id);
    if (lane.provisioning === "bound") return;
    // No turn is sent until binding. Its reserved cwd is therefore still the
    // creation marker even though later turns use the human-owned bot home.
    const scan = lane.creationScan ?? { archived: false, cursor: null, matches: [] };
    const page = await this.runtime.codex.call("thread/list", { cwd: lane.markerPath, sourceKinds: ["appServer"],
      archived: scan.archived, cursor: scan.cursor, limit: 100 });
    if (!Array.isArray(page.data)) throw new Error("Creation identity search is unavailable.");
    const matches = [...new Set([...scan.matches, ...page.data.filter(t => t.cwd === lane.markerPath && t.threadSource === lane.marker && usableTurnId(t.id)).map(t => t.id)])];
    if (matches.length > 1) throw new Error("Multiple native threads match this run's owned marker; no input was sent.");
    lane = this.store.get("runLane", id);
    if (page.nextCursor || !scan.archived) {
      this.store.put("runLane", { ...lane, creationScan: { archived: page.nextCursor ? scan.archived : true, cursor: page.nextCursor ?? null, matches } });
      return;
    }
    this.store.put("runLane", { ...lane, creationScan: null });
    if (matches.length === 1) this.bind(id, matches[0]);
    else throw new Error("Run creation remains unknown. No replacement thread or input was submitted.");
  }
  accept(lane, operationId, payload, origin, primary = false) {
    const fingerprint = hash(JSON.stringify({ laneId: lane.id, text: payload.text, attachments: payload.attachments ?? [], origin }));
    const prior = this.store.get("runIntake", operationId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error("Run operation ID was reused with different input or destination.");
      return this.receipt(prior);
    }
    const owner = this.store.bot(lane.botId);
    if (owner.archived || owner.archiving) throw new Error("Bot archival prevents new run intake; original input was not submitted.");
    if (!this.unfinished(lane)) this.store.put("runLane", { ...this.store.get("runLane", lane.id), admitted: false, reconcileAfter: null });
    const record = { id: operationId, operationId, botId: lane.botId, runId: lane.runId, laneId: lane.id,
      target: { botId: lane.botId, laneId: lane.id, runId: lane.runId }, origin, fingerprint,
      attachmentIds: payload.attachments ?? [],
      permission: lane.permission, state: "queued", primary, createdAt: now(), turnId: null };
    this.store.put("runInput", { id: operationId, botId: lane.botId, laneId: lane.id, text: payload.text, input: payload.input });
    this.store.put("runIntake", record);
    if (!primary) this.store.put("runTurn", { id: operationId, operationId, botId: lane.botId, runId: lane.runId,
      laneId: lane.id, threadId: lane.threadId, turnId: null, status: "queued", createdAt: record.createdAt });
    this.publish(lane.id);
    return this.receipt(record);
  }
  receipt(record) {
    return { operationId: record.operationId, botId: record.botId, runId: record.runId, laneId: record.laneId,
      threadId: record.threadId ?? this.store.get("runLane", record.laneId)?.threadId ?? null,
      state: record.state === "dispatching" ? "uncertain" : record.state, turnId: record.turnId,
      waitReason: record.state === "queued" ? this.publicRun(this.store.get("runLane", record.laneId)).activity.waitReason :
        ["dispatching", "uncertain"].includes(record.state) ? "delivery-unconfirmed" : null,
      outcome: record.state === "rejected" ? "rejected" :
        record.state === "accepted" ? "accepted" : record.state === "queued" ? "queued" : "uncertain", error: record.error ?? null };
  }
  async send(bot, p, operationId, origin = { kind: "owner" }) {
    const lane = this.lane(bot.id, p.runId);
    if (bot.archived || bot.archiving || lane.archived) throw new Error("Restore the bot before replying to this run.");
    const input = await this.runtime.messageInput(bot, p);
    return this.store.transaction(() => this.accept(lane, operationId,
      { text: String(p.text ?? "").trim(), attachments: p.attachments ?? [], input }, origin));
  }
  async submit(id, record, answer = null, boundary = { started: false, rejected: false }) {
    let lane = this.store.get("runLane", id); const port = this.port(id), bot = this.store.bot(lane.botId);
    const revision = admissionRevision(this.store, lane.runId);
    const payload = this.store.get("runInput", record.id), context = this.store.get("runContext", lane.contextId);
    if (!payload || !context) throw new Error("Retained run input/context is unavailable; nothing was resubmitted.");
    let fence, result;
    try {
      await this.load(id);
      if (activityUnresolved(port, bot.id) && !await reconcileCurrentActivity(port, bot.id)) throw new Error("Run activity is unresolved; no conflicting input was submitted.");
      lane = this.store.get("runLane", id);
      if (lane.paused || !admissionOpen(this.store, lane.runId, revision)) throw pauseError();
      if (this.store.bot(bot.id).archived || this.store.bot(bot.id).archiving) throw new Error("This bot is being archived; no run input was submitted.");
      if (lane.activeTurnId || port.store.list("pending", bot.id).some(p => p.id !== answer?.key)) throw new Error("Run is waiting for its current turn or question.");
      if (!answer && this.store.executionMetadata("runIntake", bot.id).some(p => p.laneId === id && p.id !== record.id && ["dispatching", "uncertain"].includes(p.state)))
        throw new Error("An earlier run input is still unconfirmed.");
      const params = { threadId: lane.threadId, clientUserMessageId: record.id, input: payload.input,
        cwd: lane.home, approvalPolicy: lane.permission.approvalPolicy, sandboxPolicy: { type: "dangerFullAccess" },
        ...lane.settings, collaborationMode: { mode: "default", settings: { model: lane.settings.model,
          reasoning_effort: lane.settings.effort, developer_instructions: null } }, turnTrigger: "scheduled",
        additionalContext: { ...context.profile, scheduledTask: { kind: "application",
          value: `${this.instructions(lane)}\nSchedule: ${this.store.get("run", lane.runId).title}. Scheduled for ${this.store.get("run", lane.runId).scheduledAt}.\nSelected context: ${context.selectedContext ? JSON.stringify(context.selectedContext) : "None saved; do not assume access to main dialogue."}` } } };
      fence = this.store.transaction(() => {
        const token = beginTurnDispatch(port, bot.id, record.id);
        if (answer) port.answers.dispatch(port.state(), record.id, answer.token, "turn/start", params, token);
        this.store.put("runDispatch", { id: record.id, botId: bot.id, laneId: id, nativeParams: params, dispatchFence: token });
        this.store.put("runIntake", { ...record, threadId: lane.threadId, state: "dispatching",
          dispatchFence: token, reconcileAfter: retryAt(3) });
        const receiptKind = record.primary ? "run" : "runTurn", receiptId = record.primary ? lane.runId : record.id;
        this.store.put(receiptKind, { ...this.store.get(receiptKind, receiptId), status: "starting", startedAt: now() });
        this.store.put("queuedAttachments", { id: record.id, botId: bot.id, laneId: id, attachmentIds: record.attachmentIds });
        return token;
      });
      result = await this.runtime.submitNative("turn/start", params, boundary);
      const turn = requireTurn(result?.turn);
      this.store.transaction(() => {
        if (answer) port.answers.accept(answer.token, { turnId: turn.id, status: turn.status, source: "run-start-ack" });
        acknowledgeTurnDispatch(port, bot.id, turn, fence);
        this.acceptEvidence(id, record.id, turn);
        projectTerminalTurn(port, bot.id, turn);
      });
      this.event(id, "codex", { method: "item/completed", params: { threadId: lane.threadId, turnId: turn.id,
        item: { type: "userMessage", id: `client:${record.id}`, clientId: record.id, content: payload.input } } });
      rememberInputProvenance(this.runtime, bot, turn.id, { type: "userMessage", id: `client:${record.id}`, clientId: record.id, content: payload.input }, this.context(lane));
      return result;
    } catch (error) {
      if (boundary.started && !boundary.rejected) requireDispatchReconciliation(port, bot.id, fence, result?.turn);
      const current = this.store.get("runIntake", record.id);
      // No-submit admission failures remain queued. A native rejection is
      // terminal; a post-effect storage/publication failure remains uncertain.
      if (current?.state !== "accepted") this.store.put("runIntake", { ...current,
        state: boundary.started ? boundary.rejected ? "rejected" : "uncertain" : "queued", error: error.message });
      if (boundary.started && current?.state !== "accepted") {
        const kind = record.primary ? "run" : "runTurn", key = record.primary ? lane.runId : record.id;
        this.store.put(kind, { ...this.store.get(kind, key), status: boundary.rejected ? "failed" : "uncertain", error: error.message,
          ...(boundary.rejected ? { finishedAt: now() } : {}) });
      }
      if (answer) port.answers.reject(answer.token, boundary, error.message);
      throw error;
    }
  }
  acceptEvidence(id, operationId, turn) {
    requireTurn(turn);
    const lane = this.store.get("runLane", id), record = this.store.get("runIntake", operationId);
    if (!record || record.laneId !== id) return;
    const evidence = this.port(id).store.get("planTurnEvidence", turn.id);
    if (evidence?.laneId === id && terminalTurn(evidence)) turn = { ...turn, status: evidence.status };
    this.store.put("runIntake", { ...record, state: "accepted", threadId: lane.threadId, turnId: turn.id, acceptedAt: record.acceptedAt ?? now(), error: null });
    const status = terminalTurn(turn) ? turn.status : observedActiveTurn(this.port(id), lane.botId, turn.id) ? "running" : "uncertain";
    if (record.primary) {
      const run = this.store.get("run", lane.runId);
      if (run.turnId && run.turnId !== turn.id) throw new Error("Primary run identity cannot be replaced.");
      this.store.put("run", { ...run, turnId: turn.id, status, startedAt: run.startedAt ?? now(),
        ...(terminalTurn(turn) ? { finishedAt: run.finishedAt ?? now() } : {}) });
    } else this.store.put("runTurn", { ...this.store.get("runTurn", operationId), laneId: id, threadId: lane.threadId,
      turnId: turn.id, status, ...(terminalTurn(turn) ? { finishedAt: now() } : {}) });
    this.publish(id);
  }
  recordEvidence(id, turn) {
    if (!usableTurn(turn)) return;
    const lane = this.store.get("runLane", id);
    const clientIds = new Set((turn.items ?? []).filter(i => i.type === "userMessage").map(i => i.clientId));
    for (const record of this.store.executionMetadata("runIntake", lane.botId)) if (record.laneId === id &&
      (record.turnId === turn.id || clientIds.has(record.id))) this.acceptEvidence(id, record.id, turn);
  }
  async recoverIntake(record) {
    record = this.store.get("runIntake", record.id); // Metadata scans never replace immutable payload.
    if (!due(record) || !["dispatching", "uncertain", "accepted"].includes(record.state)) return;
    const lane = this.store.get("runLane", record.laneId);
    if (!lane.threadId) return;
    const receipt = record.primary ? this.store.get("run", lane.runId) : this.store.get("runTurn", record.id);
    if (record.state === "accepted" && terminal.has(receipt?.status)) return;
    this.store.put("runIntake", { ...record, reconcileAfter: retryAt(3) });
    const found = await findNativeTurn(this.runtime, lane.threadId, { clientId: record.id,
      turnId: record.state === "accepted" ? record.turnId : null, cursor: record.reconcileCursor ?? null });
    const current = this.store.get("runIntake", record.id);
    this.store.put("runIntake", { ...current, reconcileCursor: found.nextCursor });
    if (!found.turn) return;
    // History settles exact receipts/terminals only. It never projects active.
    this.store.transaction(() => {
      this.acceptEvidence(lane.id, record.id, found.turn);
      projectTerminalTurn(this.port(lane.id), lane.botId, found.turn, true);
    });
  }
  async respond(bot, p, outerId, boundary) {
    const retained = this.store.get("answerExecution", `answer:${p.key}`);
    const pending = this.store.get("runPending", p.key);
    const laneId = retained?.laneId ?? pending?.laneId;
    const lane = this.store.get("runLane", laneId);
    if (!lane || lane.botId !== bot.id) throw new Error("Run question is not owned by this bot.");
    const revision = admissionRevision(this.store, lane.runId);
    const port = this.port(lane.id);
    if (pending && !pending.async) {
      if (lane.admitted === false) throw new Error("This run is waiting for background capacity; the original native request was retained.");
      if (pending.epoch !== this.runtime.epoch) throw new Error("This native request expired on restart.");
      const result = this.validateResponse(pending.request, p.result);
      if (lane.paused) throw pauseError();
      boundary.started = true;
      this.runtime.codex.respond(pending.request.id, result);
      this.store.remove("runPending", pending.id);
      this.event(lane.id, "request.resolved", { key: pending.id });
      return {};
    }
    const question = retained ? { id: retained.key, botId: bot.id, async: true, request: retained.request } : pending;
    if (!question) throw new Error("Run question is unavailable.");
    const prepared = await port.answers.prepare(port.state(), question, p.result, outerId, boundary);
    if (prepared.accepted) return {};
    const record = { id: prepared.token.id, operationId: prepared.token.id, botId: bot.id,
      laneId, runId: lane.runId, threadId: lane.threadId, state: "queued",
      attachmentIds: [], origin: { kind: "answer", requestId: question.id,
        sourceThreadId: question.request.params.threadId, sourceTurnId: question.request.params.turnId },
      permission: lane.permission, revision: prepared.token.revision, primary: false, createdAt: now(), turnId: null };
    try {
      if (lane.admitted === false) throw new Error("This run is waiting for background capacity. Keep the original answer and retry after admission.");
      await this.load(laneId);
      if (activityUnresolved(port, bot.id) && !await reconcileCurrentActivity(port, bot.id)) throw new Error("Run current state remains unresolved.");
      const current = this.store.get("runLane", laneId);
      if (current.paused || !admissionOpen(this.store, lane.runId, revision)) throw pauseError();
      if (current.activeTurnId && current.activeTurnId !== question.request.params.turnId)
        throw new Error("Another turn is active in this run. The original question and answer were retained.");
      this.store.transaction(() => {
        const prior = this.store.get("runIntake", record.id);
        if (prior && !["queued", "rejected"].includes(prior.state)) throw new Error("Original answer intake remains unconfirmed.");
        if (prior) this.store.put("runIntakeAttempt", { ...prior, id: prior.revision, logicalId: prior.id,
          retainedInput: this.store.get("runInput", prior.id), retainedDispatch: this.store.get("runDispatch", prior.id) });
        this.store.put("runInput", { id: record.id, botId: bot.id, laneId, text: prepared.text, input: [textInput(prepared.text)] });
        this.store.put("runIntake", record);
        this.store.put("runTurn", { id: record.id, operationId: record.id, botId: bot.id, runId: lane.runId,
          laneId, threadId: lane.threadId, turnId: null, status: "starting", createdAt: now() });
      });
      if (current.activeTurnId) {
        const params = { threadId: lane.threadId, expectedTurnId: current.activeTurnId,
          clientUserMessageId: record.id, input: [textInput(prepared.text)] };
        this.store.transaction(() => {
          port.answers.dispatch(port.state(), record.id, prepared.token, "turn/steer", params);
          this.store.put("runDispatch", { id: record.id, botId: bot.id, laneId, nativeParams: params });
          this.store.put("runIntake", { ...record, state: "dispatching" });
        });
        const result = await this.runtime.submitNative("turn/steer", params, boundary);
        try { requireSteer(result, current.activeTurnId); }
        catch (error) { requireCurrentActivity(port, bot.id, null, "invalid-run-answer-ack"); throw error; }
        port.answers.accept(prepared.token, { turnId: result.turnId, source: "run-steer-ack" });
        this.acceptEvidence(laneId, record.id, { id: result.turnId, status: "inProgress" });
      } else await this.submit(laneId, record, { token: prepared.token, key: question.id }, boundary);
      port.answers.finish(port.answers.get(port.state(), question.id));
      return {};
    } catch (error) {
      port.answers.reject(prepared.token, boundary, error.message);
      const current = this.store.get("runIntake", record.id);
      if (current?.revision === record.revision && current.state !== "accepted") this.store.put("runIntake", {
        ...current, state: boundary.started && !boundary.rejected ? "uncertain" : "rejected", error: error.message });
      throw error;
    }
  }
  async request(lane, message) {
    const bot = this.store.bot(lane.botId);
    if (message.method === "item/tool/call") {
      try {
        const p = message.params;
        const origin = { ...this.context(lane, p.turnId), callId: p.callId, authority: "native-tool" };
        let result;
        if (MANAGER_TOOLS.some(t => t.name === p.tool)) {
          if (!this.runtime.manager) throw new Error("Worker manager is unavailable.");
          result = await this.runtime.manager.call(bot.id, p.tool,
            typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments, origin);
        } else {
          this.assertOrigin(origin);
          result = await this.runtime.dynamicTool(bot, p, origin);
        }
        this.runtime.codex.respond(message.id, { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(result) }] });
      } catch (error) {
        this.runtime.codex.respond(message.id, { success: false, contentItems: [{ type: "inputText", text: error.message }] });
      }
      return;
    }
    if (!this.interactions.has(message.method)) { this.runtime.codex.reject(message.id, "Unsupported run request."); return; }
    const key = `${this.runtime.epoch}:${message.id}`;
    const pending = { id: key, key, ...this.context(lane), epoch: this.runtime.epoch, request: message, createdAt: now() };
    this.store.put("runPending", pending);
    this.event(lane.id, "request", pending);
    this.publish(lane.id);
    this.runtime.notify(bot, `run-question:${key}`, `Scheduled run “${this.store.get("run", lane.runId).title}” needs input. Open its Activity entry.`);
  }
  assertOrigin(origin) {
    const lane = this.store.get("runLane", origin.laneId);
    if (!lane || lane.botId !== origin.botId || lane.runId !== origin.runId || lane.threadId !== origin.threadId ||
        !usableTurnId(origin.turnId) || lane.activeTurnId !== origin.turnId || activityUnresolved(this.port(lane.id), lane.botId) || lane.paused)
      throw new Error("Run tool caller no longer has confirmed active authority. Existing receipts remain available.");
  }
  notification(lane, message) {
    const p = message.params ?? {}, port = this.port(lane.id), bot = this.store.bot(lane.botId);
    if (message.method === "thread/closed" || message.method === "thread/status/changed" && p.status?.type === "notLoaded") {
      this.runtime.loaded.delete(lane.threadId);
      this.store.put("runLane", { ...this.store.get("runLane", lane.id), releasedAt: now() });
      return;
    }
    if (["turn/started", "turn/completed"].includes(message.method)) {
      if (!usableTurn(p.turn) || (message.method === "turn/started" ? p.turn.status !== "inProgress" : !terminalTurn(p.turn))) {
        requireCurrentActivity(port, lane.botId, null, "invalid-run-native-notification"); return;
      }
      this.store.transaction(() => {
        if (message.method === "turn/started") observeStartedTurn(port, lane.botId, p.turn);
        this.recordEvidence(lane.id, p.turn);
        if (message.method === "turn/completed") projectTerminalTurn(port, lane.botId, p.turn);
      });
    }
    if (message.method === "serverRequest/resolved") {
      const key = `${this.runtime.epoch}:${p.requestId}`;
      if (this.store.get("runPending", key)?.laneId === lane.id) {
        this.store.remove("runPending", key); this.event(lane.id, "request.resolved", { key });
      }
    }
    if (message.method === "item/completed" && usableTurnId(p.turnId)) {
      this.recordEvidence(lane.id, { id: p.turnId, status: "inProgress", items: [p.item] });
      rememberInputProvenance(this.runtime, bot, p.turnId, p.item, this.context(lane));
      if (p.item?.type === "agentMessage" && p.item.questions?.length) {
        const key = `async:${lane.threadId}:${p.item.id}`;
        if (port.answers.get(port.state(), key)?.state !== "accepted") {
          const request = { id: key, method: "item/tool/requestUserInput", params: { threadId: lane.threadId,
            turnId: p.turnId, itemId: p.item.id, isBlocking: false, questions: p.item.questions.map((q, i) => ({
              id: String(i), header: "Run question", question: q.title, isOther: true, isSecret: false,
              options: q.options?.map(label => ({ label, description: "" })) ?? null })) } };
          const pending = { id: key, key, ...this.context(lane), request, async: true, createdAt: now() };
          this.store.put("runPending", pending); this.event(lane.id, "request", pending);
          this.runtime.notify(bot, `run-question:${key}`, "A scheduled run needs your input. Open its Activity entry.");
        }
      }
      if (["imageGeneration", "mcpToolCall"].includes(p.item?.type) && (this.artifactJobs ?? 0) < 8) {
        this.artifactJobs = (this.artifactJobs ?? 0) + 1;
        void registerNativeItem(this.runtime, bot, p.turnId, p.item, undefined, this.context(lane))
          .then(({ failures }) => { if (failures.length) this.runtime.emitEvent("artifact.issue", { ...this.context(lane), failures }, bot.id); })
          .catch(() => this.runtime.emitEvent("artifact.issue", { ...this.context(lane), failures: [{ itemId: p.item.id, reason: "Run output indexing failed. Retry indexing this run; original files remain." }] }, bot.id))
          .finally(() => { this.artifactJobs--; });
      }
    }
    this.event(lane.id, "codex", message);
  }
  finding(bot, origin, args) {
    const lane = this.lane(bot.id, origin.runId);
    const key = String(args.key ?? "").slice(0, 200), summary = String(args.summary ?? "").trim().slice(0, 1000);
    if (!key || !summary) throw new Error("Provide a finding key and summary.");
    const id = hash(`${bot.id}:${lane.runId}:${key}`);
    return this.store.transaction(() => {
      const prior = this.store.get("runFinding", id);
      if (prior) return prior;
      const finding = this.store.put("runFinding", { id, ...this.context(lane, origin.turnId), key, summary, createdAt: now() });
      this.runtime.notify(bot, `finding:${key}`, summary); // Preserve existing cross-run semantic push dedup.
      this.runtime.emitEvent("run.finding", finding, bot.id);
      return finding;
    });
  }
  read(bot, method, p) {
    if (method === "runs.findings") {
      if (p.runId != null) this.lane(bot.id, p.runId);
      const limit = p.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid finding page size.");
      let before = Number.MAX_SAFE_INTEGER;
      if (p.cursor != null) {
        try { if (typeof p.cursor !== "string" || p.cursor.length > 2048) throw new Error();
          const cursor = JSON.parse(Buffer.from(p.cursor, "base64url"));
          if (cursor.botId !== bot.id || cursor.runId !== (p.runId ?? null) || !Number.isSafeInteger(cursor.before)) throw new Error();
          before = cursor.before;
        } catch { throw new Error("Invalid finding cursor."); }
      }
      const rows = this.store.db.prepare("SELECT rowid,json FROM records WHERE kind='runFinding' AND bot_id=? AND (? IS NULL OR json_extract(json,'$.runId')=?) AND rowid<? ORDER BY rowid DESC LIMIT ?")
        .all(bot.id, p.runId ?? null, p.runId ?? null, before, limit + 1);
      return { findings: rows.slice(0, limit).map(r => JSON.parse(r.json)), nextCursor: rows.length > limit ?
        Buffer.from(JSON.stringify({ botId: bot.id, runId: p.runId ?? null, before: rows[limit - 1].rowid })).toString("base64url") : null };
    }
    const lane = this.lane(bot.id, p.runId);
    if (method === "runs.requests") return { pending: this.store.list("runPending", bot.id).filter(r => r.laneId === lane.id), ...this.context(lane) };
    if (method === "runs.receipt") {
      const record = this.store.get("runIntake", p.operationId);
      if (!record || record.laneId !== lane.id) throw new Error("Run input receipt is not available for this run.");
      return this.receipt(record);
    }
    throw new Error("Unknown run read.");
  }
  resume(bot, p, operationId) {
    const run = this.runtime.owned("run", p.runId, bot.id);
    if (!run.laneId) {
      if (!this.store.get("runAdmission", run.id) || !unreservedRun(this.store, run))
        throw new Error("This run has no positively unsent queued preparation to resume. Original effects were not replayed.");
      setAdmissionPause(this.store, run, false, operationId);
      this.runtime.emitEvent("schedules", {}, bot.id);
      return { runId: run.id, resumedQueuedWork: true, restartedInterruptedWork: false };
    }
    const lane = this.lane(bot.id, p.runId);
    if (!["prepared", "bound"].includes(lane.provisioning) || activityUnresolved(this.port(lane.id), bot.id) || this.store.executionMetadata("runIntake", bot.id).some(r => r.laneId === lane.id && ["dispatching", "uncertain"].includes(r.state)))
      throw new Error("Resolve this run's unknown execution before resuming queued work. Nothing was replayed.");
    // A stop ACK only accepts the interrupt; its terminal notification may
    // still pause this exact turn. Resume must follow that projection (or a
    // fenced current-idle proof), never acknowledge intent it can later undo.
    // Also retain unidentified/uncertain original targets: a later stop
    // reconciliation must not interrupt them after a successful resume.
    if (this.store.list("executionStop", bot.id).some(stop => stop.targets.some(target =>
      target.kind === "run" && target.laneId === lane.id && target.state !== "done")))
      throw new Error("This run's original stop is still settling. Nothing was resumed; retry Resume after its interruption is confirmed.");
    const activity = this.store.get("runActivity", lane.id);
    if (lane.provisioning === "bound" && (lane.activeTurnId !== null || !activity ||
        activity.unresolved !== false || activity.activeTurnId !== null))
      throw new Error("Wait for this run's current turn to finish and its activity to be confirmed before resuming queued work. Nothing was resumed.");
    setAdmissionPause(this.store, run, false, operationId);
    this.store.put("runLane", { ...lane, paused: false, pauseRevision: (lane.pauseRevision ?? 0) + 1, reconcileAfter: null });
    for (const notice of this.store.list("managerNotice", bot.id)) if (notice.destination?.laneId === lane.id && notice.state === "held" && !this.store.operation(notice.operationId))
      this.store.put("managerNotice", { ...notice, state: "queued" });
    this.publish(lane.id);
    return { runId: lane.runId, resumedQueuedWork: true, restartedInterruptedWork: false };
  }
  async tick() {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
    for (const lane of this.store.executionMetadata("runLane").filter(l => l.releasePending && due(l)).slice(0, 2)) {
      if (this.runtime.locks.has(lane.id)) continue;
      await this.runtime.lock(lane.id, () => this.release(lane.id)).catch(error => this.runtime.emit("fault", error));
    }
    let checked = 0;
    for (const lane of this.store.executionMetadata("runLane").sort((a, b) => (a.reconcileAfter ?? "").localeCompare(b.reconcileAfter ?? ""))) {
      if (lane.admitted === false) continue;
      if (lane.releaseRequestedAt && !this.unfinished(lane)) continue;
      if (checked >= 2 || !due(lane) || this.runtime.locks.has(lane.id) || this.store.bot(lane.botId).archived || this.store.bot(lane.botId).archiving) continue;
      checked++;
      await this.runtime.lock(lane.id, async () => {
        this.store.put("runLane", { ...this.store.get("runLane", lane.id), reconcileAfter: retryAt(3) });
        if (lane.provisioning !== "bound") {
          if (lane.provisioning === "prepared") await this.createThread(lane.id); else await this.recoverCreation(lane.id);
          return;
        }
        const port = this.port(lane.id);
        if (activityUnresolved(port, lane.botId)) await reconcileCurrentActivity(port, lane.botId);
        const recovery = this.store.executionMetadata("runIntake", lane.botId).filter(r => {
          if (r.laneId !== lane.id || !due(r) || !["dispatching", "uncertain", "accepted"].includes(r.state)) return false;
          const receipt = r.primary ? this.store.get("run", lane.runId) : this.store.get("runTurn", r.id);
          return r.state !== "accepted" || !terminal.has(receipt?.status);
        }).sort((a, b) => (a.reconcileAfter ?? "").localeCompare(b.reconcileAfter ?? ""));
        for (const record of recovery.slice(0, 2)) await this.recoverIntake(record);
        const answers = port.store.list("answerExecution", lane.botId).filter(answer => due(answer) &&
          answer.state !== "rejected" && !(answer.state === "accepted" && answer.settledAt && !port.store.get("pending", answer.key)))
          .sort((a, b) => (a.reconcileAfter ?? "").localeCompare(b.reconcileAfter ?? ""));
        for (const answer of answers.slice(0, 2)) await port.answers.reconcile(answer);
        const current = this.store.get("runLane", lane.id);
        if (!current.paused && !current.activeTurnId && !activityUnresolved(port, lane.botId) && !port.store.list("pending", lane.botId).length) {
          const queue = this.store.executionMetadata("runIntake", lane.botId).filter(r => r.laneId === lane.id && r.state === "queued");
          if (queue[0]) await this.submit(lane.id, this.store.get("runIntake", queue[0].id));
        }
        await this.release(lane.id);
      }).catch(error => {
        const current = this.store.get("runLane", lane.id), attempts = (current.attempts ?? 0) + 1;
        this.store.put("runLane", { ...current, attempts, error: error.message, reconcileAfter: retryAt(attempts) });
        this.publish(lane.id);
      });
    }
    // Global admission lock is distinct from every main conversation lock.
    await this.runtime.lock("run-admission", async () => {
      const unfinished = this.store.executionMetadata("runLane").filter(l => this.occupies(l));
      if (unfinished.length >= 2) return;
      const waiting = this.store.executionMetadata("runLane").find(l => l.admitted === false && this.unfinished(l) &&
        !l.paused && !admissionPaused(this.store, l.runId) && !this.store.bot(l.botId).archived && !this.store.bot(l.botId).archiving && !unfinished.some(other => other.botId === l.botId));
      if (waiting) {
        const revision = admissionRevision(this.store, waiting.runId);
        if (!await this.loadedCapacity(waiting.threadId)) return;
        if (!admissionOpen(this.store, waiting.runId, revision) || this.store.get("runLane", waiting.id).paused ||
            this.store.bot(waiting.botId).archived || this.store.bot(waiting.botId).archiving) return;
        this.store.transaction(() => {
          this.store.put("runLane", { ...this.store.get("runLane", waiting.id), admitted: true, reconcileAfter: null });
          requireCurrentActivity(this.port(waiting.id), waiting.botId, null, "explicit-run-followup-current-state-required");
          this.publish(waiting.id);
        });
        return;
      }
      const run = this.store.list("run").filter(r => unreservedRun(this.store, r) && !admissionPaused(this.store, r.id))
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).find(r =>
          !this.store.bot(r.botId).archived && !this.store.bot(r.botId).archiving && !unfinished.some(l => l.botId === r.botId));
      if (run) try { await this.provision(this.store.bot(run.botId), run); }
      catch (error) {
        const saved = this.store.get("run", run.id);
        if (!saved.laneId) {
          this.store.put("run", { ...saved, status: "failed", error: error.message, finishedAt: now() });
          this.runtime.emitEvent("schedules", {}, run.botId);
          this.runtime.notify(this.store.bot(run.botId), `schedule-preparation:${run.id}`, error.message);
        }
        throw error;
      }
    }).catch(error => this.runtime.emit("fault", error));
    for (const stop of this.store.list("executionStop").filter(s => s.state !== "done" && due(s)).slice(0, 2))
      await this.runtime.lock(`stop:${stop.id}`, async () => {
        const result = await reconcileStop(this.runtime, this.store.get("executionStop", stop.id));
        const op = this.store.operation(stop.id);
        if (op) this.store.saveOperation(op.id, op.fingerprint, "done", { ...op, result });
      }).catch(() => {});
    for (const archive of this.store.list("executionArchive").filter(a => a.state !== "done" && due(a)).slice(0, 2)) {
      if (this.runtime.locks.has(archive.botId)) continue;
      await this.runtime.lock(archive.botId, async () => {
        const result = await this.runtime.reconcileArchive(archive);
        const op = this.store.operation(archive.id);
        if (result && op) this.store.saveOperation(op.id, op.fingerprint, "done", { ...op, result });
      }).catch(error => this.runtime.emit("fault", error));
    }
    } finally { this.tickRunning = false; }
  }
  async release(id) {
    const lane = this.store.get("runLane", id);
    if (this.unfinished(lane)) return;
    this.store.put("runLane", { ...this.store.get("runLane", lane.id), admitted: false });
    if (lane.releaseRequestedAt || !lane.releasePending && !this.runtime.loaded.has(lane.threadId)) return;
    this.store.put("runLane", { ...this.store.get("runLane", id), releasePending: true, reconcileAfter: retryAt(3) });
    const port = this.port(id), fence = captureActivity(port, lane.botId);
    // Idle proof and no owned work precede unsubscribe. No archive/delete or
    // terminal cleanup is used for reclamation. Native grace is 30 minutes.
    let result;
    try { result = await this.runtime.codex.call("thread/unsubscribe", { threadId: lane.threadId }); }
    finally {
      // This cache means resumed/subscribed, not native resident resources.
      // A future follow-up must resubscribe even during native's grace period.
      this.runtime.loaded.delete(lane.threadId);
      if (!activityUnchanged(port, lane.botId, fence) || this.unfinished(this.store.get("runLane", id))) {
        this.store.put("runLane", { ...this.store.get("runLane", id), admitted: true, reconcileAfter: null });
        requireCurrentActivity(port, lane.botId, null, "activity-during-run-unsubscribe");
      }
    }
    if (!["unsubscribed", "notSubscribed", "notLoaded"].includes(result?.status)) throw new Error("Native resource release is unconfirmed.");
    this.store.put("runLane", { ...this.store.get("runLane", id), releasePending: false, releaseRequestedAt: now(),
      ...(result.status === "notLoaded" ? { releasedAt: now() } : {}) });
  }
}
