import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { BotRuntime, validateResponse } from "./runtime.mjs";
import { slugify, cleanName, PROFILE_FILES } from "./profiles.mjs";
import { normalizeSchedule, collectDueRuns } from "./schedules.mjs";
import { signBotTicket, verifyBotTicket, botsOwner } from "../lib/bots-auth.ts";
class FakeCodex extends EventEmitter {
  calls = [];
  threads = [];
  answers = [];
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === "config/read")
      return { config: { model: "model", model_reasoning_effort: "high" } };
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list")
      return {
        data: [
          {
            model: "model",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
        nextCursor: null,
      };
    if (method === "thread/start") {
      const thread = {
        id: `thread-${this.threads.length}`,
        cwd: params.cwd,
        turns: [],
      };
      this.threads.push(thread);
      return { thread };
    }
    if (method === "thread/read")
      return { thread: this.threads.find((t) => t.id === params.threadId) };
    if (method === "thread/turns/list")
      return {
        data: [
          ...this.threads.find((t) => t.id === params.threadId).turns,
        ].reverse(),
        nextCursor: null,
      };
    if (method === "thread/list")
      return { data: this.threads, nextCursor: null };
    if (method === "turn/start") {
      const turn = {
        id: `turn-${this.calls.length}`,
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: "native-id",
            clientId: params.clientUserMessageId,
            content: params.input,
          },
        ],
      };
      this.threads.find((t) => t.id === params.threadId).turns.push(turn);
      return { turn };
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
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "bots-test-"));
  const store = new Store(join(dir, "state.sqlite"));
  const codex = new FakeCodex();
  const runtime = new BotRuntime({ store, codex, root: join(dir, "bots") });
  await runtime.start();
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const create = (name = "Atlas", id = "create-operation-1") =>
    runtime.handle({
      method: "bots.create",
      params: { name },
      operationId: id,
    });
  return { dir, store, codex, runtime, create };
}
const op = (
  runtime,
  botId,
  method,
  params = {},
  operationId = crypto.randomUUID(),
) => runtime.handle({ method, botId, params, operationId });
test("initial history retries native rollout initialization and preserves saved turns", async (t) => {
  const { create, runtime, codex } = await setup(t);
  const bot = await create();
  const turns = [
    { id: "first", items: [] },
    { id: "second", items: [] },
  ];
  codex.threads[0].turns = turns;
  const call = codex.call.bind(codex);
  let attempts = 0;
  codex.call = async (method, params) => {
    if (method === "thread/turns/list") {
      attempts++;
      if (attempts === 1)
        throw new Error(
          `invalid paginated history lineage for ${bot.threadId}: missing source rollout`,
        );
      if (attempts === 2)
        throw Object.assign(new Error("list_turns is not supported yet"), {
          rpcCode: -32601,
        });
    }
    return call(method, params);
  };
  const history = await op(runtime, bot.id, "history");
  assert.deepEqual(history.thread.turns, turns);
  assert.equal(history.thread.id, bot.threadId);
  assert.equal(history.nextCursor, null);
  assert.equal(attempts, 3);
  assert.equal(
    codex.calls.filter(
      (c) => c.method === "thread/read" && c.params.includeTurns,
    ).length,
    2,
  );
  assert.equal(
    codex.calls.filter((c) => c.method === "thread/start").length,
    1,
  );
});
test("new empty history synchronizes through native read without inventing turns", async (t) => {
  const { create, runtime, codex } = await setup(t);
  const bot = await create();
  const call = codex.call.bind(codex);
  let hydrated = false;
  codex.call = async (method, params) => {
    if (method === "thread/turns/list" && !hydrated)
      throw new Error(
        `invalid paginated history lineage for ${bot.threadId}: missing source rollout`,
      );
    if (method === "thread/read" && params.includeTurns) hydrated = true;
    return call(method, params);
  };
  const history = await op(runtime, bot.id, "history");
  assert.equal(hydrated, true);
  assert.deepEqual(history.thread.turns, []);
  assert.equal(history.nextCursor, null);
});
test("history errors remain visible and cursor pages are not retried", async (t) => {
  const { create, runtime, codex } = await setup(t);
  const bot = await create();
  const call = codex.call.bind(codex);
  let attempts = 0;
  let failure = new Error("history is corrupt");
  codex.call = async (method, params) => {
    if (method === "thread/turns/list") {
      attempts++;
      throw failure;
    }
    return call(method, params);
  };
  await assert.rejects(op(runtime, bot.id, "history"), /history is corrupt/);
  assert.equal(attempts, 1);
  failure = new Error(
    `invalid paginated history lineage for ${bot.threadId}: missing source rollout`,
  );
  await assert.rejects(
    op(runtime, bot.id, "history.page", { cursor: "older" }),
    /missing source rollout/,
  );
  assert.equal(attempts, 2);
  await assert.rejects(
    op(runtime, bot.id, "history"),
    /missing source rollout/,
  );
  assert.equal(attempts, 8);
});
test("creation retry, stable avatar, normalized unique directories and one-to-one thread mapping", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const a = await create("Átlas / ../../");
  const again = await create("Átlas / ../../");
  assert.deepEqual(again, a);
  assert.equal(
    codex.calls.filter((c) => c.method === "thread/start").length,
    1,
  );
  assert.equal(a.slug, "atlas");
  const b = await create("Atlas", "create-operation-2");
  assert.equal(b.slug, "atlas-2");
  for (const f of PROFILE_FILES)
    assert.ok(await readFile(join(a.cwd, f), "utf8"));
  await op(runtime, a.id, "bots.update", { name: "Hermes" });
  const renamed = store.bot(a.id);
  assert.equal(renamed.color, a.color);
  assert.equal(renamed.cwd, a.cwd);
  assert.equal(renamed.threadId, a.threadId);
  assert.throws(() => store.saveBot({ ...b, threadId: a.threadId }), /UNIQUE/);
  assert.equal(slugify("日本語"), "bot");
  assert.throws(() => cleanName("\n"), /name/);
});
test("changed profile read for each turn, steering and Stop use mapped thread", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  await op(runtime, bot.id, "turn.send", { text: "hello" });
  await writeFile(join(bot.cwd, "SOUL.md"), "Changed personality");
  await op(runtime, bot.id, "turn.send", { text: "follow-up" });
  const steer = codex.calls.find((c) => c.method === "turn/steer");
  assert.match(
    steer.params.additionalContext.botProfile.value,
    /Changed personality/,
  );
  assert.equal(steer.params.threadId, bot.threadId);
  await op(runtime, bot.id, "turn.interrupt");
  assert.equal(codex.calls.at(-1).method, "turn/interrupt");
  assert.ok(store.bot(bot.id).activeTurnId);
});
test("all enabled request families, reconnect snapshot, duplicate device resolution", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  const variants = [
    ["item/commandExecution/requestApproval", { decision: "accept" }],
    ["item/fileChange/requestApproval", { decision: "decline" }],
    ["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    ["execCommandApproval", { decision: "approved" }],
    ["applyPatchApproval", { decision: "abort" }],
    [
      "mcpServer/elicitation/request",
      { action: "accept", content: { ok: true } },
    ],
    ["item/tool/requestUserInput", { answers: { q: { answers: ["yes"] } } }],
  ];
  for (const [method, result] of variants) {
    await runtime.onServerRequest({
      id: 42,
      method,
      params: {
        threadId: bot.threadId,
        turnId: "turn",
        permissions: {},
        questions: [{ id: "q" }],
      },
    });
    const key = runtime.snapshot().pending[0].key;
    await op(runtime, bot.id, "requests.respond", { key, result });
    await assert.rejects(
      op(runtime, bot.id, "requests.respond", { key, result }),
      /not found/,
    );
    assert.equal(store.list("pending").length, 0);
    assert.equal(codex.answers.at(-1).id, 42);
  }
  assert.ok(store.replay(0).some((e) => e.type === "request.resolved"));
  assert.throws(() =>
    validateResponse(
      { method: "item/commandExecution/requestApproval", params: {} },
      { decision: "invented" },
    ),
  );
});
test("async questions persist across turn completion and answer in same thread", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  runtime.onNotification({
    method: "item/completed",
    params: {
      threadId: bot.threadId,
      turnId: "t",
      item: {
        id: "question",
        type: "agentMessage",
        text: "Choose",
        questions: [{ title: "Which?", options: ["A", "B"] }],
      },
    },
  });
  runtime.onNotification({
    method: "turn/completed",
    params: { threadId: bot.threadId, turn: { id: "t", status: "completed" } },
  });
  assert.equal(store.bot(bot.id).status, "waiting");
  const pending = runtime.snapshot().pending[0];
  await op(runtime, bot.id, "requests.respond", {
    key: pending.key,
    result: { answers: { 0: { answers: ["A"] } } },
  });
  assert.equal(store.list("pending").length, 0);
  assert.match(
    codex.calls.findLast((c) => c.method === "turn/start").params.input[0].text,
    /Which\?\nA/,
  );
});
test("bounded acknowledged attachments, cross-bot isolation, artifact downloads and symlink escape", async (t) => {
  const { create, runtime } = await setup(t);
  const bot = await create(),
    other = await create("Other", "create-operation-2");
  const a = await op(runtime, bot.id, "attachments.begin", {
    name: "../hello.txt",
    size: 5,
    mimeType: "text/plain",
  });
  const chunk = {
    id: a.id,
    offset: 0,
    data: Buffer.from("hello").toString("base64"),
  };
  assert.deepEqual(await op(runtime, bot.id, "attachments.chunk", chunk), {
    received: 5,
  });
  assert.deepEqual(await op(runtime, bot.id, "attachments.chunk", chunk), {
    received: 5,
  });
  await op(runtime, bot.id, "attachments.finish", { id: a.id });
  const file = await op(runtime, bot.id, "attachments.read", { id: a.id });
  assert.equal(Buffer.from(file.data, "base64").toString(), "hello");
  await assert.rejects(
    op(runtime, other.id, "attachments.read", { id: a.id }),
    /not found/,
  );
  await assert.rejects(
    op(runtime, bot.id, "attachments.begin", {
      name: "huge",
      size: 101 * 1024 * 1024,
    }),
    /100 MB/,
  );
  await symlink("/etc/hosts", join(bot.cwd, "outside"));
  await assert.rejects(
    runtime.publishArtifact(bot, { path: "outside" }),
    /regular/,
  );
});
test("archive pauses schedules and retains files, restore retains mapping", async (t) => {
  const { create, runtime, store } = await setup(t);
  const bot = await create();
  const schedule = await op(runtime, bot.id, "schedules.save", {
    title: "Check",
    prompt: "check",
    cron: "0 * * * *",
    timeZone: "UTC",
  });
  await op(runtime, bot.id, "bots.archive");
  assert.equal(store.get("schedule", schedule.id).enabled, false);
  assert.ok(await readFile(join(bot.cwd, "SOUL.md")));
  await op(runtime, bot.id, "bots.restore");
  assert.equal(store.bot(bot.id).threadId, bot.threadId);
  assert.equal(store.get("schedule", schedule.id).enabled, false);
});
test("schedule timezone DST, missed runs coalesce and pending requests block queued runs", async (t) => {
  const { create, runtime, store, codex } = await setup(t);
  const bot = await create();
  const schedule = normalizeSchedule(
    {
      title: "Check",
      prompt: "check",
      cron: "0 9 * * *",
      timeZone: "America/Toronto",
    },
    bot.id,
    null,
    new Date("2026-03-07T15:00:00Z"),
  );
  assert.equal(schedule.nextRunAt, "2026-03-08T13:00:00.000Z");
  store.put("schedule", schedule);
  assert.equal(
    collectDueRuns(store, new Date("2026-03-12T16:00:00Z")).length,
    1,
  );
  assert.equal(
    collectDueRuns(store, new Date("2026-03-12T17:00:00Z")).length,
    0,
  );
  assert.equal(
    store.get("schedule", schedule.id).nextRunAt,
    "2026-03-13T13:00:00.000Z",
  );
  await runtime.onServerRequest({
    id: 4,
    method: "item/tool/requestUserInput",
    params: { threadId: bot.threadId, questions: [{ id: "q" }] },
  });
  await runtime.tick();
  assert.equal(codex.calls.filter((c) => c.method === "turn/start").length, 0);
  assert.throws(() =>
    normalizeSchedule(
      { title: "x", prompt: "y", cron: "bad", timeZone: "UTC" },
      bot.id,
    ),
  );
  assert.throws(() =>
    normalizeSchedule(
      { title: "x", prompt: "y", at: "2000-01-01", timeZone: "UTC" },
      bot.id,
    ),
  );
});
test("uncertain operation recovery matches native clientId and never replays", async (t) => {
  const { create, runtime, store, codex } = await setup(t);
  const bot = await create();
  store.saveOperation("uncertain-turn", "fingerprint", "dispatching", {
    method: "turn.send",
    botId: bot.id,
  });
  codex.threads[0].turns.push({
    id: "t",
    status: "completed",
    items: [{ id: "different-native-id", clientId: "uncertain-turn" }],
  });
  await runtime.reconcileOperations();
  assert.equal(store.operation("uncertain-turn").status, "done");
  assert.equal(codex.calls.filter((c) => c.method === "turn/start").length, 0);
  store.saveOperation("unknown-turn", "fingerprint", "dispatching", {
    method: "turn.send",
    botId: bot.id,
  });
  await runtime.reconcileOperations();
  assert.equal(store.operation("unknown-turn").status, "uncertain");
});
test("notification findings deduplicate", async (t) => {
  const { create, runtime, store } = await setup(t);
  const bot = await create();
  runtime.notify(bot, "finding:1", "Action required");
  runtime.notify(bot, "finding:1", "Action required");
  assert.equal(store.list("notice").length, 1);
});
test("owner authorization excludes API tokens, foreign identities and origins; tickets expire and are machine-scoped", async () => {
  const env = { BOTS_OWNER_EMAIL: "owner@example.com" };
  const request = (headers) =>
    new Request("https://work.dawar.ca/api/bots/session", { headers });
  assert.equal(
    botsOwner(
      request({ "oai-authenticated-user-email": "owner@example.com" }),
      env,
    ),
    "owner@example.com",
  );
  assert.throws(() =>
    botsOwner(
      request({
        Authorization: "Bearer x",
        "oai-authenticated-user-email": "owner@example.com",
      }),
      env,
    ),
  );
  assert.throws(() =>
    botsOwner(
      request({ "oai-authenticated-user-email": "other@example.com" }),
      env,
    ),
  );
  assert.throws(() =>
    botsOwner(
      request({
        "oai-authenticated-user-email": "owner@example.com",
        Origin: "https://evil.example",
      }),
      env,
    ),
  );
  const payload = {
    role: "browser",
    owner: "owner@example.com",
    machineId: "vm",
    jti: "random",
    exp: 1060,
    sessionExp: 1900,
  };
  const token = await signBotTicket(payload, "secret");
  assert.deepEqual(await verifyBotTicket(token, "secret", "vm", 1000), payload);
  await assert.rejects(verifyBotTicket(token, "secret", "other", 1000));
  await assert.rejects(verifyBotTicket(token, "secret", "vm", 1061));
  await assert.rejects(verifyBotTicket(token, "wrong", "vm", 1000));
});
