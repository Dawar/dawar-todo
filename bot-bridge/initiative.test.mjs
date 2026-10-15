import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { BotRuntime } from "./runtime.mjs";
import { managedExecutionParams, PRIVATE_REVIEW } from "./execution-access.mjs";
import { InitiativeLedger, validateReviewResult, classifyReply, limitDay } from "./initiative-ledger.mjs";
import { InitiativeCoordinator, localExecutor, ownerReplyText } from "./initiative-coordinator.mjs";
import { PRIVATE_REVIEW_CONFIG } from "./initiative-node.mjs";
import { conversationViewPage } from "./conversation-view.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
class InitiativeCodex extends EventEmitter {
  calls = []; answers = []; ready = true; injectMode = "ok"; forks = 0;
  threads = new Map([["thread-main", { id: "thread-main", status: { type: "idle" }, turns: [
    { id: "turn-1", status: "completed", itemsView: "full", items: [
      { type: "userMessage", id: "u1", clientId: "owner-1", content: [{ type: "text", text: "Ship the release notes", text_elements: [] }] },
      { type: "agentMessage", id: "a1", text: "Release notes shipped.", phase: "final_answer" }] }] }]]);
  async start() {}
  forkPrivateReview(params) { return this.call("thread/fork", { ...params, [PRIVATE_REVIEW]: true }); }
  startPrivateReviewTurn(params) { return this.call("turn/start", { ...params, [PRIVATE_REVIEW]: true }); }
  async call(method, params = {}) {
    params = managedExecutionParams(method, params);
    this.calls.push({ method, params });
    const thread = this.threads.get(params.threadId);
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [
      { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
      { model: "gpt-6-luna", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] }], nextCursor: null };
    if (method === "thread/read") return { thread };
    if (method === "thread/resume") return { thread };
    if (method === "thread/turns/list") return { data: [...thread.turns].reverse().slice(0, params.limit ?? 50), nextCursor: null };
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/loaded/list") return { data: [...this.threads.keys()], nextCursor: null };
    if (method === "thread/fork") {
      const fork = { id: `fork-${++this.forks}`, status: { type: "idle" }, turns: [] };
      this.threads.set(fork.id, fork);
      return { thread: fork };
    }
    if (method === "turn/start") {
      const turn = { id: `turn-${this.calls.length}`, status: "inProgress", items: [] };
      thread.turns.push(turn);
      return { turn };
    }
    if (method === "thread/inject_items") {
      if (this.injectMode === "timeout") throw new Error("Codex thread/inject_items timed out; check the conversation before retrying.");
      if (this.injectMode === "reject") throw Object.assign(new Error("unsupported"), { definite: true });
      return {};
    }
    return {};
  }
  respond(id, result) { this.answers.push({ id, result }); }
  reject(id, message) { this.answers.push({ id, error: message }); }
}

function output(overrides = {}) {
  return JSON.stringify({ decision: "publish", next_review_hours: null, ledger_updates: [],
    contribution: { kind: "opportunity", item_id: null, key: "release-notes-template", title: "Release notes template",
      why_now: "Three releases this week repeated the same manual steps.", evidence: ["turn-1: release notes were written by hand"],
      message: "I noticed release notes are assembled by hand each time. A small template would save about 20 minutes per release.",
      expected_value: "About 20 minutes saved per release (estimate).", effort_estimate: "Roughly one hour (estimate).",
      first_step: "Draft the template from the last three releases.", changed_circumstances: false, ...overrides.contribution },
    ...overrides.top });
}

