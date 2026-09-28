import { AnswerExecutions } from "./answer-execution.mjs";
import { BackgroundRuns } from "./background-runs.mjs";
import { stopExecutions, reconcileStop } from "./execution-stop.mjs";
import { requireTurn, requireSteer, usableTurn, usableTurnId, terminalTurn } from "./native-turn.mjs";
import { boundHistoryEvent } from "./history-events.mjs";
import { listArtifacts, artifactMime, artifactMetadata } from "./artifact-library.mjs";
import { readArtifactPreview } from "./artifact-previews.mjs";
import { registerArtifact, registerNativeItem, indexNativeArtifacts, rememberInputProvenance } from "./artifact-outputs.mjs";
import { EventEmitter } from "node:events";
import { PlanLifecycle } from "./plan-lifecycle.mjs";
import { stagedQueue, dispatchPrompt, reconcilePrompt } from "./prompt-queue.mjs";
import { findNativeTurn } from "./native-reconcile.mjs";
import { dispatchScheduled, reconcileScheduled, scheduledContext, recoverRunTurns } from "./scheduled-execution.mjs";
import { projectTerminalTurn, beginTurnDispatch, acknowledgeTurnDispatch, requireDispatchReconciliation, reconcileActiveTurns, captureActivity,
  activityUnchanged, observeStartedTurn, observedActiveTurn, activityUnresolved,
  requireCurrentActivity } from "./turn-state.mjs";
import { reconcileCurrentActivity, recoverCurrentActivities } from "./current-activity.mjs";
import { acceptLocalQueueOperation } from "./local-queue-operation.mjs";
import { listRunTurns, publicRunTurn, activeScheduledTurn } from "./run-turns.mjs";
import { randomUUID, createHash, randomInt } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  open,
  stat,
  lstat,
} from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { MANAGER_INSTRUCTIONS, RUN_MESSAGE_TOOL } from "./manager-tools.mjs";
import {
  BOT_INSTRUCTIONS,
  cleanName,
  slugify,
  initializeProfile,
  profileContext,
  containedPath,
} from "./profiles.mjs";
import { normalizeSchedule, collectDueRuns } from "./schedules.mjs";
import { readHistoryView, readHistoryDetail, readHistoryAttachments } from "./history-view.mjs";

const colors = [
  "#5c74b8",
  "#a05f87",
  "#3f8d78",
  "#b87943",
  "#7763a7",
  "#447d9c",
  "#a96562",
  "#617f55",
];
const now = () => new Date().toISOString();
const textInput = (text) => ({ type: "text", text, text_elements: [] });
const nativeIntegerText = (value) => {
  if (typeof value === "bigint") return value >= 0 ? value.toString() : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
};
const usageMetric = (groups, field) => {
  const values = groups.map((group) => nativeIntegerText(group?.[field])).filter((value) => value !== null);
  return { value: values.length ? values.reduce((sum, value) => sum + BigInt(value), 0n).toString() : null,
    reportedGroups: values.length };
};
const READ_METHODS = new Set([
  "snapshot",
  "history",
  "history.page",
  "history.turn",
  "history.view",
  "history.detail",
  "history.attachments",
  "artifacts.list",
  "artifacts.preview",
  "artifacts.index",
  "events",
  "schedules.list",
  "runs.page",
  "runs.turns",
  "runs.receipt",
  "runs.requests",
  "runs.findings",
  "usage.bot",
  "usage.account",
  "attachments.read",
  "queue.list",
  "runtime.info",
]);
const MAX_FILE = 100 * 1024 * 1024;
const CHUNK = 256 * 1024;
const INTERACTIONS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);
const schema = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string" };
export const dynamicTools = [
  { type: "function", ...RUN_MESSAGE_TOOL },
  {
    type: "function",
    name: "bots_schedule_list",
    description: "List this bot’s schedules and recent scheduled runs.",
    inputSchema: schema({}),
  },
  {
    type: "function",
    name: "bots_schedule_save",
    description:
      "Create or update a schedule for this bot. Use either at (ISO date/time including timezone offset) or cron (five-field cron). timeZone is an IANA timezone. Omit id for new schedules.",
    inputSchema: schema(
      {
        id: str,
        title: str,
        prompt: str,
        cron: { type: ["string", "null"] },
        at: { type: ["string", "null"] },
        timeZone: str,
        enabled: { type: "boolean" },
      },
      ["title", "prompt", "timeZone"],
    ),
  },
  {
    type: "function",
    name: "bots_schedule_delete",
    description: "Delete a schedule belonging to this bot.",
    inputSchema: schema({ id: str }, ["id"]),
  },
  {
    type: "function",
    name: "bots_report_result",
    description:
      "Notify Dawar of a meaningful, actionable scheduled finding. Do not call for routine unchanged checks. The key identifies this finding to suppress duplicates.",
    inputSchema: schema({ summary: str, key: str }, ["summary", "key"]),
  },
  {
    type: "function",
    name: "bots_publish_artifact",
    description:
      "Publish a regular file from this VM as a downloadable attachment in the bot conversation.",
    inputSchema: schema({ path: str, mimeType: str }, ["path"]),
  },
];

