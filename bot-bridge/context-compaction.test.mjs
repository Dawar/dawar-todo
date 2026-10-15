import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { BotRuntime } from "./runtime.mjs";
import { ProviderRouter } from "./provider-router.mjs";
import { MinimalCodex } from "./claude-test-support.mjs";
import { ClaudeTurn } from "./claude-items.mjs";
import { contextEvidence, idleDecision, idlePolicyPatch, COMPACTION_LIFECYCLE_LIMIT_MS } from "./context-compaction.mjs";

const MINUTE = 60_000;
const breakdown = (totalTokens) => ({ totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
const usageNote = (threadId, last, { total = last, window = 272_000, turnId = "turn-u" } = {}) =>
  ({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: breakdown(total), last: breakdown(last), modelContextWindow: window } } });

test("current context comes from tokenUsage.last, never cumulative totals", () => {
  const e = contextEvidence(usageNote("t", 150_000, { total: 9_000_000 }).params);
  assert.equal(e.contextTokens, 150_000);
  assert.equal(e.cumulativeTokens, 9_000_000);
  assert.equal(e.modelContextWindow, 272_000);
  assert.equal(contextEvidence({ threadId: "t", tokenUsage: { total: breakdown(1) } }), null, "no last field is unknown evidence");
  assert.equal(contextEvidence({ tokenUsage: { last: breakdown(1) } }), null, "no thread identity is unknown evidence");
});

test("idle decision: 200k current pressure and exactly 54 idle minutes", () => {
  const bot = { threadId: "t" }, at = Date.parse("2026-10-15T00:00:00Z");
  const usage = (contextTokens, extra = {}) => ({ threadId: "t", contextTokens, modelContextWindow: 272_000, generation: "g1",
    observedAt: new Date(at).toISOString(), lastActivityAt: new Date(at).toISOString(), ...extra });
  assert.equal(idleDecision(bot, usage(199_999, { cumulativeTokens: 50_000_000 }), null, at + 60 * MINUTE).state, "below-threshold");
  assert.equal(idleDecision(bot, usage(200_000), null, at + 54 * MINUTE - 1).state, "waiting");
  assert.equal(idleDecision(bot, usage(200_000), null, at + 54 * MINUTE).state, "due");
  assert.equal(idleDecision(bot, usage(250_000), { generation: "g1" }, at + 99 * MINUTE).state, "attempted", "one attempt per generation");
  assert.equal(idleDecision(bot, usage(250_000, { compactedAt: "x" }), null, at + 99 * MINUTE).state, "compacted");
  assert.equal(idleDecision({ threadId: "other" }, usage(250_000), null, at + 99 * MINUTE).state, "unknown", "foreign thread evidence");
  assert.equal(idleDecision(bot, usage(250_000, { modelContextWindow: 128_000 }), null, at + 99 * MINUTE).state, "unsupported");
  assert.equal(idleDecision({ ...bot, idleCompaction: { enabled: false, thresholdTokens: 200_000, idleMinutes: 54 } }, usage(250_000), null, at + 99 * MINUTE).state, "disabled");
  assert.equal(idleDecision(bot, null, null, at).state, "unknown");
});

test("idle policy has finite validated ranges and keeps 54 minutes by default", () => {
  assert.deepEqual(idlePolicyPatch({}, { idleMinutes: 30 }), { enabled: true, thresholdTokens: 200_000, idleMinutes: 30 });
  assert.deepEqual(idlePolicyPatch({}, { enabled: false }), { enabled: false, thresholdTokens: 200_000, idleMinutes: 54 });
  for (const bad of [{ idleMinutes: 4 }, { idleMinutes: 1441 }, { idleMinutes: 5.5 }, { thresholdTokens: 1000 }, { enabled: "yes" }, { other: 1 }, []])
    assert.throws(() => idlePolicyPatch({}, bad));
});

test("Claude turns emit native-shaped current-context evidence", () => {
  const turn = new ClaudeTurn({ threadId: "claude:t", turnId: "turn-1", cwd: "/w", now: () => 1000 });
  const usage = { input_tokens: 10, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 40_000, output_tokens: 500 };
  const message = { type: "assistant", parent_tool_use_id: null, message: { id: "m1", usage, content: [{ type: "text", text: "a" }] } };
  const first = turn.consume(message).find((n) => n.method === "thread/tokenUsage/updated");
  turn.consume(message); // the SDK repeats usage on each block of one API message
  assert.equal(first.params.tokenUsage.last.totalTokens, 190_510);
  assert.equal(turn.state.contextTotal.totalTokens, 190_510, "one API message counts once");
  const [withWindow] = turn.contextWindow({ "claude-opus": { contextWindow: 200_000 } });
  assert.equal(contextEvidence(withWindow.params).modelContextWindow, 200_000);
});

