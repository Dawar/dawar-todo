import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { ClaudeBackend, mcpServersFrom, nativeModel } from "./claude.mjs";
import { ClaudeTurn, resultStatus } from "./claude-items.mjs";

import { fakeQuery, fakeMcp, text, result, MinimalCodex } from "./claude-test-support.mjs";

async function setup(t, script, log = []) {
  const dir = await mkdtemp(join(tmpdir(), "claude-test-"));
  const store = new Store(join(dir, "state.sqlite"));
  const claude = new ClaudeBackend({ store, query: fakeQuery(script, log), mcp: fakeMcp, credential: "test", configDir: join(dir, "claude") });
  await claude.start();
  const notes = [];
  claude.on("notification", (n) => notes.push(n));
  t.after(async () => { claude.close(); await settle(); store.close(); await rm(dir, { recursive: true, force: true }); });
  return { dir, store, claude, notes, log };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const until = async (fn) => { for (let i = 0; i < 200 && !fn(); i++) await settle(); assert.ok(fn()); };
const input = (t) => [{ type: "text", text: t, text_elements: [] }];

test("a Claude turn streams Codex items and is served back from the bridge transcript", async (t) => {
  const { claude, notes, log } = await setup(t, (user) => [
    { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } },
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hel" } } },
    text("m1", "Hello there"),
    { type: "assistant", parent_tool_use_id: null, message: { id: "m2", content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } },
    { type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "a.txt" }] } },
    text("m3", "Done."),
    result(user.uuid),
  ]);
  const started = await claude.call("thread/start", { cwd: "/bots/c", model: "opus", effort: "high",
    developerInstructions: "Read SOUL.md", config: { "mcp_servers.codex_manager": { command: "node", args: ["m.mjs"], env: { T: "1" } } } });
  const threadId = started.thread.id;
  assert.match(threadId, /^claude:/);
  assert.equal(log[0].options.persistSession, false, "the model catalog read leaves no session behind");
  log.shift();
  assert.equal(log[0].options.sessionId, started.thread.sessionId);
  assert.equal(log[0].options.systemPrompt.append, "Read SOUL.md");
  assert.deepEqual(log[0].options.settingSources, []);
  assert.deepEqual(log[0].options.mcpServers, { codex_manager: { type: "stdio", command: "node", args: ["m.mjs"], env: { T: "1" } } });
  assert.doesNotMatch(JSON.stringify(log[0].options.mcpServers) && JSON.stringify(claude.data.thread(threadId)), /"T":"1"/, "MCP launch secrets are not persisted");

  const { turn } = await claude.call("turn/start", { threadId, clientUserMessageId: "op-1", input: input("hi"),
    additionalContext: { botProfile: { kind: "application", value: "I am Atlas" } } });
  assert.equal(turn.status, "inProgress");
  // Per-turn context reaches the model but never the displayed user message.
  assert.deepEqual(log[0].last.message.content.map((c) => c.text), ["<botProfile>\nI am Atlas\n</botProfile>", "hi"]);
  await until(() => notes.some((n) => n.method === "turn/completed"));

  const methods = notes.map((n) => n.method);
  assert.equal(methods[0], "turn/started");
  assert.ok(methods.includes("item/agentMessage/delta"));
  const done = notes.find((n) => n.method === "turn/completed").params.turn;
  assert.equal(done.status, "completed");
  assert.deepEqual(done.items.map((i) => i.type), ["userMessage", "agentMessage", "commandExecution", "agentMessage"]);
  assert.equal(done.items[0].clientId, "op-1");
  assert.deepEqual(done.items[0].content, input("hi"));
  assert.equal(done.items[1].id, "m1:0", "streamed and final text share one item");
  assert.equal(done.items[1].phase, "commentary");
  assert.equal(done.items[2].aggregatedOutput, "a.txt");
  assert.equal(done.items[2].exitCode, 0);
  assert.equal(done.items[3].phase, "final_answer");

  const read = await claude.call("thread/read", { threadId, includeTurns: false });
  assert.deepEqual(read.thread.status, { type: "idle" });
  const page = await claude.call("thread/turns/list", { threadId, cursor: null, limit: 25, sortDirection: "desc", itemsView: "notLoaded" });
  assert.equal(page.data.length, 1);
  assert.deepEqual(page.data[0].items, []);
  const summary = await claude.call("thread/turns/list", { threadId, itemsView: "summary" });
  assert.deepEqual(summary.data[0].items.map((i) => i.type), ["userMessage", "agentMessage"]);
  const items = await claude.call("thread/items/list", { threadId, turnId: done.id, limit: 2, sortDirection: "desc" });
  assert.deepEqual(items.data.map((e) => e.item.id), [done.items[3].id, done.items[2].id]);
  assert.equal(items.nextCursor, "2");
  // Recovery finds the thread by its reserved workspace, like Codex thread/list.
  assert.deepEqual((await claude.call("thread/list", { cwd: "/bots/c" })).data.map((x) => x.id), [threadId]);
  assert.deepEqual(await claude.call("thread/goal/get", { threadId }), { goal: null });
});