export class BotRuntime extends EventEmitter {
  constructor({ store, codex, root, defaultTimeZone = "UTC" }) {
    super();
    Object.assign(this, {
      store,
      codex,
      root: resolve(root),
      defaultTimeZone: store.meta("timeZone") ?? defaultTimeZone,
    });
    this.epoch = randomUUID();
    this.plans = new PlanLifecycle(this);
    this.answers = new AnswerExecutions(this, validateResponse);
    this.runs = new BackgroundRuns(this, dynamicTools, validateResponse, INTERACTIONS);
    this.locks = new Map();
    this.loaded = new Set();
    this.models = [];
    this.defaults = {
      model: "gpt-6-luna",
      effort: "high",
      serviceTier: "priority",
    };
    this.account = { authenticated: false };
    this.ready = false;
    codex.on("notification", (message) => this.onNotification(message));
    codex.on(
      "request",
      (message) =>
        void this.onServerRequest(message).catch((e) => {
          this.codex.reject(message.id, e.message);
          this.emit("fault", e);
        }),
    );
    codex.on("disconnect", () => {
      this.ready = false;
      this.emitEvent("runtime", { ready: false });
    });
  }
  emitEvent(type, data, botId) {
    if (type === "schedules" && botId) data = { ...data, activeScheduledTurn: activeScheduledTurn(this, botId) };
    const bounded = boundHistoryEvent(type, data);
    if (bounded.supplement && botId) {
      this.historySupplements ??= new Map();
      const key = `${botId}:${bounded.data.turnId}:${bounded.supplement.id}`;
      this.historySupplements.delete(key); this.historySupplements.set(key, bounded.supplement);
      let chars = 0;
      for (const [other, item] of [...this.historySupplements].reverse()) {
        chars += item.text.length;
        if (other !== key && (chars > 8 * 1024 * 1024 || this.historySupplements.size > 8)) this.historySupplements.delete(other);
      }
    }
    ({ type, data } = bounded);
    const event = this.store.event({ type, data, ...(botId ? { botId } : {}) });
    this.store.afterCommit(() => {
      if (botId && ["codex", "attachment", "history.refresh"].includes(type)) {
        this.historyVersions ??= new Map();
        this.historyVersions.set(botId, event.seq);
        if (type !== "attachment") {
          this.historyContentVersions ??= new Map();
          this.historyContentVersions.set(botId, event.seq);
        }
      }
      this.emit("event", event);
    });
    return event;
  }
  saveBot(bot, changes = {}) {
    // A late successful Send must not clear a pause raised while its ACK was
    // pending (including a newer turn's interruption after it already ended).
    const next = this.store.saveBot({ ...bot, ...changes,
      ...(changes.queuePaused === true ? { queuePauseRevision: (bot.queuePauseRevision ?? 0) + 1 } : {}) });
    this.emitEvent("bot", next, next.id);
    return next;
  }
  projectTerminalTurn(botId, turn, completeEvidence = false) {
    return projectTerminalTurn(this, botId, turn, completeEvidence);
  }
  activityUnresolved(botId) { return activityUnresolved(this, botId); }
  reconcileCurrentActivity(botId) { return reconcileCurrentActivity(this, botId); }
  async ensureCurrentActivity(botId) {
    if (this.activityUnresolved(botId) && !await this.reconcileCurrentActivity(botId))
      throw new Error("Current native activity is unresolved. No conflicting input was sent; recovery will retry automatically. Queue your message or retry after reconciliation.");
  }
  async start() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.runs.start();
    // A server request is only answerable in the process that emitted it.
    for (const p of this.store.list("pending"))
      if (!p.async) this.store.remove("pending", p.id);
    for (const bot of this.store.bots()) {
      // Initialize legacy stores before clearing the old UI active projection;
      // never reset an existing durable generation during process recovery.
      captureActivity(this, bot.id);
      if (bot.threadId && !bot.archived) requireCurrentActivity(this, bot.id, bot.activeTurnId, "startup-current-state-required");
      if (bot.activeTurnId || bot.status === "waiting")
        this.saveBot(bot, {
          activeTurnId: null,
          status: this.store.list("pending", bot.id).length
            ? "waiting"
            : "interrupted",
          error: "The runtime restarted. Checking the native conversation.",
        });
    }
    for (const active of this.store.list("activeRun"))
      this.store.remove("activeRun", active.id);
    for (const receipt of this.store.list("runTurn"))
      if (!receipt.laneId && ["starting", "running"].includes(receipt.status))
        this.store.put("runTurn", { ...receipt, status: "uncertain" });
    for (const run of this.store.list("run"))
      if (run.executionLane !== "run-v1" && ["running", "starting"].includes(run.status))
        this.store.put("run", {
          ...run,
          status: "uncertain",
          error:
            "Runtime restarted during execution. Review the conversation before retrying.",
        });
    await this.codex.start();
    const account = await this.codex.call("account/read", {
      refreshToken: false,
    });
    this.account = { authenticated: Boolean(account.account) };
    let cursor = null;
    do {
      const page = await this.codex.call("model/list", { limit: 100, cursor });
      this.models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const preferred = this.models.find((m) => m.model === this.defaults.model);
    if (
      !preferred?.supportedReasoningEfforts.some(
        (e) => e.reasoningEffort === this.defaults.effort,
      ) ||
      !preferred.serviceTiers?.some((tier) => tier.id === this.defaults.serviceTier)
    )
      throw new Error("The configured Bots model, effort, or Fast tier is unavailable.");
    for (const bot of this.store.bots()) {
      const activity = captureActivity(this, bot.id);
      if (!bot.threadId)
        try {
          await this.recoverCreation(bot);
          if (this.store.bot(bot.id).threadId && !bot.archived)
            requireCurrentActivity(this, bot.id, null, "recovered-thread-current-state-required");
        } catch (e) {
          if (activityUnchanged(this, bot.id, activity))
            this.saveBot(this.store.bot(bot.id), { status: "error", error: e.message });
        }
      else if (bot.threadId && !bot.archived)
        try {
          await this.load(bot);
        } catch (e) {
          if (activityUnchanged(this, bot.id, activity))
            this.saveBot(this.store.bot(bot.id), { status: "error", error: e.message });
        }
    }
    // Recovery establishes current runtime activity separately from historical
    // acceptance. A failed/stale startup read leaves a durable start barrier.
    await recoverCurrentActivities(this, 100, true);
    await this.reconcileOperations();
    await this.plans.recover(100);
    await this.answers.recover(100);
    for (const run of this.store.list("run").filter(run => run.executionLane !== "run-v1" && run.status === "uncertain")) {
      try { await reconcileScheduled(this, run); } catch { /* Keep uncertain IDs for the next bounded recovery. */ }
    }
    await recoverRunTurns(this, 100, true);
    await recoverCurrentActivities(this, 100, true);
    // Done send receipts are not in uncertainOperations. Durable turn
    // attribution must be restored before requests can be accepted anyway.
    for (const bot of this.store.bots()) {
      const context = this.scheduledContext(bot.id);
      if (context && observedActiveTurn(this, bot.id, context.turnId))
        this.store.put("activeRun", { ...context, id: bot.id });
    }
    this.ready = true;
    this.emitEvent("runtime", { ready: true });
  }
  async recoverCreation(bot) {
    // The reserved directory is unique. Search before ever attempting another thread/start.
    const matches = [];
    let cursor = null;
    do {
      const page = await this.codex.call("thread/list", {
        cwd: bot.cwd,
        limit: 100,
        cursor,
        sourceKinds: [],
      });
      matches.push(...page.data.filter((t) => t.cwd === bot.cwd));
      cursor = page.nextCursor;
    } while (cursor);
    if (matches.length === 1)
      this.saveBot(bot, {
        threadId: matches[0].id,
        status: "idle",
        error: null,
      });
    else if (matches.length > 1)
      throw new Error(
        "Multiple native threads found for this reserved workspace. Select the canonical thread in the local database before continuing.",
      );
    else
      this.saveBot(bot, {
        status: "error",
        error:
          "Bot creation was interrupted. Its reserved workspace was retained; reconcile the native thread before retrying.",
      });
  }
  async reconcileOperations() {
    for (const op of this.store.uncertainOperations())
      await this.reconcileOperation(op);
  }
  async reconcileOperation(op) {
    let result = null;
    const archive = this.store.get("executionArchive", op.id);
    if (archive) {
      try { result = await this.reconcileArchive(archive); }
      catch { return null; } // Read failure never makes startup replay archival.
    }
    const stop = this.store.get("executionStop", op.id);
    if (stop) {
      try { result = await this.lock(`stop:${stop.id}`, () => reconcileStop(this, stop)); } catch { return null; }
    }
    if (op.method === "runs.send") {
      const intake = this.store.get("runIntake", op.id);
      if (intake?.botId === op.botId && intake.runId === op.params.runId) result = this.runs.receipt(intake);
    }
    if (op.method === "requests.respond" && op.botId) {
      const bot = this.store.bot(op.botId);
      const saved = this.store.get("answerExecution", `answer:${op.params?.key}`);
      const answers = saved?.laneId ? this.runs.port(saved.laneId).answers : this.answers;
      const state = saved?.laneId ? this.runs.port(saved.laneId).state() : bot;
      let record = answers.get(state, op.params?.key);
      const pending = this.store.get("pending", op.params?.key);
      if (!record && pending?.async && pending.botId === bot.id) record = this.answers.importLegacy(bot, pending);
      if (record) {
        await answers.reconcile(record);
        record = answers.get(state, op.params.key);
        let matches = false;
        try {
          const payload = answers.payload(record.request, op.params.result);
          matches = record.fingerprint ? payload.fingerprint === record.fingerprint : payload.text === record.text;
        } catch { /* Malformed/different input is never silently accepted. */ }
        if (matches && record.state === "accepted") result = {};
        else if (record.state === "rejected" && record.originalOuterId === op.id) {
          this.store.saveOperation(op.id, op.fingerprint, "failed", { ...op, outcome: "rejected",
            error: "The original answer was not submitted or was definitively rejected. You may answer again." });
          return null;
        }
      }
    }
    if (op.method === "schedule.dispatch") {
      const run = this.store.get("run", op.runId);
      if (run && run.botId === op.botId) {
        await reconcileScheduled(this, run);
        return this.store.operation(op.id)?.result ?? null;
      }
    }
    if (op.method === "queue.dispatch") {
      const item = this.store.get("promptQueue", op.queueId);
      if (item && item.botId === op.botId) {
        await reconcilePrompt(this, item);
        return this.store.operation(op.id)?.result ?? null;
      }
    }
    if (["queue.add", "queue.update", "queue.delete", "queue.reorder"].includes(op.method) && op.status === "done") return op.result;
    if (op.method === "bots.create") {
      const bot = this.store.bots().find((b) => b.id === op.id);
      if (bot?.threadId) result = bot;
    }
    if (["turn.send", "queue.add"].includes(op.method) && op.botId) {
      let bot;
      try {
        bot = this.store.bot(op.botId);
      } catch {
        /* Bot lookup may be unavailable during recovery. */
      }
      if (bot && op.method === "queue.add") {
        try {
          const queue = await this.queueList(bot);
          const item = queue.find((item) => item.clientUserMessageId === op.id);
          if (item) result = { queuedSubmission: this.publicQueued(bot, item) };
        } catch {
          /* A consumed item can still be found in the native turn history. */
        }
      }
      if (bot && !result) {
        try {
          const found = await findNativeTurn(this, bot.threadId, {
            clientId: op.id, cursor: op.reconcileCursor ?? null,
          });
          op = { ...op, reconcileCursor: found.nextCursor };
          if (found.turn) {
            const notice = op.id.startsWith("manager-notice:") &&
              this.store.get("managerNotice", op.id.slice("manager-notice:".length));
            if (notice?.botId === bot.id && notice.runId) this.recordScheduledTurn(bot.id, notice.runId, op.id, found.turn);
            this.projectTerminalTurn(bot.id, found.turn, true);
            // Historical acceptance settles a receipt, never current activity.
            result = op.method === "queue.add" ? { consumedTurnId: found.turn.id } : { turn: found.turn };
          }
        } catch {
          /* Missing native evidence never authorizes a second execution. */
        }
      }
    }
    this.store.saveOperation(op.id, op.fingerprint,
      result ? "done" : "uncertain", {
        ...op,
        ...(result
          ? { result, error: null }
          : { error: "Acknowledgement was lost. Native state has not confirmed this operation; it was not replayed." }),
      });
    return result;
  }
  snapshot() {
    return {
      capabilities: { backgroundRunLanes: 1 },
      ...this.runs.snapshot(),
      bots: this.store
        .bots()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      pending: this.store.list("pending"),
      cursor: this.store.cursor(),
      ready: this.ready,
      account: this.account,
      defaults: this.defaults,
      models: this.models,
      schedules: this.store.list("schedule"),
      activeScheduledTurns: this.store.bots().map(bot => activeScheduledTurn(this, bot.id)).filter(Boolean),
      runs: this.store
        .list("run")
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
        .slice(0, 100).map(run => this.publicRun(run)),
    };
  }
  publicRun(run) {
    const lane = run.executionLane === "run-v1" && this.store.get("runLane", run.laneId);
    return { ...run, ...(lane ? this.runs.publicRun(lane) : this.runs.unreservedMetadata(run)) };
  }
  async lock(key, fn) {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  async handle(request) {
    const { method, botId, params = {}, operationId } = request;
    if (
      typeof method !== "string" ||
      !params ||
      typeof params !== "object" ||
      Array.isArray(params)
    )
      throw new Error("Invalid request.");
    if (READ_METHODS.has(method))
      return this.dispatch(method, botId, params, operationId);
    if (
      typeof operationId !== "string" ||
      !/^[a-zA-Z0-9:_-]{10,180}$/.test(operationId)
    )
      throw new Error("A stable operation ID is required.");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ method, botId, params }))
      .digest("hex");
    const runRequest = method === "requests.respond" && (this.store.get("runPending", params.key) ?? this.store.get("answerExecution", `answer:${params.key}`));
    const resumeRun = method === "runs.resume" && this.owned("run", params.runId, botId);
    const laneKey = resumeRun ? resumeRun.laneId ?? `run-preparation:${resumeRun.id}` :
      method.startsWith("runs.") && params.runId ? this.runs.lane(botId, params.runId).id : runRequest?.laneId;
    return this.lock(laneKey ?? botId ?? "create", async () => {
      const inputMutation = ["turn.send", "requests.respond", "queue.add", "queue.update", "queue.delete", "queue.reorder"].includes(method);
      const lifecycleMutation = ["turn.interrupt", "runs.interrupt", "bots.archive", "bots.restore"].includes(method);
      const attempt = inputMutation ? { started: false, rejected: false } : null;
      const existing = this.store.operation(operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("Operation ID was reused with different input.");
        if (existing.status === "done") return existing.result;
        if (["dispatching", "uncertain"].includes(existing.status) ||
            ((inputMutation || lifecycleMutation) && existing.status === "failed" && existing.outcome !== "rejected")) {
          const result = await this.reconcileOperation(existing);
          if (result) return result;
        }
        throw Object.assign(new Error(
          this.store.operation(operationId).error ??
            "This operation may already have run. Refresh the conversation before retrying.",
        ), { outcome: this.store.operation(operationId).outcome === "rejected" ? "rejected" : "uncertain" });
      }
      const local = await acceptLocalQueueOperation(this, { method, botId, params, operationId }, fingerprint);
      if (local) return local.result;
      if (method === "runs.send" || method === "runs.resume") {
        try {
          const bot = this.store.bot(botId), run = this.owned("run", params.runId, botId);
          const lane = method === "runs.send" || run.laneId ? this.runs.lane(botId, params.runId) : null;
          if (bot.archived || bot.archiving || lane?.archived) throw new Error("Restore this bot before changing a run.");
          const input = method === "runs.send" ? await this.messageInput(bot, params) : null;
          return this.store.transaction(() => {
            const result = method === "runs.send" ? this.runs.accept(lane, operationId,
              { text: String(params.text ?? "").trim(), input, attachments: params.attachments ?? [] }, { kind: "owner" }) : this.runs.resume(bot, params, operationId);
            this.store.saveOperation(operationId, fingerprint, "done", { method, botId, params, result, createdAt: now() });
            return result;
          });
        } catch (error) {
          const committed = this.store.operation(operationId);
          if (committed?.status === "done") return committed.result;
          error.outcome = "rejected";
          throw error;
        }
      }
      if (method === "turn.send" && operationId.startsWith("manager-notice:")) {
        const notice = this.store.get("managerNotice", operationId.slice("manager-notice:".length));
        if (!notice || notice.botId !== botId) throw new Error("Manager notice is not owned by this bot.");
        const current = this.store.bot(botId);
        if (current.activeTurnId || current.managerPaused || this.plans.blocked(botId) || this.scheduledUncertain(botId) ||
            this.store.list("pending", botId).length ||
            (await this.queueList(current)).length) return { deferred: true };
      }
      const data = { method, botId, params, createdAt: now() };
      this.store.saveOperation(operationId, fingerprint, "dispatching", data);
      try {
        const result = await this.dispatch(method, botId, params, operationId, attempt);
        this.store.saveOperation(operationId, fingerprint, "done", {
          ...data,
          result,
        });
        return result;
      } catch (e) {
        const committed = this.store.operation(operationId);
        if (committed?.status === "done") return committed.result;
        // For input mutations certainty comes from the native call boundary,
        // never an error string or the fact that dispatch threw after a commit.
        const uncertain = attempt
          ? attempt.started && !attempt.rejected
          : /timed out|disconnected|acknowledg/i.test(e.message) && !e.definite;
        // Settings-only updates have no side effect before validation/native
        // settings acknowledgement. An explicit native rejection is definite;
        // transport loss or a later storage fault still needs reconciliation.
        const settingsRejected = method === "bots.update" && params.name === undefined && e.definite === true;
        const lifecycleRejected = lifecycleMutation && !this.store.get("executionStop", operationId) && !this.store.get("executionArchive", operationId);
        const outcome = attempt ? (uncertain ? "uncertain" : "rejected") : lifecycleRejected ? "rejected" :
          settingsRejected ? "rejected" : "uncertain";
        this.store.saveOperation(
          operationId,
          fingerprint,
          uncertain ? "uncertain" : "failed",
          { ...data, error: e.message, outcome },
        );
        e.outcome = outcome;
        throw e;
      }
    });
  }
  owned(kind, id, botId) {
    const record = this.store.get(kind, String(id));
    if (!record || record.botId !== botId)
      throw new Error("Record not found for this bot.");
    return record;
  }
  resolveHistoryTarget(bot, params = {}) {
    let run = params.runId != null ? this.owned("run", params.runId, bot.id) : null;
    let part = null;
    if (params.turnId != null) {
      if (!usableTurnId(params.turnId) || params.turnId.length > 200) throw new Error("Invalid turn identity.");
      const rows = this.store.db.prepare("SELECT json FROM records WHERE kind IN ('run','runTurn') AND bot_id=? AND json_extract(json,'$.turnId')=? AND (? IS NULL OR (kind='run' AND id=?) OR (kind='runTurn' AND json_extract(json,'$.runId')=?)) GROUP BY CASE WHEN kind='run' THEN id ELSE json_extract(json,'$.runId') END LIMIT 2")
        .all(bot.id, params.turnId, run?.id ?? null, run?.id ?? null, run?.id ?? null);
      const parts = rows.map(row => JSON.parse(row.json));
      if (new Set(parts.map(value => value.runId ?? value.id)).size > 1)
        throw new Error("Turn identity has multiple retained run contexts. Select its exact run.");
      part = parts[0] ?? null;
      const owner = part && (part.runId ?? part.id);
      if (run && run.turnId !== params.turnId && owner !== run.id) throw new Error("Selected turn is not a retained part of this run.");
      if (!run && owner) run = this.owned("run", owner, bot.id);
    }
    if (!run) return { botId: bot.id, laneId: `main:${bot.id}`, runId: null, threadId: bot.threadId,
      kind: "main", turnId: params.turnId ?? null, updatedAt: bot.updatedAt, versionKey: `main:${bot.threadId}` };
    if (params.projection === "conversation") throw new Error("Conversation projection cannot select a scheduled run.");
    const isolated = run.executionLane === "run-v1", lane = isolated ? this.runs.lane(bot.id, run.id) : null;
    const turnId = params.turnId ?? run.turnId;
    if (!usableTurnId(turnId)) throw new Error("This run's primary native receipt is still unconfirmed. History is unavailable until exact evidence arrives.");
    const threadId = lane?.threadId ?? run.threadId ?? bot.threadId;
    if (!usableTurnId(threadId) || part?.threadId && part.threadId !== threadId) throw new Error("Run history destination is inconsistent; original receipts were retained.");
    return { botId: bot.id, laneId: lane?.id ?? `main:${bot.id}`, runId: run.id, threadId,
      kind: isolated ? "scheduled-run" : "main-legacy", turnId,
      updatedAt: lane?.updatedAt ?? part?.finishedAt ?? run.finishedAt ?? run.startedAt ?? run.scheduledAt,
      versionKey: `run:${run.id}:${threadId}` };
  }
  async submitNative(method, params, attempt) {
    if (attempt) attempt.started = true;
    try {
      return await this.codex.call(method, params);
    } catch (error) {
      // Codex sets definite only for an explicit native JSON-RPC error reply.
      // Legacy delete/reorder have no reviewed native no-effect receipt: only
      // our local pre-boundary validation can reject those operations safely.
      // A subsequent local/parser/storage exception cannot reuse native evidence.
      if (attempt && error.definite === true &&
          !["thread/queue/delete", "thread/queue/reorder"].includes(method)) attempt.rejected = true;
      throw error;
    }
  }
  async dispatch(method, botId, p, id, attempt = null) {
    if (method === "snapshot") return this.snapshot();
    if (method === "usage.account") {
      const readAt = now();
      let accountType = null;
      try {
        const account = await this.codex.call("account/read", { refreshToken: false });
        accountType = account?.account?.type ?? null;
        if (!accountType) return { accountType: null,
          ordinaryUsageAllowed: null, availableResetCredits: null, limits: [], readAt,
          reason: "Sign in to Codex to read account usage." };
        const response = await this.codex.call("account/rateLimits/read", {});
        const buckets = Object.entries(response?.rateLimitsByLimitId ?? {})
          .filter(([, value]) => value);
        const snapshots = buckets.length
          ? buckets : [[response?.rateLimits?.limitId ?? null, response?.rateLimits]];
        const window = (value) => value && Number.isFinite(value.usedPercent)
          && value.usedPercent >= 0 ? {
            usedPercent: value.usedPercent,
            windowDurationMins: Number.isFinite(value.windowDurationMins) && value.windowDurationMins > 0
              ? value.windowDurationMins : null,
            resetsAt: Number.isFinite(value.resetsAt) && value.resetsAt > 0
              ? value.resetsAt : null,
          } : null;
        const limits = snapshots.filter(([, value]) => value).map(([id, value]) => ({
          limitId: value.limitId ?? id,
          limitName: value.limitName ?? null,
          model: value.normalModelSlug ?? null,
          windows: [window(value.primary), window(value.secondary)].filter(Boolean),
        }));
        return { accountType, ordinaryUsageAllowed: typeof response?.ordinaryUsageAllowed === "boolean"
          ? response.ordinaryUsageAllowed : null,
          availableResetCredits: nativeIntegerText(response?.rateLimitResetCredits?.availableCount),
          limits, readAt: now() };
      } catch {
        return { accountType, ordinaryUsageAllowed: null,
          availableResetCredits: null, limits: [], readAt,
          reason: "Account usage is unavailable right now. Try refreshing." };
      }
    }
    if (method === "runtime.info")
      return {
        ready: this.ready,
        account: this.account,
        defaults: this.defaults,
        version: "0.156.1",
      };
    if (method === "events") return this.store.replay(Number(p.after) || 0);
    if (method === "bots.create") return this.create(p, id);
    if (method === "settings.timeZone") {
      new Intl.DateTimeFormat("en", { timeZone: p.timeZone }).format();
      this.defaultTimeZone = p.timeZone;
      this.store.meta("timeZone", p.timeZone);
      return {};
    }
    if (method === "artifacts.list") return listArtifacts(this, botId, p);
    const bot = this.store.bot(String(botId));
    switch (method) {
      case "artifacts.preview":
        return readArtifactPreview(this, bot, p);
      case "artifacts.index":
        return indexNativeArtifacts(this, bot, p, this.resolveHistoryTarget(bot, p));
      case "history.attachments":
        return readHistoryAttachments(this, bot, p);
      case "history.view":
        if (!bot.archived && this.resolveHistoryTarget(bot, p).kind !== "scheduled-run") await this.load(bot);
        return readHistoryView(this, bot, p);
      case "history.detail":
        return readHistoryDetail(this, bot, p);
      case "history": {
        if (!bot.archived) await this.load(bot);
        const { thread } = await this.codex.call("thread/read", {
          threadId: bot.threadId,
          includeTurns: false,
        });
        const page = await this.historyPage(bot.threadId);
        return {
          thread: { ...thread, turns: page.data.reverse() },
          nextCursor: page.nextCursor,
          attachments: this.store
            .list("attachment", bot.id)
            .filter((a) => a.ready)
            .map((a) => this.publicAttachment(a)),
          pending: this.store.list("pending", bot.id),
        };
      }
      case "history.page": {
        const target = this.resolveHistoryTarget(bot, p);
        if (!target.runId) return this.historyPage(target.threadId, p.cursor ?? null);
        let cursor = null;
        if (p.cursor != null) {
          try {
            if (typeof p.cursor !== "string" || p.cursor.length > 8192) throw new Error();
            const saved = JSON.parse(Buffer.from(p.cursor, "base64url"));
            if (saved.context !== target.versionKey || saved.turnId !== target.turnId || typeof saved.native !== "string") throw new Error();
            cursor = saved.native;
          } catch { throw new Error("Run history cursor belongs to a different execution."); }
        }
        const page = await this.historyPage(target.threadId, cursor);
        const data = page.data.filter(t => t.id === target.turnId);
        return { ...page, data, context: { laneId: target.laneId, runId: target.runId, threadId: target.threadId },
          nextCursor: !data.length && page.nextCursor ? Buffer.from(JSON.stringify({ context: target.versionKey, turnId: target.turnId, native: page.nextCursor })).toString("base64url") : null };
      }
      case "history.turn": {
        if (typeof p.turnId !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(p.turnId))
          throw new Error("Invalid turn ID.");
        const target = this.resolveHistoryTarget(bot, p);
        if (target.runId) {
          let position = p.cursor ?? null;
          for (let i = 0; i < 5; i++) {
            const page = await this.dispatch("history.page", bot.id, { ...p, cursor: position });
            if (page.data[0]) return { turn: page.data[0], nextCursor: null, context: page.context };
            position = page.nextCursor;
            if (!position) break;
          }
          return { turn: null, nextCursor: position, context: { laneId: target.laneId, runId: target.runId, threadId: target.threadId } };
        }
        let cursor = typeof p.cursor === "string" ? p.cursor : null;
        for (let i = 0; i < 5; i++) {
          const page = await this.historyPage(this.resolveHistoryTarget(bot, p).threadId, cursor);
          const turn = page.data.find((item) => item.id === p.turnId);
          if (turn) return { turn, nextCursor: null };
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        return { turn: null, nextCursor: cursor };
      }
      case "queue.list": {
        const queue = await this.queueList(bot);
        return queue.map((item) => this.publicQueued(bot, item));
      }
      case "queue.add":
      case "queue.resume":
        throw new Error("Local queue operations require atomic acceptance through handle().");
      case "queue.update": {
        const local = this.store.get("promptQueue", p.id);
        if (local) throw new Error("Local queue edits require atomic acceptance through handle().");
        const queue = await this.queueList(bot);
        const item = queue.find((x) => x.id === p.id);
        if (!item) throw new Error("Queued prompt not found.");
        const input = await this.messageInput(bot, p);
        const result = await this.submitNative("thread/queue/update", {
          threadId: bot.threadId,
          queuedSubmissionId: item.id,
          input,
        }, attempt);
        this.store.put("queuedAttachments", {
          id: item.clientUserMessageId, botId: bot.id,
          attachmentIds: p.attachments ?? [],
        });
        this.emitEvent("queue", {}, bot.id);
        return { queuedSubmission: this.publicQueued(bot, result.queuedSubmission) };
      }
      case "queue.delete": {
        const local = this.store.get("promptQueue", p.id);
        if (local) throw new Error("Local queue removal requires atomic acceptance through handle().");
        const item = (await this.queueList(bot)).find((x) => x.id === p.id);
        if (!item)
          throw new Error("Queued prompt not found.");
        const result = await this.submitNative("thread/queue/delete", {
          threadId: bot.threadId,
          queuedSubmissionId: p.id,
        }, attempt);
        this.store.remove("queuedAttachments", item.clientUserMessageId);
        this.emitEvent("queue", {}, bot.id);
        return result;
      }
      case "queue.reorder": {
        const queue = await this.queueList(bot);
        if (!Array.isArray(p.ids) || p.ids.length !== queue.length ||
            new Set(p.ids).size !== queue.length ||
            queue.some((x) => !p.ids.includes(x.id)))
          throw new Error("Reorder must include every queued prompt once.");
        const local = stagedQueue(this.store, bot.id);
        if (local.length) throw new Error("Local queue reorder requires atomic acceptance through handle().");
        const result = await this.submitNative("thread/queue/reorder", {
          threadId: bot.threadId,
          queuedSubmissionIds: p.ids,
        }, attempt);
        this.emitEvent("queue", {}, bot.id);
        return result;
      }
      case "bots.recover": {
        if (bot.threadId) return bot;
        await this.recoverCreation(bot);
        const recovered = this.store.bot(bot.id);
        if (recovered.threadId) return recovered;
        await initializeProfile(recovered);
        const result = await this.codex.call("thread/start", {
          cwd: bot.cwd,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          ephemeral: false,
          developerInstructions: this.manager
            ? `${BOT_INSTRUCTIONS}\n\n${MANAGER_INSTRUCTIONS}`
            : BOT_INSTRUCTIONS,
          ...(this.manager ? { config: this.manager.config(bot) } : {}),
          dynamicTools,
          serviceName: "dawar-todo-bots",
        });
        this.loaded.add(result.thread.id);
        return this.saveBot(recovered, {
          threadId: result.thread.id,
          status: "idle",
          error: null,
        });
      }
      case "bots.read":
        return this.saveBot(bot, { lastReadAt: now() });
      case "bots.update":
        return this.update(bot, p, id);
      case "bots.archive":
        return this.archive(bot, true, id);
      case "bots.restore":
        return this.archive(bot, false, id);
      case "turn.send": {
        const notice = id?.startsWith("manager-notice:")
          ? this.store.get("managerNotice", id.slice("manager-notice:".length))
          : null;
        const run =
          notice?.botId === bot.id && notice.runId
            ? this.store.get("run", notice.runId)
            : null;
        return this.send(bot, p, id, run, attempt);
      }
      case "turn.interrupt": {
        return this.lock(`stop:${id}`, () => stopExecutions(this, bot, id, p.scope ?? "all"));
      }
      case "thread.compact": {
        await this.load(bot);
        await this.ensureCurrentActivity(bot.id);
        if (this.store.bot(bot.id).activeTurnId || this.scheduledUncertain(bot.id))
          throw new Error("Wait for this turn to finish before compacting.");
        return this.codex.call("thread/compact/start", {
          threadId: bot.threadId,
        });
      }
      case "requests.respond":
        if (this.store.get("runPending", p.key) || this.store.get("answerExecution", `answer:${p.key}`)?.laneId)
          return this.runs.respond(bot, p, id, attempt);
        return this.respond(bot, p, attempt, id);
      case "runs.receipt":
      case "runs.requests":
      case "runs.findings":
        return this.runs.read(bot, method, p);
      case "runs.interrupt":
        this.runs.lane(bot.id, p.runId);
        return this.lock(`stop:${id}`, () => stopExecutions(this, bot, id, "run", p.runId));
      case "schedules.list":
        return {
          schedules: this.store.list("schedule", bot.id),
          runs: this.store.list("run", bot.id),
        };
      case "runs.page": {
        const limit = Number.isInteger(p.limit) ? Math.min(50, Math.max(1, p.limit)) : 25;
        const runs = this.store.list("run", bot.id)
          .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt) || b.id.localeCompare(a.id));
        const cursor = typeof p.cursor === "string" ? p.cursor : null;
        const start = cursor ? runs.findIndex((run) => run.id === cursor) + 1 : 0;
        if (cursor && start === 0) throw new Error("Run history cursor expired. Refresh the history.");
        const page = runs.slice(start, start + limit);
        const latestBySchedule = [];
        const seen = new Set();
        for (const run of runs) {
          if (!run.finishedAt || seen.has(run.scheduleId)) continue;
          seen.add(run.scheduleId);
          latestBySchedule.push(run);
        }
        return { runs: page.map(run => this.publicRun(run)), nextCursor: runs[start + limit] ? page.at(-1)?.id ?? null : null,
          latestBySchedule: latestBySchedule.map(run => this.publicRun(run)) };
      }
      case "runs.turns":
        return listRunTurns(this, bot, p);
      case "usage.bot": {
        if (!bot.threadId) return { botId: bot.id, threadId: null,
          estimatedCreditsMicros: null, reason: "No conversation thread yet." };
        try {
          const response = await this.codex.call("account/usage/read", { threadId: bot.threadId });
          const usage = response?.threadUsage;
          if (usage?.threadId !== bot.threadId)
            return { botId: bot.id, threadId: bot.threadId,
              estimatedCreditsMicros: null, reason: "Native thread usage unavailable." };
          // The native API also returns account-wide summaries. Never include them
          // in a bot estimate or forward them to this UI.
          const groups = Array.isArray(usage.groups) ? usage.groups : [];
          const tokens = {
            total: usageMetric(groups, "totalTokens"),
            input: usageMetric(groups, "inputTokens"),
            output: usageMetric(groups, "outputTokens"),
            cachedInput: usageMetric(groups, "cachedInputTokens"),
            netNewInput: usageMetric(groups, "netNewInputTokens"),
          };
          return { botId: bot.id, threadId: bot.threadId,
            estimatedCreditsMicros: nativeIntegerText(usage.estimatedUsageCreditsMicros),
            groupCount: groups.length, tokens,
            ...(!groups.length && usage.estimatedUsageCreditsMicros == null
              ? { reason: "Native thread usage unavailable." } : {}) };
        } catch {
          return { botId: bot.id, threadId: bot.threadId,
            estimatedCreditsMicros: null, reason: "Native thread usage unavailable." };
        }
      }
      case "schedules.save":
        return this.saveSchedule(bot, p, id);
      case "schedules.delete": {
        this.owned("schedule", p.id, bot.id);
        this.store.remove("schedule", p.id);
        for (const run of this.store.list("run", bot.id))
          if (run.scheduleId === p.id && run.status === "queued")
            this.store.put("run", {
              ...run,
              status: "cancelled",
              finishedAt: now(),
            });
        this.emitEvent("schedules", {}, bot.id);
        return {};
      }
      case "schedules.run": {
        const s = this.owned("schedule", p.id, bot.id);
        if (bot.archived) throw new Error("Restore this bot first.");
        const run = this.store.put("run", {
          id,
          botId: bot.id,
          scheduleId: s.id,
          title: s.title,
          prompt: s.prompt,
          origin: s.origin ?? null,
          selectedContext: s.selectedContext ?? null,
          status: "queued",
          scheduledAt: now(),
          startedAt: null,
          finishedAt: null,
          error: null,
        });
        this.emitEvent("schedules", {}, bot.id);
        return run;
      }
      case "runs.acknowledge": {
        const run = this.owned("run", p.id, bot.id);
        if (run.executionLane === "run-v1") throw new Error("An isolated run requires exact native evidence; manual acknowledgement cannot fabricate completion.");
        if (run.status !== "uncertain")
          throw new Error("This run does not need reconciliation.");
        this.store.put("run", {
          ...run,
          status: "interrupted",
          finishedAt: now(),
        });
        this.emitEvent("schedules", {}, bot.id);
        return {};
      }
      case "attachments.begin":
        return this.beginUpload(bot, p, id);
      case "attachments.chunk":
        return this.uploadChunk(bot, p);
      case "attachments.finish":
        return this.finishUpload(bot, p);
      case "attachments.read":
        return this.readAttachment(bot, p);
      default:
        throw new Error("Unsupported Bots operation.");
    }
  }
  async create(p, id) {
    if (!this.ready) throw new Error("Codex is not ready.");
    const name = cleanName(p.name),
      purpose = String(p.purpose ?? "")
        .trim()
        .slice(0, 2000);
    const base = slugify(name);
    let slug = base;
    let suffix = 2;
    const used = new Set(this.store.bots().map((b) => b.slug));
    while (
      used.has(slug) ||
      (await lstat(join(this.root, slug)).then(
        () => true,
        () => false,
      ))
    )
      slug = `${base}-${suffix++}`;
    const bot = {
      id,
      name,
      purpose,
      slug,
      cwd: join(this.root, slug),
      threadId: null,
      color: colors[randomInt(colors.length)],
      status: "provisioning",
      archived: false,
      model: null,
      effort: null,
      serviceTier: null,
      mode: "default",
      preview: "",
      updatedAt: now(),
      lastReadAt: now(),
      activeTurnId: null,
      error: null,
    };
    this.saveBot(bot);
    await initializeProfile(bot);
    const result = await this.codex.call("thread/start", {
      cwd: bot.cwd,
      model: this.defaults.model,
      serviceTier: this.defaults.serviceTier,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
      developerInstructions: this.manager
        ? `${BOT_INSTRUCTIONS}\n\n${MANAGER_INSTRUCTIONS}`
        : BOT_INSTRUCTIONS,
      config: {
        "features.fast_mode": true,
        ...(this.manager ? this.manager.config(bot) : {}),
      },
      dynamicTools,
      serviceName: "dawar-todo-bots",
    });
    // Save the mapping before any subsequent RPC can fail.
    const saved = this.saveBot(bot, {
      threadId: result.thread.id,
      status: "idle",
    });
    this.loaded.add(saved.threadId);
    await this.codex
      .call("thread/name/set", { threadId: saved.threadId, name })
      .catch(() => {});
    return saved;
  }
  async historyPage(threadId, cursor = null, limit = 20) {
    // Codex 0.156.1 can acknowledge thread/start before its rollout and
    // paginated store are readable. A full native read synchronizes that store.
    // Never turn an unavailable or corrupt history into an empty conversation.
    const delays = [100, 250, 500, 1000, 2000];
    const initializing = (error) =>
      error.message ===
        `invalid paginated history lineage for ${threadId}: missing source rollout` ||
      (error.rpcCode === -32601 &&
        error.message === "list_turns is not supported yet");
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.codex.call("thread/turns/list", {
          threadId,
          cursor,
          limit,
          sortDirection: "desc",
          itemsView: "full",
        });
      } catch (error) {
        if (
          cursor !== null ||
          !initializing(error) ||
          attempt === delays.length
        )
          throw error;
        // Use Codex's own hydration path; do not infer empty history from a
        // missing file or synthesize a replacement thread.
        try {
          await this.codex.call("thread/read", {
            threadId,
            includeTurns: true,
          });
        } catch (readError) {
          if (!initializing(readError)) throw readError;
        }
        await delay(delays[attempt]);
      }
    }
  }
  async load(bot) {
    if (!bot.threadId)
      throw new Error(bot.error ?? "This bot has not finished provisioning.");
    if (!this.loaded.has(bot.threadId)) {
      await this.codex.call("thread/resume", {
        threadId: bot.threadId,
        cwd: bot.cwd,
        model: this.settings(bot).model,
        serviceTier: this.settings(bot).serviceTier,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: this.manager
          ? `${BOT_INSTRUCTIONS}\n\n${MANAGER_INSTRUCTIONS}`
          : BOT_INSTRUCTIONS,
        config: {
          "features.fast_mode": true,
          ...(this.manager ? this.manager.config(bot) : {}),
        },
        excludeTurns: true,
      });
      this.loaded.add(bot.threadId);
    }
  }
  settings(bot, override = {}) {
    return {
      model: override.model ?? bot.model ?? this.defaults.model,
      effort: override.effort ?? bot.effort ?? this.defaults.effort,
      serviceTier:
        override.serviceTier ?? bot.serviceTier ?? this.defaults.serviceTier,
    };
  }
  async update(bot, p, operationId) {
    if (p.mode === "plan" && (await this.nativeQueueList(bot)).length)
      throw Object.assign(new Error("Let the legacy native queue finish before enabling Plan. New queued prompts are staged safely."), { definite: true });
    const name = p.name === undefined ? bot.name : cleanName(p.name);
    const model = p.model === undefined ? bot.model : p.model || null,
      effort = p.effort === undefined ? bot.effort : p.effort || null,
      serviceTier =
        p.serviceTier === undefined ? bot.serviceTier : p.serviceTier || null;
    const catalog = this.models.find(
      (m) => m.model === (model ?? this.defaults.model),
    );
    if (!catalog) throw Object.assign(new Error("That model is not available."), { definite: true });
    if (
      effort &&
      !catalog.supportedReasoningEfforts.some(
        (e) => e.reasoningEffort === effort,
      )
    )
      throw Object.assign(new Error("That reasoning effort is not available for this model."), { definite: true });
    const effectiveTier = serviceTier ?? this.defaults.serviceTier;
    if (
      effectiveTier !== "default" &&
      !catalog.serviceTiers?.some((tier) => tier.id === effectiveTier)
    )
      throw Object.assign(new Error("That speed is not available for this model."), { definite: true });
    if (p.mode !== undefined && !["default", "plan"].includes(p.mode))
      throw Object.assign(new Error("Invalid collaboration mode."), { definite: true });
    if (name !== bot.name) {
      await this.codex.call("thread/name/set", {
        threadId: bot.threadId,
        name,
      });
      const path = join(bot.cwd, "IDENTITY.md");
      const content = await readFile(path, "utf8");
      await writeFile(
        path,
        content.replace(/^- Name:.*$/m, `- Name: ${name}`),
        { mode: 0o600 },
      );
    }
    const next = {
      ...bot,
      name,
      model,
      effort,
      serviceTier,
      mode: p.mode ?? bot.mode,
    };
    if (next.model !== bot.model || next.effort !== bot.effort ||
        next.serviceTier !== bot.serviceTier || next.mode !== bot.mode)
      await this.syncQueueSettings(next);
    // Native queue advance can start the next turn without startQueued. v2
    // thread/settings/update targets subsequent turns, including during a run.
    // Notifications may change activeTurnId while that call is awaiting its
    // reply; retain those newer fields when committing the confirmed choice.
    return this.store.transaction(() => {
      if (p.mode !== undefined) for (const record of this.store.list("planExecution", bot.id))
        if (record.state === "blocked") this.store.put("planExecution", { ...record, state: "superseded", finishedAt: now() });
      return this.saveBot(this.store.bot(bot.id), { name, model, effort, serviceTier, mode: next.mode,
        ...(p.mode !== undefined ? { modeIntentId: operationId ?? randomUUID() } : {}) });
    });
  }
  async reconcileArchive(record) {
    const bot = this.store.bot(record.botId);
    const unknown = record.targets.find(t => ["dispatching", "uncertain"].includes(t.state));
    if (!unknown) return this.archive(bot, record.archived, record.id);
    const lane = this.runs.byThread(unknown.threadId);
    const paths = [...new Set([bot.cwd, lane?.markerPath].filter(Boolean))];
    const page = await this.codex.call("thread/list", { archived: record.archived, cwd: paths,
      sourceKinds: ["appServer"], cursor: record.cursorThreadId === unknown.threadId ? record.cursor ?? null : null, limit: 100 });
    if (!Array.isArray(page.data)) return null;
    const ids = new Set(page.data.map(t => t.id));
    const current = this.store.get("executionArchive", record.id);
    const targets = current.targets.map(t => ids.has(t.threadId) && ["dispatching", "uncertain"].includes(t.state) ? { ...t, state: "done", evidence: "exact-current-archive-membership" } : t);
    this.store.put("executionArchive", { ...current, targets, cursorThreadId: unknown.threadId, cursor: page.nextCursor ?? null,
      reconcileAfter: new Date(Date.now() + 30000).toISOString() });
    if (targets.some(t => ["dispatching", "uncertain"].includes(t.state))) return null;
    return this.archive(bot, record.archived, record.id);
  }
  async archive(bot, archived, operationId) {
    if (archived && this.store.list("runAdmission", bot.id).some(a => Number.isSafeInteger(a.preparingRevision)))
      throw new Error("Run preparation is still returning to its admission fence. Retry archival after it settles; its prompt was retained.");
    if (archived && (this.store.executionMetadata("runLane", bot.id).some(l => this.runs.unfinished(l)) ||
      this.store.list("executionStop", bot.id).some(s => s.state !== "done") ||
      this.store.list("managerTask", bot.id).some(t => !["completed", "failed", "interrupted", "cancelled"].includes(t.state))))
      throw new Error("Resolve all run executions, questions and retained stops before archiving this bot.");
    if (bot.activeTurnId || this.store.list("pending", bot.id).length)
      throw new Error(
        "Stop the bot and resolve pending questions before archiving.",
      );
    let archive = this.store.get("executionArchive", operationId);
    if (!archive) archive = this.store.transaction(() => {
      if (this.store.list("executionArchive", bot.id).some(a => a.state !== "done")) throw new Error("An earlier archive/restore operation still needs exact native evidence.");
      this.saveBot(this.store.bot(bot.id), { archiving: true });
      return this.store.put("executionArchive", { id: operationId, botId: bot.id, archived, state: "pending",
        targets: [...new Set([bot.threadId, ...this.store.executionMetadata("runLane", bot.id).map(l => l.threadId)].filter(Boolean))]
          .map(threadId => ({ threadId, state: "queued" })), createdAt: now() });
    });
    for (const target of archive.targets) {
      if (target.state === "done") continue;
      if (target.state !== "queued") throw new Error("Archive acknowledgement remains unconfirmed. Original thread targets were retained and not replayed.");
      target.state = "dispatching";
      this.store.put("executionArchive", archive);
      try {
        await this.codex.call(archived ? "thread/archive" : "thread/unarchive", { threadId: target.threadId });
        target.state = "done";
        this.loaded.delete(target.threadId);
        this.store.put("executionArchive", archive);
      } catch (error) {
        const saved = this.store.get("executionArchive", operationId);
        if (saved.targets.find(t => t.threadId === target.threadId)?.state === "done") { target.state = "done"; continue; }
        target.state = "uncertain"; this.store.put("executionArchive", archive); throw error;
      }
    }
    for (const schedule of this.store.list("schedule", bot.id))
      if (archived)
        this.store.put("schedule", {
          ...schedule,
          enabled: false,
          nextRunAt: null,
        });
    for (const run of this.store.list("run", bot.id))
      if (archived && run.status === "queued")
        this.store.put("run", {
          ...run,
          status: "cancelled",
          finishedAt: now(),
        });
    this.emitEvent("schedules", {}, bot.id);
    return this.store.transaction(() => {
      this.store.put("executionArchive", { ...archive, state: "done" });
      for (const lane of this.store.executionMetadata("runLane", bot.id)) this.store.put("runLane", { ...this.store.get("runLane", lane.id), archived });
      return this.saveBot(this.store.bot(bot.id), { archived, archiving: false, status: "idle" });
    });
  }
  async send(bot, p, id, run = null, attempt = null, staged = false, answer = null) {
    this.answers.assertPrepared(bot, id, answer);
    if (bot.archived || bot.archiving) throw new Error("Restore this bot or finish its retained archive operation first.");
    if (!this.ready) throw new Error("Codex is not ready.");
    if (bot.managerPaused && !id.startsWith("manager-notice:"))
      bot = this.saveBot(bot, { managerPaused: false });
    const input = staged ? p.stagedInput : await this.messageInput(bot, p);
    const text = String(p.text ?? "").trim();
    await this.load(bot);
    const additionalContext = await profileContext(bot);
    if (this.manager)
      additionalContext.managerPolicy = {
        kind: "application",
        value: MANAGER_INSTRUCTIONS,
      };
    if (run)
      additionalContext.scheduledTask = {
        kind: "application",
        value: `This is scheduled work: ${run.title}, scheduled for ${run.scheduledAt}. Use bots_report_result only for meaningful or actionable findings; routine unchanged results should remain quiet.`,
      };
    await this.ensureCurrentActivity(bot.id);
    bot = this.store.bot(bot.id);
    if (this.scheduledUncertain(bot.id, id))
      throw new Error("Scheduled execution is unconfirmed. Queue your message while its native state is reconciled.");
    if (bot.activeTurnId) {
      if (run || staged) throw new Error("Bot is busy.");
      if (this.scheduledContext(bot.id, bot.activeTurnId))
        throw new Error("A scheduled run is using this conversation. Use Queue next to keep your message separate; your draft is retained.");
      const params = { threadId: bot.threadId, expectedTurnId: bot.activeTurnId,
        clientUserMessageId: id, input, additionalContext };
      this.answers.dispatch(bot, id, answer, "turn/steer", params);
      const result = await this.submitNative("turn/steer", params, attempt);
      try { requireSteer(result, bot.activeTurnId); }
      catch (error) {
        requireCurrentActivity(this, bot.id, null, "invalid-steer-acknowledgement");
        throw error;
      }
      this.answers.accept(answer, { turnId: result.turnId, source: "steer-ack" });
      this.emitUserMessage(bot, bot.activeTurnId, id, input);
      this.saveBot(this.store.bot(bot.id), {
        preview: id.startsWith("manager-notice:")
          ? bot.preview
          : text.slice(0, 160),
        updatedAt: now(),
      });
      if (!run && bot.queuePaused && this.store.bot(bot.id).activeTurnId === bot.activeTurnId &&
          (this.store.bot(bot.id).queuePauseRevision ?? 0) === (bot.queuePauseRevision ?? 0) &&
          this.store.get("planTurnEvidence", bot.activeTurnId)?.status !== "interrupted")
        this.saveBot(this.store.bot(bot.id), { queuePaused: false });
      return result;
    }
    const result = await this.startTurn(bot, input, text, id, run, additionalContext, attempt, answer);
    if (!run && bot.queuePaused && this.store.get("planTurnEvidence", result.turn?.id)?.status !== "interrupted" &&
        (this.store.bot(bot.id).queuePauseRevision ?? 0) === (bot.queuePauseRevision ?? 0) &&
        (!this.store.bot(bot.id).activeTurnId || this.store.bot(bot.id).activeTurnId === result.turn?.id))
      this.saveBot(this.store.bot(bot.id), { queuePaused: false });
    return result;
  }
  async messageInput(bot, p) {
    const text = String(p.text ?? "").trim();
    if (text.length > 200000) throw new Error("This message is too long.");
    const attachmentIds = p.attachments ?? [];
    if (!Array.isArray(attachmentIds) || attachmentIds.length > 12)
      throw new Error("Attach at most 12 files.");
    if (!text && !attachmentIds.length)
      throw new Error("Write a message or attach a file.");
    const input = text ? [textInput(text)] : [];
    let images = 0;
    for (const attachmentId of attachmentIds) {
      const a = this.owned("attachment", attachmentId, bot.id);
      if (!a.ready)
        throw new Error("Wait for attachments to finish uploading.");
      await containedPath(bot.cwd, a.path);
      if (a.mimeType.startsWith("image/")) {
        if (++images > 6) throw new Error("Attach at most 6 images per message.");
        input.push({ type: "localImage", path: a.path });
      } else
        input.push(
          textInput(`Attached file: ${a.name}\nLocal path: ${a.path}`),
        );
    }
    return input;
  }
  publicQueued(bot, item) {
    const saved = this.store.get("queuedAttachments", item.clientUserMessageId);
    const owned = this.store.list("attachment", bot.id).filter((a) => a.ready);
    const attachments = saved?.botId === bot.id
      ? saved.attachmentIds
        .map((id) => owned.find((a) => a.id === id))
        .filter(Boolean)
      : item.input
        .map((part) => part.type === "localImage"
          ? part.path
          : part.type === "text" && part.text.startsWith("Attached file: ")
            ? part.text.split("\nLocal path: ")[1]
            : null)
        .map((path) => owned.find((a) => a.path === path))
        .filter(Boolean);
    const images = attachments.filter((a) => a.mimeType.startsWith("image/"));
    let imageIndex = 0;
    const input = item.input.map((part) => {
      if (part.type !== "image") return part;
      const image = images[imageIndex++];
      return image
        ? { type: "localImage", path: image.path }
        : textInput("[Queued image; upload metadata unavailable]");
    });
    const waitReason = item.state === "uncertain" || item.state === "dispatching" || this.activityUnresolved(bot.id) ? "delivery-unconfirmed" :
      item.state === "failed" ? "rejected" : bot.queuePaused ? "paused" :
      this.store.list("pending", bot.id).length ? "needs-input" : bot.activeTurnId ? "main-turn-running" :
      this.plans.blocked(bot.id) ? "plan-reconciliation" : null;
    return { ...item, input, waitReason,
      attachments: attachments.map((a) => this.publicAttachment(a)) };
  }
  async queueList(bot) {
    return [...await this.nativeQueueList(bot), ...stagedQueue(this.store, bot.id)];
  }
  async nativeQueueList(bot) {
    await this.load(bot);
    const items = [];
    let cursor = null;
    do {
      const page = await this.codex.call("thread/queue/list", {
        threadId: bot.threadId, cursor, limit: 100,
      });
      items.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }
  async startTurn(bot, input, text, id, run, additionalContext, attempt = null, answer = null) {
    // The boundary/owner covers preparation too, for every caller including
    // async answers that do not pass an outer composer attempt object.
    const boundary = attempt ?? { started: false, rejected: false };
    const preparationId = randomUUID();
    let activity, result;
    try {
      this.answers.assertPrepared(bot, id, answer);
      const plan = await this.plans.prepare(bot, id, run, preparationId);
      await this.ensureCurrentActivity(bot.id);
      bot = this.store.bot(bot.id);
      if (bot.activeTurnId || this.scheduledUncertain(bot.id, id))
        throw new Error("Native activity changed before dispatch. No new turn was started; queue or retry your input after reconciliation.");
      const { model, effort, serviceTier } = this.settings(bot);
      const params = {
        threadId: bot.threadId,
        clientUserMessageId: id,
        input,
        additionalContext,
        cwd: bot.cwd,
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
        model,
        effort,
        serviceTier,
        collaborationMode: {
          mode: run || id.startsWith("manager-notice:") ? "default" : bot.mode,
          settings: { model, reasoning_effort: effort, developer_instructions: null },
        },
        turnTrigger: run ? "scheduled" : "user",
      };
      activity = this.store.transaction(() => {
        const fence = beginTurnDispatch(this, bot.id, id);
        this.plans.dispatching(plan, fence);
        this.answers.dispatch(bot, id, answer, "turn/start", params, fence);
        if (run) {
          this.store.put("activeRun", { id: bot.id, botId: bot.id, runId: run.id, operationId: id, preparationId });
          if (id !== (run.operationId ?? `schedule:${run.id}`)) this.store.put("runTurn", {
            id, operationId: id, botId: bot.id, runId: run.id, threadId: bot.threadId, turnId: null,
            status: "starting", preparationId, createdAt: now(),
          });
        }
        return fence;
      });
      result = await this.submitNative("turn/start", params, boundary);
      requireTurn(result?.turn);
      this.answers.accept(answer, { turnId: result.turn.id, status: result.turn.status, source: "start-ack" });
      this.plans.bind(plan, result.turn);
      const completed = this.store.get("planTurnEvidence", result.turn.id);
      acknowledgeTurnDispatch(this, bot.id, result.turn, activity, {
        preview: id.startsWith("manager-notice:") ? bot.preview : text.slice(0, 160),
        updatedAt: now(), error: null,
      });
      this.emitUserMessage(bot, result.turn.id, id, input);
      if (run) this.recordScheduledTurn(bot.id, run.id, id,
        ["completed", "failed", "interrupted"].includes(completed?.status)
          ? { ...result.turn, status: completed.status, error: completed.error ? { message: completed.error } : null }
          : result.turn);
      this.projectTerminalTurn(bot.id, result.turn);
      return result;
    } catch (error) {
      if (boundary.started && !boundary.rejected)
        requireDispatchReconciliation(this, bot.id, activity, result?.turn);
      this.plans.rejected(id, preparationId, boundary);
      if (run && (!boundary.started || boundary.rejected) &&
          this.store.get("activeRun", bot.id)?.preparationId === preparationId) {
        this.store.remove("activeRun", bot.id);
        const receipt = this.store.get("runTurn", id);
        if (receipt?.preparationId === preparationId && !receipt.turnId)
          this.store.put("runTurn", { ...receipt, status: "failed", outcome: "rejected", error: error.message });
      }
      throw error;
    }
  }
  scheduledUncertain(botId, excludeOperationId = null) {
    if (this.activityUnresolved(botId)) return true;
    if (this.store.list("run", botId).some(run => run.executionLane !== "run-v1" && ["starting", "uncertain"].includes(run.status) &&
        (run.operationId ?? `schedule:${run.id}`) !== excludeOperationId &&
        (!run.turnId || this.store.operation(run.operationId ?? `schedule:${run.id}`)?.status !== "done"))) return true;
    if (this.store.list("runTurn", botId).some(receipt => !receipt.laneId && ["starting", "uncertain"].includes(receipt.status) &&
        (receipt.operationId ?? receipt.id) !== excludeOperationId &&
        (!receipt.turnId || this.store.operation(receipt.operationId ?? receipt.id)?.status !== "done"))) return true;
    return this.store.list("managerNotice", botId).some(notice => {
      if (notice.destination?.laneId) return false;
      if (!notice.runId) return false;
      const id = notice.operationId ?? `manager-notice:${notice.id}`;
      if (id === excludeOperationId) return false;
      const operation = this.store.operation(id);
      return operation && ["dispatching", "uncertain"].includes(operation.status);
    });
  }
  scheduledContext(botId, turnId) { return scheduledContext(this, botId, turnId); }
  recordScheduledEvidence(botId, turn) {
    if (!usableTurn(turn)) return;
    let context = this.scheduledContext(botId, turn.id);
    if (!context) for (const item of turn.items ?? []) {
      if (item.type !== "userMessage" || !item.clientId) continue;
      const savedReceipt = this.store.get("runTurn", item.clientId);
      const receipt = savedReceipt?.laneId ? null : savedReceipt;
      const run = receipt?.botId === botId ? this.store.get("run", receipt.runId) :
        this.store.list("run", botId).find(entry => entry.executionLane !== "run-v1" && (entry.operationId ?? `schedule:${entry.id}`) === item.clientId);
      if (run?.botId === botId) { context = { runId: run.id, operationId: item.clientId }; break; }
    }
    if (context) this.recordScheduledTurn(botId, context.runId, context.operationId, turn);
  }
  recordScheduledTurn(botId, runId, operationId, turn) {
    requireTurn(turn);
    this.store.transaction(() => {
      const run = this.owned("run", runId, botId);
      const evidence = this.store.get("planTurnEvidence", turn.id);
      if (evidence?.botId === botId && ["completed", "failed", "interrupted"].includes(evidence.status))
        turn = { ...turn, status: evidence.status, error: evidence.error ? { message: evidence.error } : null };
      const complete = ["completed", "failed", "interrupted"].includes(turn.status);
      // An old inProgress receipt is acceptance, not current execution proof.
      // Keep its unfinished outcome explicit without restoring/reblocking it.
      const state = { turnId: turn.id, status: turn.status === "inProgress"
        ? observedActiveTurn(this, botId, turn.id) ? "running" : "uncertain" : turn.status,
        error: turn.error?.message ?? null, ...(complete ? { finishedAt: now() } : {}) };
      const primary = operationId === (run.operationId ?? `schedule:${run.id}`);
      // Preserve the original run's execution identity when a worker notice
      // continues its scheduled context on a distinct native turn.
      if (primary && ["starting", "running", "uncertain"].includes(run.status))
        this.store.put("run", { ...run, ...state });
      else if (!primary) this.store.put("runTurn", { ...this.store.get("runTurn", operationId),
        id: operationId, botId, runId, operationId, threadId: run.threadId ?? this.store.bot(botId).threadId, ...state });
      const active = this.store.get("activeRun", botId);
      const bot = this.store.bot(botId);
      if (!complete && observedActiveTurn(this, bot.id, turn.id) &&
          (!active || active.operationId === operationId || active.turnId === turn.id))
        this.store.put("activeRun", { id: botId, botId, runId, operationId, turnId: turn.id });
      else if (complete && active && (active.operationId === operationId || active.turnId === turn.id))
        this.store.remove("activeRun", botId);
      this.emitEvent("schedules", { runTurn: primary ? null : publicRunTurn(this.store.get("runTurn", operationId)) }, botId);
    });
  }
  async startQueued(bot, item) {
    await this.ensureCurrentActivity(bot.id);
    bot = this.store.bot(bot.id);
    if (bot.activeTurnId || this.scheduledUncertain(bot.id)) throw new Error("Native activity is busy or unresolved.");
    if (this.store.list("planExecution", bot.id).some(record => record.legacyNativeReset?.outcome === "unconfirmed" ||
        record.resetOperationId && ["resetting", "uncertain"].includes(record.state)))
      throw new Error("Legacy native queue inheritance requires review of the retained native-reset receipt. Managed staged turns use explicit mode.");
    // queue/start takes only a submission ID; its turn inherits thread settings.
    const activity = captureActivity(this, bot.id);
    await this.syncQueueSettings(bot);
    if (!activityUnchanged(this, bot.id, activity) || this.activityUnresolved(bot.id) || this.store.bot(bot.id).activeTurnId)
      throw new Error("Native activity changed before the legacy queued start.");
    const dispatch = beginTurnDispatch(this, bot.id, item.id);
    let turn;
    try {
      ({ turn } = await this.codex.call("thread/queue/start", {
        threadId: bot.threadId,
        queuedSubmissionId: item.id,
      }));
      requireTurn(turn);
      acknowledgeTurnDispatch(this, bot.id, turn, dispatch, {
        preview: item.input.find((input) => input.type === "text")?.text.slice(0, 160) ?? "Attachments",
        error: null,
        updatedAt: now(),
      });
      this.emitEvent("queue", {}, bot.id);
      this.emitUserMessage(bot, turn.id, item.clientUserMessageId, item.input);
      this.projectTerminalTurn(bot.id, turn);
      return turn;
    } catch (error) {
      requireDispatchReconciliation(this, bot.id, dispatch, turn);
      throw error;
    }
  }
  async syncQueueSettings(bot) {
    const { model, effort, serviceTier } = this.settings(bot);
    await this.codex.call("thread/settings/update", {
      threadId: bot.threadId,
      cwd: bot.cwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
      model,
      effort,
      serviceTier,
      collaborationMode: {
        mode: bot.mode,
        settings: { model, reasoning_effort: effort, developer_instructions: null },
      },
    });
  }
  emitUserMessage(bot, turnId, clientId, content) {
    rememberInputProvenance(this, bot, turnId, { type: "userMessage", id: `client:${clientId}`, clientId, content });
    this.emitEvent(
      "codex",
      {
        method: "item/completed",
        params: {
          threadId: bot.threadId,
          turnId,
          item: {
            type: "userMessage",
            id: `client:${clientId}`,
            clientId,
            content,
          },
        },
      },
      bot.id,
    );
  }
  async respond(bot, p, attempt = null, outerId = null) {
    const prior = this.answers.get(bot, p.key);
    const pending = prior ? { id: prior.key, botId: bot.id, async: true, request: prior.request } : this.owned("pending", p.key, bot.id);
    if (!pending.async && pending.epoch !== this.epoch)
      throw new Error("This request expired when the runtime restarted.");
    if (pending.async) {
      const boundary = attempt ?? { started: false, rejected: false };
      const prepared = await this.answers.prepare(bot, pending, p.result, outerId, boundary);
      if (prepared.accepted) return {};
      try {
        await this.send(this.store.bot(bot.id), { text: prepared.text }, `answer:${pending.id}`, null, boundary, false, prepared.token);
        this.answers.finish(this.answers.get(bot, pending.id));
        return {};
      } catch (error) {
        this.answers.reject(prepared.token, boundary, error.message);
        throw error;
      }
    }
    const result = validateResponse(pending.request, p.result);
    // Sync native requests have no acceptance receipt; preserve the existing
    // uncertain outer-ID boundary. They do not use the async answer identity.
    if (attempt) attempt.started = true;
    this.codex.respond(pending.request.id, result);
    this.store.remove("pending", pending.id);
    this.emitEvent("request.resolved", { key: pending.id }, bot.id);
    const current = this.store.bot(bot.id);
    this.saveBot(current, { status: this.store.list("pending", bot.id).length ? "waiting" : current.activeTurnId ? "running" : "idle" });
    return {};
  }
  async onServerRequest(message) {
    if (message.method === "currentTime/read") {
      this.codex.respond(message.id, {
        currentTimeAt: Math.floor(Date.now() / 1000),
      });
      return;
    }
    if (
      message.method === "attestation/generate" ||
      message.method === "account/chatgptAuthTokens/refresh"
    ) {
      this.codex.reject(
        message.id,
        "This client uses Codex-managed authentication and does not opt into external authentication or attestation.",
      );
      return;
    }
    const threadId = message.params.threadId ?? message.params.conversationId;
    if (this.manager?.request(message)) return;
    const lane = this.runs.byThread(threadId);
    if (lane) return this.runs.request(lane, message);
    const bot = this.store.bots().find((b) => b.threadId === threadId);
    if (!bot) {
      this.codex.reject(
        message.id,
        "The request is not associated with a managed bot.",
      );
      return;
    }
    if (message.method === "item/tool/call") {
      try {
        const result = await this.dynamicTool(bot, message.params);
        this.codex.respond(message.id, {
          success: true,
          contentItems: [{ type: "inputText", text: JSON.stringify(result) }],
        });
      } catch (e) {
        this.codex.respond(message.id, {
          success: false,
          contentItems: [{ type: "inputText", text: e.message }],
        });
      }
      return;
    }
    if (!INTERACTIONS.has(message.method)) {
      this.codex.reject(
        message.id,
        "Unsupported server request for this protocol version.",
      );
      this.notify(
        bot,
        `unsupported:${message.method}`,
        "This bot needs an updated protocol adapter.",
      );
      return;
    }
    const key = `${this.epoch}:${message.id}`;
    const pending = {
      id: key,
      key,
      botId: bot.id,
      epoch: this.epoch,
      request: message,
      createdAt: now(),
    };
    this.store.put("pending", pending);
    this.emitEvent("request", pending, bot.id);
    if (message.params.isBlocking !== false)
      this.saveBot(bot, { status: "waiting" });
    this.notify(bot, `request:${key}`, `${bot.name} needs your input.`);
  }
  onNotification(message) {
    if (this.manager?.event(message)) return;
    const p = message.params ?? {};
    const threadId = p.threadId ?? p.thread?.id;
    if (["thread/archived", "thread/unarchived"].includes(message.method)) {
      for (const archive of this.store.list("executionArchive")) if (archive.state !== "done" && archive.archived === (message.method === "thread/archived")) {
        const target = archive.targets.find(t => t.threadId === threadId && ["dispatching", "uncertain"].includes(t.state));
        if (target) { target.state = "done"; this.store.put("executionArchive", archive); }
      }
    }
    const lane = this.runs.byThread(threadId);
    if (lane) { this.runs.notification(lane, message); return; }
    const bot = this.store.bots().find((b) => b.threadId === threadId);
    if (!bot) return;
    if (["turn/started", "turn/completed"].includes(message.method) &&
        (!usableTurn(p.turn) || (message.method === "turn/started" ? p.turn.status !== "inProgress" : !terminalTurn(p.turn)))) {
      requireCurrentActivity(this, bot.id, null, "invalid-native-turn-notification");
      this.emit("fault", new Error("Native turn notification has no usable identity/status; current reconciliation is required."));
      return;
    }
    if (message.method === "item/completed" && !usableTurnId(p.turnId)) return;
    if (message.method !== "turn/completed") this.plans.note(bot.id, message);
    if (message.method === "item/completed") {
      rememberInputProvenance(this, bot, p.turnId, p.item);
      if (p.item?.type === "userMessage") this.recordScheduledEvidence(bot.id, {
        id: p.turnId, status: "inProgress", items: [p.item],
      });
      if (["imageGeneration", "mcpToolCall"].includes(p.item?.type)) {
        this.pendingArtifactItems ??= 0;
        const report = (failures) => { if (failures.length) this.emitEvent("artifact.issue", { failures }, bot.id); };
        if (this.pendingArtifactItems >= 8) report([{ itemId: p.item.id, reason: "Output indexing is busy. Reopen the artifact library to recover this output from native history." }]);
        else {
          this.pendingArtifactItems++;
          void registerNativeItem(this, bot, p.turnId, p.item).then(({ failures }) => report(failures))
            .catch(() => report([{ itemId: p.item.id, reason: "Output indexing failed. Retry from the artifact library; the native output was retained." }]))
            .finally(() => { this.pendingArtifactItems--; });
        }
      }
    }
    // Keep native events intact so every renderer uses the generated protocol contract.
    this.emitEvent("codex", message, bot.id);
    if (message.method === "thread/queue/changed")
      this.emitEvent("queue", {}, bot.id);
    if (message.method === "turn/started" && !["completed", "failed", "interrupted"].includes(
      this.store.get("planTurnEvidence", p.turn.id)?.status)) {
      observeStartedTurn(this, bot.id, p.turn, {
        updatedAt: now(),
        error: null,
      });
      this.recordScheduledEvidence(bot.id, p.turn);
    }
    if (message.method === "item/completed" && p.item?.type === "agentMessage")
      this.saveBot(this.store.bot(bot.id), {
        preview: p.item.text.slice(0, 160),
        updatedAt: now(),
      });
    if (
      message.method === "item/completed" &&
      p.item?.type === "agentMessage" &&
      p.item.questions?.length
    ) {
      const key = `async:${p.item.id}`;
      if (this.answers.get(bot, key)?.state === "accepted") return;
      const request = {
        id: key,
        method: "item/tool/requestUserInput",
        params: {
          threadId: bot.threadId,
          turnId: p.turnId,
          itemId: p.item.id,
          isBlocking: false,
          questions: p.item.questions.map((q, i) => ({
            id: String(i),
            header: "Question",
            question: q.title,
            isOther: true,
            isSecret: false,
            options:
              q.options?.map((label) => ({ label, description: "" })) ?? null,
          })),
        },
      };
      const pending = {
        id: key,
        key,
        botId: bot.id,
        async: true,
        request,
        createdAt: now(),
      };
      this.store.put("pending", pending);
      this.emitEvent("request", pending, bot.id);
      this.notify(bot, key, `${bot.name} needs your input.`);
    }
    if (message.method === "serverRequest/resolved") {
      const key = `${this.epoch}:${p.requestId}`;
      this.store.remove("pending", key);
      this.emitEvent("request.resolved", { key }, bot.id);
    }
    if (message.method === "turn/completed") {
      this.recordScheduledEvidence(bot.id, p.turn);
      this.projectTerminalTurn(bot.id, p.turn);
      if (p.turn.status === "failed")
        this.notify(
          bot,
          `failure:${p.turn.id}`,
          p.turn.error?.message ?? "The bot encountered an error.",
        );
    }
  }
  saveSchedule(bot, p, id, origin = null) {
    if (bot.archived) throw new Error("Restore this bot first.");
    const existing = p.id ? this.owned("schedule", p.id, bot.id) : null;
    const schedule = normalizeSchedule(
      {
        ...p,
        timeZone: p.timeZone ?? existing?.timeZone ?? this.defaultTimeZone,
      },
      bot.id,
      existing,
    );
    if (!existing && id) schedule.id = id;
    if (!existing) schedule.origin = origin ?? { kind: "owner", operationId: id ?? null };
    this.store.put("schedule", schedule);
    this.emitEvent("schedules", {}, bot.id);
    return schedule;
  }
  async tick() {
    if (!this.ready || this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.plans.recover();
      await this.answers.recover();
      await recoverRunTurns(this);
      await reconcileActiveTurns(this);
      let recovered = 0;
      for (const item of this.store.list("promptQueue")) {
        if (!["dispatching", "uncertain"].includes(item.state) || this.locks.has(item.botId) ||
            Date.parse(item.reconcileAfter ?? "") > Date.now() || recovered >= 2) continue;
        recovered++;
        await this.lock(item.botId, () => reconcilePrompt(this, item)).catch(error => {
          this.store.put("promptQueue", { ...this.store.get("promptQueue", item.id),
            reconcileAfter: new Date(Date.now() + 30000).toISOString(), error: error.message });
        });
      }
      let runsChecked = 0;
      for (const run of this.store.list("run")) {
        if (run.executionLane === "run-v1" || !["starting", "running", "uncertain"].includes(run.status) || this.locks.has(run.botId) ||
            Date.parse(run.reconcileAfter ?? "") > Date.now() || runsChecked >= 2) continue;
        runsChecked++;
        await this.lock(run.botId, () => reconcileScheduled(this, run)).catch(error => {
          this.store.put("run", { ...this.store.get("run", run.id), reconcileAfter: new Date(Date.now() + 60000).toISOString(),
            reconciliationError: error.message });
        });
      }
      await recoverCurrentActivities(this);
      if (this.manager)
        void this.manager.tick().catch((error) => this.emit("fault", error));
      const created = collectDueRuns(this.store);
      if (created.length) this.emitEvent("schedules", {});
      void this.runs.tick().catch(error => this.emit("fault", error));
      for (const bot of this.store.bots()) {
        // Native 0.156.1 also skips interrupted thread idle and wake events.
        // Keep the bridge pause across restart until queue.resume is requested.
        if (
          bot.archived ||
          bot.archiving ||
          bot.queuePaused ||
          bot.activeTurnId ||
          this.locks.has(bot.id) ||
          this.store.list("pending", bot.id).length ||
          this.scheduledUncertain(bot.id)
        )
          continue;
        // Native dispatches after completed or failed turns. This path only
        // recovers a queue left idle after a bridge restart or explicit resume.
        let queue;
        try {
          queue = await this.queueList(bot);
        } catch (error) {
          this.emit("fault", error);
          continue;
        }
        if (queue.length) {
          void this.lock(bot.id, async () => {
            const current = this.store.bot(bot.id);
            if (current.activeTurnId || current.archived || current.queuePaused || this.scheduledUncertain(current.id) ||
                this.store.list("pending", bot.id).length) return;
            try {
              // Re-read after obtaining the lock: another client can mutate the queue.
              const first = (await this.queueList(current))[0];
              if (!first) return;
              // Only current-state authority can decide idle/active. Historical
              // inProgress rows cannot substitute for this read or reblock it.
              if (!await this.reconcileCurrentActivity(current.id)) return;
              const checked = this.store.bot(current.id);
              if (checked.activeTurnId || checked.queuePaused || this.scheduledUncertain(current.id) ||
                  this.store.list("pending", current.id).length) return;
              const activity = captureActivity(this, bot.id);
              await this.plans.settle(current.id);
              if (!activityUnchanged(this, bot.id, activity)) return;
              if (this.plans.blocked(current.id)) return;
              const local = this.store.get("promptQueue", first.id);
              if (local) await dispatchPrompt(this, this.store.bot(current.id), local);
              else await this.startQueued(this.store.bot(current.id), first);
            } catch (error) {
              // Current idle is not a receipt for the failed legacy dispatch.
              // Pause before read-only repair; no absence/text-based replay or
              // clearing a newer pause if the recovery reader also fails.
              this.saveBot(this.store.bot(bot.id), {
                queuePaused: true,
                error: `Queued prompt needs review: ${error.message}`,
              });
              await this.reconcileCurrentActivity(current.id);
            }
          }).catch((e) => this.emit("fault", e));
          continue;
        }
        const run = this.store
          .list("run", bot.id)
          .filter((r) => r.status === "queued" && r.executionLane === "main-legacy")
          .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
        if (!run) continue;
        void this.lock(bot.id, async () => {
          const current = this.store.bot(bot.id);
          if (current.activeTurnId || current.archived) return;
          if (current.queuePaused || this.plans.blocked(current.id) || this.store.list("pending", current.id).length ||
              stagedQueue(this.store, current.id).length || this.scheduledUncertain(current.id)) return;
          await dispatchScheduled(this, current, run);
        }).catch((e) => this.emit("fault", e));
      }
    } finally { this.tickRunning = false; }
  }
  async dynamicTool(bot, p, origin = null) {
    const args =
      typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
    switch (p.tool) {
      case "bots_run_message": {
        if (typeof args.operationId !== "string" || !/^[a-zA-Z0-9:_-]{10,180}$/.test(args.operationId)) throw new Error("A stable run message operationId is required.");
        const source = origin ?? { botId: bot.id, threadId: bot.threadId, turnId: p.turnId, callId: p.callId, authority: "native-tool" };
        if (!origin && (this.activityUnresolved(bot.id) || this.store.bot(bot.id).activeTurnId !== p.turnId || p.threadId !== bot.threadId))
          throw new Error("Forwarding requires the current native main turn's authority.");
        return this.lock(this.runs.lane(bot.id, args.runId).id, () => this.runs.send(bot, args, args.operationId,
          { kind: "native-forward", sourceThreadId: source.threadId, sourceTurnId: source.turnId, sourceRunId: source.runId ?? null, authority: source.authority }));
      }
      case "bots_schedule_list":
        return {
          schedules: this.store.list("schedule", bot.id),
          runs: this.store.list("run", bot.id).slice(-20),
          defaultTimeZone: this.defaultTimeZone,
        };
      case "bots_schedule_save":
        return this.saveSchedule(bot, args, `tool:${p.callId}`, { kind: "native-tool", threadId: p.threadId, turnId: p.turnId,
          callId: p.callId, runId: origin?.runId ?? null });
      case "bots_schedule_delete":
        return this.dispatch("schedules.delete", bot.id, args);
      case "bots_report_result": {
        if (origin?.runId) return this.runs.finding(bot, origin, args);
        const active = this.scheduledContext(bot.id, p.turnId);
        if (!active)
          throw new Error(
            "Result notifications are for scheduled runs. Reply normally in an interactive conversation.",
          );
        const key = String(args.key ?? "").slice(0, 200);
        const summary = String(args.summary ?? "")
          .trim()
          .slice(0, 1000);
        if (!key || !summary)
          throw new Error("Provide a finding key and summary.");
        this.notify(bot, `finding:${key}`, summary);
        return { reported: true };
      }
      case "bots_publish_artifact":
        return this.publishArtifact(bot, args, { key: origin ? `publish:${p.threadId}:${p.callId}` : `publish:${p.callId}`, turnId: p.turnId, itemId: p.callId, ...(origin ?? {}) });
      default:
        throw new Error("Unknown bot tool.");
    }
  }
  notify(bot, key, body) {
    const id = createHash("sha256")
      .update(`${bot.id}:${key}:${body}`)
      .digest("hex");
    if (!this.store.get("notice", id))
      this.store.put("notice", {
        id,
        botId: bot.id,
        title: bot.name,
        body,
        createdAt: now(),
        deliveredAt: null,
      });
  }
  publicAttachment(a) {
    if (a.ready && a.artifact) return { ...artifactMetadata(a, this.store.bot(a.botId)), artifact: true };
    const { received, sha256, ...publicData } = a;
    void received; void sha256;
    return publicData;
  }
  async beginUpload(bot, p, id) {
    const name =
      basename(String(p.name ?? "file"))
        .replace(/[\x00-\x1f]/g, "")
        .slice(0, 160) || "file";
    const size = Number(p.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE)
      throw new Error("Files must be at most 100 MB.");
    const mimeType = String(p.mimeType ?? "application/octet-stream").slice(
      0,
      100,
    );
    const dir = join(bot.cwd, "uploads", id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, name);
    await containedPath(bot.cwd, dir);
    await writeFile(path, "", { flag: "wx", mode: 0o600 });
    const a = {
      id,
      botId: bot.id,
      name,
      size,
      mimeType,
      path,
      received: 0,
      ready: false,
      createdAt: now(),
    };
    this.store.put("attachment", a);
    return this.publicAttachment(a);
  }
  async uploadChunk(bot, p) {
    const a = this.owned("attachment", p.id, bot.id);
    if (a.ready) throw new Error("This upload is already complete.");
    const offset = Number(p.offset);
    const bytes = Buffer.from(String(p.data ?? ""), "base64");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      bytes.length > CHUNK ||
      offset + bytes.length > a.size
    )
      throw new Error("Invalid upload chunk.");
    await containedPath(bot.cwd, a.path);
    const f = await open(a.path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      if (offset < a.received) {
        const previous = Buffer.alloc(bytes.length);
        await f.read(previous, 0, bytes.length, offset);
        if (!previous.equals(bytes))
          throw new Error("Upload retry contains different bytes.");
        return { received: a.received };
      }
      if (offset !== a.received)
        throw new Error("Upload chunks must be sent in order.");
      await f.write(bytes, 0, bytes.length, offset);
      await f.sync();
      this.store.put("attachment", { ...a, received: offset + bytes.length });
      return { received: offset + bytes.length };
    } finally {
      await f.close();
    }
  }
  async finishUpload(bot, p) {
    const a = this.owned("attachment", p.id, bot.id);
    await containedPath(bot.cwd, a.path);
    if (a.received !== a.size || (await stat(a.path)).size !== a.size)
      throw new Error("Upload is incomplete.");
    if (p.sha256) {
      const actual = createHash("sha256")
        .update(await readFile(a.path))
        .digest("hex");
      if (actual !== p.sha256) throw new Error("Upload checksum mismatch.");
    }
    const ready = this.store.put("attachment", { ...a, ready: true });
    this.emitEvent("attachment", this.publicAttachment(ready), bot.id);
    return this.publicAttachment(ready);
  }
  async readAttachment(bot, p) {
    const a = this.owned("attachment", p.id, bot.id);
    if (!a.ready) throw new Error("Attachment is not ready.");
    const offset = Number(p.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > a.size)
      throw new Error("Invalid file offset.");
    await containedPath(bot.cwd, a.path);
    const f = await open(a.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await containedPath(bot.cwd, `/proc/self/fd/${f.fd}`);
      const info = await f.stat();
      if (!info.isFile() || info.size !== a.size) throw new Error("Attachment file changed. Its stored metadata was retained.");
      const data = Buffer.alloc(Math.min(CHUNK, a.size - offset));
      const { bytesRead } = await f.read(data, 0, data.length, offset);
      return {
        data: data.subarray(0, bytesRead).toString("base64"),
        offset,
        nextOffset: offset + bytesRead,
        size: a.size,
        name: a.name,
        mimeType: artifactMime(a.name, a.mimeType),
      };
    } finally {
      await f.close();
    }
  }
  async publishArtifact(bot, p, context) {
    return registerArtifact(this, bot, p, context);
  }
}