// A Codex app-server double with scripted compaction answers.
class CompactCodex extends MinimalCodex {
  compactAnswer = () => ({});
  async call(method, params) {
    this.admissionGuard?.(method, params);
    if (method === "thread/resume") { this.calls.push({ method, params }); return { thread: { id: params.threadId } }; }
    if (method === "thread/compact/start") { this.calls.push({ method, params }); return this.compactAnswer(params); }
    return super.call(method, params);
  }
  compactions() { return this.calls.filter((c) => c.method === "thread/compact/start").length; }
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), "compaction-"));
  const store = new Store(join(dir, "state.sqlite"));
  const codex = new CompactCodex();
  const runtime = new BotRuntime({ store, codex: new ProviderRouter({ codex }), root: join(dir, "bots") });
  t.after(async () => { runtime.maintenance.close(); await new Promise((r) => setTimeout(r, 20)); store.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.start();
  const bot = await runtime.handle({ method: "bots.create", params: { name: "Compact" }, operationId: "create-compact-bot" });
  const notify = (message) => codex.emit("notification", message);
  const compact = (operationId = `compact:${crypto.randomUUID()}`) => runtime.handle({ method: "thread.compact", botId: bot.id, params: {}, operationId });
  const lifecycle = (turnId = "compact-turn", threadId = bot.threadId) => {
    notify({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress", items: [] } } });
    notify({ method: "item/started", params: { threadId, turnId, item: { type: "contextCompaction", id: `item-${turnId}` } } });
    notify({ method: "item/completed", params: { threadId, turnId, item: { type: "contextCompaction", id: `item-${turnId}` } } });
    notify({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed", items: [] } } });
  };
  return { store, codex, runtime, bot, notify, compact, lifecycle, state: () => store.bot(bot.id).contextCompaction };
}

test("manual compaction: the empty ACK is Compacting; only the native item completes it", async (t) => {
  const { store, codex, runtime, bot, notify, compact, lifecycle, state } = await setup(t);
  notify(usageNote(bot.threadId, 230_000, { total: 4_000_000 }));
  store.put("profileDelivery", { id: bot.id, botId: bot.id, threadId: bot.threadId });
  const ack = await compact("compact:manual-1");
  assert.equal(ack.compaction.state, "compacting");
  assert.equal(state().state, "compacting");
  assert.equal(codex.compactions(), 1);
  assert.throws(() => runtime.compaction.native("turn/start", { threadId: bot.threadId }), /compaction is running/i, "no new turn while compacting");
  lifecycle("other-thread-turn", "foreign-thread");
  assert.equal(state().state, "compacting", "a foreign thread's item is not evidence");
  lifecycle();
  assert.equal(state().state, "completed");
  assert.equal(state().itemId, "item-compact-turn");
  assert.equal(state().beforeTokens, 230_000);
  assert.equal(store.get("profileDelivery", bot.id), null, "contextCompaction resets the profile epoch");
  assert.equal(state().context.compacted, true, "pre-compaction pressure is stale evidence");
  notify(usageNote(bot.threadId, 31_000));
  assert.equal(state().afterTokens, 31_000);
  runtime.compaction.native("turn/start", { threadId: bot.threadId });
  assert.deepEqual(await compact("compact:manual-1"), ack, "same operation is never resubmitted");
  assert.equal(codex.compactions(), 1);
});

test("manual compaction refuses active turns, questions and Goals without a native call; Stop is not changed", async (t) => {
  const { store, codex, runtime, bot, compact, state } = await setup(t);
  runtime.saveBot(store.bot(bot.id), { activeTurnId: "busy-turn" });
  await assert.rejects(compact(), (e) => e.outcome === "rejected" && /turn to finish/.test(e.message));
  assert.equal(state().state, "blocked");
  runtime.saveBot(store.bot(bot.id), { activeTurnId: null });
  store.put("pending", { id: "q1", key: "q1", botId: bot.id, async: true, request: {} });
  await assert.rejects(compact(), /question/);
  store.remove("pending", "q1");
  store.put("nativeGoal", { id: bot.id, botId: bot.id, goal: { status: "active" } });
  await assert.rejects(compact(), /Goal/);
  store.remove("nativeGoal", bot.id);
  assert.equal(codex.compactions(), 0);
  runtime.saveBot(store.bot(bot.id), { queuePaused: true });
  await compact();
  assert.equal(codex.compactions(), 1, "an explicit owner action may compact a Stopped idle thread");
  assert.equal(store.bot(bot.id).queuePaused, true, "Stop is unchanged");
});

test("lost ACK is Unconfirmed, never retried; a late matching item settles the original operation", async (t) => {
  const { store, codex, bot, compact, lifecycle, state } = await setup(t);
  codex.compactAnswer = () => Promise.reject(new Error("Codex thread/compact/start timed out; check the conversation before retrying."));
  await assert.rejects(compact("compact:lost-ack"), (e) => e.outcome === "uncertain");
  assert.equal(state().state, "unconfirmed");
  assert.equal(store.operation("compact:lost-ack").status, "uncertain");
  await assert.rejects(compact("compact:lost-ack"), (e) => e.outcome === "uncertain");
  assert.equal(codex.compactions(), 1, "same original operation is not repeated");
  lifecycle();
  assert.equal(state().state, "completed", "late lifecycle reconciles the original request");
  assert.equal(store.operation("compact:lost-ack").status, "done");
});

test("an explicit native error fails definitely; a non-compaction terminal turn fails truthfully", async (t) => {
  const { codex, bot, notify, compact, state } = await setup(t);
  codex.compactAnswer = () => Promise.reject(Object.assign(new Error("thread busy"), { definite: true }));
  await assert.rejects(compact(), (e) => e.outcome === "rejected");
  assert.equal(state().state, "failed");
  codex.compactAnswer = () => ({});
  await compact();
  notify({ method: "turn/started", params: { threadId: bot.threadId, turn: { id: "ct", status: "inProgress", items: [] } } });
  notify({ method: "turn/completed", params: { threadId: bot.threadId, turn: { id: "ct", status: "failed", items: [], error: { message: "context too small" } } } });
  assert.equal(state().state, "failed");
  assert.match(state().reason, /context too small/);
});

test("idle compaction runs once per context generation, after 54 idle minutes, and yields to Stop and queued input", async (t) => {
  const { store, codex, runtime, bot, notify, lifecycle, state } = await setup(t);
  let now = Date.parse("2026-10-15T01:00:00Z");
  runtime.compaction.clock = () => now;
  notify(usageNote(bot.threadId, 180_000, { total: 20_000_000 }));
  now += 120 * MINUTE;
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 0, "lifetime totals never trigger");
  notify(usageNote(bot.threadId, 205_000));
  now += 53 * MINUTE;
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 0, "not yet 54 minutes");
  runtime.saveBot(store.bot(bot.id), { queuePaused: true });
  now += 2 * MINUTE;
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 0, "Stop holds automatic work");
  runtime.saveBot(store.bot(bot.id), { queuePaused: false });
  store.put("promptQueue", { id: "q-1", botId: bot.id, state: "staged" });
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 0, "queued human input wins");
  store.remove("promptQueue", "q-1");
  assert.equal(await runtime.compaction.tick({ admit: () => false }), null, "portable fence holds");
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 1);
  assert.equal(state().trigger, "idle");
  lifecycle();
  now += 120 * MINUTE;
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 1, "completed compaction does not loop");
  notify(usageNote(bot.threadId, 210_000, { turnId: "later" }));
  codex.compactAnswer = () => Promise.reject(Object.assign(new Error("refused"), { definite: true }));
  now += 54 * MINUTE;
  await new Promise((r) => setTimeout(r, 20)); // turn/completed reconciliation releases the bot lock
  await runtime.compaction.tick();
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 2, "a failed generation is not retried");
  assert.equal(state().state, "failed");
});

