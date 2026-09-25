import { createServer } from "node:http";
import {
  randomUUID,
  randomBytes,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, chmod, unlink, realpath } from "node:fs/promises";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGER_TOOLS, WORKER_INSTRUCTIONS } from "./manager-tools.mjs";
import { validateResponse } from "./runtime.mjs";
import { slugify, cleanName } from "./profiles.mjs";

const exec = promisify(execFile);
const now = () => new Date().toISOString();
const terminal = new Set(["completed", "failed", "interrupted", "cancelled"]);
const sources = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];
const required = (value, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > 200000)
    throw new Error(`${label} is required.`);
  return value.trim();
};
const git = async (cwd, args) =>
  (
    await exec("git", ["-C", cwd, ...args], {
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  ).stdout.trim();
const pageParams = (p) => ({
  cursor: p.cursor ?? null,
  limit: Math.max(1, Math.min(100, p.limit ?? 30)),
});
const resultText = (turn) =>
  (turn?.items ?? [])
    .filter((i) => i.type === "agentMessage")
    .map((i) => i.text)
    .join("\n\n")
    .slice(-24000);

export class CodexManager {
  constructor({ runtime, store, directory }) {
    Object.assign(this, {
      runtime,
      store,
      codex: runtime.codex,
      directory: resolve(directory),
    });
    this.socketPath = join(this.directory, "manager.sock");
    this.tokens = new Map();
    this.loaded = new Set();
    this.tickRunning = false;
    this.concurrency = Math.max(
      1,
      Math.min(16, Number(process.env.BOTS_WORKER_CONCURRENCY) || 4),
    );
  }
  config(bot) {
    if (!this.tokens.has(bot.id))
      this.tokens.set(bot.id, randomBytes(32).toString("hex"));
    return {
      "mcp_servers.codex_manager": {
        command: process.execPath,
        args: [
          join(dirname(fileURLToPath(import.meta.url)), "manager-mcp.mjs"),
          this.socketPath,
          bot.id,
        ],
        env: { DAWAR_MANAGER_TOKEN: this.tokens.get(bot.id) },
        startup_timeout_sec: 15,
        tool_timeout_sec: 120,
        required: true,
      },
    };
  }
  workerConfig() {
    // Even a disabled server must have a valid transport in 0.156.1.
    return {
      "mcp_servers.codex_manager": {
        command: process.execPath,
        args: [],
        enabled: false,
      },
    };
  }
  async listen() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Service has a single systemd owner; stale sockets are not persisted state.
    await unlink(this.socketPath).catch((e) => {
      if (e.code !== "ENOENT") throw e;
    });
    this.server = createServer(async (req, res) => {
      const respond = (status, value) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (req.method !== "POST" || req.url !== "/tools/call")
        return respond(404, { error: "Not found." });
      try {
        let size = 0,
          chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 256 * 1024)
            return respond(413, { error: "Request too large." });
          chunks.push(chunk);
        }
        const { botId, name, args } = JSON.parse(Buffer.concat(chunks));
        const expected = this.tokens.get(botId),
          token = String(req.headers.authorization ?? "").replace(
            /^Bearer /,
            "",
          );
        if (
          !expected ||
          token.length !== expected.length ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
        )
          return respond(403, { error: "Invalid manager session." });
        respond(200, { result: await this.call(botId, name, args) });
      } catch (error) {
        respond(400, { error: error.message });
      }
    });
    await new Promise((yes, no) => {
      this.server.once("error", no);
      this.server.listen(this.socketPath, yes);
    });
    await chmod(this.socketPath, 0o600);
  }
  async close() {
    if (this.server) await new Promise((yes) => this.server.close(yes));
    await unlink(this.socketPath).catch(() => {});
  }
  owned(kind, id, botId) {
    const value = this.store.get(kind, String(id));
    if (!value || value.botId !== botId)
      throw new Error("Record is not owned by this manager.");
    return value;
  }
  workerFor(threadId) {
    return this.store
      .list("managerWorker")
      .find((w) => w.threadId === threadId && w.state !== "deleted");
  }
  put(kind, value) {
    const next = this.store.put(kind, { ...value, updatedAt: now() });
    this.runtime.emitEvent(
      "manager",
      { kind, id: next.id, state: next.state },
      next.botId,
    );
    if (["managerTask", "managerWorker"].includes(kind))
      this.refreshStats(next.botId);
    return next;
  }
  refreshStats(botId) {
    const tasks = this.store.list("managerTask", botId);
    const workers = this.store.list("managerWorker", botId);
    const workerTasks = {
      active: tasks.filter((t) =>
        ["queued", "starting", "running"].includes(t.state),
      ).length,
      waiting: workers.filter((w) => w.state === "waiting").length,
    };
    const bot = this.store.bot(botId);
    if (JSON.stringify(bot.workerTasks) !== JSON.stringify(workerTasks))
      this.runtime.saveBot(bot, { workerTasks });
  }
  async stop(bot) {
    this.runtime.saveBot(this.store.bot(bot.id), { managerPaused: true });
    for (const task of this.store.list("managerTask", bot.id))
      if (["queued", "waiting"].includes(task.state))
        this.finish(task, "cancelled", "Stopped by the human.");
    for (const notice of this.store.list("managerNotice", bot.id))
      if (notice.state === "queued")
        this.store.put("managerNotice", { ...notice, state: "held" });
    const outcomes = await Promise.allSettled(
      this.store
        .list("managerWorker", bot.id)
        .filter((worker) => worker.activeTurnId)
        .map((worker) =>
          this.codex.call("turn/interrupt", {
            threadId: worker.threadId,
            turnId: worker.activeTurnId,
          }),
        ),
    );
    const failed = outcomes.find((r) => r.status === "rejected");
    if (failed) throw failed.reason;
  }
  async call(botId, name, args) {
    const bot = this.store.bot(botId);
    if (bot.archived)
      throw new Error("Restore this manager before using its tools.");
    const tool = MANAGER_TOOLS.find((t) => t.name === name);
    if (
      !tool ||
      !args ||
      !tool.inputSchema.properties.operation.enum.includes(args.operation)
    )
      throw new Error("Unknown manager operation.");
    const read =
      ["list", "read", "status", "requests", "review"].includes(
        args.operation,
      ) ||
      (name === "codex_organize" &&
        args.operation === "housekeep" &&
        !args.apply);
    if (read) return this.dispatch(bot, name, args);
    const opId = required(args.operationId, "operationId");
    if (opId.length > 160) throw new Error("operationId is too long.");
    const id = createHash("sha256").update(`${botId}:${opId}`).digest("hex");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ name, args }))
      .digest("hex");
    return this.runtime.lock(`manager:${botId}`, async () => {
      const prior = this.store.get("managerOperation", id);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error("operationId was reused with different input.");
        if (prior.state === "done") return prior.result;
        throw new Error(
          `Operation ${opId} is ${prior.state}: ${prior.error ?? "Inspect status before any retry."}`,
        );
      }
      const operation = {
        id,
        botId,
        opId,
        name,
        args,
        fingerprint,
        state: "dispatching",
        createdAt: now(),
      };
      this.store.put("managerOperation", operation);
      try {
        const result = await this.dispatch(bot, name, args, id);
        this.store.put("managerOperation", {
          ...operation,
          state: "done",
          result,
          finishedAt: now(),
        });
        return result;
      } catch (error) {
        // Conservatively preserve uncertainty; multi-step operations may have
        // created a worktree or thread before a subsequent native request failed.
        this.store.put("managerOperation", {
          ...operation,
          state: "uncertain",
          error: error.message,
          finishedAt: now(),
        });
        throw error;
      }
    });
  }
  async dispatch(bot, name, p, id) {
    if (name === "codex_projects") return this.projects(bot, p, id);
    if (name === "codex_threads") return this.threads(bot, p, id);
    if (name === "codex_sections") return this.sections(bot, p);
    if (name === "codex_worktrees") {
      if (p.operation === "create") return this.createWorktree(bot, p, id);
      if (p.operation === "remove") return this.removeWorktree(bot, p);
      return Promise.all(
        this.store.list("managerWorktree", bot.id).map(async (w) => ({
          ...w,
          gitStatus:
            w.state === "removed"
              ? null
              : await git(w.path, ["status", "--short"]).catch(
                  (e) => e.message,
                ),
        })),
      );
    }
    if (name === "codex_tasks") return this.tasks(bot, p, id);
    if (name === "codex_organize") return this.organize(bot, p);
    throw new Error("Unknown manager tool.");
  }
  async directoryPath(path) {
    if (!isAbsolute(required(path, "Absolute directory path")))
      throw new Error("Use an absolute directory path.");
    return realpath(path);
  }
  async projects(bot, p, id) {
    if (p.operation === "list")
      return this.codex.call("project/list", pageParams(p));
    if (p.operation === "read")
      return this.codex.call("project/read", {
        projectId: required(p.projectId, "projectId"),
      });
    if (p.operation === "delete") {
      if (!p.confirm)
        throw new Error("Project deletion requires confirm=true.");
      for (const archived of [false, true]) {
        const page = await this.codex.call("thread/list", {
          projectId: p.projectId,
          archived,
          sourceKinds: sources,
          limit: 1,
        });
        if (page.data.length)
          throw new Error("The project still contains native tasks.");
      }
      return this.codex.call("project/delete", {
        projectId: required(p.projectId, "projectId"),
      });
    }
    const roots = p.roots
      ? await Promise.all(
          p.roots.map(async (path) => ({
            path: await this.directoryPath(path),
          })),
        )
      : undefined;
    if (p.operation === "create") {
      if (!roots?.length)
        throw new Error("A project needs at least one root directory.");
      return this.codex.call("project/create", {
        name: cleanName(p.name),
        roots,
        metadata: p.metadata,
        idempotencyKey: id,
      });
    }
    return this.codex.call("project/update", {
      projectId: required(p.projectId, "projectId"),
      ...(p.name ? { name: cleanName(p.name) } : {}),
      ...(roots ? { roots } : {}),
      ...(p.metadata ? { metadata: p.metadata } : {}),
    });
  }
  async rootFor(p) {
    if (p.projectId) {
      const { project } = await this.codex.call("project/read", {
        projectId: p.projectId,
      });
      return this.directoryPath(p.cwd ?? p.root ?? project.roots[0]?.path);
    }
    return this.directoryPath(p.cwd ?? p.root);
  }
  async createWorktree(bot, p, id) {
    const root = await git(await this.rootFor(p), [
      "rev-parse",
      "--show-toplevel",
    ]);
    const ref = await git(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${p.ref ?? "HEAD"}^{commit}`,
    ]);
    const branch =
      p.branch ?? `codex/${slugify(p.name ?? "worker")}-${id.slice(0, 8)}`;
    await git(root, ["check-ref-format", "--branch", branch]);
    const path = join(this.directory, "worktrees", id);
    const record = {
      id,
      botId: bot.id,
      projectId: p.projectId ?? null,
      root,
      path,
      branch,
      baseCommit: ref,
      state: "creating",
      createdAt: now(),
    };
    this.put("managerWorktree", record);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await git(root, ["worktree", "add", "-b", branch, path, ref]);
    return this.put("managerWorktree", { ...record, state: "ready" });
  }
  async removeWorktree(bot, p) {
    const w = this.owned("managerWorktree", p.id, bot.id);
    if (w.state === "removed") return w;
    const workers = this.store
      .list("managerWorker", bot.id)
      .filter((a) => a.worktreeId === w.id);
    if (
      workers.some(
        (a) =>
          a.activeTurnId ||
          this.store
            .list("managerTask", bot.id)
            .some(
              (t) =>
                t.workerId === a.id &&
                (!terminal.has(t.state) || !t.collectedAt),
            ),
      )
    )
      throw new Error(
        "Collect every worker result and finish queued/active tasks before removing this worktree.",
      );
    if (await git(w.path, ["status", "--porcelain", "--untracked-files=all"]))
      throw new Error(
        "Worktree has uncommitted or untracked changes; it was retained.",
      );
    const target = await git(w.root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${required(p.integratedRef, "integratedRef")}^{commit}`,
    ]);
    const head = await git(w.path, ["rev-parse", "HEAD"]);
    await git(w.root, ["merge-base", "--is-ancestor", head, target]).catch(
      () => {
        throw new Error(
          "Worktree commits are not integrated into integratedRef; it was retained.",
        );
      },
    );
    // A worker cannot retain a live cwd that is about to disappear.
    for (const worker of workers)
      if (!["archived", "deleted"].includes(worker.state))
        await this.archiveWorker(worker);
    await git(w.root, ["worktree", "remove", w.path]);
    return this.put("managerWorktree", {
      ...w,
      state: "removed",
      integratedRef: p.integratedRef,
      integratedCommit: target,
    });
  }
  async createWorker(bot, p, id, worktree = null) {
    const cwd = worktree?.path ?? (await this.rootFor(p));
    if (p.parentWorkerId) this.owned("managerWorker", p.parentWorkerId, bot.id);
    const worker = {
      id,
      botId: bot.id,
      managerThreadId: bot.threadId,
      parentWorkerId: p.parentWorkerId ?? null,
      name: cleanName(p.name),
      role: p.role ?? "Engineer",
      purpose: p.purpose ?? p.name,
      persistent: Boolean(p.persistent),
      projectId: p.projectId ?? null,
      cwd,
      worktreeId: worktree?.id ?? null,
      branch: worktree?.branch ?? null,
      threadId: null,
      state: "provisioning",
      activeTurnId: null,
      createdAt: now(),
    };
    this.put("managerWorker", worker);
    const params = {
      cwd,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      developerInstructions: WORKER_INSTRUCTIONS,
      config: this.workerConfig(),
      ...(p.model ? { model: p.model } : {}),
      ephemeral: false,
    };
    const response =
      p.operation === "fork"
        ? await this.codex.call("thread/fork", {
            ...params,
            threadId: required(p.threadId, "threadId"),
            excludeTurns: true,
          })
        : await this.codex.call("thread/start", {
            ...params,
            projectId: p.projectId,
            serviceName: "dawar-codex-worker",
          });
    const saved = this.put("managerWorker", {
      ...worker,
      threadId: response.thread.id,
      state: "active",
    });
    this.loaded.add(saved.threadId);
    await this.codex.call("thread/name/set", {
      threadId: saved.threadId,
      name: saved.name,
    });
    // Ensure a newly created worker can resume even before its first task.
    await this.codex.call("thread/read", {
      threadId: saved.threadId,
      includeTurns: true,
    });
    return saved;
  }
  async loadWorker(worker) {
    if (worker.state === "deleted" || worker.state === "archived")
      throw new Error("Restore the worker before assigning work.");
    if (!worker.threadId)
      throw new Error(
        "Worker creation is uncertain; inspect the registry before retrying.",
      );
    if (
      worker.worktreeId &&
      this.store.get("managerWorktree", worker.worktreeId)?.state !== "ready"
    )
      throw new Error(
        "Worker worktree is unavailable; create a new worker in a valid workspace.",
      );
    if (!this.loaded.has(worker.threadId)) {
      await this.codex.call("thread/resume", {
        threadId: worker.threadId,
        cwd: worker.cwd,
        excludeTurns: true,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        developerInstructions: WORKER_INSTRUCTIONS,
        config: this.workerConfig(),
      });
      this.loaded.add(worker.threadId);
    }
  }
  async threads(bot, p, id) {
    if (p.operation === "list")
      return this.codex.call("thread/list", {
        ...pageParams(p),
        sourceKinds: sources,
        ...(p.projectId ? { projectId: p.projectId } : {}),
        ...(p.searchTerm ? { searchTerm: p.searchTerm } : {}),
        archived: Boolean(p.archived),
      });
    if (p.operation === "read") {
      const threadId = p.workerId
        ? this.owned("managerWorker", p.workerId, bot.id).threadId
        : required(p.threadId, "threadId");
      const { thread } = await this.codex.call("thread/read", {
        threadId,
        includeTurns: false,
      });
      const page = await this.runtime.historyPage(threadId, p.cursor ?? null);
      return { thread, ...page };
    }
    if (["create", "fork"].includes(p.operation))
      return this.createWorker(bot, p, id);
    if (p.operation === "adopt") {
      const threadId = required(p.threadId, "threadId");
      if (
        this.store.bots().some((b) => b.threadId === threadId) ||
        this.workerFor(threadId)
      )
        throw new Error("This thread already belongs to a bot or manager.");
      const { thread } = await this.codex.call("thread/read", {
        threadId,
        includeTurns: false,
      });
      if (thread.status.type === "active")
        throw new Error(
          "Wait for the existing task to stop before adopting it.",
        );
      return this.put("managerWorker", {
        id,
        botId: bot.id,
        managerThreadId: bot.threadId,
        threadId,
        name: p.name ?? thread.name ?? "Adopted worker",
        role: p.role ?? "Specialist",
        purpose: p.purpose ?? "",
        cwd: thread.cwd,
        projectId: thread.projectId,
        state: "reference",
        persistent: true,
        activeTurnId: null,
        worktreeId: null,
        createdAt: now(),
      });
    }
    const worker = this.owned("managerWorker", p.workerId, bot.id);
    if (p.operation === "message")
      return this.delegate(bot, { ...p, name: p.name ?? worker.name }, id);
    if (p.operation === "steer") {
      if (!worker.activeTurnId)
        throw new Error("Worker is idle; use message or delegate.");
      return this.codex.call("turn/steer", {
        threadId: worker.threadId,
        expectedTurnId: worker.activeTurnId,
        clientUserMessageId: `manager:${id}`,
        input: [
          {
            type: "text",
            text: required(p.prompt, "prompt"),
            text_elements: [],
          },
        ],
      });
    }
    if (p.operation === "interrupt") {
      if (!worker.activeTurnId) return worker;
      return this.codex.call("turn/interrupt", {
        threadId: worker.threadId,
        turnId: worker.activeTurnId,
      });
    }
    if (p.operation === "rename") {
      await this.codex.call("thread/name/set", {
        threadId: worker.threadId,
        name: cleanName(p.name),
      });
      return this.put("managerWorker", { ...worker, name: p.name });
    }
    if (p.operation === "archive") return this.archiveWorker(worker);
    if (p.operation === "restore") {
      await this.codex.call("thread/unarchive", { threadId: worker.threadId });
      return this.put("managerWorker", {
        ...worker,
        state: worker.persistent ? "reference" : "completed",
      });
    }
    if (p.operation === "delete") {
      if (!p.confirm)
        throw new Error(
          "Permanent deletion requires confirm=true; prefer archive.",
        );
      this.requireFinished(worker, true);
      await this.codex.call("thread/delete", { threadId: worker.threadId });
      this.loaded.delete(worker.threadId);
      return this.put("managerWorker", { ...worker, state: "deleted" });
    }
    throw new Error("Unknown worker operation.");
  }
  requireFinished(worker, collected = false) {
    if (
      worker.activeTurnId ||
      this.store
        .list("managerTask", worker.botId)
        .some(
          (t) =>
            t.workerId === worker.id &&
            (!terminal.has(t.state) || (collected && !t.collectedAt)),
        )
    )
      throw new Error(
        "Finish all worker tasks and collect required results first.",
      );
  }
  async archiveWorker(worker) {
    this.requireFinished(worker);
    if (worker.state !== "archived")
      await this.codex.call("thread/archive", { threadId: worker.threadId });
    this.loaded.delete(worker.threadId);
    return this.put("managerWorker", { ...worker, state: "archived" });
  }
  async sections(bot, p) {
    if (p.operation === "list")
      return this.codex.call("threadSection/list", pageParams(p));
    if (p.operation === "create")
      return this.codex.call("threadSection/create", {
        name: cleanName(p.name),
      });
    if (p.operation === "moveThread") {
      const worker = this.owned("managerWorker", p.workerId, bot.id);
      const result = await this.codex.call("thread/section/move", {
        threadId: worker.threadId,
        sectionId: p.sectionId ?? null,
      });
      this.put("managerWorker", { ...worker, sectionManaged: false });
      return result;
    }
    if (p.operation === "delete" && !p.confirm)
      throw new Error("Section deletion requires confirm=true.");
    return this.codex.call(`threadSection/${p.operation}`, {
      sectionId: required(p.sectionId, "sectionId"),
      ...(p.operation === "update" ? { name: cleanName(p.name) } : {}),
    });
  }
  async delegate(bot, p, id) {
    const prompt = required(p.prompt, "prompt");
    const dependencies = p.dependencies ?? [];
    if (!Array.isArray(dependencies) || dependencies.length > 50)
      throw new Error("Invalid task dependencies.");
    for (const dependency of dependencies)
      this.owned("managerTask", dependency, bot.id);
    const task = {
      id,
      botId: bot.id,
      requestedBy: bot.threadId,
      scheduledRunId: this.store.get("activeRun", bot.id)?.runId ?? null,
      name: cleanName(p.name),
      prompt,
      context: p.context ?? "",
      constraints: p.constraints ?? "",
      acceptance: p.acceptance ?? "",
      dependencies,
      model: p.model ?? null,
      effort: p.effort ?? null,
      state: "provisioning",
      workerId: p.workerId ?? null,
      turnId: null,
      collectedAt: null,
      createdAt: now(),
    };
    this.put("managerTask", task);
    let worker;
    try {
      if (p.workerId) {
        worker = this.owned("managerWorker", p.workerId, bot.id);
        if (["archived", "deleted"].includes(worker.state))
          throw new Error("Restore the worker first.");
      } else {
        const worktree =
          p.isolated === false
            ? null
            : await this.createWorktree(bot, p, `${id}-tree`);
        worker = await this.createWorker(bot, p, `${id}-worker`, worktree);
      }
      return this.put("managerTask", {
        ...task,
        workerId: worker.id,
        state: this.store.bot(bot.id).managerPaused ? "cancelled" : "queued",
      });
    } catch (error) {
      this.put("managerTask", {
        ...task,
        workerId:
          worker?.id ??
          (this.store.get("managerWorker", `${id}-worker`)
            ? `${id}-worker`
            : task.workerId),
        state: "uncertain",
        error: error.message,
      });
      throw error;
    }
  }
  async tasks(bot, p, id) {
    if (p.operation === "delegate") return this.delegate(bot, p, id);
    if (p.operation === "requests")
      return this.store.list("managerRequest", bot.id);
    if (p.operation === "respond") return this.respond(bot, p);
    if (p.operation === "status")
      return {
        tasks: this.store
          .list("managerTask", bot.id)
          .filter(
            (t) =>
              (!p.id || t.id === p.id) &&
              (!p.workerId || t.workerId === p.workerId),
          ),
        workers: this.store
          .list("managerWorker", bot.id)
          .filter((w) => !p.workerId || w.id === p.workerId),
        operations: this.store
          .list("managerOperation", bot.id)
          .filter((o) => o.state !== "done"),
        notices: this.store
          .list("managerNotice", bot.id)
          .filter((n) => n.state !== "delivered"),
      };
    const task = this.owned("managerTask", p.id, bot.id);
    if (p.operation === "collectResult") {
      if (!terminal.has(task.state))
        throw new Error(
          `Task is ${task.state}; inspect status or its pending requests.`,
        );
      const worker = task.workerId
        ? this.owned("managerWorker", task.workerId, bot.id)
        : null;
      let turn = null;
      if (task.turnId) {
        const { thread } = await this.codex.call("thread/read", {
          threadId: worker?.threadId,
          includeTurns: true,
        });
        turn = thread.turns.find((t) => t.id === task.turnId);
        if (!turn)
          throw new Error(
            "Native task history is unavailable; result was not marked collected.",
          );
      }
      const saved = this.put("managerTask", {
        ...task,
        collectedAt: now(),
        resultSummary: p.summary ?? resultText(turn) ?? task.resultSummary,
      });
      return {
        task: saved,
        worker,
        turn: turn
          ? {
              id: turn.id,
              status: turn.status,
              error: turn.error,
              finalMessages: resultText(turn),
            }
          : null,
      };
    }
    if (p.operation === "cancel") {
      if (task.state === "queued") return this.finish(task, "cancelled", null);
      if (task.state !== "running")
        throw new Error("Only queued or running tasks can be cancelled.");
      const worker = this.owned("managerWorker", task.workerId, bot.id);
      return this.codex.call("turn/interrupt", {
        threadId: worker.threadId,
        turnId: task.turnId,
      });
    }
    if (p.operation === "acknowledge") {
      if (task.state !== "uncertain" || !p.confirm)
        throw new Error(
          "Inspect native history, then confirm an uncertain task.",
        );
      return this.finish(
        task,
        "interrupted",
        "Execution was reviewed; no retry was dispatched.",
      );
    }
    throw new Error("Unknown task operation.");
  }
  async organize(bot, p) {
    const workers = this.store.list("managerWorker", bot.id),
      tasks = this.store.list("managerTask", bot.id);
    if (p.operation === "review")
      return {
        workers,
        tasks,
        worktrees: this.store.list("managerWorktree", bot.id),
      };
    if (p.operation === "setState") {
      if (!["active", "waiting", "reference", "completed"].includes(p.state))
        throw new Error("Invalid lifecycle state.");
      const w = this.owned("managerWorker", p.workerId, bot.id);
      if (["archived", "deleted"].includes(w.state))
        throw new Error("Restore the worker first.");
      if (p.state === "completed") this.requireFinished(w, true);
      return this.put("managerWorker", {
        ...w,
        state: p.state,
        sectionManaged: true,
      });
    }
    const candidates = workers.filter(
      (w) =>
        !w.persistent &&
        w.state === "completed" &&
        !w.activeTurnId &&
        Date.now() - Date.parse(w.updatedAt) > 7 * 86400000 &&
        tasks
          .filter((t) => t.workerId === w.id)
          .every((t) => terminal.has(t.state) && t.collectedAt),
    );
    if (p.apply)
      for (const worker of candidates) await this.archiveWorker(worker);
    return {
      applied: Boolean(p.apply),
      candidates: candidates.map((w) => ({ id: w.id, name: w.name })),
    };
  }
  async syncSection(worker) {
    if (
      !worker.threadId ||
      worker.sectionManaged === false ||
      !["active", "waiting", "reference", "completed"].includes(worker.state) ||
      worker.sectionState === worker.state ||
      worker.sectionFailedState === worker.state
    )
      return;
    try {
      const bot = this.store.bot(worker.botId);
      const labels = {
        active: "Active Development",
        waiting: "Waiting",
        reference: "Reference",
        completed: "Completed",
      };
      const id = `${worker.botId}:${worker.state}`;
      let section = this.store.get("managerSection", id);
      if (!section) {
        const name = `${bot.name} · ${labels[worker.state]}`;
        let cursor = null,
          found;
        do {
          const page = await this.codex.call("threadSection/list", {
            cursor,
            limit: 100,
          });
          found = page.data.find((s) => s.name === name);
          cursor = page.nextCursor;
        } while (cursor && !found);
        if (!found)
          found = (await this.codex.call("threadSection/create", { name }))
            .section;
        section = this.store.put("managerSection", {
          id,
          botId: bot.id,
          sectionId: found.id,
        });
      }
      await this.codex.call("thread/section/move", {
        threadId: worker.threadId,
        sectionId: section.sectionId,
      });
      const current = this.owned("managerWorker", worker.id, worker.botId);
      this.put("managerWorker", {
        ...current,
        sectionState: worker.state,
        sectionFailedState: null,
      });
    } catch (error) {
      const current = this.owned("managerWorker", worker.id, worker.botId);
      this.put("managerWorker", {
        ...current,
        sectionFailedState: worker.state,
        sectionError: error.message,
      });
    }
  }
  notice(botId, key, text, runId = null) {
    const id = createHash("sha256").update(`${botId}:${key}`).digest("hex");
    if (!this.store.get("managerNotice", id))
      this.store.put("managerNotice", {
        id,
        botId,
        state: this.store.bot(botId).managerPaused ? "held" : "queued",
        text,
        runId,
        createdAt: now(),
      });
  }
  finish(task, state, error, turn) {
    const saved = this.put("managerTask", {
      ...task,
      state,
      error,
      resultSummary: resultText(turn) || task.resultSummary || "",
      finishedAt: now(),
    });
    const worker = this.store.get("managerWorker", task.workerId);
    if (worker && (!worker.activeTurnId || worker.activeTurnId === task.turnId))
      this.put("managerWorker", {
        ...worker,
        activeTurnId: null,
        state: state === "completed" ? "completed" : "waiting",
        lastTaskId: task.id,
      });
    if (state !== "completed")
      for (const pending of this.store.list("managerRequest", task.botId))
        if (
          pending.workerId === task.workerId &&
          pending.request.params.turnId === task.turnId
        )
          this.store.remove("managerRequest", pending.id);
    this.notice(
      task.botId,
      `task:${task.id}:${state}`,
      `Worker task ${task.name} (${task.id}) is ${state}. ${error ?? ""} Use codex_tasks collectResult to inspect native evidence, review it and continue the human's request.`,
      task.scheduledRunId,
    );
    return saved;
  }
  continueTask(task, reply) {
    return this.put("managerTask", {
      ...task,
      state: "queued",
      turnId: null,
      pendingReply: null,
      replyPrompt: reply,
      previousTurnIds: [...(task.previousTurnIds ?? []), task.turnId].filter(
        Boolean,
      ),
      dispatchKey: `${task.id}-reply-${randomUUID()}`,
    });
  }
  completeTask(task, turn) {
    const worker = this.owned("managerWorker", task.workerId, task.botId);
    const pending = this.store
      .list("managerRequest", task.botId)
      .some(
        (r) =>
          r.async &&
          r.workerId === worker.id &&
          r.request.params.turnId === turn.id,
      );
    if (turn.status === "completed" && (pending || task.pendingReply)) {
      this.put("managerWorker", {
        ...worker,
        activeTurnId: null,
        state: "waiting",
      });
      if (task.pendingReply)
        return this.continueTask(
          { ...task, turnId: turn.id },
          task.pendingReply,
        );
      return this.put("managerTask", {
        ...task,
        turnId: turn.id,
        state: "waiting",
      });
    }
    return this.finish(
      { ...task, turnId: turn.id },
      turn.status,
      turn.error?.message ?? null,
      turn,
    );
  }
  event(message) {
    const p = message.params ?? {},
      worker = this.workerFor(p.threadId ?? p.thread?.id);
    if (!worker) return false;
    if (message.method === "turn/started")
      this.put("managerWorker", {
        ...worker,
        activeTurnId: p.turn.id,
        state: "active",
      });
    if (message.method === "turn/completed") {
      const task = this.store
        .list("managerTask", worker.botId)
        .find(
          (t) =>
            t.workerId === worker.id &&
            (t.turnId === p.turn.id || (t.state === "starting" && !t.turnId)),
        );
      if (task) this.completeTask(task, p.turn);
      for (const pending of this.store.list("managerRequest", worker.botId))
        if (
          !pending.async &&
          pending.workerId === worker.id &&
          pending.request.params.turnId === p.turn.id
        )
          this.store.remove("managerRequest", pending.id);
    }
    if (message.method === "thread/archived")
      this.put("managerWorker", {
        ...worker,
        state: "archived",
        activeTurnId: null,
      });
    if (message.method === "thread/unarchived")
      this.put("managerWorker", { ...worker, state: "reference" });
    if (message.method === "serverRequest/resolved")
      this.store.remove(
        "managerRequest",
        `${this.runtime.epoch}:${p.requestId}`,
      );
    if (
      message.method === "item/completed" &&
      p.item?.type === "agentMessage" &&
      p.item.questions?.length
    ) {
      this.recordRequest(
        worker,
        {
          id: `async:${p.item.id}`,
          method: "item/tool/requestUserInput",
          params: {
            threadId: worker.threadId,
            turnId: p.turnId,
            itemId: p.item.id,
            isBlocking: false,
            questions: p.item.questions.map((q, i) => ({
              id: String(i),
              header: "Worker question",
              question: q.title,
              isOther: true,
              isSecret: false,
              options:
                q.options?.map((label) => ({ label, description: "" })) ?? null,
            })),
          },
        },
        true,
      );
    }
    return true;
  }
  recordRequest(worker, request, async = false) {
    const id = async
      ? String(request.id)
      : `${this.runtime.epoch}:${request.id}`;
    this.store.put("managerRequest", {
      id,
      botId: worker.botId,
      workerId: worker.id,
      request,
      async,
      epoch: this.runtime.epoch,
      createdAt: now(),
    });
    this.put("managerWorker", { ...worker, state: "waiting" });
    this.notice(
      worker.botId,
      `request:${id}`,
      `Worker ${worker.name} (${worker.id}) needs input. Read codex_tasks requests, answer from the task's existing authorization or ask the human if necessary. Request ID: ${id}.`,
      this.store
        .list("managerTask", worker.botId)
        .find(
          (t) =>
            t.workerId === worker.id &&
            ["starting", "running", "waiting"].includes(t.state),
        )?.scheduledRunId,
    );
  }
  request(message) {
    const worker = this.workerFor(
      message.params?.threadId ?? message.params?.conversationId,
    );
    if (!worker) return false;
    if (message.method === "item/tool/call") {
      this.codex.respond(message.id, {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Manager tools are only available in the parent conversation.",
          },
        ],
      });
    } else this.recordRequest(worker, message);
    return true;
  }
  async respond(bot, p) {
    const pending = this.owned("managerRequest", p.id, bot.id);
    if (!pending.async && pending.epoch !== this.runtime.epoch)
      throw new Error("Worker request expired on restart.");
    const result = validateResponse(pending.request, p.result);
    if (pending.async) {
      const text = pending.request.params.questions
        .map((q) => `${q.question}\n${result.answers[q.id].answers.join("\n")}`)
        .join("\n\n");
      const task = this.store
        .list("managerTask", bot.id)
        .find(
          (t) =>
            t.workerId === pending.workerId &&
            t.turnId === pending.request.params.turnId &&
            ["running", "waiting", "starting"].includes(t.state),
        );
      if (!task)
        throw new Error("This question no longer has an active worker task.");
      if (task.state === "waiting") this.continueTask(task, text);
      else this.put("managerTask", { ...task, pendingReply: text });
    } else this.codex.respond(pending.request.id, result);
    this.store.remove("managerRequest", pending.id);
    const worker = this.owned("managerWorker", pending.workerId, bot.id);
    this.put("managerWorker", {
      ...worker,
      state: worker.activeTurnId ? "active" : "reference",
    });
    return { answered: true };
  }
  async recover() {
    for (const r of this.store.list("managerRequest"))
      if (!r.async) this.store.remove("managerRequest", r.id);
    for (const op of this.store.list("managerOperation"))
      if (op.state === "dispatching")
        this.store.put("managerOperation", {
          ...op,
          state: "uncertain",
          error:
            "Service restarted before acknowledgement; inspect registry and native history.",
        });
    for (const worktree of this.store.list("managerWorktree"))
      if (worktree.state === "creating") {
        try {
          const entries = await git(worktree.root, [
            "worktree",
            "list",
            "--porcelain",
          ]);
          if (entries.split("\n").includes(`worktree ${worktree.path}`))
            this.put("managerWorktree", { ...worktree, state: "ready" });
        } catch {
          /* Retain the reserved worktree; never repeat git worktree add. */
        }
      }
    for (const worker of this.store.list("managerWorker")) {
      if (!worker.threadId) {
        // Never create another thread while its prior creation is uncertain.
        const matches = [];
        let cursor = null;
        do {
          const page = await this.codex.call("thread/list", {
            cwd: worker.cwd,
            sourceKinds: sources,
            cursor,
            limit: 100,
          });
          matches.push(...page.data);
          cursor = page.nextCursor;
        } while (cursor);
        if (
          matches.length === 1 &&
          !this.workerFor(matches[0].id) &&
          !this.store.bots().some((b) => b.threadId === matches[0].id)
        )
          this.put("managerWorker", {
            ...worker,
            threadId: matches[0].id,
            state: "waiting",
          });
        continue;
      }
      if (["archived", "deleted"].includes(worker.state)) continue;
      this.put("managerWorker", {
        ...worker,
        activeTurnId: null,
        state: worker.activeTurnId ? "waiting" : worker.state,
      });
    }
    for (const task of this.store.list("managerTask")) {
      if (
        !["starting", "running", "uncertain", "provisioning"].includes(
          task.state,
        )
      )
        continue;
      const worker = this.store.get(
        "managerWorker",
        task.workerId ?? `${task.id}-worker`,
      );
      if (!task.workerId && worker) task.workerId = worker.id;
      try {
        if (!worker?.threadId)
          throw new Error("Worker creation needs reconciliation.");
        const { thread } = await this.codex.call("thread/read", {
          threadId: worker.threadId,
          includeTurns: true,
        });
        const turn = thread.turns.find(
          (t) =>
            t.id === task.turnId ||
            t.items?.some(
              (i) =>
                i.clientId === `manager-task:${task.dispatchKey ?? task.id}`,
            ),
        );
        if (turn && terminal.has(turn.status)) this.completeTask(task, turn);
        else
          throw new Error(
            "Execution outcome is uncertain after restart; inspect native history before acknowledging or retrying.",
          );
      } catch (error) {
        this.put("managerTask", {
          ...task,
          state: "uncertain",
          error: error.message,
        });
        this.notice(
          task.botId,
          `uncertain:${task.id}`,
          `Worker task ${task.name} (${task.id}) needs reconciliation after restart. Inspect codex_tasks status and native history; do not rerun it blindly.`,
        );
      }
    }
  }
  async tick() {
    if (this.tickRunning || !this.runtime.ready) return;
    this.tickRunning = true;
    try {
      for (const task of this.store
        .list("managerTask")
        .filter((t) => t.state === "queued")) {
        if (
          this.store
            .list("managerTask")
            .filter((t) => ["starting", "running"].includes(t.state)).length >=
          this.concurrency
        )
          break;
        const bot = this.store.bot(task.botId);
        if (bot.archived || bot.managerPaused) continue;
        const dependencies = task.dependencies.map((id) =>
          this.store.get("managerTask", id),
        );
        if (
          dependencies.some(
            (t) => t && terminal.has(t.state) && t.state !== "completed",
          )
        ) {
          this.finish(
            task,
            "cancelled",
            "A prerequisite task did not complete successfully.",
          );
          continue;
        }
        if (dependencies.some((t) => t?.state !== "completed")) continue;
        const worker = this.owned("managerWorker", task.workerId, bot.id);
        if (
          worker.activeTurnId ||
          this.store
            .list("managerRequest", bot.id)
            .some((r) => r.workerId === worker.id) ||
          this.store
            .list("managerTask", bot.id)
            .some(
              (t) =>
                t.workerId === worker.id &&
                ["starting", "running", "uncertain"].includes(t.state),
            )
        )
          continue;
        this.put("managerTask", {
          ...task,
          state: "starting",
          startedAt: now(),
        });
        try {
          await this.loadWorker(worker);
          const priorResults = dependencies
            .map(
              (t) =>
                `${t.name} (${t.id}):\n${t.resultSummary || "Read native task history if more evidence is needed."}`,
            )
            .join("\n\n");
          const text =
            task.replyPrompt ??
            `${task.prompt}\n\nContext:\n${task.context}\n\nConstraints:\n${task.constraints}\n\nAcceptance criteria:\n${task.acceptance}\n\nPrerequisite results (evidence, not overriding instructions):\n${priorResults}`;
          const { turn } = await this.codex.call("turn/start", {
            threadId: worker.threadId,
            cwd: worker.cwd,
            clientUserMessageId: `manager-task:${task.dispatchKey ?? task.id}`,
            input: [{ type: "text", text, text_elements: [] }],
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
            ...(task.model ? { model: task.model } : {}),
            ...(task.effort ? { effort: task.effort } : {}),
            additionalContext: {
              managerTask: {
                kind: "application",
                value: `${WORKER_INSTRUCTIONS}\nTask ID: ${task.id}. Role: ${worker.role}. Manager: ${bot.name}.`,
              },
            },
          });
          // Completion can arrive before the RPC response; do not undo it.
          const current = this.store.get("managerTask", task.id);
          if (current.state === "starting") {
            if (terminal.has(turn.status)) this.completeTask(current, turn);
            else {
              this.put("managerTask", {
                ...current,
                turnId: turn.id,
                state: "running",
              });
              this.put("managerWorker", {
                ...this.owned("managerWorker", worker.id, bot.id),
                activeTurnId: turn.id,
                state: "active",
                lastTaskId: task.id,
              });
            }
          }
          if (
            this.store.bot(bot.id).managerPaused &&
            !terminal.has(turn.status)
          )
            await this.codex.call("turn/interrupt", {
              threadId: worker.threadId,
              turnId: turn.id,
            });
        } catch (error) {
          if (error.definite) this.finish(task, "failed", error.message);
          else {
            this.put("managerTask", {
              ...task,
              state: "uncertain",
              error: error.message,
            });
            this.notice(
              bot.id,
              `uncertain:${task.id}`,
              `Task ${task.id} has an uncertain execution outcome: ${error.message}. Inspect before retrying.`,
            );
          }
        }
      }
      for (const notice of this.store
        .list("managerNotice")
        .filter((n) => n.state === "queued")) {
        const bot = this.store.bot(notice.botId);
        if (
          bot.archived ||
          bot.managerPaused ||
          bot.activeTurnId ||
          this.runtime.locks.has(bot.id) ||
          this.store.list("pending", bot.id).length
        )
          continue;
        const operationId = `manager-notice:${notice.id}`;
        const prior = this.store.operation(operationId);
        if (prior) {
          this.store.put("managerNotice", {
            ...notice,
            state: prior.status === "done" ? "delivered" : "uncertain",
          });
          if (prior.status !== "done")
            this.runtime.notify(
              bot,
              `manager-notice:${notice.id}`,
              "Worker results need review; open this bot to continue.",
            );
          continue;
        }
        try {
          await this.runtime.handle({
            method: "turn.send",
            botId: bot.id,
            operationId,
            params: { text: `[Manager update]\n${notice.text}` },
          });
          this.store.put("managerNotice", {
            ...notice,
            state: "delivered",
            deliveredAt: now(),
          });
        } catch (error) {
          this.store.put("managerNotice", {
            ...notice,
            state: "uncertain",
            error: error.message,
          });
          this.runtime.notify(
            bot,
            `manager-notice:${notice.id}`,
            "Worker results need review; open this bot to continue.",
          );
        }
      }
      for (const worker of this.store.list("managerWorker"))
        await this.syncSection(worker);
    } finally {
      this.tickRunning = false;
    }
  }
}