test("steering folds into the running turn; interrupt ends it as interrupted", async (t) => {
  let release;
  const { claude, notes } = await setup(t, async (user, ctx) => {
    if (user.priority === "now") return [];
    await new Promise((r) => { release = r; ctx.wake = r; });
    return [text("m1", "partial"), result(user.uuid, { subtype: "error_during_execution", is_error: true, errors: ["aborted"],
      user_message_uuids: [user.uuid, ctx.last.uuid] })];
  });
  const { thread } = await claude.call("thread/start", { cwd: "/bots/s" });
  const { turn } = await claude.call("turn/start", { threadId: thread.id, input: input("long job") });
  await assert.rejects(claude.call("turn/start", { threadId: thread.id, input: input("again") }), (e) => e.definite);
  const steer = await claude.call("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, clientUserMessageId: "op-2", input: input("also this") });
  assert.equal(steer.turnId, turn.id);
  await assert.rejects(claude.call("turn/steer", { threadId: thread.id, expectedTurnId: "other", input: input("x") }), (e) => e.definite);
  await until(() => release);
  await claude.call("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  await until(() => notes.some((n) => n.method === "turn/completed"));
  const done = notes.find((n) => n.method === "turn/completed").params.turn;
  assert.equal(done.status, "interrupted");
  assert.deepEqual(done.items.filter((i) => i.type === "userMessage").map((i) => i.clientId), [null, "op-2"]);
});

test("a restart ends unfinished Claude turns as interrupted and resumes the SDK session", async (t) => {
  const { dir, store, claude, log } = await setup(t, async () => new Promise(() => {}));
  const { thread } = await claude.call("thread/start", { cwd: "/bots/r", model: "opus" });
  await claude.call("turn/start", { threadId: thread.id, input: input("never finishes") });
  await settle();
  // Simulated crash: the first process never settles its turn. The SDK reported init, so the next load resumes instead of reusing sessionId.
  const restarted = new ClaudeBackend({ store, query: fakeQuery(async () => []), credential: "test", configDir: join(dir, "claude") });
  const logs = [];
  restarted.query = fakeQuery(async () => [], logs);
  await restarted.start();
  t.after(() => restarted.close());
  const page = await restarted.call("thread/turns/list", { threadId: thread.id });
  assert.equal(page.data[0].status, "interrupted");
  assert.match(page.data[0].error.message, /restarted/);
  assert.deepEqual((await restarted.call("thread/read", { threadId: thread.id })).thread.status, { type: "notLoaded" });
  await restarted.call("thread/resume", { threadId: thread.id });
  const resumed = logs.find((ctx) => ctx.options.cwd === "/bots/r");
  assert.equal(resumed.options.resume, thread.sessionId);
  assert.equal(resumed.options.sessionId, undefined);
});

test("unsupported Codex mutations are refused definitively; reads stay empty", async (t) => {
  const { claude } = await setup(t, async () => []);
  const { thread } = await claude.call("thread/start", { cwd: "/bots/u" });
  for (const method of ["thread/goal/set", "thread/goal/clear", "thread/fork", "project/list"])
    await assert.rejects(claude.call(method, { threadId: thread.id }), (e) => e.definite === true);
  assert.deepEqual(await claude.call("thread/queue/list", { threadId: thread.id }), { data: [], nextCursor: null });
  await assert.rejects(claude.call("thread/read", { threadId: "claude:missing" }), (e) => e.definite === true);
});

test("pure mappings: tools, results, models and MCP config", () => {
  const turn = new ClaudeTurn({ threadId: "claude:t", turnId: "t1", cwd: "/w", now: () => 1000 });
  turn.consume({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [
    { type: "tool_use", id: "e", name: "Edit", input: { file_path: "/w/a", old_string: "x", new_string: "y" } },
    { type: "tool_use", id: "d", name: "mcp__bots__bots_report_result", input: { summary: "s" } },
    { type: "tool_use", id: "g", name: "Grep", input: { pattern: "p" } },
    { type: "tool_use", id: "ts", name: "ToolSearch", input: { query: "select:x" } },
    { type: "tool_use", id: "p", name: "TodoWrite", input: { todos: [{ content: "one", status: "in_progress" }] } },
    { type: "tool_use", id: "x", name: "ExitPlanMode", input: { plan: "1. Do it" } },
  ] } });
  turn.consume({ type: "user", parent_tool_use_id: null, message: { content: [
    { type: "tool_result", tool_use_id: "e", content: "ok" },
    { type: "tool_result", tool_use_id: "d", content: [{ type: "text", text: "saved" }] },
  ] } });
  const finish = turn.finish("completed");
  const items = Object.fromEntries(turn.turn.items.map((i) => [i.id, i]));
  assert.deepEqual(items.e.changes, [{ path: "/w/a", kind: { type: "update", move_path: null }, diff: "-x\n+y" }]);
  assert.equal(items.e.status, "completed");
  assert.equal(items.d.type, "dynamicToolCall");
  assert.equal(items.d.tool, "bots_report_result");
  assert.deepEqual(items.d.contentItems, [{ type: "inputText", text: "saved" }]);
  assert.equal(items.g.type, "mcpToolCall");
  assert.equal(items.g.status, "failed", "a tool still running at turn end is not left inProgress");
  assert.equal(items.p.type, "mcpToolCall", "a to-do list is not a proposed plan");
  assert.deepEqual(items.x, { type: "plan", id: "x", text: "1. Do it" });
  assert.equal(items.ts, undefined, "ToolSearch plumbing is not shown");
  assert.equal(finish.at(-1).method, "turn/completed");
  assert.deepEqual(resultStatus({ subtype: "error_max_turns", errors: [] }, false), { status: "failed", error: "error_max_turns" });
  assert.deepEqual(resultStatus({ subtype: "success", is_error: false }, true), { status: "interrupted", error: null });
  const model = nativeModel({ value: "sonnet", displayName: "Sonnet", supportedEffortLevels: ["low", "medium"] });
  assert.equal(model.provider, "claude");
  assert.equal(model.defaultReasoningEffort, "low");
  assert.deepEqual(model.serviceTiers, []);
  assert.deepEqual(mcpServersFrom({ "features.fast_mode": true, "mcp_servers.off": { command: "x", enabled: false } }), {});
});

// --- Through the real BotRuntime -------------------------------------------
import { EventEmitter } from "node:events";
import { BotRuntime } from "./runtime.mjs";
import { ProviderRouter } from "./provider-router.mjs";


test("BotRuntime creates, chats with and reads history of a Claude bot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-runtime-"));
  const store = new Store(join(dir, "state.sqlite"));
  const log = [];
  const codex = new MinimalCodex();
  const claude = new ClaudeBackend({ store, credential: "test", configDir: join(dir, "claude"), mcp: fakeMcp,
    query: fakeQuery((user) => [text("m1", `You said: ${user.message.content.at(-1).text}`), result(user.uuid)], log) });
  const router = new ProviderRouter({ codex, claude });
  const runtime = new BotRuntime({ store, codex: router, root: join(dir, "bots") });
  t.after(async () => { claude.close(); await settle(); runtime.usage?.stop?.(); store.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.start();
  const op = (botId, method, params = {}) => runtime.handle({ method, botId, params, operationId: crypto.randomUUID() });

  const bot = await runtime.handle({ method: "bots.create", params: { name: "Sage", provider: "claude" }, operationId: "create-claude" });
  assert.equal(bot.provider, "claude");
  assert.match(bot.threadId, /^claude:/);
  assert.equal(bot.model, "opus");
  assert.ok(runtime.models.some((m) => m.provider === "claude"));
  assert.ok(!codex.calls.some((c) => c.params?.threadId === bot.threadId), "Codex never sees the Claude thread");
  const session = log.find((ctx) => ctx.options.cwd === bot.cwd);
  assert.match(session.options.systemPrompt.append, /SOUL\.md/);

  const sent = await op(bot.id, "turn.send", { text: "hello" });
  assert.ok(sent.turn.id);
  await until(() => !store.bot(bot.id).activeTurnId && store.bot(bot.id).status === "idle");
  // The runtime's profile context rides along with the user text.
  assert.ok(session.last.message.content.some((c) => c.text?.startsWith("<botProfile>")));
  const history = await op(bot.id, "history.view", {});
  const types = JSON.stringify(history).match(/"type":"(userMessage|agentMessage)"/g) ?? [];
  assert.ok(types.length >= 2, "history shows the user message and the reply");
  assert.match(JSON.stringify(history), /You said: hello/);

  // Settings changes validate against the Claude catalog only.
  await assert.rejects(op(bot.id, "bots.update", { model: "gpt-6.1-sol" }), /not available/);
  const updated = await op(bot.id, "bots.update", { model: "opus", effort: "max" });
  assert.equal(updated.effort, "max");
});

