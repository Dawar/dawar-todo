import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Store } from "./store.mjs";
import { BotRuntime, validateResponse } from "./runtime.mjs";
import { nativeWaiting, requireCurrentActivity, beginTurnDispatch, captureActivity, projectCurrentActive } from "./turn-state.mjs";
import { recoverCurrentActivities } from "./current-activity.mjs";
import { slugify, cleanName, PROFILE_FILES } from "./profiles.mjs";
import { readTeam } from "./teams.mjs";
import { normalizeSchedule, collectDueRuns } from "./schedules.mjs";
import { signBotTicket, verifyBotTicket, botsOwner } from "../lib/bots-auth.ts";
import { BotsClient } from "../app/bots/client.ts";
import { bridgeResponse } from "./response.mjs";
import { runtime as browserRuntime } from "../tests/helpers/load-ts.mjs";
async function snapshotQueuedInput(input) {
  return Promise.all(input.map(async (part) => part.type === "localImage"
    ? { type: "image", url: `data:image/png;base64,${(await readFile(part.path)).toString("base64")}` }
    : part));
}
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
          { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
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
      const item = { id: `queued-${this.calls.length}`,
        input: await snapshotQueuedInput(params.input),
        clientUserMessageId: params.clientUserMessageId };
      this.queues.set(params.threadId,
        [...(this.queues.get(params.threadId) ?? []), item]);
      return { queuedSubmission: item };
    }
    if (method === "thread/queue/update") {
      const queue = this.queues.get(params.threadId);
      const item = queue.find((x) => x.id === params.queuedSubmissionId);
      item.input = await snapshotQueuedInput(params.input);
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
  assert.equal(codex.queues.get(bot.threadId)[0].input.filter((x) => x.type === "image").length, 6);
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
  assert.equal(settings.model, "gpt-6.1-sol");
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
test("interrupted turn leaves queued work paused across bridge restart", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  const active = await op(runtime, bot.id, "turn.send", { text: "Working" });
  const queued = (await op(runtime, bot.id, "queue.add", { text: "Later" })).queuedSubmission;
  await op(runtime, bot.id, "turn.interrupt");
  codex.threads[0].turns[0].status = "interrupted";
  runtime.onNotification({ method: "turn/completed", params: {
    threadId: bot.threadId, turn: { id: active.turn.id, status: "interrupted" },
  } });
  const resumed = new BotRuntime({ store, codex, root: runtime.root });
  await resumed.start();
  await resumed.tick();
  await settleQueue(resumed, bot.id);
  assert.equal(store.bot(bot.id).queuePaused, true);
  assert.equal(codex.calls.filter((call) => call.method === "thread/queue/start").length, 0);
  assert.deepEqual((await op(resumed, bot.id, "queue.list")).map((item) => item.id), [queued.id]);
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
test("New bots default to GPT-6.1-Sol medium Fast and preserve an explicit standard-speed choice", async (t) => {
  const { create, runtime, codex, store } = await setup(t);
  const bot = await create();
  assert.deepEqual(runtime.defaults, {
    model: "gpt-6-luna",
    effort: "high",
    serviceTier: "priority",
  });
  const start = codex.calls.find((call) => call.method === "thread/start").params;
  assert.equal(start.model, "gpt-6.1-sol");
  assert.equal(start.serviceTier, "priority");
  assert.equal(start.config["features.fast_mode"], true);
  await op(runtime, bot.id, "turn.send", { text: "hello" });
  const first = codex.calls.find((call) => call.method === "turn/start").params;
  assert.equal(first.model, "gpt-6.1-sol");
  assert.equal(first.effort, "medium");
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
test("team memory and files refresh on turn start and steering; membership removal clears them", async t => {
  const { create, runtime, codex, store } = await setup(t);
  // The retained generic fake returns {} for steer. This check needs the
  // protocol's positive acknowledgement, without weakening production guards.
  const originalCall = codex.call.bind(codex);
  codex.call = async (method, params) => {
    const result = await originalCall(method, params);
    return method === "turn/steer" ? { turnId: params.expectedTurnId } : result;
  };
  const bot = await create();
  const team = store.put("team", { id: `team-${"b".repeat(32)}`, name: "Team", memory: "Start discovery", revision: 1 });
  runtime.saveBot(bot, { teamId: team.id });
  const shared = await readTeam(runtime, team.id);
  await writeFile(join(shared.workspace, "TOOLS.md"), "Shared tools first");
  await op(runtime, bot.id, "turn.send", { text: "hello" });
  const start = codex.calls.find(c => c.method === "turn/start");
  assert.match(start.params.additionalContext.teamProfile.value, /Start discovery/);
  assert.match(start.params.additionalContext.teamProfile.value, /Shared tools first/);
  store.put("team", { ...team, memory: "Steer discovery", revision: 2 });
  await writeFile(join(shared.workspace, "TOOLS.md"), "Shared tools changed");
  await op(runtime, bot.id, "turn.send", { text: "follow-up" });
  const steer = codex.calls.filter(c => c.method === "turn/steer").at(-1);
  assert.match(steer.params.additionalContext.teamProfile.value, /Steer discovery/);
  assert.match(steer.params.additionalContext.teamProfile.value, /Shared tools changed/);
  assert.doesNotMatch(steer.params.additionalContext.teamProfile.value, /Start discovery|Shared tools first/);
  runtime.saveBot(store.bot(bot.id), { teamId: null });
  await op(runtime, bot.id, "turn.send", { text: "now independent" });
  const unassigned = codex.calls.filter(c => c.method === "turn/steer").at(-1).params.additionalContext.teamProfile.value;
  assert.match(unassigned, /No current team is assigned/);
  assert.doesNotMatch(unassigned, /Steer discovery|Shared tools changed/);
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
test("uncertain image enqueue is recovered from native queue after restart without adding twice", async (t) => {
  const { create, runtime, store, codex } = await setup(t);
  const bot = await create();
  await op(runtime, bot.id, "turn.send", { text: "Working" });
  const png = tinyPng();
  const image = await op(runtime, bot.id, "attachments.begin", {
    name: "pasted.png", size: png.length, mimeType: "image/png",
  });
  await op(runtime, bot.id, "attachments.chunk", {
    id: image.id, offset: 0, data: png.toString("base64"),
  });
  await op(runtime, bot.id, "attachments.finish", { id: image.id });
  const originalCall = codex.call.bind(codex);
  codex.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === "thread/queue/add")
      throw new Error("disconnected after acknowledgement");
    return result;
  };
  const id = "stable-image-enqueue-id";
  const params = { text: "Check image", attachments: [image.id] };
  await assert.rejects(op(runtime, bot.id, "queue.add", params, id), /disconnected/);
  assert.equal(store.operation(id).status, "uncertain");
  const resumed = new BotRuntime({ store, codex, root: runtime.root });
  await resumed.start();
  const item = codex.queues.get(bot.threadId)[0];
  assert.equal(store.operation(id).status, "done");
  assert.equal(item.clientUserMessageId, id);
  assert.equal(item.input.filter((input) => input.type === "image").length, 1);
  const recovered = await op(resumed, bot.id, "queue.add", params, id);
  assert.deepEqual(recovered.queuedSubmission.input.filter((input) => input.type === "localImage"),
    [{ type: "localImage", path: store.get("attachment", image.id).path }]);
  assert.deepEqual(recovered.queuedSubmission.attachments.map((a) => a.id), [image.id]);
  assert.equal(codex.calls.filter((call) => call.method === "thread/queue/add").length, 1);
});
test("consumed uncertain image enqueue reconciles from the turn; missing evidence never replays", async (t) => {
  const { create, runtime, store, codex } = await setup(t);
  const bot = await create();
  await op(runtime, bot.id, "turn.send", { text: "Working" });
  const png = tinyPng();
  const image = await op(runtime, bot.id, "attachments.begin", {
    name: "pasted.png", size: png.length, mimeType: "image/png",
  });
  await op(runtime, bot.id, "attachments.chunk", {
    id: image.id, offset: 0, data: png.toString("base64"),
  });
  await op(runtime, bot.id, "attachments.finish", { id: image.id });
  const originalCall = codex.call.bind(codex);
  codex.call = async (method, params) => {
    const result = await originalCall(method, params);
    if (method === "thread/queue/add")
      throw new Error("disconnected after acknowledgement");
    return result;
  };
  const id = "consumed-image-enqueue-id";
  const params = { text: "Check image", attachments: [image.id] };
  await assert.rejects(op(runtime, bot.id, "queue.add", params, id), /disconnected/);
  const item = codex.queues.get(bot.threadId)[0];
  codex.queues.set(bot.threadId, []);
  codex.threads[0].turns.push({ id: "consumed-turn", status: "completed",
    items: [{ type: "userMessage", clientId: id, content: item.input }] });
  const resumed = new BotRuntime({ store, codex, root: runtime.root });
  await resumed.start();
  assert.deepEqual(await op(resumed, bot.id, "queue.add", params, id),
    { consumedTurnId: "consumed-turn" });
  assert.equal(store.operation(id).status, "done");
  const unknownId = "unknown-image-enqueue-id";
  store.saveOperation(unknownId, "fingerprint", "dispatching", {
    method: "queue.add", botId: bot.id,
  });
  await resumed.reconcileOperations();
  assert.equal(store.operation(unknownId).status, "uncertain");
  assert.equal(codex.calls.filter((call) => call.method === "thread/queue/add").length, 1);
});
test("browser defers legacy queued sends to durable migration and replays pending stable IDs", async () => {
  const client = new BotsClient();
  const cache = new Map();
  client.cache = (key, fallback) => cache.get(key) ?? fallback;
  client.save = (key, value) => cache.set(key, value);
  const request = { type: "request", id: "socket-request", operationId: "stable-image-enqueue-id",
    method: "queue.add", botId: "bot", params: { text: "Check image", attachments: ["image"] } };
  cache.set("operations", { [request.operationId]: request });
  const replayed = [];
  client.rpc = async (...args) => { replayed.push(args); return {}; };
  client.refresh = async () => {};
  client.replayPending();
  assert.deepEqual(replayed, []);
  let rejected;
  client.pending.set(request.id, {
    request, owner: client.owner, managed: true, timer: setTimeout(() => {}, 10000), resolve: () => {},
    reject: (error) => { rejected = error; },
  });
  client.receive({ type: "response", id: request.id,
    error: "Acknowledgement was lost. Native state has not confirmed this operation." });
  assert.match(rejected.message, /Acknowledgement was lost/);
  assert.equal(cache.get("operations")[request.operationId].operationId, request.operationId);
  client.pending.set(request.id, {
    request, owner: client.owner, managed: true, timer: setTimeout(() => {}, 10000), resolve: () => {}, reject: () => {},
  });
  client.receive({ type: "response", id: request.id, result: { consumedTurnId: "turn" } });
  assert.equal(cache.get("operations")[request.operationId].operationId, request.operationId);
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

async function connectedComposer(runtime, bot) {
  const env = browserRuntime({ Error, TypeError });
  const { BotDraftStore } = env.load('app/bots/draft-store.ts');
  const { BotComposer } = env.load('app/bots/composer-controller.ts');
  const store = new BotDraftStore(env.indexedDB);
  const client = new BotsClient(); client.owner = 'test-owner'; client.online = true;
  const requests = [], responses = [];
  client.socket = { readyState: WebSocket.OPEN, close() {}, send(json) {
    const request = JSON.parse(json); requests.push(request);
    void bridgeResponse(runtime, request).then((response) => { responses.push(response); client.receive(response); });
  } };
  const composer = new BotComposer(client.owner, bot.id, store, client);
  await composer.open();
  return { composer, client, requests, responses, store };
}

test('real runtime/service/client rejects pre-dispatch validation and permits a corrected durable send', async (t) => {
  const { create, runtime, codex, store } = await setup(t); const bot = await create();
  const { composer, requests, responses } = await connectedComposer(runtime, bot);
  runtime.saveBot(bot, { archived: true });
  composer.setText('first draft'); await composer.flush(); await composer.send();
  assert.equal(responses[0].outcome, 'rejected'); assert.equal(composer.operation, undefined);
  assert.equal(store.operation(requests[0].operationId).outcome, 'rejected');
  assert.equal(composer.draft.text, 'first draft');
  runtime.saveBot(store.bot(bot.id), { archived: false });
  composer.setText('corrected draft'); await composer.flush(); await composer.send();
  assert.notEqual(requests[0].operationId, requests[1].operationId);
  assert.equal(composer.draft.text, '');
  assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('native definite error is rejected, but post-commit EPIPE/parser/local errors keep the operation ID', async (t) => {
  for (const fault of ['native-definite', 'EPIPE', 'parser', 'post-commit-definite-property']) {
    await t.test(fault, async (t) => {
      const { create, runtime, codex, store } = await setup(t); const bot = await create();
      const { composer, requests, responses } = await connectedComposer(runtime, bot);
      const original = codex.call.bind(codex), originalEcho = runtime.emitUserMessage.bind(runtime);
      codex.call = async (method, params) => {
        if (method === 'turn/start' && fault === 'native-definite') throw Object.assign(new Error('Native rejected parameters'), { definite: true });
        const result = await original(method, params);
        if (method === 'turn/start' && fault === 'EPIPE') throw new Error('write EPIPE');
        if (method === 'turn/start' && fault === 'parser') return {}; // Successful native commit, malformed return data.
        return result;
      };
      if (fault === 'post-commit-definite-property') runtime.emitUserMessage = () => { throw Object.assign(new Error('Local formatting failure'), { definite: true }); };
      composer.setText('one submitted message'); await composer.flush(); await composer.send();
      const id = requests[0].operationId;
      codex.call = original; runtime.emitUserMessage = originalEcho;
      if (fault === 'native-definite') {
        assert.equal(responses[0].outcome, 'rejected'); assert.equal(composer.operation, undefined);
        assert.equal(store.operation(id).status, 'failed');
        composer.setText('corrected after definite rejection'); await composer.flush(); await composer.send();
        assert.notEqual(requests[1].operationId, id);
      } else {
        assert.equal(responses[0].outcome, 'uncertain'); assert.equal(composer.operation.id, id);
        assert.equal(store.operation(id).status, 'uncertain');
        composer.setText('new unsubmitted typing'); await composer.flush(); await composer.reconcile();
        assert.equal(requests[1].operationId, id); assert.equal(composer.operation, undefined);
        assert.equal(composer.draft.text, 'new unsubmitted typing');
      }
      assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 1);
    });
  }
});

test('legacy failed label without certainty cannot authorize a second native send', async (t) => {
  const { create, runtime, codex, store } = await setup(t); const bot = await create();
  const { composer, requests, responses } = await connectedComposer(runtime, bot);
  const original = codex.call.bind(codex);
  codex.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'turn/start') throw new Error('arbitrary old-bridge failure');
    return result;
  };
  composer.setText('legacy uncertain'); await composer.flush(); await composer.send();
  const id = requests[0].operationId, saved = store.operation(id);
  store.saveOperation(id, saved.fingerprint, 'failed', { ...saved, outcome: undefined });
  codex.call = original;
  await composer.reconcile();
  assert.equal(requests[1].operationId, id); assert.ok(responses[1].result.turn);
  assert.equal(codex.calls.filter((call) => call.method === 'turn/start').length, 1);
});

test('queue add and queue update propagate certainty at their native mutation boundaries', async (t) => {
  const { create, runtime, codex, store } = await setup(t); const bot = await create();
  const { composer, requests, responses } = await connectedComposer(runtime, bot);
  const original = codex.call.bind(codex);
  codex.call = async (method, params) => {
    const result = await original(method, params);
    if (method === 'thread/queue/add') throw new Error('post-commit queue transport error');
    return result;
  };
  composer.setText('queue once'); await composer.flush(); await composer.send(true);
  assert.equal(responses[0].outcome, 'uncertain'); const addId = requests[0].operationId;
  codex.call = original; await composer.reconcile(); assert.equal(requests[1].operationId, addId);
  assert.equal(codex.calls.filter((call) => call.method === 'thread/queue/add').length, 1);
  const item = (await runtime.queueList(store.bot(bot.id)))[0]; composer.edit({ ...item, attachments: [] }); await composer.flush();
  codex.call = async (method, params) => { if (method === 'thread/queue/update') throw Object.assign(new Error('Native rejected edit'), { definite: true }); return original(method, params); };
  composer.setText('invalid edit'); await composer.flush(); await composer.send(true);
  assert.equal(responses.at(-1).outcome, 'rejected'); assert.equal(composer.operation, undefined);
  const rejectedId = requests.at(-1).operationId;
  codex.call = async (method, params) => { const result = await original(method, params); if (method === 'thread/queue/update') throw new Error('post-commit edit transport error'); return result; };
  composer.setText('corrected edit'); await composer.flush(); await composer.send(true);
  assert.notEqual(requests.at(-1).operationId, rejectedId); assert.equal(responses.at(-1).outcome, 'uncertain');
  const uncertainId = composer.operation.id; codex.call = original; await composer.reconcile();
  assert.equal(composer.operation.id, uncertainId); // No native operation identity exists to prove this queue update after a lost ack.
  assert.equal(codex.calls.filter((call) => call.method === 'thread/queue/update').length, 1);
});

test("native thread status fences reads, invalidates unloaded subscriptions and projects waiting flags", async (t) => {
  const { runtime, store, codex, create } = await setup(t);
  const bot = await create();
  const current = { id: "native-active", status: "inProgress", items: [], itemsView: "notLoaded" };
  runtime.onNotification({ method: "turn/started", params: { threadId: bot.threadId, turn: current } });
  const token = store.get("botActivity", bot.id).generation;
  runtime.onNotification({ method: "thread/status/changed", params: { threadId: bot.threadId,
    status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
  assert.ok(store.get("botActivity", bot.id).generation > token);
  assert.equal(store.bot(bot.id).status, "waiting");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "needs-input");
  assert.equal(runtime.activityUnresolved(bot.id), false);
  runtime.onNotification({ method: "thread/status/changed", params: { threadId: bot.threadId,
    status: { type: "active", activeFlags: [] } } });
  assert.equal(store.bot(bot.id).status, "running");
  const key = `${runtime.epoch}:777`;
  store.put("pending", { id: key, key, botId: bot.id, request: { params: { threadId: bot.threadId, turnId: current.id } } });
  runtime.onNotification({ method: "thread/status/changed", params: { threadId: bot.threadId, status: { type: "active", activeFlags: [] } } });
  assert.equal(store.bot(bot.id).status, "waiting");
  runtime.onNotification({ method: "serverRequest/resolved", params: { threadId: bot.threadId, requestId: 777 } });
  assert.equal(store.bot(bot.id).status, "running");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "working");
  runtime.loaded.add(bot.threadId);
  runtime.onNotification({ method: "thread/closed", params: { threadId: bot.threadId } });
  assert.equal(runtime.loaded.has(bot.threadId), false);
  assert.equal(runtime.activityUnresolved(bot.id), true);
  assert.equal(nativeWaiting(runtime, bot.id), false);
  assert.equal(store.get("botActivity", bot.id).nativeStatus, null);
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "unconfirmed");
  assert.equal(store.bot(bot.id).activeTurnId, current.id, "unload is not turn completion");
  assert.equal(codex.calls.some(call => call.method === "turn/start"), false, "no replay during unload");
});

test("status-only native activity cannot release a stale idle read or dispatch queued work", async (t) => {
  const { runtime, store, codex, create } = await setup(t);
  const bot = await create();
  runtime.loaded.add(bot.threadId);
  const original = codex.call.bind(codex);
  let release, enteredSecond, reads = 0;
  const secondRead = new Promise(resolve => { enteredSecond = resolve; });
  codex.call = async (method, params) => method === "thread/read"
    ? await new Promise(resolve => { release = () => resolve({ thread: { id: bot.threadId, status: { type: "idle" } } }); if (++reads === 2) enteredSecond(); })
    : original(method, params);
  const reading = runtime.reconcileCurrentActivity(bot.id);
  await Promise.resolve();
  runtime.onNotification({ method: "thread/status/changed", params: { threadId: bot.threadId,
    status: { type: "active", activeFlags: [] } } });
  release();
  // The second status read is also delayed; both stale reads must lose to the notification.
  await secondRead;
  release();
  assert.equal(await reading, false);
  assert.equal(runtime.activityUnresolved(bot.id), true);
  assert.equal(store.bot(bot.id).activeTurnId, null, "no invented current turn identity");
});

test("native system error contains execution until confirmed current recovery", async (t) => {
  const { runtime, store, codex, create } = await setup(t);
  const bot = await create();
  runtime.loaded.add(bot.threadId);
  runtime.onNotification({ method: "thread/status/changed", params: { threadId: bot.threadId, status: { type: "systemError" } } });
  assert.equal(store.bot(bot.id).status, "error");
  codex.threads[0].status = { type: "systemError" };
  assert.equal(await runtime.reconcileCurrentActivity(bot.id), false);
  assert.match(store.get("botActivity", bot.id).reconciliationError, /system error/);
  codex.threads[0].status = { type: "idle" };
  assert.equal(await runtime.reconcileCurrentActivity(bot.id), true);
  assert.equal(store.bot(bot.id).status, "idle");
  assert.equal(runtime.activityUnresolved(bot.id), false);
});

test("retained run lanes use native waiting/unload evidence without changing main-thread execution", async (t) => {
  const { runtime, store, create } = await setup(t);
  const bot = await create();
  store.put("run", { id: "retained-run", botId: bot.id, title: "Retained run", status: "running", laneId: "retained-lane", executionLane: "run-v1" });
  store.put("runLane", { id: "retained-lane", botId: bot.id, runId: "retained-run", threadId: "retained-thread", provisioning: "bound", status: "idle", paused: false });
  runtime.onNotification({ method: "turn/started", params: { threadId: "retained-thread", turn: { id: "retained-turn", status: "inProgress", items: [] } } });
  runtime.onNotification({ method: "thread/status/changed", params: { threadId: "retained-thread", status: { type: "active", activeFlags: ["waitingOnUserInput"] } } });
  assert.equal(store.get("runLane", "retained-lane").status, "waiting");
  assert.equal(runtime.runs.publicRun(store.get("runLane", "retained-lane")).activity.state, "waiting-input");
  assert.equal(runtime.runs.counts(bot.id).needsInput, 1);
  assert.equal(store.bot(bot.id).activeTurnId, null);
  runtime.loaded.add("retained-thread");
  runtime.onNotification({ method: "thread/closed", params: { threadId: "retained-thread" } });
  assert.equal(runtime.loaded.has("retained-thread"), false);
  assert.equal(store.get("runActivity", "retained-lane").unresolved, true);
  assert.equal(store.get("runLane", "retained-lane").activeTurnId, "retained-turn");
});


const waitingStatus = { type: "active", activeFlags: ["waitingOnUserInput"] };
const nativeStatus = (runtime, threadId, status) => runtime.onNotification({ method: "thread/status/changed", params: { threadId, status } });
const nativeStart = (runtime, threadId, id) => runtime.onNotification({ method: "turn/started", params: { threadId, turn: { id, status: "inProgress", items: [] } } });

for (const legacy of [true, false]) test(`waiting recovery discards ${legacy ? "legacy" : "bound"} persisted flags on actual runtime restart`, async t => {
  const { runtime, store, codex, create } = await setup(t);
  const bot = await create();
  nativeStart(runtime, bot.threadId, "persisted-turn");
  nativeStatus(runtime, bot.threadId, waitingStatus);
  assert.equal(nativeWaiting(runtime, bot.id), true);
  if (legacy) {
    const saved = store.get("botActivity", bot.id);
    delete saved.threadId; delete saved.nativeStatusThreadId; delete saved.nativeStatusTurnId;
    store.put("botActivity", saved);
  }
  store.put("pending", { id: "restart-blocking", botId: bot.id, request: { params: { threadId: bot.threadId, turnId: "persisted-turn" } } });
  store.put("pending", { id: "restart-async", botId: bot.id, async: true, request: { params: { threadId: bot.threadId, turnId: "prior-turn", isBlocking: false } } });
  const call = codex.call.bind(codex);
  codex.call = (method, params) => method === "thread/resume" ? Promise.resolve({ thread: codex.threads.find(t => t.id === params.threadId) }) : call(method, params);
  const restart = new BotRuntime({ store, codex, root: runtime.root });
  await restart.start(); // Fake native current status is unavailable; recovery stays unresolved.
  assert.equal(restart.activityUnresolved(bot.id), true);
  assert.equal(nativeWaiting(restart, bot.id), false);
  assert.equal(store.get("botActivity", bot.id).nativeStatus, null);
  assert.equal(store.get("pending", "restart-blocking"), null, "expired process request is retired");
  assert.equal(store.get("pending", "restart-async").async, true);
  assert.equal(restart.primary.work(store.bot(bot.id)).state, "needs-input", "exact retained async question survives startup");
  store.remove("pending", "restart-async");
  assert.equal(restart.primary.work(store.bot(bot.id)).state, "unconfirmed");
  codex.threads[0].status = { type: "idle" };
  assert.equal(await restart.reconcileCurrentActivity(bot.id), true);
  assert.equal(store.bot(bot.id).activeTurnId, null);
  assert.equal(restart.primary.work(store.bot(bot.id)).state, "ready");
  assert.equal(codex.calls.filter(c => c.method === "turn/start").length, 0);
});

test("waiting recovery contains status-only unknown turn until a current native read identifies it", async t => {
  const { runtime, store, codex, create } = await setup(t);
  const bot = await create();
  runtime.loaded.add(bot.threadId);
  nativeStatus(runtime, bot.threadId, waitingStatus);
  assert.equal(nativeWaiting(runtime, bot.id), false);
  assert.equal(store.get("botActivity", bot.id).nativeStatus, null);
  assert.equal(store.bot(bot.id).activeTurnId, null);
  assert.equal(store.bot(bot.id).status, "interrupted");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "unconfirmed");
  codex.threads[0].status = waitingStatus;
  assert.equal(await runtime.reconcileCurrentActivity(bot.id), false);
  codex.threads[0].turns.push({ id: "identified-turn", status: "inProgress", items: [] });
  assert.equal(await runtime.reconcileCurrentActivity(bot.id), true);
  assert.equal(nativeWaiting(runtime, bot.id), true);
  assert.equal(store.get("botActivity", bot.id).nativeStatusTurnId, "identified-turn");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "needs-input");
  nativeStatus(runtime, bot.threadId, { type: "active", activeFlags: [] });
  assert.equal(store.bot(bot.id).status, "running");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "working");
});

test("waiting recovery binds observations to current thread and clears old flags on new turns and dispatch", async t => {
  const { runtime, store, create } = await setup(t);
  const bot = await create();
  nativeStart(runtime, bot.threadId, "old-turn");
  nativeStatus(runtime, bot.threadId, waitingStatus);
  nativeStart(runtime, bot.threadId, "new-turn");
  assert.equal(nativeWaiting(runtime, bot.id), false);
  assert.equal(store.bot(bot.id).status, "running");
  nativeStatus(runtime, bot.threadId, waitingStatus);
  runtime.onNotification({ method: "turn/completed", params: { threadId: bot.threadId, turn: { id: "old-turn", status: "completed", items: [] } } });
  assert.equal(nativeWaiting(runtime, bot.id), true, "old terminal evidence cannot clear newer waiting");
  assert.equal(store.bot(bot.id).activeTurnId, "new-turn");
  const previousThreadRead = captureActivity(runtime, bot.id);
  const replacement = runtime.saveBot(store.bot(bot.id), { threadId: "replacement-thread" });
  assert.equal(nativeWaiting(runtime, bot.id), false, "observation belongs to original thread");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "unconfirmed");
  assert.equal(projectCurrentActive(runtime, bot.id, { id: "new-turn", status: "inProgress", items: [] }, previousThreadRead, waitingStatus), false,
    "a current read captured on the previous thread cannot bind waiting to its replacement");
  nativeStatus(runtime, replacement.threadId, waitingStatus);
  assert.equal(runtime.activityUnresolved(bot.id), true, "old turn proof cannot bind status on replacement thread");
  assert.equal(nativeWaiting(runtime, bot.id), false);
  nativeStart(runtime, replacement.threadId, "replacement-turn");
  nativeStatus(runtime, replacement.threadId, waitingStatus);
  assert.equal(nativeWaiting(runtime, bot.id), true);
  beginTurnDispatch(runtime, bot.id, "new-dispatch");
  assert.equal(nativeWaiting(runtime, bot.id), false);
  assert.equal(store.get("botActivity", bot.id).nativeStatus, null);
});

test("waiting recovery keeps exact async and blocking questions separate from unresolved flags and answer settlement", async t => {
  const { runtime, store, codex, create } = await setup(t);
  const bot = await create();
  nativeStart(runtime, bot.threadId, "current-turn");
  nativeStatus(runtime, bot.threadId, waitingStatus);
  requireCurrentActivity(runtime, bot.id, null, "fresh-recovery");
  const key = `${runtime.epoch}:998`;
  store.put("pending", { id: key, botId: bot.id, epoch: runtime.epoch, request: { id: 998, params: { threadId: bot.threadId, turnId: "current-turn" } } });
  assert.equal(nativeWaiting(runtime, bot.id), false);
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "needs-input", "actual pending blocking request is still visible");
  runtime.onNotification({ method: "serverRequest/resolved", params: { threadId: bot.threadId, requestId: 998 } });
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "unconfirmed");
  const asyncKey = "async:old-question";
  store.put("pending", { id: asyncKey, botId: bot.id, async: true, request: { params: { threadId: bot.threadId, turnId: "prior-turn", isBlocking: false } } });
  store.put("pending", { id: "foreign-question", botId: bot.id, async: true, request: { params: { threadId: "other-thread", turnId: "other-turn", isBlocking: false } } });
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "needs-input", "retained async question outlives its turn");
  runtime.answers.finish({ id: asyncKey, key: asyncKey, botId: bot.id, state: "accepted" });
  assert.equal(store.bot(bot.id).status, "interrupted", "answer settlement cannot invent confirmed running from retained turn ID");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "unconfirmed", "foreign-thread question cannot count as current input");
  codex.threads[0].status = { type: "idle" };
  assert.equal(await runtime.reconcileCurrentActivity(bot.id), true);
  assert.equal(store.bot(bot.id).status, "idle");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "ready");
});