export function validateResponse(request, result) {
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new Error("Invalid response.");
  switch (request.method) {
    case "item/tool/requestUserInput": {
      const answers = {};
      for (const q of request.params.questions) {
        const value = result.answers?.[q.id]?.answers;
        if (
          !Array.isArray(value) ||
          !value.every((x) => typeof x === "string") ||
          value.join("").length > 20000
        )
          throw new Error("Answer each question.");
        answers[q.id] = { answers: value };
      }
      return { answers };
    }
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      const available = request.params.availableDecisions;
      const allowed = available?.length
        ? available
        : ["accept", "acceptForSession", "decline", "cancel"];
      if (
        !allowed.some(
          (x) => JSON.stringify(x) === JSON.stringify(result.decision),
        )
      )
        throw new Error("Choose an available approval decision.");
      return { decision: result.decision };
    }
    case "execCommandApproval":
    case "applyPatchApproval": {
      if (
        !["approved", "approved_for_session", "abort"].includes(result.decision)
      )
        throw new Error("Invalid approval decision.");
      return { decision: result.decision };
    }
    case "item/permissions/requestApproval": {
      if (!["turn", "session"].includes(result.scope))
        throw new Error("Invalid permission scope.");
      const permissions = result.permissions ?? {};
      if (
        JSON.stringify(permissions) !== "{}" &&
        JSON.stringify(permissions) !==
          JSON.stringify(request.params.permissions)
      )
        throw new Error("Only the requested permissions may be granted.");
      return { permissions, scope: result.scope };
    }
    case "mcpServer/elicitation/request": {
      if (!["accept", "decline", "cancel"].includes(result.action))
        throw new Error("Invalid form action.");
      return {
        action: result.action,
        content: result.action === "accept" ? (result.content ?? {}) : null,
        _meta: null,
      };
    }
    default:
      throw new Error("This request cannot be answered by the browser.");
  }
}