test("streamed thinking becomes a reasoning row only when it has text", () => {
  const turn = new ClaudeTurn({ threadId: "claude:t", turnId: "t1", cwd: "/w", now: () => 1 });
  const ev = (event) => ({ type: "stream_event", parent_tool_use_id: null, event });
  const notes = [
    ...turn.consume(ev({ type: "message_start", message: { id: "m" } })),
    ...turn.consume(ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } })),
    ...turn.consume(ev({ type: "content_block_start", index: 1, content_block: { type: "thinking" } })),
    ...turn.consume(ev({ type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "plan" } })),
    ...turn.consume({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "thinking", thinking: "" }] } }),
    ...turn.consume({ type: "assistant", parent_tool_use_id: null, message: { id: "m", content: [{ type: "thinking", thinking: "" }] } }),
  ];
  assert.deepEqual(notes.filter((n) => n.method === "item/started").map((n) => n.params.item.id), ["m:1"]);
  assert.deepEqual(turn.turn.items, [{ type: "reasoning", id: "m:1", summary: ["plan"], content: [] }]);
});

// --- Phase 3: questions and bridge tools ------------------------------------
const askBlock = { type: "tool_use", id: "ask1", name: "AskUserQuestion",
  input: { questions: [{ question: "Favorite color?", header: "Color", multiSelect: false,
    options: [{ label: "Blue", description: "calm" }, { label: "Red", description: "bold" }] }] } };