test("waiting recovery shares validity and exact question rules with retained lanes without main-thread leakage", async t => {
  const { runtime, store, create } = await setup(t);
  const bot = await create();
  nativeStart(runtime, bot.threadId, "main-turn");
  nativeStatus(runtime, bot.threadId, waitingStatus);
  store.put("run", { id: "waiting-run", botId: bot.id, title: "Retained", status: "running", laneId: "waiting-lane", executionLane: "run-v1" });
  store.put("runLane", { id: "waiting-lane", botId: bot.id, runId: "waiting-run", threadId: "waiting-thread", provisioning: "bound", status: "idle", paused: false });
  const port = runtime.runs.port("waiting-lane"), lane = () => store.get("runLane", "waiting-lane");
  nativeStatus(runtime, "waiting-thread", waitingStatus);
  assert.equal(runtime.runs.publicRun(lane()).activity.state, "uncertain");
  assert.equal(runtime.runs.counts(bot.id).needsInput, 0);
  nativeStart(runtime, "waiting-thread", "lane-turn");
  nativeStatus(runtime, "waiting-thread", waitingStatus);
  assert.equal(nativeWaiting(port, bot.id), true);
  const blocking = `${runtime.epoch}:999`;
  port.store.put("pending", { id: blocking, botId: bot.id, request: { params: { threadId: "waiting-thread", turnId: "lane-turn" } } });
  nativeStatus(runtime, "waiting-thread", { type: "active", activeFlags: [] });
  assert.equal(lane().status, "waiting", "current blocking question keeps lane waiting");
  runtime.onNotification({ method: "serverRequest/resolved", params: { threadId: "waiting-thread", requestId: 999 } });
  assert.equal(lane().status, "running");
  assert.equal(runtime.runs.counts(bot.id).needsInput, 0);
  nativeStatus(runtime, "waiting-thread", waitingStatus);
  port.initialize(); // Startup invalidates persisted observation, keeps exact identity for recovery.
  assert.equal(nativeWaiting(port, bot.id), false);
  assert.equal(runtime.runs.counts(bot.id).needsInput, 0);
  const question = "async:lane-question";
  port.store.put("pending", { id: question, botId: bot.id, async: true, request: { params: { threadId: "waiting-thread", turnId: "old-lane-turn", isBlocking: false } } });
  assert.equal(runtime.runs.publicRun(lane()).activity.state, "waiting-input");
  assert.equal(runtime.runs.publicRun(lane()).activity.unresolved, true);
  assert.equal(runtime.runs.counts(bot.id).needsInput, 1);
  port.answers.finish({ id: question, key: question, botId: bot.id, state: "accepted" });
  assert.equal(lane().status, "interrupted");
  assert.equal(runtime.runs.publicRun(lane()).activity.state, "uncertain");
  assert.equal(runtime.runs.counts(bot.id).needsInput, 0);
  nativeStart(runtime, "waiting-thread", "new-lane-turn");
  nativeStatus(runtime, "waiting-thread", waitingStatus);
  nativeStatus(runtime, "waiting-thread", { type: "systemError" });
  assert.equal(nativeWaiting(port, bot.id), false);
  assert.equal(runtime.runs.counts(bot.id).needsInput, 0);
  assert.equal(nativeWaiting(runtime, bot.id), true);
  assert.equal(store.bot(bot.id).activeTurnId, "main-turn");
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "needs-input");
});


