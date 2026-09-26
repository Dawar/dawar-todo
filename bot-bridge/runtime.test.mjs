import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Store } from "./store.mjs";
import { BotRuntime, validateResponse } from "./runtime.mjs";
import { slugify, cleanName, PROFILE_FILES } from "./profiles.mjs";
import { normalizeSchedule, collectDueRuns } from "./schedules.mjs";
import { signBotTicket, verifyBotTicket, botsOwner } from "../lib/bots-auth.ts";
class FakeCodex extends EventEmitter {
  calls = [];
  threads = [];
  answers = [];
  queues = new Map();
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list")
      return {
        data: [
          {
            model: "gpt-6-luna",
            isDefault: true,
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            serviceTiers: [{ id: "priority", name: "Fast" }],
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
    if (method === "thread/queue/list")
      return { data: [...(this.queues.get(params.threadId) ?? [])], nextCursor: null };
    if (method === "thread/queue/add") {
      const item = { id: `queued-${this.calls.length}`, input: params.input,
        clientUserMessageId: params.clientUserMessageId };
      this.queues.set(params.threadId,
        [...(this.queues.get(params.threadId) ?? []), item]);
      return { queuedSubmission: item };
    }
    if (method === "thread/queue/update") {
      const queue = this.queues.get(params.threadId);
      const item = queue.find((x) => x.id === params.queuedSubmissionId);
      item.input = params.input;
      return { queuedSubmission: item };
    }
    if (method === "thread/queue/delete") {
      const queue = this.queues.get(params.threadId);
      const remaining = queue.filter((x) => x.id !== params.queuedSubmissionId);
      this.queues.set(params.threadId, remaining);
      return { deleted: remaining.length !== queue.length };
    }
    if (method === "thread/queue/reorder") {
      const queue = this.queues.get(params.threadId);
      this.queues.set(params.threadId,
        params.queuedSubmissionIds.map((id) => queue.find((x) => x.id === id)));
      return {};
    }
    if (method === "thread/queue/start") {
      const queue = this.queues.get(params.threadId);
      const item = queue.find((x) => x.id === params.queuedSubmissionId);
      if (!item) throw new Error("Queued prompt not found");
      this.queues.set(params.threadId, queue.filter((x) => x.id !== item.id));
      const turn = { id: `turn-${this.calls.length}`, status: "inProgress",
        items: [{ type: "userMessage", id: `native-${item.id}`,
          clientId: item.clientUserMessageId, content: item.input }] };
      this.threads.find((t) => t.id === params.threadId).turns.push(turn);
      return { turn };
    }
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
async function settleQueue(runtime, botId) {
  await new Promise((resolve) => setImmediate(resolve));
  if (runtime.locks.has(botId)) await runtime.locks.get(botId);
}
function tinyPng() {
  const crc32 = (bytes) => {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++)
        crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  };
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
test("queued uploads preserve six localImage paths and reject unready or foreign attachments", async (t) => {
  const { create, runtime, codex } = await setup(t);
  const bot = await create();
  const other = await create("Other", "create-operation-2");
  await op(runtime, bot.id, "turn.send", { text: "Working" });
  const images = [];
  const png = tinyPng();
  for (let i = 0; i < 6; i++) {
    const image = await op(runtime, bot.id, "attachments.begin", {
      name: `pasted-${i}.png`, size: png.length, mimeType: "image/png",
    });
    await op(runtime, bot.id, "attachments.chunk", {
      id: image.id, offset: 0, data: png.toString("base64"),
    });
    await op(runtime, bot.id, "attachments.finish", { id: image.id });
    images.push(image);
  }
  const queued = await op(runtime, bot.id, "queue.add", {
    text: "Inspect pasted images", attachments: images.map((a) => a.id),
  });
  assert.equal(queued.queuedSubmission.input.filter((x) => x.type === "localImage").length, 6);
  const listed = await op(runtime, bot.id, "queue.list");
  assert.deepEqual(listed[0].attachments.map((a) => a.name), images.map((a) => a.name));
  const edited = await op(runtime, bot.id, "queue.update", {
    id: queued.queuedSubmission.id,
    text: "Inspect all six pasted images carefully",
    attachments: images.map((a) => a.id),
  });
  assert.equal(edited.queuedSubmission.input.filter((x) => x.type === "localImage").length, 6);
  assert.deepEqual((await op(runtime, bot.id, "queue.list"))[0].attachments.map((a) => a.id),
    images.map((a) => a.id));
  for (const image of images)
    assert.equal((await op(runtime, bot.id, "attachments.read", { id: image.id })).size, png.length);
  const seventh = await op(runtime, bot.id, "attachments.begin", {
    name: "seventh.png", size: 1, mimeType: "image/png",
  });
  await assert.rejects(op(runtime, bot.id, "queue.add", {
    text: "Wait", attachments: [seventh.id],
  }), /finish uploading/);
  await op(runtime, bot.id, "attachments.chunk", {
    id: seventh.id, offset: 0, data: Buffer.from([7]).toString("base64"),
  });
  await op(runtime, bot.id, "attachments.finish", { id: seventh.id });
  await assert.rejects(op(runtime, bot.id, "queue.add", {
    text: "Too many", attachments: [...images, seventh].map((a) => a.id),
  }), /at most 6 images/);
  await assert.rejects(op(runtime, other.id, "queue.add", {
    text: "Foreign", attachments: [images[0].id],
  }), /not found/);
  assert.equal(codex.calls.filter((c) => c.method === "thread/queue/add").length, 1);
});
test("native queue reorders and removes items, then dispatches sequentially across restart", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  const first = await op(runtime, bot.id, "turn.send", { text: "Active" });
  const a = (await op(runtime, bot.id, "queue.add", { text: "A" })).queuedSubmission;
  const b = (await op(runtime, bot.id, "queue.add", { text: "B" })).queuedSubmission;
  const c = (await op(runtime, bot.id, "queue.add", { text: "C" })).queuedSubmission;
  await op(runtime, bot.id, "queue.reorder", { ids: [b.id, a.id, c.id] });
  await op(runtime, bot.id, "queue.update", { id: b.id, text: "B edited" });
  await op(runtime, bot.id, "queue.delete", { id: a.id });
  assert.deepEqual((await op(runtime, bot.id, "queue.list")).map((x) => x.id), [b.id, c.id]);
  await assert.rejects(op(runtime, bot.id, "queue.reorder", { ids: [b.id, b.id] }), /every queued prompt/);
  const nativeFirst = codex.threads[0].turns.find((turn) => turn.id === first.turn.id);
  nativeFirst.status = "completed";
  runtime.onNotification({ method: "turn/completed", params: {
    threadId: bot.threadId, turn: { id: first.turn.id, status: "completed" },
  } });
  await runtime.tick();
  await settleQueue(runtime, bot.id);
  const startCalls = () => codex.calls.filter((call) => call.method === "thread/queue/start");
  assert.equal(startCalls().length, 1);
  assert.equal(startCalls()[0].params.queuedSubmissionId, b.id);
  const settings = codex.calls.find((call) => call.method === "thread/settings/update").params;
  assert.equal(settings.model, "gpt-6-luna");
  assert.equal(settings.collaborationMode.mode, "default");
  const resumed = new BotRuntime({ store, codex, root: runtime.root });
  await resumed.start();
  await resumed.tick();
  await settleQueue(resumed, bot.id);
  assert.equal(startCalls().length, 1, "restart must retain the running native turn");
  const running = codex.threads[0].turns.at(-1);
  assert.equal(running.items[0].content[0].text, "B edited");
  running.status = "completed";
  resumed.onNotification({ method: "turn/completed", params: {
    threadId: bot.threadId, turn: { id: running.id, status: "completed" },
  } });
  await resumed.tick();
  await settleQueue(resumed, bot.id);
  assert.equal(startCalls().length, 2);
  assert.equal(startCalls()[1].params.queuedSubmissionId, c.id);
  assert.deepEqual(await op(resumed, bot.id, "queue.list"), []);
});
test("queued work waits for questions and Stop, and uncertain start reconciles before resume", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  const first = await op(runtime, bot.id, "turn.send", { text: "Active" });
  const a = (await op(runtime, bot.id, "queue.add", { text: "A" })).queuedSubmission;
  const b = (await op(runtime, bot.id, "queue.add", { text: "B" })).queuedSubmission;
  const nativeFirst = codex.threads[0].turns[0];
  nativeFirst.status = "completed";
  runtime.store.put("pending", {
    id: "question", botId: bot.id, async: true,
    request: { method: "item/tool/requestUserInput", params: { questions: [] } },
  });
  runtime.onNotification({ method: "turn/completed", params: {
    threadId: bot.threadId, turn: { id: first.turn.id, status: "completed" },
  } });
  await runtime.tick();
  assert.equal(codex.calls.filter((x) => x.method === "thread/queue/start").length, 0);
  store.remove("pending", "question");
  await op(runtime, bot.id, "turn.interrupt");
  await runtime.tick();
  assert.equal(codex.calls.filter((x) => x.method === "thread/queue/start").length, 0);
  const originalCall = codex.call.bind(codex);
  let lostAck = true;
  codex.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === "thread/queue/start" && lostAck) {
      lostAck = false;
      throw new Error("disconnected after acknowledgement");
    }
    return result;
  };
  await op(runtime, bot.id, "queue.resume");
  await settleQueue(runtime, bot.id);
  assert.equal(store.bot(bot.id).queuePaused, false);
  assert.equal(store.bot(bot.id).activeTurnId, codex.threads[0].turns.at(-1).id);
  assert.equal(codex.calls.filter((x) => x.method === "thread/queue/start").length, 1);
  const resumed = new BotRuntime({ store, codex, root: runtime.root });
  await resumed.start();
  await op(resumed, bot.id, "queue.resume");
  await resumed.tick();
  await settleQueue(resumed, bot.id);
  assert.equal(codex.calls.filter((x) => x.method === "thread/queue/start").length, 1);
  assert.equal(store.bot(bot.id).activeTurnId, codex.threads[0].turns.at(-1).id);
  assert.deepEqual((await op(resumed, bot.id, "queue.list")).map((x) => x.id), [b.id]);
  assert.equal(a.id, codex.calls.find((x) => x.method === "thread/queue/start").params.queuedSubmissionId);
});
test("native automatic queue advance keeps the newer turn active", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  const first = await op(runtime, bot.id, "turn.send", { text: "Active" });
  const a = (await op(runtime, bot.id, "queue.add", { text: "A" })).queuedSubmission;
  const b = (await op(runtime, bot.id, "queue.add", { text: "B" })).queuedSubmission;
  const queue = codex.queues.get(bot.threadId);
  codex.queues.set(bot.threadId, queue.filter((item) => item.id !== a.id));
  codex.threads[0].turns[0].status = "completed";
  codex.threads[0].turns.push({ id: "native-next", status: "inProgress", items: [] });
  runtime.onNotification({ method: "turn/started", params: {
    threadId: bot.threadId, turn: { id: "native-next", status: "inProgress" },
  } });
  runtime.onNotification({ method: "turn/completed", params: {
    threadId: bot.threadId, turn: { id: first.turn.id, status: "completed" },
  } });
  await runtime.tick();
  assert.equal(store.bot(bot.id).activeTurnId, "native-next");
  assert.equal(codex.calls.filter((call) => call.method === "thread/queue/start").length, 0);
  assert.deepEqual((await op(runtime, bot.id, "queue.list")).map((item) => item.id), [b.id]);
  const resumed = new BotRuntime({ store, codex, root: runtime.root });
  await resumed.start();
  await resumed.tick();
  await settleQueue(resumed, bot.id);
  assert.equal(store.bot(bot.id).activeTurnId, "native-next");
  assert.equal(codex.calls.filter((call) => call.method === "thread/queue/start").length, 0);
});
test("idle native queue left after bridge restart starts once", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  const first = await op(runtime, bot.id, "turn.send", { text: "Active" });
  const queued = (await op(runtime, bot.id, "queue.add", { text: "After restart" })).queuedSubmission;
  codex.threads[0].turns[0].status = "completed";
  runtime.onNotification({ method: "turn/completed", params: {
    threadId: bot.threadId, turn: { id: first.turn.id, status: "completed" },
  } });
  const resumed = new BotRuntime({ store, codex, root: runtime.root });
  await resumed.start();
  await resumed.tick();
  await settleQueue(resumed, bot.id);
  const starts = codex.calls.filter((call) => call.method === "thread/queue/start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].params.queuedSubmissionId, queued.id);
  await resumed.tick();
  await settleQueue(resumed, bot.id);
  assert.equal(codex.calls.filter((call) => call.method === "thread/queue/start").length, 1);
});
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
test("Bots default to Luna high Fast and preserve an explicit standard-speed choice", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  assert.deepEqual(runtime.defaults, {
    model: "gpt-6-luna",
    effort: "high",
    serviceTier: "priority",
  });
  const start = codex.calls.find((call) => call.method === "thread/start").params;
  assert.equal(start.model, "gpt-6-luna");
  assert.equal(start.serviceTier, "priority");
  assert.equal(start.config["features.fast_mode"], true);
  await op(runtime, bot.id, "turn.send", { text: "hello" });
  const first = codex.calls.find((call) => call.method === "turn/start").params;
  assert.equal(first.model, "gpt-6-luna");
  assert.equal(first.effort, "high");
  assert.equal(first.serviceTier, "priority");
  await op(runtime, bot.id, "bots.update", { serviceTier: "default" });
  assert.equal(runtime.settings(store.bot(bot.id)).serviceTier, "default");
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
test("owner authorization uses stable site identity and excludes API tokens, foreign identities and origins; tickets expire and are machine-scoped", async () => {
  const env = {
    BOTS_OWNER_EMAIL: "owner@example.com",
    BOTS_OWNER_USER_ID: "stable-owner-id",
  };
  const request = (headers) =>
    new Request("https://work.dawar.ca/api/bots/session", { headers });
  assert.equal(
    botsOwner(
      request({
        "oai-authenticated-user-id": "stable-owner-id",
        "oai-authenticated-user-email": "alias@example.com",
      }),
      env,
    ),
    "owner@example.com",
  );
  assert.throws(() =>
    botsOwner(
      request({
        Authorization: "Bearer x",
        "oai-authenticated-user-id": "stable-owner-id",
        "oai-authenticated-user-email": "owner@example.com",
      }),
      env,
    ),
  );
  assert.throws(() =>
    botsOwner(
      request({
        "oai-authenticated-user-id": "foreign-user-id",
        "oai-authenticated-user-email": "owner@example.com",
      }),
      env,
    ),
  );
  assert.throws(() =>
    botsOwner(request({ "oai-authenticated-user-email": "owner@example.com" }), env),
  );
  assert.throws(() =>
    botsOwner(
      request({
        "oai-authenticated-user-id": "stable-owner-id",
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