const assistant = (id, block) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content: [block] } });

test("AskUserQuestion becomes a native user-input request and its answer returns to the SDK", async (t) => {
  let decision;
  const { claude, notes } = await setup(t, async (user, ctx) => {
    const ac = new AbortController();
    decision = await ctx.options.canUseTool("AskUserQuestion", askBlock.input, { signal: ac.signal, toolUseID: "ask1" });
    return [text("m2", `Picked ${decision.updatedInput?.answers?.["Favorite color?"]}`), result(user.uuid)];
  });
  const requests = [];
  claude.on("request", (r) => requests.push(r));
  const { thread } = await claude.call("thread/start", { cwd: "/bots/q" });
  const { turn } = await claude.call("turn/start", { threadId: thread.id, input: input("ask me") });
  await until(() => requests.length);
  const [request] = requests;
  assert.equal(request.method, "item/tool/requestUserInput");
  assert.match(request.id, /^claude:/);
  assert.deepEqual(request.params, { threadId: thread.id, turnId: turn.id, itemId: "ask1", isBlocking: true, autoResolutionMs: null,
    questions: [{ id: "q1", header: "Color", question: "Favorite color?", isOther: true, isSecret: false,
      options: [{ label: "Blue", description: "calm" }, { label: "Red", description: "bold" }] }] });
  assert.deepEqual((await claude.call("thread/read", { threadId: thread.id })).thread.status, { type: "active", activeFlags: ["waitingOnUserInput"] });
  claude.respond(request.id, { answers: { q1: { answers: ["Blue"] } } });
  claude.respond(request.id, { answers: { q1: { answers: ["Red"] } } }); // A late duplicate is ignored.
  await until(() => notes.some((n) => n.method === "turn/completed"));
  assert.equal(decision.behavior, "allow");
  assert.deepEqual(decision.updatedInput.answers, { "Favorite color?": "Blue" });
  assert.ok(notes.some((n) => n.method === "serverRequest/resolved" && n.params.requestId === request.id));
  assert.equal(notes.find((n) => n.method === "turn/completed").params.turn.items.at(-1).text, "Picked Blue");
});