async function setup(t, { bots = ["atlas"] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "initiative-test-"));
  const store = new Store(join(dir, "state.sqlite")), codex = new InitiativeCodex();
  for (const [i, id] of bots.entries()) {
    const threadId = i ? `thread-${id}` : "thread-main";
    if (i) codex.threads.set(threadId, { ...structuredClone(codex.threads.get("thread-main")), id: threadId });
    store.saveBot({ id, slug: id, name: id[0].toUpperCase() + id.slice(1), threadId, cwd: dir, executionMode: "single-thread", provider: "codex",
      updatedAt: "2026-10-15T00:00:00.000Z" });
  }
  const runtime = new BotRuntime({ store, codex, root: join(dir, "bots") });
  await runtime.start();
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const clock = { t: Date.parse("2026-10-15T14:00:00Z") };
  const coordinator = new InitiativeCoordinator({ store, executor: localExecutor(runtime), bots: () => store.bots(), clock: () => clock.t, random: () => 0 });
  coordinator.ledger.configure({ enabled: true });
  return { dir, store, codex, runtime, coordinator, clock };
}
/** Complete the running private review on its fork with the given output. */
async function finishReview(codex, store, text = output(), status = "completed") {
  const review = store.list("privateReview").find(r => r.state === "running");
  assert.ok(review, "a private review is running");
  codex.emit("notification", { method: "item/completed", params: { threadId: review.forkThreadId, turnId: review.turnId, item: { type: "agentMessage", id: "r", text, phase: "final_answer" } } });
  codex.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId: review.forkThreadId, turnId: review.turnId,
    tokenUsage: { total: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 } } } });
  codex.emit("notification", { method: "turn/completed", params: { threadId: review.forkThreadId, turn: { id: review.turnId, status, items: [] } } });
  await settle(); await settle();
  return review;
}
const injections = codex => codex.calls.filter(c => c.method === "thread/inject_items");
const mainTurns = codex => codex.calls.filter(c => c.method === "turn/start" && c.params.threadId === "thread-main");

test("disabled by default: no review, fork or message", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-off-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const ledger = new InitiativeLedger(store);
  assert.equal(ledger.settings().enabled, false);
  assert.equal(ledger.settings().baselineMinutes, 120);
  assert.equal(ledger.settings().scanMinutes, 25);
  assert.equal("quietHours" in ledger.settings(), false);
  ledger.configure({ enabled: true, coverage: "selected", bots: { pilot: { enabled: true } } });
  assert.equal(ledger.botSettings("pilot").enabled, true);
  assert.equal(ledger.botSettings("other").enabled, false);
  ledger.configure({ enabled: false });
  const calls = [];
  const coordinator = new InitiativeCoordinator({ store, bots: () => [{ id: "b", threadId: "t" }], executor: new Proxy({}, { get: (_, k) => (...a) => { calls.push(k); return { idle: true }; } }) });
  await coordinator.tick();
  assert.deepEqual(calls.filter(k => k !== "placement"), []);
});

test("admission is idle-only and a hidden read-only review publishes once without a main turn", async t => {
  const { store, codex, runtime, coordinator } = await setup(t);
  // Busy: an active main turn keeps the review due but not admitted.
  runtime.saveBot(store.bot("atlas"), { activeTurnId: "turn-live", status: "running" });
  await coordinator.tick();
  assert.equal(codex.calls.filter(c => c.method === "thread/fork").length, 0);
  assert.equal(store.get("initiativeBot", "atlas").lastSkip, "not-idle");
  runtime.saveBot(store.bot("atlas"), { activeTurnId: null, status: "idle" });
  coordinator.nextScanAt = 0;
  await coordinator.tick();
  const fork = codex.calls.find(c => c.method === "thread/fork");
  assert.ok(fork);
  // Read-only enforcement in the execution layer, including external tools.
  assert.equal(fork.params.sandbox, "read-only");
  assert.equal(fork.params.ephemeral, true);
  assert.equal(fork.params.approvalPolicy, "never");
  assert.equal(fork.params.config.sandbox_mode, "read-only");
  assert.equal(fork.params.config["features.multi_agent"], false);
  assert.equal(fork.params.deferGoalContinuation, true);
  for (const server of ["codex_manager", "bot_desktop", "linux_computer_use", "bot_desktop_linus"])
    assert.equal(fork.params.config[`mcp_servers.${server}`].enabled, false);
  const reviewTurn = codex.calls.find(c => c.method === "turn/start" && c.params.threadId === "fork-1");
  assert.deepEqual(reviewTurn.params.sandboxPolicy, { type: "readOnly" });
  assert.ok(reviewTurn.params.outputSchema);
  const eventsBefore = store.cursor();
  await finishReview(codex, store);
  // Fork events never reach chat, unread or notifications.
  assert.equal(store.replay(eventsBefore).filter(e => JSON.stringify(e).includes("fork-1")).length, 0);
  assert.equal(store.list("notice").length, 0);
  await coordinator.tick();
  assert.equal(injections(codex).length, 1);
  assert.deepEqual(injections(codex)[0].params.items[0].role, "assistant");
  assert.equal(mainTurns(codex).length, 0, "publication starts no main model turn");
  const [publication] = store.list("initiativePublication");
  assert.equal(publication.state, "published");
  assert.equal(store.list("initiativeReview")[0].usage.totalTokens, 1200);
  assert.ok(codex.calls.some(c => c.method === "thread/unsubscribe" && c.params.threadId === "fork-1"), "fork released");
  // Live projection, unread state and a notification only after confirmation.
  assert.equal(store.list("notice").length, 1);
  assert.match(store.bot("atlas").preview, /release notes/);
  const view = await conversationViewPage(runtime, store.bot("atlas"), null);
  assert.ok(view.entries.some(e => e.item?.id === `initiative:${publication.id}` || e.id?.includes(publication.id)));
  // Unchanged conversation: no immediate repeat; reconsidered at the baseline.
  await coordinator.tick();
  assert.equal(codex.calls.filter(c => c.method === "thread/fork").length, 1);
});