test("policy saves through bots.update and a restart leaves in-flight compaction Unconfirmed", async (t) => {
  const { store, codex, runtime, bot, compact, state } = await setup(t);
  await runtime.handle({ method: "bots.update", botId: bot.id, params: { idleCompaction: { idleMinutes: 90 } }, operationId: "policy-1234567890" });
  assert.deepEqual(store.bot(bot.id).idleCompaction, { enabled: true, thresholdTokens: 200_000, idleMinutes: 90 });
  await assert.rejects(runtime.handle({ method: "bots.update", botId: bot.id, params: { idleCompaction: { idleMinutes: 2 } }, operationId: "policy-bad-123456" }));
  await compact("compact:before-restart");
  runtime.epoch = "next-process";
  runtime.compaction.recover();
  assert.equal(state().state, "unconfirmed");
  runtime.compaction.native("turn/start", { threadId: bot.threadId });
  await compact();
  assert.equal(codex.compactions(), 2, "a new explicit request may compact again");
  assert.ok(COMPACTION_LIFECYCLE_LIMIT_MS >= 10 * MINUTE);
});

test("hub admission sees an in-flight idle compaction as work, so dispatched input defers instead of failing", async (t) => {
  const { store, codex, runtime, bot, notify, lifecycle } = await setup(t);
  let now = Date.parse("2026-10-15T01:00:00Z");
  runtime.compaction.clock = () => now;
  notify(usageNote(bot.threadId, 205_000));
  now += 55 * MINUTE;
  await runtime.compaction.tick();
  assert.equal(codex.compactions(), 1);
  // The compaction is ACKed but its turn/started has not arrived: portable
  // admission (agent-admission.mjs) defers only when this is not "ready".
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "working");
  lifecycle();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runtime.primary.work(store.bot(bot.id)).state, "ready");
});