test("an unanswered question is settled when its turn is interrupted", async (t) => {
  let decision;
  const { claude, notes } = await setup(t, async (user, ctx) => {
    const ac = new AbortController();
    ctx.wake = () => ac.abort();
    decision = await ctx.options.canUseTool("AskUserQuestion", askBlock.input, { signal: ac.signal, toolUseID: "ask1" });
    return [result(user.uuid, { subtype: "error_during_execution", is_error: true, errors: ["interrupted"] })];
  });
  const requests = [];
  claude.on("request", (r) => requests.push(r));
  const { thread } = await claude.call("thread/start", { cwd: "/bots/qi" });
  const { turn } = await claude.call("turn/start", { threadId: thread.id, input: input("ask") });
  await until(() => requests.length);
  await claude.call("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  await until(() => notes.some((n) => n.method === "turn/completed"));
  assert.equal(decision.behavior, "deny");
  assert.ok(notes.some((n) => n.method === "serverRequest/resolved"));
  assert.equal(claude.requests.size, 0);
});

test("bridge dynamic tools run through an in-process MCP server as native tool calls", async (t) => {
  let toolResult, server;
  const { claude, log } = await setup(t, async (user, ctx) => {
    server = ctx.options.mcpServers.bots;
    toolResult = await server.tools.find((x) => x.name === "bots_report_result").handler({ summary: "found it" });
    return [result(user.uuid)];
  });
  const requests = [];
  claude.on("request", (r) => requests.push(r));
  const { thread } = await claude.call("thread/start", { cwd: "/bots/d", dynamicTools: [
    { type: "function", name: "bots_report_result", description: "Report", inputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
    { type: "function", name: "bots_schedule_list", description: "List", inputSchema: { type: "object", properties: {} } },
  ] });
  assert.deepEqual(log.at(-1).options.mcpServers.bots.tools.map((x) => x.name), ["bots_report_result", "bots_schedule_list"]);
  const { turn } = await claude.call("turn/start", { threadId: thread.id, input: input("report") });
  await until(() => requests.length);
  assert.equal(requests[0].method, "item/tool/call");
  assert.deepEqual(requests[0].params, { threadId: thread.id, turnId: turn.id, callId: requests[0].id, namespace: null,
    tool: "bots_report_result", arguments: { summary: "found it" } });
  assert.ok(server.tools[0].shape.summary, "the JSON schema becomes the tool's input shape");
  claude.respond(requests[0].id, { success: true, contentItems: [{ type: "inputText", text: "{\"ok\":true}" }] });
  await until(() => toolResult);
  assert.deepEqual(toolResult, { isError: false, content: [{ type: "text", text: "{\"ok\":true}" }] });
  // A tool called outside a turn is refused without a request.
  assert.equal((await server.tools[1].handler({})).isError, true);
  assert.equal(requests.length, 1);
});

test("BotRuntime answers a Claude question card and runs a bridge tool for a Claude bot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-runtime-q-"));
  const store = new Store(join(dir, "state.sqlite"));
  const codex = new MinimalCodex();
  const seen = {};
  const claude = new ClaudeBackend({ store, credential: "test", configDir: join(dir, "claude"), mcp: fakeMcp,
    query: fakeQuery(async (user, ctx) => {
      seen.tool = await ctx.options.mcpServers.bots.tools.find((x) => x.name === "bots_schedule_list").handler({});
      seen.decision = await ctx.options.canUseTool("AskUserQuestion", askBlock.input, { signal: new AbortController().signal, toolUseID: "ask1" });
      return [text("m1", "thanks"), result(user.uuid)];
    }) });
  const runtime = new BotRuntime({ store, codex: new ProviderRouter({ codex, claude }), root: join(dir, "bots") });
  t.after(async () => { claude.close(); await settle(); runtime.usage?.stop?.(); store.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.start();
  const events = [];
  runtime.on("event", (e) => events.push(e));
  const op = (botId, method, params = {}) => runtime.handle({ method, botId, params, operationId: crypto.randomUUID() });
  const bot = await runtime.handle({ method: "bots.create", params: { name: "Quill", provider: "claude" }, operationId: "create-quill" });
  await op(bot.id, "turn.send", { text: "go" });
  await until(() => store.list("pending", bot.id).length);
  const [pending] = store.list("pending", bot.id);
  assert.equal(pending.request.method, "item/tool/requestUserInput");
  assert.equal(store.bot(bot.id).status, "waiting");
  assert.ok(events.some((e) => e.type === "request" && e.data.key === pending.key));
  // The bridge tool ran in the runtime and its JSON result reached the SDK.
  assert.equal(seen.tool.isError, false);
  assert.ok(Array.isArray(JSON.parse(seen.tool.content[0].text).schedules));
  await op(bot.id, "requests.respond", { key: pending.key, result: { answers: { q1: { answers: ["Red"] } } } });
  await until(() => seen.decision && !store.bot(bot.id).activeTurnId);
  assert.deepEqual(seen.decision.updatedInput.answers, { "Favorite color?": "Red" });
  assert.equal(store.list("pending", bot.id).length, 0);
  assert.notEqual(store.bot(bot.id).status, "waiting");
});

// --- Phase 4: native queue, compaction, effort ------------------------------
test("the native queue starts when idle, waits behind a running turn and drains in order", async (t) => {
  const gates = [];
  const { claude, notes } = await setup(t, async (user) => {
    await new Promise((r) => gates.push(r));
    return [text(`m-${user.uuid}`, `done ${user.message.content.at(-1).text}`), result(user.uuid)];
  });
  const { thread } = await claude.call("thread/start", { cwd: "/bots/queue" });
  const add = (id, t) => claude.call("thread/queue/add", { threadId: thread.id, input: input(t), clientUserMessageId: id });
  const first = await add("c1", "one");
  await until(() => gates.length === 1);
  assert.deepEqual((await claude.call("thread/queue/list", { threadId: thread.id })).data, [], "an idle thread starts the first prompt");
  const second = await add("c2", "two"), third = await add("c3", "three");
  assert.deepEqual(await add("c2", "two again"), { queuedSubmission: second.queuedSubmission }, "same client message is idempotent");
  await claude.call("thread/queue/update", { threadId: thread.id, queuedSubmissionId: third.queuedSubmission.id, input: input("THREE") });
  await claude.call("thread/queue/reorder", { threadId: thread.id, queuedSubmissionIds: [third.queuedSubmission.id, second.queuedSubmission.id] });
  await assert.rejects(claude.call("thread/queue/reorder", { threadId: thread.id, queuedSubmissionIds: [second.queuedSubmission.id] }), (e) => e.definite);
  gates.shift()();
  await until(() => gates.length === 1);
  gates.shift()();
  await until(() => gates.length === 1);
  gates.shift()();
  await until(() => notes.filter((n) => n.method === "turn/completed").length === 3);
  const users = notes.filter((n) => n.method === "turn/completed").map((n) => n.params.turn.items[0]);
  assert.deepEqual(users.map((u) => [u.clientId, u.content[0].text]), [["c1", "one"], ["c3", "THREE"], ["c2", "two"]]);
  assert.ok(notes.some((n) => n.method === "thread/queue/changed"));
  assert.equal(first.queuedSubmission.clientUserMessageId, "c1");
});

test("a stopped turn holds the queue until it is started explicitly", async (t) => {
  let gate;
  const { claude, notes } = await setup(t, async (user, ctx) => {
    if (user.message.content.at(-1).text === "slow") { await new Promise((r) => { gate = r; ctx.wake = r; }); }
    return [result(user.uuid)];
  });
  const { thread } = await claude.call("thread/start", { cwd: "/bots/hold" });
  const { turn } = await claude.call("turn/start", { threadId: thread.id, input: input("slow") });
  const queued = await claude.call("thread/queue/add", { threadId: thread.id, input: input("later"), clientUserMessageId: "c9" });
  await until(() => gate);
  await claude.call("turn/interrupt", { threadId: thread.id, turnId: turn.id });
  await until(() => notes.some((n) => n.method === "turn/completed"));
  await settle();
  assert.equal((await claude.call("thread/queue/list", { threadId: thread.id })).data.length, 1);
  const started = await claude.call("thread/queue/start", { threadId: thread.id, queuedSubmissionId: queued.queuedSubmission.id });
  assert.equal(started.turn.status, "inProgress");
  await until(() => notes.filter((n) => n.method === "turn/completed").length === 2);
  assert.deepEqual((await claude.call("thread/queue/list", { threadId: thread.id })).data, []);
});

test("compaction runs /compact as its own turn with a contextCompaction item", async (t) => {
  const { claude, notes, log } = await setup(t, async (user) => user.message.content === "/compact"
    ? [{ type: "system", subtype: "compact_boundary", uuid: "cb1" }, result(user.uuid)]
    : [result(user.uuid)]);
  const { thread } = await claude.call("thread/start", { cwd: "/bots/compact" });
  assert.deepEqual(await claude.call("thread/compact/start", { threadId: thread.id }), {});
  await until(() => notes.some((n) => n.method === "turn/completed"));
  const turn = notes.find((n) => n.method === "turn/completed").params.turn;
  assert.equal(turn.status, "completed");
  assert.deepEqual(turn.items, [{ type: "contextCompaction", id: "cb1" }]);
  assert.equal(log.at(-1).last.message.content, "/compact");
});

test("a changed effort restarts an idle session on resume with the new effort", async (t) => {
  const { claude, notes, log } = await setup(t, async (user) => [result(user.uuid)]);
  const { thread } = await claude.call("thread/start", { cwd: "/bots/effort", effort: "high" });
  await claude.call("turn/start", { threadId: thread.id, input: input("a"), effort: "high" });
  await until(() => notes.some((n) => n.method === "turn/completed"));
  const before = log.length;
  await claude.call("turn/start", { threadId: thread.id, input: input("b"), effort: "max" });
  assert.equal(log.length, before + 1);
  assert.equal(log.at(-1).options.effort, "max");
  assert.equal(log.at(-1).options.resume, thread.sessionId);
  assert.ok(!notes.some((n) => n.method === "thread/status/changed" && n.params.status.type === "notLoaded"), "the restart is internal");
});

test("BotRuntime queue and schedules run on a Claude bot", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-runtime-queue-"));
  const store = new Store(join(dir, "state.sqlite"));
  const prompts = [];
  const claude = new ClaudeBackend({ store, credential: "test", configDir: join(dir, "claude"), mcp: fakeMcp,
    query: fakeQuery(async (user) => { prompts.push(JSON.stringify(user.message.content)); return [text(`m-${user.uuid}`, "ok"), result(user.uuid)]; }) });
  const runtime = new BotRuntime({ store, codex: new ProviderRouter({ codex: new MinimalCodex(), claude }), root: join(dir, "bots") });
  t.after(async () => { claude.close(); await settle(); runtime.usage?.stop?.(); store.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.start();
  const op = (botId, method, params = {}) => runtime.handle({ method, botId, params, operationId: crypto.randomUUID() });
  const bot = await runtime.handle({ method: "bots.create", params: { name: "Queue", provider: "claude" }, operationId: "create-queue-bot" });
  const added = await op(bot.id, "queue.add", { text: "queued hello" });
  assert.ok(added.queuedSubmission || added.consumedTurnId);
  // The service ticks the staged queue and scheduler; drive it here.
  const ticking = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) { await runtime.tick(); await settle(); } assert.ok(fn()); };
  await ticking(() => prompts.some((p) => p.includes("queued hello")) && !store.bot(bot.id).activeTurnId);
  const schedule = await op(bot.id, "schedules.save", { title: "Check", prompt: "scheduled check", cron: "0 * * * *", timeZone: "UTC" });
  await op(bot.id, "schedules.run", { id: schedule.id });
  await ticking(() => prompts.some((p) => p.includes("scheduled check")));
  await ticking(() => store.list("run").some((r) => r.status === "completed"));
  const turns = store.list("claudeTurn").map((r) => r.turn.status);
  assert.ok(turns.length >= 2 && turns.every((s) => s === "completed"), JSON.stringify(turns));
});