test("waiting recovery fences peer admission by thread without inventing native MCP provenance", async t => {
  const { runtime, store, create } = await setup(t);
  const bot = await create();
  nativeStart(runtime, bot.threadId, "peer-current");
  const accepted = [];
  runtime.handle = async (_message, origin) => {
    runtime.peers.assertOrigin(store.bot(bot.id), origin);
    accepted.push(origin);
  };
  await runtime.peerTool(store.bot(bot.id), { operation: "directory" },
    { authority: "authenticated-bot-mcp", botId: bot.id, threadId: null, turnId: null, callId: null });
  await runtime.peerTool(store.bot(bot.id), { operation: "directory" },
    { authority: "native-tool", botId: bot.id, threadId: bot.threadId, turnId: "peer-current", callId: "native-call" });
  assert.equal(accepted[0].threadId, null);
  assert.equal(accepted[0].turnId, null);
  assert.equal(accepted[0].activityThreadId, bot.threadId);
  runtime.saveBot(store.bot(bot.id), { threadId: "peer-replacement" });
  for (const origin of accepted) assert.throws(() => runtime.peers.assertOrigin(store.bot(bot.id), origin), /changed|no longer confirmed/);
});


test("waiting recovery automatically reconciles thread replacement even without a status notification", async t => {
  const { runtime, store, codex, create } = await setup(t);
  const bot = await create();
  nativeStart(runtime, bot.threadId, "previous-thread-turn");
  nativeStatus(runtime, bot.threadId, waitingStatus);
  runtime.saveBot(store.bot(bot.id), { threadId: "idle-replacement" });
  runtime.loaded.add("idle-replacement");
  codex.threads.push({ id: "idle-replacement", status: { type: "idle" }, turns: [] });
  assert.equal(store.get("botActivity", bot.id).unresolved, false, "retained proof predates replacement");
  assert.equal(runtime.activityUnresolved(bot.id), true);
  await recoverCurrentActivities(runtime);
  assert.equal(runtime.activityUnresolved(bot.id), false);
  assert.equal(store.get("botActivity", bot.id).threadId, "idle-replacement");
  assert.equal(store.get("botActivity", bot.id).nativeStatus, null);
  assert.equal(store.bot(bot.id).activeTurnId, null);
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "ready");
  assert.equal(codex.calls.filter(c => c.method === "turn/start").length, 0);
});
