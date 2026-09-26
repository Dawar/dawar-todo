import { EventEmitter } from "node:events";
import { randomUUID, createHash, randomInt } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  open,
  copyFile,
  stat,
  lstat,
} from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { constants } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { MANAGER_INSTRUCTIONS } from "./manager-tools.mjs";
import {
  BOT_INSTRUCTIONS,
  cleanName,
  slugify,
  initializeProfile,
  profileContext,
  containedPath,
} from "./profiles.mjs";
import { normalizeSchedule, collectDueRuns } from "./schedules.mjs";

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
  "events",
  "schedules.list",
  "runs.page",
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
    const event = this.store.event({ type, data, ...(botId ? { botId } : {}) });
    this.emit("event", event);
    return event;
  }
  saveBot(bot, changes = {}) {
    const next = this.store.saveBot({ ...bot, ...changes });
    this.emitEvent("bot", next, next.id);
    return next;
  }
  async start() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const recovering = new Set(this.store.bots()
      .filter((bot) => bot.activeTurnId)
      .map((bot) => bot.id));
    // A server request is only answerable in the process that emitted it.
    for (const p of this.store.list("pending"))
      if (!p.async) this.store.remove("pending", p.id);
    for (const bot of this.store.bots())
      if (bot.activeTurnId || bot.status === "waiting")
        this.saveBot(bot, {
          activeTurnId: null,
          status: this.store.list("pending", bot.id).length
            ? "waiting"
            : "interrupted",
          error: "The runtime restarted. Checking the native conversation.",
        });
    for (const active of this.store.list("activeRun"))
      this.store.remove("activeRun", active.id);
    for (const run of this.store.list("run"))
      if (["running", "starting"].includes(run.status))
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
      if (!bot.threadId)
        try {
          await this.recoverCreation(bot);
        } catch (e) {
          this.saveBot(bot, { status: "error", error: e.message });
        }
      else if (bot.threadId && !bot.archived)
        try {
          await this.load(bot);
        } catch (e) {
          this.saveBot(bot, { status: "error", error: e.message });
        }
    }
    // The native thread owns execution across bridge restarts. Never dispatch a
    // queued prompt until its latest turn has been reconciled.
    for (const bot of this.store.bots()) {
      if (!bot.threadId || bot.archived) continue;
      try {
        const [{ thread: summary }, queue] = await Promise.all([
          this.codex.call("thread/read", {
            threadId: bot.threadId, includeTurns: false,
          }),
          this.queueList(bot),
        ]);
        if (!recovering.has(bot.id) && !queue.length &&
            summary.status?.type !== "active") continue;
        const { thread } = await this.codex.call("thread/read", {
          threadId: bot.threadId,
          includeTurns: true,
        });
        const latest = await this.latestNativeTurn(bot, thread);
        const active = thread.status?.type === "active" ||
          (!thread.status && latest?.status === "inProgress");
        if (active && latest?.status !== "inProgress")
          this.saveBot(this.store.bot(bot.id), {
            queuePaused: true,
            status: "error",
            error: "An active native turn could not be identified after restart.",
          });
        else if (active)
          this.saveBot(this.store.bot(bot.id), {
            activeTurnId: latest.id,
            status: "running",
            queuePaused: false,
            error: null,
          });
        else if (latest?.status === "interrupted")
          this.saveBot(this.store.bot(bot.id), {
            queuePaused: true,
            status: "interrupted",
            error: latest.error?.message ?? null,
          });
        else if (bot.status === "interrupted" && !bot.queuePaused)
          this.saveBot(this.store.bot(bot.id), {
            status: this.store.list("pending", bot.id).length ? "waiting" : "idle",
            error: null,
          });
      } catch (error) {
        this.saveBot(this.store.bot(bot.id), {
          queuePaused: true,
          status: "error",
          error: `Queue recovery needs review: ${error.message}`,
        });
      }
    }
    await this.reconcileOperations();
    for (const run of this.store
      .list("run")
      .filter((r) => r.status === "uncertain")) {
      try {
        const bot = this.store.bot(run.botId);
        const { thread } = await this.codex.call("thread/read", {
          threadId: bot.threadId,
          includeTurns: true,
        });
        const turn = thread.turns.find(
          (t) =>
            t.id === run.turnId ||
            t.items?.some((i) => i.clientId === `schedule:${run.id}`),
        );
        if (turn && turn.status !== "inProgress")
          this.store.put("run", {
            ...run,
            status: turn.status,
            finishedAt: now(),
            error: turn.error?.message ?? null,
          });
      } catch {
        /* Leave uncertain until reviewed. */
      }
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
          const { thread } = await this.codex.call("thread/read", {
            threadId: bot.threadId,
            includeTurns: true,
          });
          const turn = thread.turns?.find((t) =>
            t.items?.some((i) => i.clientId === op.id),
          );
          if (turn) result = op.method === "queue.add"
            ? { consumedTurnId: turn.id }
            : { turn };
        } catch {
          /* Native state is unavailable; never replay an uncertain mutation. */
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
      runs: this.store
        .list("run")
        .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))
        .slice(0, 100),
    };
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
    return this.lock(botId ?? "create", async () => {
      const existing = this.store.operation(operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error("Operation ID was reused with different input.");
        if (existing.status === "done") return existing.result;
        if (["dispatching", "uncertain"].includes(existing.status)) {
          const result = await this.reconcileOperation(existing);
          if (result) return result;
        }
        throw new Error(
          this.store.operation(operationId).error ??
            "This operation may already have run. Refresh the conversation before retrying.",
        );
      }
      const data = { method, botId, params, createdAt: now() };
      this.store.saveOperation(operationId, fingerprint, "dispatching", data);
      try {
        const result = await this.dispatch(method, botId, params, operationId);
        this.store.saveOperation(operationId, fingerprint, "done", {
          ...data,
          result,
        });
        return result;
      } catch (e) {
        const uncertain =
          /timed out|disconnected|acknowledg/i.test(e.message) && !e.definite;
        this.store.saveOperation(
          operationId,
          fingerprint,
          uncertain ? "uncertain" : "failed",
          { ...data, error: e.message },
        );
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
  async dispatch(method, botId, p, id) {
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
    const bot = this.store.bot(String(botId));
    switch (method) {
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
      case "history.page":
        return this.historyPage(bot.threadId, p.cursor ?? null);
      case "history.turn": {
        if (typeof p.turnId !== "string" || !/^[a-zA-Z0-9-]{8,100}$/.test(p.turnId))
          throw new Error("Invalid turn ID.");
        let cursor = typeof p.cursor === "string" ? p.cursor : null;
        for (let i = 0; i < 5; i++) {
          const page = await this.historyPage(bot.threadId, cursor);
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
      case "queue.add": {
        if (bot.archived) throw new Error("Restore this bot first.");
        if (!this.ready) throw new Error("Codex is not ready.");
        const input = await this.messageInput(bot, p);
        await this.load(bot);
        await this.syncQueueSettings(bot);
        // Native snapshots localImage to inline data URLs. Save IDs first so
        // previews and edits survive a lost queue/add acknowledgement.
        this.store.put("queuedAttachments", {
          id, botId: bot.id, attachmentIds: p.attachments ?? [],
        });
        const result = await this.codex.call("thread/queue/add", {
          threadId: bot.threadId,
          input,
          clientUserMessageId: id,
        });
        this.emitEvent("queue", {}, bot.id);
        return { queuedSubmission: this.publicQueued(bot, result.queuedSubmission) };
      }
      case "queue.update": {
        const queue = await this.queueList(bot);
        const item = queue.find((x) => x.id === p.id);
        if (!item) throw new Error("Queued prompt not found.");
        const input = await this.messageInput(bot, p);
        const result = await this.codex.call("thread/queue/update", {
          threadId: bot.threadId,
          queuedSubmissionId: item.id,
          input,
        });
        this.store.put("queuedAttachments", {
          id: item.clientUserMessageId, botId: bot.id,
          attachmentIds: p.attachments ?? [],
        });
        this.emitEvent("queue", {}, bot.id);
        return { queuedSubmission: this.publicQueued(bot, result.queuedSubmission) };
      }
      case "queue.delete": {
        const item = (await this.queueList(bot)).find((x) => x.id === p.id);
        if (!item)
          throw new Error("Queued prompt not found.");
        const result = await this.codex.call("thread/queue/delete", {
          threadId: bot.threadId,
          queuedSubmissionId: p.id,
        });
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
        const result = await this.codex.call("thread/queue/reorder", {
          threadId: bot.threadId,
          queuedSubmissionIds: p.ids,
        });
        this.emitEvent("queue", {}, bot.id);
        return result;
      }
      case "queue.resume": {
        if (bot.archived) throw new Error("Restore this bot first.");
        const { thread } = await this.codex.call("thread/read", {
          threadId: bot.threadId, includeTurns: true,
        });
        const latest = await this.latestNativeTurn(bot, thread);
        const active = thread.status?.type === "active" ||
          (!thread.status && latest?.status === "inProgress");
        if (active && latest?.status !== "inProgress")
          throw new Error("The active native turn could not be identified. Refresh before resuming the queue.");
        const waiting = this.store.list("pending", bot.id).length > 0;
        this.saveBot(bot, { queuePaused: false, error: null,
          activeTurnId: active ? latest.id : null,
          status: waiting ? "waiting" : active ? "running" : "idle" });
        setImmediate(() => void this.tick().catch((e) => this.emit("fault", e)));
        return {};
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
        return this.update(bot, p);
      case "bots.archive":
        return this.archive(bot, true);
      case "bots.restore":
        return this.archive(bot, false);
      case "turn.send": {
        const notice = id?.startsWith("manager-notice:")
          ? this.store.get("managerNotice", id.slice("manager-notice:".length))
          : null;
        const run =
          notice?.botId === bot.id && notice.runId
            ? this.store.get("run", notice.runId)
            : null;
        return this.send(bot, p, id, run);
      }
      case "turn.interrupt": {
        this.saveBot(bot, { queuePaused: true });
        const operations = [];
        if (this.manager) operations.push(this.manager.stop(bot));
        if (bot.activeTurnId)
          operations.push(
            this.codex.call("turn/interrupt", {
              threadId: bot.threadId,
              turnId: bot.activeTurnId,
            }),
          );
        const outcomes = await Promise.allSettled(operations);
        const failed = outcomes.find((r) => r.status === "rejected");
        if (failed) throw failed.reason;
        return {};
      }
      case "thread.compact": {
        if (bot.activeTurnId)
          throw new Error("Wait for this turn to finish before compacting.");
        await this.load(bot);
        return this.codex.call("thread/compact/start", {
          threadId: bot.threadId,
        });
      }
      case "requests.respond":
        return this.respond(bot, p);
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
        return { runs: page, nextCursor: runs[start + limit] ? page.at(-1)?.id ?? null : null,
          latestBySchedule };
      }
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
  async historyPage(threadId, cursor = null) {
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
          limit: 20,
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
  async update(bot, p) {
    const name = p.name === undefined ? bot.name : cleanName(p.name);
    const model = p.model === undefined ? bot.model : p.model || null,
      effort = p.effort === undefined ? bot.effort : p.effort || null,
      serviceTier =
        p.serviceTier === undefined ? bot.serviceTier : p.serviceTier || null;
    const catalog = this.models.find(
      (m) => m.model === (model ?? this.defaults.model),
    );
    if (!catalog) throw new Error("That model is not available.");
    if (
      effort &&
      !catalog.supportedReasoningEfforts.some(
        (e) => e.reasoningEffort === effort,
      )
    )
      throw new Error("That reasoning effort is not available for this model.");
    const effectiveTier = serviceTier ?? this.defaults.serviceTier;
    if (
      effectiveTier !== "default" &&
      !catalog.serviceTiers?.some((tier) => tier.id === effectiveTier)
    )
      throw new Error("That speed is not available for this model.");
    if (p.mode !== undefined && !["default", "plan"].includes(p.mode))
      throw new Error("Invalid collaboration mode.");
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
    return this.saveBot(bot, next);
  }
  async archive(bot, archived) {
    if (bot.activeTurnId || this.store.list("pending", bot.id).length)
      throw new Error(
        "Stop the bot and resolve pending questions before archiving.",
      );
    if (archived) {
      await this.codex.call("thread/archive", { threadId: bot.threadId });
      this.loaded.delete(bot.threadId);
    } else {
      await this.codex.call("thread/unarchive", { threadId: bot.threadId });
      this.loaded.delete(bot.threadId);
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
    return this.saveBot(bot, { archived, status: "idle" });
  }
  async send(bot, p, id, run = null) {
    if (bot.archived) throw new Error("Restore this bot first.");
    if (!this.ready) throw new Error("Codex is not ready.");
    if (bot.managerPaused && !id.startsWith("manager-notice:"))
      bot = this.saveBot(bot, { managerPaused: false });
    const input = await this.messageInput(bot, p);
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
    if (bot.activeTurnId) {
      if (run) throw new Error("Bot is busy.");
      const result = await this.codex.call("turn/steer", {
        threadId: bot.threadId,
        expectedTurnId: bot.activeTurnId,
        clientUserMessageId: id,
        input,
        additionalContext,
      });
      this.emitUserMessage(bot, bot.activeTurnId, id, input);
      this.saveBot(this.store.bot(bot.id), {
        preview: id.startsWith("manager-notice:")
          ? bot.preview
          : text.slice(0, 160),
        updatedAt: now(),
      });
      if (!run && bot.queuePaused)
        this.saveBot(this.store.bot(bot.id), { queuePaused: false });
      return result;
    }
    const result = await this.startTurn(bot, input, text, id, run, additionalContext);
    if (!run && bot.queuePaused)
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
    return { ...item, input,
      attachments: attachments.map((a) => this.publicAttachment(a)) };
  }
  async queueList(bot) {
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
  async latestNativeTurn(bot, thread) {
    let latest = thread.turns?.at(-1);
    if (thread.status?.type === "active" && latest?.status !== "inProgress") {
      const page = await this.historyPage(bot.threadId);
      latest = page.data.find((turn) => turn.status === "inProgress") ?? latest;
    }
    return latest;
  }
  async startTurn(bot, input, text, id, run, additionalContext) {
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
        mode: run ? "default" : bot.mode,
        settings: {
          model,
          reasoning_effort: effort,
          developer_instructions: null,
        },
      },
      turnTrigger: run ? "scheduled" : "user",
    };
    if (run)
      this.store.put("activeRun", { id: bot.id, botId: bot.id, runId: run.id });
    const result = await this.codex.call("turn/start", params);
    this.emitUserMessage(bot, result.turn.id, id, input);
    const current = this.store.bot(bot.id);
    if (result.turn.status === "inProgress")
      this.saveBot(current, {
        activeTurnId: result.turn.id,
        status: this.store
          .list("pending", bot.id)
          .some((x) => x.request.params.isBlocking !== false)
          ? "waiting"
          : "running",
        preview: id.startsWith("manager-notice:")
          ? bot.preview
          : text.slice(0, 160),
        updatedAt: now(),
        error: null,
      });
    if (run) {
      const currentRun = this.store.get("run", run.id);
      if (currentRun?.status === "starting")
        this.store.put("run", {
          ...currentRun,
          status: "running",
          turnId: result.turn.id,
        });
    }
    return result;
  }
  async startQueued(bot, item) {
    // queue/start takes only a submission ID; its turn inherits thread settings.
    await this.syncQueueSettings(bot);
    const { turn } = await this.codex.call("thread/queue/start", {
      threadId: bot.threadId,
      queuedSubmissionId: item.id,
    });
    this.emitEvent("queue", {}, bot.id);
    this.emitUserMessage(bot, turn.id, item.clientUserMessageId, item.input);
    if (turn.status === "inProgress")
      this.saveBot(this.store.bot(bot.id), {
        activeTurnId: turn.id,
        status: "running",
        preview: item.input.find((input) => input.type === "text")?.text.slice(0, 160) ?? "Attachments",
        error: null,
        updatedAt: now(),
      });
    return turn;
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
  async respond(bot, p) {
    const pending = this.owned("pending", p.key, bot.id);
    if (!pending.async && pending.epoch !== this.epoch)
      throw new Error("This request expired when the runtime restarted.");
    const result = validateResponse(pending.request, p.result);
    if (pending.async) {
      const text = pending.request.params.questions
        .map((q) => `${q.question}\n${result.answers[q.id].answers.join("\n")}`)
        .join("\n\n");
      await this.send(this.store.bot(bot.id), { text }, `answer:${pending.id}`);
    } else this.codex.respond(pending.request.id, result);
    this.store.remove("pending", pending.id);
    this.emitEvent("request.resolved", { key: pending.id }, bot.id);
    const current = this.store.bot(bot.id);
    this.saveBot(current, {
      status: this.store.list("pending", bot.id).length
        ? "waiting"
        : current.activeTurnId
          ? "running"
          : "idle",
    });
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
    const bot = this.store.bots().find((b) => b.threadId === threadId);
    if (!bot) return;
    // Keep native events intact so every renderer uses the generated protocol contract.
    this.emitEvent("codex", message, bot.id);
    if (message.method === "thread/queue/changed")
      this.emitEvent("queue", {}, bot.id);
    if (message.method === "turn/started")
      this.saveBot(bot, {
        activeTurnId: p.turn.id,
        status: "running",
        updatedAt: now(),
        error: null,
      });
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
      // Native queue dispatch can start the next turn before this notification
      // is delivered. Do not clear that newer turn's active ID.
      const newerActive = this.store.bot(bot.id).activeTurnId &&
        this.store.bot(bot.id).activeTurnId !== p.turn.id;
      for (const pending of this.store.list("pending", bot.id))
        if (!pending.async && pending.request.params.turnId === p.turn.id) {
          this.store.remove("pending", pending.id);
          this.emitEvent("request.resolved", { key: pending.id }, bot.id);
        }
      const failed = p.turn.status === "failed";
      if (p.turn.status === "interrupted")
        this.saveBot(this.store.bot(bot.id), { queuePaused: true });
      const error = p.turn.error?.message ?? null;
      if (!newerActive)
        this.saveBot(this.store.bot(bot.id), {
          activeTurnId: null,
          status: failed
            ? "error"
            : p.turn.status === "interrupted"
              ? "interrupted"
              : this.store.list("pending", bot.id).length
                ? "waiting"
                : "idle",
          error,
          updatedAt: now(),
        });
      const active = this.store.get("activeRun", bot.id);
      if (active) {
        const run = this.store.get("run", active.runId);
        if (run)
          this.store.put("run", {
            ...run,
            status: p.turn.status,
            finishedAt: now(),
            error,
          });
        this.store.remove("activeRun", bot.id);
        this.emitEvent("schedules", {}, bot.id);
      }
      if (failed)
        this.notify(
          bot,
          `failure:${p.turn.id}`,
          error ?? "The bot encountered an error.",
        );
    }
  }
  saveSchedule(bot, p, id) {
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
    this.store.put("schedule", schedule);
    this.emitEvent("schedules", {}, bot.id);
    return schedule;
  }
  async tick() {
    if (!this.ready) return;
    if (this.manager)
      void this.manager.tick().catch((error) => this.emit("fault", error));
    const created = collectDueRuns(this.store);
    if (created.length) this.emitEvent("schedules", {});
    for (const bot of this.store.bots()) {
      // Native 0.156.1 also skips interrupted thread idle and wake events.
      // Keep the bridge pause across restart until queue.resume is requested.
      if (
        bot.archived ||
        bot.queuePaused ||
        bot.activeTurnId ||
        bot.workerTasks?.active ||
        bot.workerTasks?.waiting ||
        this.locks.has(bot.id) ||
        this.store.list("pending", bot.id).length ||
        this.store.list("run", bot.id).some((r) => r.status === "uncertain")
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
          if (current.activeTurnId || current.archived || current.queuePaused ||
              current.workerTasks?.active || current.workerTasks?.waiting ||
              this.store.list("pending", bot.id).length) return;
          let first;
          try {
            // Re-read after obtaining the lock: another client can mutate the queue.
            first = (await this.queueList(current))[0];
            if (!first) return;
            const { thread } = await this.codex.call("thread/read", {
              threadId: current.threadId, includeTurns: true,
            });
            const latest = await this.latestNativeTurn(current, thread);
            const active = thread.status?.type === "active" ||
              (!thread.status && latest?.status === "inProgress");
            if (active && latest?.status !== "inProgress")
              throw new Error("An active native turn could not be identified.");
            if (active) {
              this.saveBot(this.store.bot(bot.id), {
                activeTurnId: latest.id, status: "running", error: null,
              });
              return;
            }
            await this.startQueued(current, first);
          } catch (error) {
            try {
              const [{ thread }, remaining] = await Promise.all([
                this.codex.call("thread/read", {
                  threadId: current.threadId, includeTurns: true,
                }),
                this.queueList(current),
              ]);
              const latest = await this.latestNativeTurn(current, thread);
              const active = thread.status?.type === "active" ||
                (!thread.status && latest?.status === "inProgress");
              if (active && latest?.status === "inProgress") {
                this.saveBot(this.store.bot(bot.id), {
                  activeTurnId: latest.id, status: "running",
                  queuePaused: false, error: null,
                });
                return;
              }
              if (first && !remaining.some((item) => item.id === first.id) ||
                  /active or pending turn/i.test(error.message)) return;
            } catch {
              // Preserve the queue for review when native state cannot be read.
            }
            this.saveBot(this.store.bot(bot.id), {
              queuePaused: true, status: "error",
              error: `Queued prompt needs review: ${error.message}`,
            });
          }
        }).catch((e) => this.emit("fault", e));
        continue;
      }
      const run = this.store
        .list("run", bot.id)
        .filter((r) => r.status === "queued")
        .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
      if (!run) continue;
      void this.lock(bot.id, async () => {
        const current = this.store.bot(bot.id);
        if (current.activeTurnId || current.archived) return;
        this.store.put("run", { ...run, status: "starting", startedAt: now() });
        try {
          await this.send(
            current,
            {
              text: run.prompt,
            },
            `schedule:${run.id}`,
            run,
          );
        } catch (e) {
          const uncertain = /timed out|disconnected/i.test(e.message);
          this.store.put("run", {
            ...run,
            status: uncertain ? "uncertain" : "failed",
            error: e.message,
            finishedAt: now(),
          });
          this.store.remove("activeRun", bot.id);
          this.notify(current, `schedule-failure:${run.id}`, e.message);
        }
        this.emitEvent("schedules", {}, bot.id);
      }).catch((e) => this.emit("fault", e));
    }
  }
  async dynamicTool(bot, p) {
    const args =
      typeof p.arguments === "string" ? JSON.parse(p.arguments) : p.arguments;
    switch (p.tool) {
      case "bots_schedule_list":
        return {
          schedules: this.store.list("schedule", bot.id),
          runs: this.store.list("run", bot.id).slice(-20),
          defaultTimeZone: this.defaultTimeZone,
        };
      case "bots_schedule_save":
        return this.saveSchedule(bot, args, `tool:${p.callId}`);
      case "bots_schedule_delete":
        return this.dispatch("schedules.delete", bot.id, args);
      case "bots_report_result": {
        const active = this.store.get("activeRun", bot.id);
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
        return this.publishArtifact(bot, args);
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
    const { received, ...publicData } = a;
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
      const data = Buffer.alloc(Math.min(CHUNK, a.size - offset));
      const { bytesRead } = await f.read(data, 0, data.length, offset);
      return {
        data: data.subarray(0, bytesRead).toString("base64"),
        offset,
        nextOffset: offset + bytesRead,
        size: a.size,
        name: a.name,
        mimeType: a.mimeType,
      };
    } finally {
      await f.close();
    }
  }
  async publishArtifact(bot, p) {
    const source = resolve(bot.cwd, String(p.path));
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE)
      throw new Error("Publish a regular file of at most 100 MB.");
    const id = randomUUID(),
      name = basename(source),
      dir = join(bot.cwd, "artifacts", id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await containedPath(bot.cwd, dir);
    const path = join(dir, name);
    await copyFile(source, path, constants.COPYFILE_EXCL);
    const a = this.store.put("attachment", {
      id,
      botId: bot.id,
      name,
      path,
      size: info.size,
      mimeType: String(p.mimeType ?? "application/octet-stream"),
      ready: true,
      received: info.size,
      createdAt: now(),
      artifact: true,
    });
    this.emitEvent("attachment", this.publicAttachment(a), bot.id);
    return {
      attachmentId: id,
      name,
      markdown: `[${name}](bot-artifact:${id})`,
    };
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