test("Plan mode switches the SDK permission mode and declines ExitPlanMode for review", async (t) => {
  const { claude, notes, log } = await setup(t, async (user, ctx) => {
    ctx.decision = await ctx.options.canUseTool("ExitPlanMode", { plan: "1. Step" }, { signal: new AbortController().signal, toolUseID: "x1" });
    return [assistant("m1", { type: "tool_use", id: "x1", name: "ExitPlanMode", input: { plan: "1. Step" } }), result(user.uuid)];
  });
  const modes = [];
  const { thread } = await claude.call("thread/start", { cwd: "/bots/plan" });
  const ctx = log.at(-1);
  claude.sessions.get(thread.id).query.setPermissionMode = async (m) => modes.push(m);
  await claude.call("turn/start", { threadId: thread.id, input: input("plan it"), collaborationMode: { mode: "plan" } });
  await until(() => notes.some((n) => n.method === "turn/completed"));
  assert.equal(ctx.decision.behavior, "deny");
  assert.ok(notes.some((n) => n.method === "item/completed" && n.params.item.type === "plan" && n.params.item.text === "1. Step"));
  await claude.call("turn/start", { threadId: thread.id, input: input("go"), collaborationMode: { mode: "default" } });
  assert.deepEqual(modes, ["plan", "default"]);
});