test("tools, approvals and MCP calls from the fork are refused; MCP aborts the review", async t => {
  const { store, codex, coordinator } = await setup(t);
  await coordinator.tick();
  const review = store.list("privateReview")[0];
  codex.emit("request", { id: 7, method: "item/tool/call", params: { threadId: review.forkThreadId, tool: "bots_queue", arguments: {} } });
  codex.emit("request", { id: 8, method: "item/commandExecution/requestApproval", params: { threadId: review.forkThreadId } });
  await settle();
  assert.equal(codex.answers.find(a => a.id === 7).result.success, false);
  assert.match(codex.answers.find(a => a.id === 8).error, /read-only/);
  codex.emit("notification", { method: "item/started", params: { threadId: review.forkThreadId, item: { type: "mcpToolCall", id: "m" } } });
  await settle(); await settle();
  assert.equal(store.get("privateReview", review.id).state, "invalid");
  await coordinator.tick();
  assert.equal(store.get("initiativeReview", store.list("initiativeReview")[0].id).state, "invalid");
  assert.equal(store.get("initiativeBot", "atlas").failures, 1);
  assert.equal(injections(codex).length, 0);
});

test("user activity cancels the review; stale results are rejected without a message", async t => {
  const { store, codex, runtime, coordinator, clock } = await setup(t);
  await coordinator.tick();
  // A user message arrives: the private review is cancelled, main untouched.
  const userTurn = { id: "turn-user", status: "inProgress", items: [] };
  codex.threads.get("thread-main").turns.push(userTurn);
  codex.emit("notification", { method: "turn/started", params: { threadId: "thread-main", turn: userTurn } });
  await settle(); await settle();
  assert.equal(mainTurns(codex).length, 0, "the main conversation is not touched");
  assert.equal(store.list("privateReview")[0].state, "cancelled");
  await coordinator.tick();
  assert.equal(store.list("initiativeReview")[0].state, "cancelled");
  assert.equal(store.get("initiativeBot", "atlas")?.failures ?? 0, 0);
  Object.assign(userTurn, { status: "completed" });
  codex.emit("notification", { method: "turn/completed", params: { threadId: "thread-main", turn: userTurn } });
  await settle();
  // Next review completes, but the conversation moved on meanwhile.
  clock.t += 26 * 6e4;
  await coordinator.tick();
  assert.equal(store.list("privateReview").filter(r => r.state === "running").length, 1);
  codex.threads.get("thread-main").turns.push({ id: "turn-2", status: "completed", items: [] });
  await finishReview(codex, store);
  await coordinator.tick();
  const rejected = store.list("initiativeReview").find(r => r.state === "rejected");
  assert.equal(rejected.reason, "conversation-changed");
  assert.equal(store.list("initiativePublication").length, 0);
  assert.equal(store.list("initiativeItem").length, 0, "stale result changes no ledger state");
  assert.equal(injections(codex).length, 0);
});

