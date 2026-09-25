import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Store } from "./store.mjs";
import { BotRuntime } from "./runtime.mjs";
import { CodexManager } from "./manager.mjs";

class Native extends EventEmitter {
  threads = new Map();
  calls = [];
  sections = [];
  answers = [];
  count = 0;
  async call(method, p) {
    this.calls.push({ method, p });
    if (method === "thread/start") {
      const thread = {
        id: `native-${++this.count}`,
        cwd: p.cwd,
        name: p.name,
        status: { type: "idle" },
        turns: [],
      };
      this.threads.set(thread.id, thread);
      return { thread };
    }
    if (method === "thread/read" || method === "thread/resume")
      return { thread: this.threads.get(p.threadId) };
    if (method === "thread/list")
      return {
        data: [...this.threads.values()].filter(
          (t) =>
            (!p.cwd || t.cwd === p.cwd) &&
            Boolean(t.archived) === Boolean(p.archived),
        ),
        nextCursor: null,
      };
    if (method === "thread/turns/list")
      return {
        data: this.threads.get(p.threadId).turns.toReversed(),
        nextCursor: null,
      };
    if (method === "thread/archive")
      this.threads.get(p.threadId).archived = true;
    if (method === "thread/unarchive")
      this.threads.get(p.threadId).archived = false;
    if (method === "turn/start") {
      const turn = {
        id: `turn-${++this.count}`,
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            clientId: p.clientUserMessageId,
            content: p.input,
          },
        ],
      };
      this.threads.get(p.threadId).turns.push(turn);
      return { turn };
    }
    if (method === "threadSection/list")
      return { data: this.sections, nextCursor: null };
    if (method === "threadSection/create") {
      const section = { id: `section-${++this.count}`, name: p.name };
      this.sections.push(section);
      return { section };
    }
    return {};
  }
  respond(id, result) {
    this.answers.push({ id, result });
  }
  reject(id, message) {
    this.answers.push({ id, error: message });
  }
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "manager-test-"));
  const store = new Store(join(directory, "state.sqlite"));
  const codex = new Native();
  const runtime = new BotRuntime({ store, codex, root: directory });
  runtime.ready = true;
  runtime.loaded.add("main");
  runtime.defaults.model = "default-model";
  const bot = store.saveBot({
    id: "bot",
    slug: "manager",
    threadId: "main",
    name: "Manager",
    cwd: directory,
    archived: false,
    mode: "default",
    activeTurnId: null,
  });
  codex.threads.set("main", {
    id: "main",
    cwd: directory,
    turns: [],
    status: { type: "idle" },
  });
  const manager = new CodexManager({
    runtime,
    store,
    directory: join(directory, "manager"),
  });
  runtime.manager = manager;
  const call = (name, operation, p = {}, operationId = crypto.randomUUID()) =>
    manager.call(bot.id, `codex_${name}`, { operation, ...p, operationId });
  t.after(async () => {
    await manager.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, codex, runtime, bot, manager, call };
}
test("manager mutations deduplicate and never expose tools to workers", async (t) => {
  const f = await fixture(t),
    id = "stable-create";
  const worker = await f.call(
    "threads",
    "create",
    { name: "Backend", cwd: f.directory },
    id,
  );
  const again = await f.call(
    "threads",
    "create",
    { name: "Backend", cwd: f.directory },
    id,
  );
  assert.equal(worker.threadId, again.threadId);
  assert.equal(
    f.codex.calls.filter((c) => c.method === "thread/start").length,
    1,
  );
  assert.equal(
    f.codex.calls.find((c) => c.method === "thread/start").p.config[
      "mcp_servers.codex_manager"
    ].enabled,
    false,
  );
  await assert.rejects(
    f.call("threads", "create", { name: "Changed", cwd: f.directory }, id),
    /reused/,
  );
  await assert.rejects(
    f.call("threads", "adopt", { threadId: "main" }),
    /already belongs/,
  );
  const token = f.manager.config(f.bot)["mcp_servers.codex_manager"].env
    .DAWAR_MANAGER_TOKEN;
  assert.equal(token.length, 64);
  assert.equal(
    f.manager.config(f.bot)["mcp_servers.codex_manager"].env
      .DAWAR_MANAGER_TOKEN,
    token,
  );
});
test("tasks serialize per worker, satisfy dependencies and wake only their manager", async (t) => {
  const f = await fixture(t);
  const first = await f.call("tasks", "delegate", {
    name: "Implement",
    prompt: "Do the work",
    cwd: f.directory,
    isolated: false,
  });
  const second = await f.call("tasks", "delegate", {
    name: "Review",
    prompt: "Review",
    workerId: first.workerId,
    dependencies: [first.id],
  });
  await f.manager.tick();
  const active = f.store.get("managerTask", first.id),
    worker = f.store.get("managerWorker", first.workerId);
  assert.equal(active.state, "running");
  assert.equal(f.store.get("managerTask", second.id).state, "queued");
  const turn = f.codex.threads.get(worker.threadId).turns[0];
  turn.status = "completed";
  turn.items.push({ type: "agentMessage", text: "Done with evidence." });
  f.runtime.onNotification({
    method: "turn/completed",
    params: { threadId: worker.threadId, turn },
  });
  assert.equal(f.store.get("managerTask", first.id).state, "completed");
  const result = await f.call("tasks", "collectResult", { id: first.id });
  assert.equal(result.turn.finalMessages, "Done with evidence.");
  await f.manager.tick();
  assert.equal(f.store.get("managerTask", second.id).state, "running");
  assert.equal(f.store.list("managerNotice")[0].state, "delivered");
  assert.equal(f.codex.threads.get("main").turns.length, 1);
  await f.manager.tick();
  assert.equal(f.codex.threads.get("main").turns.length, 1);
  assert.ok(f.codex.sections.length > 0);
});
test("failed prerequisites cancel dependents and manager archive pauses dispatch", async (t) => {
  const f = await fixture(t);
  const first = await f.call("tasks", "delegate", {
    name: "First",
    prompt: "First",
    cwd: f.directory,
    isolated: false,
  });
  const second = await f.call("tasks", "delegate", {
    name: "Second",
    prompt: "Second",
    workerId: first.workerId,
    dependencies: [first.id],
  });
  f.store.saveBot({ ...f.bot, archived: true });
  await f.manager.tick();
  assert.equal(f.store.get("managerTask", first.id).state, "queued");
  f.store.saveBot(f.bot);
  f.manager.finish(first, "failed", "Failure");
  await f.manager.tick();
  assert.equal(f.store.get("managerTask", second.id).state, "cancelled");
});
test("worker native questions are routed to manager, validated and resolved once", async (t) => {
  const f = await fixture(t);
  const worker = await f.call("threads", "create", {
    name: "Worker",
    cwd: f.directory,
  });
  await f.runtime.onServerRequest({
    id: 12,
    method: "item/tool/requestUserInput",
    params: {
      threadId: worker.threadId,
      turnId: "turn",
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Which?",
          options: null,
          isOther: true,
          isSecret: false,
        },
      ],
    },
  });
  const request = f.store.list("managerRequest", f.bot.id)[0];
  assert.ok(request);
  assert.equal(f.store.list("pending", f.bot.id).length, 0);
  await f.call("tasks", "respond", {
    id: request.id,
    result: { answers: { choice: { answers: ["A"] } } },
  });
  assert.equal(f.codex.answers[0].id, 12);
  assert.equal(f.store.list("managerRequest").length, 0);
  await assert.rejects(
    f.call("tasks", "respond", { id: request.id, result: {} }),
    /not owned/,
  );
});
test("restart reconciles completed native turns and does not rerun uncertain work", async (t) => {
  const f = await fixture(t);
  const task = await f.call("tasks", "delegate", {
    name: "Work",
    prompt: "Work",
    cwd: f.directory,
    isolated: false,
  });
  await f.manager.tick();
  const worker = f.store.get("managerWorker", task.workerId);
  const turn = f.codex.threads.get(worker.threadId).turns[0];
  turn.status = "completed";
  await f.manager.recover();
  assert.equal(f.store.get("managerTask", task.id).state, "completed");
  const next = await f.call("tasks", "delegate", {
    name: "Next",
    prompt: "Next",
    workerId: worker.id,
  });
  f.store.put("managerTask", { ...next, state: "starting" });
  await f.manager.recover();
  assert.equal(f.store.get("managerTask", next.id).state, "uncertain");
  const before = f.codex.calls.filter(
    (c) => c.method === "turn/start" && c.p.threadId === worker.threadId,
  ).length;
  await f.manager.tick();
  assert.equal(
    f.codex.calls.filter(
      (c) => c.method === "turn/start" && c.p.threadId === worker.threadId,
    ).length,
    before,
  );
});
test("asynchronous worker questions continue the same task and hold its dependencies", async (t) => {
  const f = await fixture(t);
  const task = await f.call("tasks", "delegate", {
    name: "Question",
    prompt: "Work",
    cwd: f.directory,
    isolated: false,
  });
  await f.manager.tick();
  const worker = f.store.get("managerWorker", task.workerId);
  const turn = f.codex.threads.get(worker.threadId).turns[0];
  f.runtime.onNotification({
    method: "item/completed",
    params: {
      threadId: worker.threadId,
      turnId: turn.id,
      item: {
        id: "question-item",
        type: "agentMessage",
        text: "Which?",
        questions: [{ title: "Which option?", options: ["A", "B"] }],
      },
    },
  });
  turn.status = "completed";
  f.runtime.onNotification({
    method: "turn/completed",
    params: { threadId: worker.threadId, turn },
  });
  assert.equal(f.store.get("managerTask", task.id).state, "waiting");
  const pending = f.store.list("managerRequest")[0];
  await f.call("tasks", "respond", {
    id: pending.id,
    result: { answers: { 0: { answers: ["A"] } } },
  });
  assert.equal(f.store.list("managerTask").length, 1);
  await f.manager.tick();
  const turns = f.codex.threads.get(worker.threadId).turns;
  assert.equal(turns.length, 2);
  assert.notEqual(turns[0].items[0].clientId, turns[1].items[0].clientId);
  assert.equal(f.store.get("managerTask", task.id).state, "running");
});
test("Stop cancels queued work without losing the active worker's interrupt target", async (t) => {
  const f = await fixture(t);
  const first = await f.call("tasks", "delegate", {
    name: "First",
    prompt: "Work",
    cwd: f.directory,
    isolated: false,
  });
  const second = await f.call("tasks", "delegate", {
    name: "Second",
    prompt: "More",
    workerId: first.workerId,
  });
  await f.manager.tick();
  const active = f.store.get("managerTask", first.id);
  await f.runtime.handle({
    method: "turn.interrupt",
    botId: f.bot.id,
    params: {},
    operationId: crypto.randomUUID(),
  });
  assert.equal(f.store.get("managerTask", second.id).state, "cancelled");
  assert.ok(
    f.codex.calls.some(
      (c) => c.method === "turn/interrupt" && c.p.turnId === active.turnId,
    ),
  );
  assert.equal(f.store.bot(f.bot.id).managerPaused, true);
  assert.equal(
    f.store.list("managerNotice").filter((n) => n.state === "queued").length,
    0,
  );
});
test("worktree cleanup preserves dirty and unmerged work, then removes integrated clean work", async (t) => {
  const f = await fixture(t),
    root = join(f.directory, "repo");
  const git = (cwd, ...args) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "Test");
  git(root, "commit", "--allow-empty", "-qm", "Initial");
  const w = await f.call("worktrees", "create", { root, name: "Change" });
  await writeFile(join(w.path, "new.txt"), "change");
  await assert.rejects(
    f.call("worktrees", "remove", { id: w.id, integratedRef: "main" }),
    /uncommitted/,
  );
  git(w.path, "add", "new.txt");
  git(w.path, "commit", "-qm", "Change");
  await assert.rejects(
    f.call("worktrees", "remove", { id: w.id, integratedRef: "main" }),
    /not integrated/,
  );
  git(root, "merge", "--ff-only", w.branch);
  const result = await f.call("worktrees", "remove", {
    id: w.id,
    integratedRef: "main",
  });
  assert.equal(result.state, "removed");
  assert.ok(git(root, "branch", "--list", w.branch));
});