test("usage: real rate-limit events flatten into per-window rows; turn costs are totalled", async (t) => {
  const { rateLimitWindows, turnUsage } = await import("./claude.mjs");
  const rows = rateLimitWindows({ five_hour: { status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 100, isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.81, resetsAt: 100 }, seven_day: { utilization: 0.2, resetsAt: 900 } }, observedAt: "2026-10-14T20:00:00.000Z" } });
  assert.deepEqual(rows.map((r) => [r.type, r.status, r.utilization, r.resetsAt]), [["five_hour", "allowed_warning", 0.81, 100], ["seven_day", "allowed", 0.2, 900]]);
  const usage = turnUsage({ total_cost_usd: 0.5, usage: { input_tokens: 10, output_tokens: 5 } }, turnUsage({ total_cost_usd: 0.25, usage: { input_tokens: 1 } }));
  assert.deepEqual(usage, { costUsd: 0.75, inputTokens: 11, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 });

  const { claude } = await setup(t, async (user, ctx) => [
    { type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 5 } } } },
    result(user.uuid, { total_cost_usd: 0.02, usage: { input_tokens: 3, output_tokens: 4 } })]);
  const { thread } = await claude.call("thread/start", { cwd: "/bots/usage" });
  await claude.call("turn/start", { threadId: thread.id, input: input("hi") });
  await until(() => claude.data.turns(thread.id)[0]?.turn.status === "completed");
  const read = await claude.call("claude/usage/read", { threadId: thread.id });
  assert.deepEqual(read.rateLimits.map((r) => [r.type, r.utilization]), [["five_hour", 0.1]]);
  assert.equal(read.thread.all.turns, 1);
  assert.equal(read.account.day.costUsd, 0.02);
  assert.equal(read.thread.all.outputTokens, 4);
});

// --- Portable agent wiring ---------------------------------------------------
import { writeFile as writeFileAsync } from "node:fs/promises";
import { createHash } from "node:crypto";
import { portableClaude } from "../portable/agent-claude.mjs";