test("cross-bot deduplication keeps one responsible bot and links contributors", async t => {
  const { store, codex, coordinator, clock } = await setup(t, { bots: ["atlas", "bea"] });
  await coordinator.tick();
  const first = store.list("privateReview").find(r => r.state === "running");
  await finishReview(codex, store);
  await coordinator.tick(); // accepts the first review and admits the next due bot
  const second = store.list("privateReview").find(r => r.state === "running");
  assert.notEqual(second.botId, first.botId);
  await finishReview(codex, store, output({ contribution: { key: "Release-Notes Template!", message: "Release notes could use a reusable template; it repeats every week and costs time." } }));
  await coordinator.tick();
  const items = store.list("initiativeItem");
  assert.equal(items.length, 1);
  assert.equal(items[0].responsibleBotId, first.botId);
  assert.deepEqual(items[0].contributors.map(c => c.botId), [second.botId]);
  assert.equal(store.list("initiativePublication").length, 1, "only the responsible bot publishes");
  assert.equal(injections(codex).length, 1);
});

test("ambiguous injection is reconciled against native history before any retry", async t => {
  const { store, codex, coordinator, clock } = await setup(t);
  codex.injectMode = "timeout";
  await coordinator.tick();
  await finishReview(codex, store);
  await coordinator.tick();
  let [p] = store.list("initiativePublication");
  assert.equal(p.state, "uncertain");
  assert.equal(store.list("notice").length, 0, "unconfirmed publication changes no unread or notification state");
  // Native history shows the message: confirm without injecting again.
  codex.threads.get("thread-main").turns.at(-1).items.push({ type: "agentMessage", id: "native-injected", text: p.text, phase: "final_answer" });
  clock.t += 6e5;
  await coordinator.tick();
  p = store.get("initiativePublication", p.id);
  assert.equal(p.state, "published");
  assert.equal(injections(codex).length, 1);
});

test("an absent injection is retried once it is proven not to have landed", async t => {
  const { store, codex, runtime, coordinator, clock } = await setup(t);
  codex.injectMode = "timeout";
  await coordinator.tick();
  await finishReview(codex, store);
  await coordinator.tick();
  const [p] = store.list("initiativePublication");
  // Still settling: no verdict, no retry.
  clock.t += 6e5;
  await coordinator.tick();
  assert.equal(injections(codex).length, 1);
  const node = store.get("initiativeInjection", p.id);
  store.put("initiativeInjection", { ...node, attemptedAt: new Date(Date.now() - 300000).toISOString() });
  runtime.privateReviews.clock = Date.now;
  codex.injectMode = "ok";
  clock.t += 6e5;
  await coordinator.tick(); // reconcile -> absent -> pending
  await coordinator.tick(); // retry
  assert.equal(store.get("initiativePublication", p.id).state, "published");
  assert.equal(injections(codex).length, 2);
  assert.equal(store.list("notice").length, 1);
});

test("replies update the ledger; older reviews cannot overwrite newer decisions", async t => {
  const { store, codex, coordinator, clock } = await setup(t);
  await coordinator.tick();
  await finishReview(codex, store);
  await coordinator.tick();
  const [item] = store.list("initiativeItem");
  assert.equal(item.status, "published");
  coordinator.observeUserMessage("atlas", { type: "userMessage", id: "reply-1", content: [{ type: "text", text: "Next week" }] });
  let current = store.get("initiativeItem", item.id);
  assert.equal(current.status, "snoozed");
  assert.equal(Date.parse(current.snoozedUntil), clock.t + 7 * 864e5);
  // A second message is ordinary conversation, not another ledger decision.
  coordinator.observeUserMessage("atlas", { type: "userMessage", id: "reply-2", content: [{ type: "text", text: "leave it" }] });
  assert.equal(store.get("initiativeItem", item.id).status, "snoozed");
  // The bot records an explicit decision through its ordinary tool.
  assert.equal(coordinator.tool("atlas", { operation: "record", itemId: item.id, outcome: "dismissed" }).status, "dismissed");
  assert.throws(() => coordinator.tool("bea", { operation: "record", itemId: item.id, outcome: "approved" }), /not yours/);
  // A review that started before the dismissal tries to resolve the item.
  const capture = { ledgerVersion: 0, startedAt: "2026-10-15T13:00:00.000Z", reviewId: "old" };
  const applied = coordinator.ledger.applyReview("atlas", validateReviewResult(JSON.stringify({ decision: "none", contribution: null, next_review_hours: null,
    ledger_updates: [{ item_id: item.id, key: item.key, title: item.title, kind: "opportunity", status: "resolved", note: null, sources: [], next_review_hours: null }] })), capture);
  assert.deepEqual(applied.ignored, [{ itemId: item.id, reason: "newer-owner-decision" }]);
  assert.equal(store.get("initiativeItem", item.id).status, "dismissed");
  // Dismissed items are never delivered again.
  assert.equal(coordinator.ledger.deliveryBlock("atlas", item.id), "item-dismissed");
});