test("portable agent: Claude is off by default and its executable is pinned by SHA-256", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-portable-"));
  const store = new Store(join(dir, "state.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(portableClaude(store, dir, {}), null);
  assert.equal(portableClaude(store, dir, { BOTS_CLAUDE_ENABLED: "0" }), null);
  const binary = join(dir, "claude-bin");
  await writeFileAsync(binary, "#!/bin/sh\n", { mode: 0o700 });
  const sha = createHash("sha256").update("#!/bin/sh\n").digest("hex");
  const make = (env) => {
    const backend = portableClaude(store, dir, { BOTS_CLAUDE_ENABLED: "1", ...env });
    Object.assign(backend, { credential: "test", query: fakeQuery(async () => []), mcp: fakeMcp });
    return backend;
  };
  await assert.rejects(make({}).start(), /absolute path/);
  const { chmod } = await import("node:fs/promises");
  await chmod(binary, 0o775);
  await assert.rejects(make({ BOTS_CLAUDE_BINARY: binary, BOTS_CLAUDE_BINARY_SHA256: sha }).start(), /writable/);
  await chmod(binary, 0o700);
  await assert.rejects(make({ BOTS_CLAUDE_BINARY: binary }).start(), /reviewed SHA-256/);
  await assert.rejects(make({ BOTS_CLAUDE_BINARY: binary, BOTS_CLAUDE_BINARY_SHA256: "0".repeat(64) }).start(), /differs/);
  const ok = make({ BOTS_CLAUDE_BINARY: binary, BOTS_CLAUDE_BINARY_SHA256: sha });
  const log = [];
  ok.query = fakeQuery(async () => [], log);
  await ok.start();
  t.after(() => ok.close());
  assert.equal(ok.configDir, join(dir, "claude"));
  assert.equal(log[0].options.pathToClaudeCodeExecutable, binary, "the model catalog read uses the pinned binary");
  const { thread } = await ok.call("thread/start", { cwd: "/bots/p" });
  assert.equal(log.at(-1).options.pathToClaudeCodeExecutable, binary);
  assert.match(thread.id, /^claude:/);
});

test("portable agent: a misconfigured Claude backend never blocks Codex startup", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-portable-fault-"));
  const store = new Store(join(dir, "state.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const codex = new MinimalCodex();
  const claude = portableClaude(store, dir, { BOTS_CLAUDE_ENABLED: "1", BOTS_CLAUDE_BINARY: "relative/claude" });
  claude.credential = "test";
  const router = new ProviderRouter({ codex, claude });
  const faults = [];
  router.on("claudeFault", (e) => faults.push(e.message));
  await router.start();
  assert.equal(router.ready, true);
  assert.equal(router.claudeReady, false);
  assert.match(faults[0], /absolute path/);
  await assert.rejects(router.call("thread/start", { provider: "claude", cwd: "/bots/x" }), (e) => e.definite);
});


test("BotRuntime sends the full profile once per conversation epoch, then only changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "claude-runtime-delivery-"));
  const store = new Store(join(dir, "state.sqlite"));
  const log = [];
  const claude = new ClaudeBackend({ store, credential: "test", configDir: join(dir, "claude"), mcp: fakeMcp,
    query: fakeQuery(async (user) => user.message.content === "/compact"
      ? [{ type: "system", subtype: "compact_boundary", uuid: `cb-${user.uuid}` }, result(user.uuid)]
      : [text(`m-${user.uuid}`, "ok"), result(user.uuid)], log) });
  const runtime = new BotRuntime({ store, codex: new ProviderRouter({ codex: new MinimalCodex(), claude }), root: join(dir, "bots") });
  t.after(async () => { claude.close(); await settle(); runtime.usage?.stop?.(); store.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.start();
  const op = (botId, method, params = {}) => runtime.handle({ method, botId, params, operationId: crypto.randomUUID() });
  const bot = await runtime.handle({ method: "bots.create", params: { name: "Lean", provider: "claude" }, operationId: "create-lean-bot" });
  const session = () => log.find((ctx) => ctx.options.cwd === bot.cwd);
  assert.match(session().options.systemPrompt.append, /Secure one-time input/, "standing policy is in the thread instructions");
  const profileOf = () => session().last.message.content.find((c) => c.text?.startsWith("<botProfile>")).text;
  const idle = () => until(() => !store.bot(bot.id).activeTurnId && store.list("claudeTurn").every((r) => r.turn.status !== "inProgress"));

  await op(bot.id, "turn.send", { text: "one" }); await idle();
  const first = profileOf();
  assert.match(first, /## SOUL\.md/);
  assert.doesNotMatch(first, /Current application operating policy|## Secure one-time input/, "no per-message policy copy");
  await op(bot.id, "turn.send", { text: "two" }); await idle();
  const second = profileOf();
  assert.doesNotMatch(second, /## SOUL\.md/);
  assert.match(second, /Unchanged since provided earlier/);
  assert.ok(second.length < first.length / 3, `${second.length} vs ${first.length}`);

  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(bot.cwd, "MEMORY.md"), "# Memory\n\nNew fact.\n");
  await op(bot.id, "turn.send", { text: "three" }); await idle();
  assert.match(profileOf(), /## MEMORY\.md\n# Memory\n\nNew fact\./);
  assert.doesNotMatch(profileOf(), /## SOUL\.md/);

  await op(bot.id, "thread.compact", {});
  await until(() => !store.get("profileDelivery", bot.id));
  await idle();
  await op(bot.id, "turn.send", { text: "four" }); await idle();
  assert.match(profileOf(), /## SOUL\.md/, "a compaction starts a new epoch");
});

test("the Claude child environment carries only its own credential, never the service secrets", async (t) => {
  const saved = { ...process.env };
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]; Object.assign(process.env, saved); });
  Object.assign(process.env, { BOTS_MACHINE_SECRET: "m", BOTS_STORAGE_SERVICE_SECRET: "s", BOTS_NOTIFICATION_SECRET: "n", OPENAI_API_KEY: "o", CLAUDE_CODE_OAUTH_TOKEN: "oauth", BOTS_SITE_URL: "https://example.invalid" });
  const env = new ClaudeBackend({ credential: "oauth", configDir: "/tmp/claude-config" }).env();
  for (const name of ["BOTS_MACHINE_SECRET", "BOTS_STORAGE_SERVICE_SECRET", "BOTS_NOTIFICATION_SECRET", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) assert.equal(env[name], undefined, name);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "oauth");
  assert.equal(env.CLAUDE_CONFIG_DIR, "/tmp/claude-config");
  assert.equal(env.BOTS_SITE_URL, "https://example.invalid");
  assert.equal(env.PATH, process.env.PATH);
});