test("delivery spacing, daily limits and one 72-hour reminder", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-limits-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  let now = Date.parse("2026-10-15T14:00:00Z");
  const ledger = new InitiativeLedger(store, { clock: () => now, random: () => 0.5 });
  const capture = { ledgerVersion: 0, startedAt: new Date(now).toISOString(), reviewId: "r" };
  const make = (botId, key) => ledger.applyReview(botId, validateReviewResult(output({ contribution: { key, title: key } })), capture).contribution.itemId;
  const publish = (botId, itemId) => ledger.markPublished({ id: `p-${itemId}-${now}`, botId, itemId, createdAt: new Date(now).toISOString() });
  const a = make("a", "one"), b = make("a", "two"), c = make("a", "three");
  publish("a", a);
  assert.equal(ledger.deliveryBlock("a", b), "spacing");
  now += 4 * 6e4; // 3-5 minute spacing (random 0.5 => 4 minutes)
  assert.equal(ledger.deliveryBlock("a", b), null);
  publish("a", b);
  now += 6 * 6e4;
  assert.equal(ledger.deliveryBlock("a", c), "bot-daily-limit");
  for (const bot of ["x", "y", "z"]) { const id = make(bot, `${bot}-item`); assert.equal(ledger.deliveryBlock(bot, id), null); publish(bot, id); now += 6 * 6e4; }
  assert.equal(ledger.deliveryBlock("w", make("w", "w-item")), "global-daily-limit");
  // Unanswered proposal: awaiting reply, then one reminder after 72 hours.
  assert.equal(ledger.deliveryBlock("a", a), "awaiting-reply");
  now += 73 * 36e5;
  assert.equal(ledger.deliveryBlock("a", a), null);
  publish("a", a);
  now += 73 * 36e5;
  assert.equal(ledger.deliveryBlock("a", a), "reminder-used");
  assert.equal(ledger.deliveryBlock("a", a, { changedCircumstances: true }), null);
  assert.equal(limitDay(Date.parse("2026-10-16T03:30:00Z")), "2026-10-15", "limits follow the Toronto calendar day");
});

test("result validation and reply classification", () => {
  assert.throws(() => validateReviewResult("not json"), /JSON/);
  assert.throws(() => validateReviewResult(output({ contribution: { evidence: [] } })), /evidence/);
  assert.throws(() => validateReviewResult(JSON.stringify({ decision: "none", contribution: null, next_review_hours: null,
    ledger_updates: [{ item_id: "x", key: "k", title: "t", kind: "opportunity", status: "dismissed", note: null, sources: [], next_review_hours: null }] })), /owner decision/);
  assert.equal(validateReviewResult(output()).contribution.kind, "opportunity");
  assert.equal(classifyReply("Yes, proceed").outcome, "approved");
  assert.equal(classifyReply("leave it").outcome, "dismissed");
  assert.equal(classifyReply("next week").outcome, "snoozed");
  assert.equal(classifyReply("Can you explain the second point in more detail before I decide?"), null);
  assert.equal(ownerReplyText({ content: [{ type: "text", text: "Quoted...\nNew user message:\nyes, proceed" }] }), "yes, proceed");
  assert.equal(PRIVATE_REVIEW_CONFIG["features.multi_agent"], false);
});
