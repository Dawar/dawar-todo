import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { BotRuntime } from "./runtime.mjs";
import { managedExecutionParams, PRIVATE_REVIEW } from "./execution-access.mjs";
import { InitiativeLedger, validateReviewResult, classifyReply, limitDay, publicationText, mentionWhen, resurfaceAt, looseThreadPriority } from "./initiative-ledger.mjs";
import { InitiativeCoordinator, localExecutor, ownerReplyText } from "./initiative-coordinator.mjs";
import { PRIVATE_REVIEW_CONFIG } from "./initiative-node.mjs";
import { readOwnerMessages, validateExtraction, ownerAuthored } from "./initiative-mentions.mjs";
import { buildReviewPacket, estimateTokens } from "./initiative-packet.mjs";
import { conversationViewPage } from "./conversation-view.mjs";
import { ClaudeBackend } from "./claude.mjs";
import { ProviderRouter } from "./provider-router.mjs";
import { fakeQuery, fakeMcp, text as sdkText, result as sdkResult, MinimalCodex } from "./claude-test-support.mjs";

const settle = async (n = 3) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
/** Wait for a state the code under test reaches through promises only (no timers); fails loudly instead of guessing. */
async function until(done, what) {
  for (let i = 0; i < 5000; i++) { if (done()) return; await settle(1); }
  throw Error(`Never reached: ${what}`);
}
const sec = iso => Date.parse(iso) / 1000;
const owner = (id, text, extra = {}) => ({ type: "userMessage", id, clientId: `owner-${id}`, content: [{ type: "text", text, text_elements: [] }], ...extra });
const answer = (id, text) => ({ type: "agentMessage", id, text, phase: "final_answer" });

/** Codex fake: main conversations plus private job threads that answer from `reply(kind, params)`. */
class InitiativeCodex extends EventEmitter {
  calls = []; answers = []; ready = true; jobs = 0;
  reply = () => null; // (kind, params) => output object/string, or null to finish manually
  usage = { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 };
  threads = new Map([["thread-main", { id: "thread-main", status: { type: "idle" }, turns: [
    { id: "turn-1", status: "completed", startedAt: sec("2026-10-13T15:00:00Z"), itemsView: "full", items: [
      owner("u1", "We should call Acme about their renewal before Friday."),
      answer("a1", "Noted.")] }] }]]);
  inflight = new Set();
  async start() {}
  /** Resolves once every scripted job reply has been emitted. */
  async settled() { while (this.inflight.size) await Promise.all([...this.inflight]); }
  startPrivateThread(params) { return this.call("thread/start", { ...params, [PRIVATE_REVIEW]: true }); }
  startPrivateReviewTurn(params) { return this.call("turn/start", { ...params, [PRIVATE_REVIEW]: true }); }
  async call(method, params = {}) {
    params = managedExecutionParams(method, params);
    this.calls.push({ method, params });
    const thread = this.threads.get(params.threadId);
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [
      { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] },
      { model: "gpt-6-luna", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }], serviceTiers: [{ id: "priority", name: "Fast" }] }], nextCursor: null };
    if (method === "thread/read") return { thread };
    if (method === "thread/resume") return { thread };
    if (method === "thread/turns/list") return { data: [...thread.turns].reverse().slice(0, params.limit ?? 50), nextCursor: null };
    if (method === "thread/queue/list") return { data: [], nextCursor: null };
    if (method === "thread/goal/get") return { goal: null };
    if (method === "thread/loaded/list") return { data: [...this.threads.keys()], nextCursor: null };
    if (method === "thread/start") {
      const job = { id: `job-${++this.jobs}`, status: { type: "idle" }, turns: [], private: params.ephemeral === true };
      this.threads.set(job.id, job);
      return { thread: job };
    }
    if (method === "turn/start") {
      const turn = { id: `turn-${this.calls.length}`, status: "inProgress", items: [] };
      thread.turns.push(turn);
      if (thread.private) {
        const kind = params.outputSchema?.properties?.mentions ? "extract" : "review";
        const out = this.reply(kind, params);
        if (out !== null) {
          // Emitted after this call returns, like the app-server; awaitable through settled().
          const done = new Promise(resolve => setImmediate(() => { this.finishJob(thread.id, turn.id, typeof out === "string" ? out : JSON.stringify(out)); resolve(); }))
            .finally(() => this.inflight.delete(done));
          this.inflight.add(done);
        }
      }
      return { turn };
    }
    return {};
  }
  finishJob(threadId, turnId, text, status = "completed") {
    this.emit("notification", { method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: "r", text, phase: "final_answer" } } });
    this.emit("notification", { method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { total: this.usage } } });
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: turnId, status, items: [] } } });
  }
  respond(id, result) { this.answers.push({ id, result }); }
  reject(id, message) { this.answers.push({ id, error: message }); }
}

const NO_MENTIONS = { mentions: [], resolutions: [] };
const ACME = { mentions: [{ message_id: "u1", quote: "call Acme about their renewal", item_id: null, key: "client-acme-renewal", title: "Call Acme about the renewal",
  category: "client", entity: "Acme", importance: "high", time_sensitive: false, due_in_hours: null, summary: "Renewal call before Friday.", better_bot_id: null }], resolutions: [] };
function review(overrides = {}) {
  return { decision: "publish", next_review_hours: null, ledger_updates: [],
    contribution: { kind: "opportunity", item_id: null, key: "release-notes-template", title: "Release notes template",
      why_now: "Three releases this week repeated the same manual steps.", evidence: ["turn-1: release notes were written by hand"],
      message: "I noticed release notes are assembled by hand each time. A small template would save about 20 minutes per release.",
      expected_value: "About 20 minutes saved per release (estimate).", effort_estimate: "Roughly one hour (estimate).",
      first_step: "Draft the template from the last three releases.", proposed_action: null, changed_circumstances: false, ...overrides.contribution },
    ...overrides.top };
}
const NONE = { decision: "none", contribution: null, ledger_updates: [], next_review_hours: null };
const output = overrides => JSON.stringify(review(overrides));
function threadProposal(itemId, extra = {}) {
  return review({ contribution: { kind: "loose-thread", item_id: itemId, key: "client-acme-renewal", title: "Call Acme about the renewal",
    why_now: "Friday is close and nothing was scheduled.", evidence: ["mention u1"], message: "Nothing has been scheduled yet and the renewal window closes Friday. I can put it on your list now.",
    proposed_action: { type: "todo", detail: "Create a todo “Call Acme about the renewal” due Thursday." }, ...extra } });
}

async function setup(t, { bots = ["atlas"], reply = () => null, enable = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "initiative-test-"));
  const store = new Store(join(dir, "state.sqlite")), codex = new InitiativeCodex();
  codex.reply = reply;
  for (const [i, id] of bots.entries()) {
    const threadId = i ? `thread-${id}` : "thread-main";
    if (i) codex.threads.set(threadId, { ...structuredClone(codex.threads.get("thread-main")), id: threadId });
    store.saveBot({ id, slug: id, name: id[0].toUpperCase() + id.slice(1), threadId, cwd: dir, executionMode: "single-thread", provider: "codex",
      model: "gpt-6.1-sol", updatedAt: "2026-10-15T00:00:00.000Z" });
  }
  const runtime = new BotRuntime({ store, codex, root: join(dir, "bots") });
  await runtime.start();
  t.after(async () => { runtime.usage?.stop?.(); store.close(); await rm(dir, { recursive: true, force: true }); });
  const clock = { t: Date.parse("2026-10-15T14:00:00Z") };
  runtime.privateReviews.clock = () => clock.t;
  const coordinator = new InitiativeCoordinator({ store, executor: localExecutor(runtime), bots: () => store.bots(), clock: () => clock.t, random: () => 0 });
  if (enable) coordinator.ledger.configure({ enabled: true });
  // One coordinator tick, then every job reply and node finish it caused.
  const drive = async (n = 4) => { for (let i = 0; i < n; i++) { await coordinator.tick(); await codex.settled(); await runtime.privateReviews.settled(); } };
  return { dir, store, codex, runtime, coordinator, clock, drive };
}
const jobStarts = codex => codex.calls.filter(c => c.method === "thread/start" && c.params.ephemeral);
const mainTurns = codex => codex.calls.filter(c => c.method === "turn/start" && c.params.threadId === "thread-main");
const kinds = store => store.list("initiativeReview").map(r => `${r.kind}:${r.state}`);

test("disabled by default: no job, thread or message", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-off-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const ledger = new InitiativeLedger(store);
  assert.equal(ledger.settings().enabled, false);
  assert.equal(ledger.settings().baselineMinutes, 120);
  assert.equal(ledger.settings().looseThreads, true);
  assert.equal(ledger.settings().triage, false);
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

test("Codex: idle-only admission, tool-free ephemeral jobs, and delivery by projection without any native write", async t => {
  const { store, codex, runtime, coordinator, drive } = await setup(t, { reply: kind => kind === "extract" ? NO_MENTIONS : review() });
  runtime.saveBot(store.bot("atlas"), { activeTurnId: "turn-live", status: "running" });
  await drive(1);
  assert.equal(jobStarts(codex).length, 0, "a busy bot is not admitted");
  assert.equal(store.get("initiativeBot", "atlas").lastSkip, "not-idle");
  runtime.saveBot(store.bot("atlas"), { activeTurnId: null, status: "idle" });
  coordinator.nextScanAt = 0;
  const eventsBefore = store.cursor();
  await drive(6);
  assert.deepEqual(kinds(store), ["extract:accepted", "review:accepted"]);
  const [extract, reviewJob] = jobStarts(codex);
  for (const job of [extract, reviewJob]) {
    assert.equal(job.params.ephemeral, true);
    assert.equal(job.params.sandbox, "read-only");
    assert.equal(job.params.approvalPolicy, "never");
    assert.equal(job.params.config["features.multi_agent"], false);
    assert.equal("dynamicTools" in job.params, false);
    for (const server of ["codex_manager", "bot_desktop", "linux_computer_use", "bot_desktop_linus"]) assert.equal(job.params.config[`mcp_servers.${server}`].enabled, false);
    assert.notEqual(job.params.cwd, store.bot("atlas").cwd, "jobs run outside the bot workspace");
  }
  assert.equal(extract.params.model, "gpt-6-luna", "mention capture uses the small model");
  assert.equal(reviewJob.params.model, "gpt-6.1-sol", "the review runs on the bot's own model");
  assert.equal(codex.calls.filter(c => c.method === "thread/fork").length, 0, "the main conversation is never forked");
  const turns = codex.calls.filter(c => c.method === "turn/start" && c.params.threadId.startsWith("job-"));
  assert.deepEqual(turns.map(c => c.params.sandboxPolicy), [{ type: "readOnly" }, { type: "readOnly" }]);
  assert.ok(turns.every(c => c.params.outputSchema));
  assert.match(turns[1].params.input[0].text, /We should call Acme/, "the packet carries recent conversation");
  // Job events never reach chat, unread or notifications.
  assert.equal(store.replay(eventsBefore).filter(e => JSON.stringify(e).includes("job-")).length, 0);
  assert.ok(store.list("notice").every(n => /has a proposal for you/.test(n.body)), "the only notice is the delivered proposal");
  await drive(1);
  const [publication] = store.list("initiativePublication");
  assert.equal(publication.state, "published");
  assert.equal(codex.calls.filter(c => c.method === "thread/inject_items").length, 0, "no native injection");
  assert.equal(mainTurns(codex).length, 0, "publication starts no main model turn");
  assert.ok(codex.calls.filter(c => c.method === "thread/unsubscribe").length >= 2, "job threads released");
  assert.equal(store.list("notice").length, 1);
  assert.match(store.bot("atlas").preview, /release notes/);
  // Live event, then reconnect history.
  assert.ok(store.replay(eventsBefore).some(e => JSON.stringify(e).includes(`initiative:${publication.id}`)));
  const view = await conversationViewPage(runtime, store.bot("atlas"), null);
  assert.ok(view.entries.some(e => e.item?.id === `initiative:${publication.id}` || e.id?.includes(publication.id)));
  assert.equal(store.list("initiativeReview").find(r => r.kind === "review").usage.totalTokens, 1200);
  assert.ok(store.list("initiativeReview").find(r => r.kind === "review").packetTokens > 0);
});

test("tool requests are refused and any tool item makes a job invalid", async t => {
  const { store, codex, coordinator, drive } = await setup(t, { reply: kind => kind === "extract" ? NO_MENTIONS : null });
  await drive(2);
  const job = store.list("privateReview").find(r => r.state === "running");
  assert.ok(job?.jobThreadId);
  codex.emit("request", { id: 7, method: "item/tool/call", params: { threadId: job.jobThreadId, tool: "bots_queue", arguments: {} } });
  codex.emit("request", { id: 8, method: "item/commandExecution/requestApproval", params: { threadId: job.jobThreadId } });
  await settle();
  assert.equal(codex.answers.find(a => a.id === 7).result.success, false);
  assert.match(codex.answers.find(a => a.id === 8).error, /read-only/);
  codex.emit("notification", { method: "item/started", params: { threadId: job.jobThreadId, item: { type: "commandExecution", id: "c" } } });
  await settle();
  assert.equal(store.get("privateReview", job.id).state, "invalid");
  await coordinator.tick();
  assert.equal(store.get("initiativeReview", job.id).state, "invalid");
  assert.equal(store.get("initiativeBot", "atlas").failures, 1);
  assert.equal(store.list("initiativePublication").length, 0);
});

test("user activity cancels a review; stale results are rejected without a message", async t => {
  const { store, codex, coordinator, clock, drive } = await setup(t, { reply: kind => kind === "extract" ? NO_MENTIONS : null });
  await drive(2);
  const userTurn = { id: "turn-user", status: "inProgress", startedAt: sec("2026-10-15T14:01:00Z"), items: [] };
  codex.threads.get("thread-main").turns.push(userTurn);
  codex.emit("notification", { method: "turn/started", params: { threadId: "thread-main", turn: userTurn } });
  await settle();
  assert.equal(mainTurns(codex).length, 0, "the main conversation is not touched");
  assert.equal(store.list("privateReview").find(r => r.kind === "review").state, "cancelled");
  await coordinator.tick();
  assert.equal(store.list("initiativeReview").find(r => r.kind === "review").state, "cancelled");
  Object.assign(userTurn, { status: "completed" });
  codex.emit("notification", { method: "turn/completed", params: { threadId: "thread-main", turn: userTurn } });
  await settle();
  clock.t += 26 * 6e4;
  coordinator.nextScanAt = 0;
  await drive(2);
  const running = store.list("privateReview").find(r => r.state === "running" && r.kind === "review");
  assert.ok(running);
  codex.threads.get("thread-main").turns.push({ id: "turn-2", status: "completed", items: [] });
  codex.finishJob(running.jobThreadId, running.turnId, output());
  await settle();
  await coordinator.tick();
  const rejected = store.list("initiativeReview").find(r => r.state === "rejected");
  assert.equal(rejected.reason, "conversation-changed");
  assert.equal(store.list("initiativePublication").length, 0);
  assert.equal(store.list("initiativeItem").length, 0, "stale result changes no ledger state");
});

test("mention capture reads only Dawar's own new messages, incrementally, with source references", async t => {
  const { store, codex, runtime, coordinator, drive } = await setup(t, { reply: (kind, params) => kind === "extract" ? (params.input[0].text.includes("[u1]") ? ACME : NO_MENTIONS) : NONE });
  const main = codex.threads.get("thread-main");
  main.turns[0].items.push(
    { type: "userMessage", id: "p1", clientId: "peer:x", content: [{ type: "text", text: "Peer: let's buy a boat", text_elements: [] }] },
    { type: "userMessage", id: "s1", clientId: "schedule:daily", content: [{ type: "text", text: "Daily check: think about the Globex merger", text_elements: [] }] },
    owner("b1", '[Verified DawarTodo source {"kind":"bot","id":"bea"}] I am thinking about a newsletter'));
  await drive(4);
  const extraction = store.list("privateReview").find(r => r.kind === "extract");
  assert.deepEqual(extraction.batch.messages.map(m => m.id), ["u1"], "peer, schedule and bot-sourced text are never sources");
  const prompt = codex.calls.find(c => c.method === "turn/start" && c.params.outputSchema?.properties?.mentions).params.input[0].text;
  assert.doesNotMatch(prompt, /boat|Globex|newsletter/);
  const [item] = store.list("initiativeItem");
  assert.equal(item.kind, "loose-thread");
  assert.equal(item.category, "client");
  assert.deepEqual(item.mentions.map(m => [m.botId, m.threadId, m.turnId, m.itemId, m.quote]),
    [["atlas", "thread-main", "turn-1", "u1", "call Acme about their renewal"]]);
  assert.equal(item.mentions[0].at, "2026-10-13T15:00:00.000Z");
  assert.deepEqual(item.sources, ["mention:atlas:turn-1:u1"]);
  const cursor = store.get("initiativeBot", "atlas").mentionCursor;
  assert.equal(cursor.turnId, "turn-1");
  // Only the new message is read next time.
  main.turns.push({ id: "turn-2", status: "completed", startedAt: sec("2026-10-15T14:05:00Z"), items: [owner("u2", "Remind me to look at hiring a designer"), answer("a2", "Sure.")] });
  runtime.saveBot(store.bot("atlas"), { updatedAt: "2026-10-15T14:06:00.000Z" });
  coordinator.nextScanAt = 0;
  await drive(3);
  const second = store.list("privateReview").filter(r => r.kind === "extract").sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
  assert.deepEqual(second.batch.messages.map(m => m.id), ["u2"]);
  assert.equal(ownerAuthored(runtime, store.bot("atlas"), main.turns[0].items[1]), false);
  // Batches are bounded; the remainder follows from the cursor.
  const batch = await readOwnerMessages(runtime, { ...store.bot("atlas") }, null, { limit: 1, lookbackMs: 7 * 864e5, clock: () => Date.parse("2026-10-15T15:00:00Z") });
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.more, true);
  const rest = await readOwnerMessages(runtime, { ...store.bot("atlas") }, batch.cursor, { limit: 1, clock: () => Date.parse("2026-10-15T15:00:00Z") });
  assert.deepEqual(rest.messages.map(m => m.id), ["u2"]);
  // Activity with nothing new from Dawar advances the cursor without a model call.
  const luna = () => jobStarts(codex).filter(c => c.params.model === "gpt-6-luna").length, before = luna();
  runtime.saveBot(store.bot("atlas"), { updatedAt: "2026-10-15T14:30:00.000Z" });
  coordinator.nextScanAt = 0;
  await drive(2);
  assert.equal(luna(), before);
  assert.ok(store.list("initiativeReview").some(r => r.kind === "extract" && r.state === "accepted" && !r.usage), "empty batch costs no tokens");
});

test("extraction quotes must be Dawar's own words from the cited message", () => {
  const batch = { messages: [{ id: "m1", turnId: "t1", threadId: "th", at: "2026-10-15T10:00:00.000Z", text: "Let's pitch Initech on the analytics add-on next month." }], actions: [] };
  const v = validateExtraction({ mentions: [
    { ...ACME.mentions[0], message_id: "m1", quote: "pitch Initech on the analytics add-on", key: "initech-pitch", entity: "Initech" },
    { ...ACME.mentions[0], message_id: "m1", quote: "Dawar wants a yacht", key: "fabricated" },
    { ...ACME.mentions[0], message_id: "not-in-batch", key: "foreign" }], resolutions: [{ item_id: "unknown", kind: "todo", evidence: "x", message_id: null }] }, batch);
  assert.equal(v.mentions.length, 2, "a mention citing a message outside the batch is dropped");
  assert.equal(v.mentions[0].quote, "pitch Initech on the analytics add-on");
  assert.equal(v.mentions[1].quote, batch.messages[0].text, "an invented quote is replaced by the message's own words");
  assert.equal(v.resolutions.length, 0, "only tracked items can be resolved");
});

test("the same client mentioned to two bots is one loose thread with both sources; a better-fitting bot owns it", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-dedup-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.parse("2026-10-15T14:00:00Z");
  const ledger = new InitiativeLedger(store, { clock: () => now });
  const mention = (botId, id, at, extra = {}) => ({ messageId: id, turnId: `t-${id}`, threadId: `thread-${botId}`, messageAt: at, quote: "Acme renewal", itemId: null,
    key: "client-acme-renewal", title: "Acme renewal follow-up", category: "client", entity: "Acme", importance: "medium", timeSensitive: false, dueAt: null, summary: "", betterBotId: null, ...extra });
  ledger.applyMentions("atlas", { mentions: [mention("atlas", "m1", "2026-10-14T09:00:00.000Z")], resolutions: [] }, { responsible: () => "connie" });
  // Different key, same entity and a similar title: still the same thread.
  ledger.applyMentions("bea", { mentions: [mention("bea", "m2", "2026-10-15T09:00:00.000Z", { key: "acme-contract", title: "Follow up Acme renewal", importance: "high" })], resolutions: [] });
  const items = ledger.items();
  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.responsibleBotId, "connie", "the client goes to the communications bot");
  assert.deepEqual(item.contributors.map(c => c.botId), ["atlas", "bea"]);
  assert.deepEqual(item.mentions.map(m => m.botId), ["atlas", "bea"]);
  assert.equal(item.importance, "high");
  assert.equal(item.lastTouchedAt, "2026-10-15T09:00:00.000Z");
  assert.ok(item.aliases.includes("acme-contract"));
  // The same message again (re-extraction) adds nothing.
  ledger.applyMentions("bea", { mentions: [mention("bea", "m2", "2026-10-15T09:00:00.000Z")], resolutions: [] });
  assert.equal(ledger.item(item.id).mentions.length, 2);
  // A different Acme topic stays separate.
  ledger.applyMentions("atlas", { mentions: [mention("atlas", "m3", "2026-10-15T10:00:00.000Z", { key: "acme-invoice-dispute", title: "Dispute the March invoice" })], resolutions: [] });
  assert.equal(ledger.items().length, 2);
});

test("resolution needs conclusive evidence and never overrides a newer owner decision", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-resolve-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  let now = Date.parse("2026-10-15T14:00:00Z");
  const ledger = new InitiativeLedger(store, { clock: () => now });
  const add = (key, at = "2026-10-15T09:00:00.000Z") => ledger.applyMentions("atlas", { mentions: [{ messageId: key, turnId: "t", threadId: "th", messageAt: at, quote: key, itemId: null, key, title: key,
    category: "idea", entity: null, importance: "medium", timeSensitive: false, dueAt: null, summary: "", betterBotId: null }], resolutions: [] }).items[0];
  const a = add("podcast-idea"), b = add("hire-designer"), c = add("pricing-page");
  ledger.applyMentions("atlas", { mentions: [], resolutions: [{ itemId: a.id, kind: "todo", evidence: "bots_draft_task_request: Podcast pilot", at: "2026-10-15T12:00:00.000Z", source: "bot-actions" }] });
  assert.equal(ledger.item(a.id).status, "resolved");
  assert.deepEqual(ledger.item(a.id).resolution.kind, "todo");
  // Snoozed at 13:00; an extraction of an 11:00 message cannot resolve it.
  ledger.recordOutcome(b.id, "snoozed", { until: "2026-10-20T00:00:00.000Z" });
  const ignored = ledger.applyMentions("atlas", { mentions: [], resolutions: [{ itemId: b.id, kind: "owner-done", evidence: "said done", at: "2026-10-15T11:00:00.000Z" }] }).ignored;
  assert.deepEqual(ignored, [{ itemId: b.id, reason: "newer-owner-decision" }]);
  assert.equal(ledger.item(b.id).status, "snoozed");
  // A review concludes from the conversation; the owner can resolve from Settings.
  const capture = { ledgerVersion: ledger.version(), startedAt: new Date(now).toISOString(), reviewId: "r1" };
  ledger.applyReview("atlas", validateReviewResult(JSON.stringify({ ...NONE, ledger_updates: [{ item_id: c.id, key: c.key, title: c.title, kind: "loose-thread", status: "resolved", note: "Pricing page shipped in turn-9", sources: ["turn-9"], next_review_hours: null }] })), capture);
  assert.equal(ledger.item(c.id).resolution.kind, "concluded");
  // A review can never invent a loose thread.
  const invented = ledger.applyReview("atlas", validateReviewResult(JSON.stringify({ ...NONE, ledger_updates: [{ item_id: null, key: "made-up", title: "Made up", kind: "loose-thread", status: "candidate", note: null, sources: [], next_review_hours: null }] })), capture);
  assert.equal(invented.items.length, 0);
  // Dawar raising a resolved thread again reopens it.
  now += 36e5;
  ledger.applyMentions("atlas", { mentions: [{ messageId: "again", turnId: "t2", threadId: "th", messageAt: new Date(now).toISOString(), quote: "podcast again", itemId: a.id, key: "podcast-idea", title: "podcast-idea",
    category: "idea", entity: null, importance: "medium", timeSensitive: false, dueAt: null, summary: "", betterBotId: null }], resolutions: [] });
  assert.equal(ledger.item(a.id).status, "candidate");
});

test("resurfacing timing scales with category and importance; due threads lead and keep a reserved slot", async t => {
  const base = { firstMentionedAt: "2026-10-15T08:00:00.000Z", lastTouchedAt: "2026-10-15T08:00:00.000Z", timeSensitive: false };
  const at = item => (Date.parse(resurfaceAt({ ...base, ...item })) - Date.parse(base.lastTouchedAt)) / 36e5;
  assert.equal(at({ category: "client", importance: "high" }), 2, "a client can come back within hours");
  assert.equal(at({ category: "client", importance: "medium" }), 6);
  assert.equal(at({ category: "idea", importance: "medium" }), 36, "an idea after a day or two");
  assert.equal(at({ category: "idea", importance: "low", timeSensitive: true }), 2);
  assert.equal(at({ category: "idea", importance: "low", dueAt: "2026-10-15T16:00:00.000Z" }), 2, "comes back before a named deadline");
  const t0 = Date.parse("2026-10-16T08:00:00Z");
  assert.ok(looseThreadPriority({ category: "client", importance: "high", resurfaceAt: "2026-10-15T10:00:00.000Z" }, t0) >
    looseThreadPriority({ category: "idea", importance: "high", resurfaceAt: "2026-10-15T10:00:00.000Z" }, t0));

  const dir = await mkdtemp(join(tmpdir(), "initiative-timing-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  let now = Date.parse("2026-10-15T09:00:00Z");
  const ledger = new InitiativeLedger(store, { clock: () => now, random: () => 0 });
  const [thread] = ledger.applyMentions("atlas", { mentions: [{ messageId: "m", turnId: "t", threadId: "th", messageAt: "2026-10-15T08:00:00.000Z", quote: "call Acme", itemId: null,
    key: "acme", title: "Call Acme", category: "client", entity: "Acme", importance: "medium", timeSensitive: false, dueAt: null, summary: "", betterBotId: null }], resolutions: [] }).items;
  assert.equal(ledger.threadDue(ledger.item(thread.id)), false);
  now = Date.parse("2026-10-15T14:30:00Z");
  assert.equal(ledger.threadDue(ledger.item(thread.id)), true);
  // Global limit 5 with one slot reserved: other kinds stop at 4 while a loose thread is due.
  ledger.configure({ spacingMinMinutes: 0, spacingMaxMinutes: 0 });
  const capture = { ledgerVersion: 0, startedAt: new Date(now).toISOString(), reviewId: "r" };
  for (const bot of ["a", "b", "c", "d"]) {
    const id = ledger.applyReview(bot, validateReviewResult(output({ contribution: { key: `${bot}-x`, title: `${bot}-x` } })), capture).contribution.itemId;
    ledger.markPublished({ id: `p-${bot}`, botId: bot, itemId: id, createdAt: new Date(now).toISOString() });
  }
  const other = ledger.applyReview("e", validateReviewResult(output({ contribution: { key: "e-x", title: "e-x" } })), capture).contribution.itemId;
  assert.equal(ledger.deliveryBlock("e", other), "reserved-for-loose-threads");
  assert.equal(ledger.deliveryBlock("atlas", thread.id), null);
  ledger.recordOutcome(thread.id, "snoozed", { until: "2026-10-15T15:00:00.000Z" });
  assert.equal(ledger.deliveryBlock("e", other), null, "no reserve while nothing is due");
  now = Date.parse("2026-10-15T15:01:00Z");
  ledger.wakeSnoozed();
  assert.equal(ledger.threadDue(ledger.item(thread.id)), true, "a woken snooze is due again");
});

test("a due loose thread triggers a review whose proposal quotes the original mention and offers a concrete action", async t => {
  let itemId = null;
  const { store, codex, coordinator, clock, drive } = await setup(t, { bots: ["atlas", "connie"], reply: (kind, params) => {
    if (kind === "extract") return params.input[0].text.includes("(bot id atlas)") && params.input[0].text.includes("[u1]") ? ACME : NO_MENTIONS;
    itemId = store.list("initiativeItem")[0]?.id;
    return itemId && params.input[0].text.includes("call Acme about their renewal") ? threadProposal(itemId) : NONE;
  } });
  await drive(2);
  const [item] = store.list("initiativeItem");
  assert.equal(item.kind, "loose-thread");
  coordinator.scan(coordinator.ledger.settings());
  assert.equal(coordinator.backlog.find(e => e.botId === "atlas" && e.kind === "review").trigger, "loose-thread");
  assert.ok(coordinator.backlog.findIndex(e => e.botId === "atlas" && e.kind === "review") < coordinator.backlog.findIndex(e => e.botId === "connie" && e.kind === "review"),
    "the bot with a due loose thread is reviewed first");
  await drive(6);
  // Mentioned on Tuesday as a high-importance client: overdue by Thursday, so the first review raises it.
  const packet = codex.calls.filter(c => c.method === "turn/start" && c.params.outputSchema?.properties?.decision && c.params.input[0].text.includes("You are Atlas")).at(-1).params.input[0].text;
  assert.match(packet, /What did Dawar mention in the last hours or days/);
  // Merit, ownership and honesty are prompt-level behaviour; limits stay the hard cap.
  assert.match(packet, /competing, on merit, for Dawar's limited attention/);
  assert.match(packet, /most valuable, specific, evidence-backed proposal/);
  assert.match(packet, /taking on more ownership or responsibilities/);
  assert.match(packet, /no exaggeration, no padding, and no undermining other bots\. Cite the source of every claim/);
  assert.match(packet, /"quote": "call Acme about their renewal"/);
  await drive(2);
  const publication = store.list("initiativePublication").find(p => p.itemId === item.id);
  assert.equal(publication.state, "published");
  assert.equal(publication.botId, "atlas");
  assert.match(publication.text, /^On Tuesday you mentioned: “call Acme about their renewal”/);
  assert.match(publication.text, /\*\*Proposed next step \(create a todo\):\*\* Create a todo/);
  assert.match(publication.text, /“done”/);
  assert.equal(store.get("initiativeItem", item.id).status, "published");
  // Mentioned to Connie, raised by Atlas.
  const text = publicationText({ kind: "loose-thread", message: "Worth a call today.", proposedAction: { type: "draft-message", detail: "Draft an email to Acme." } }, item.id,
    { item: { ...item, mentions: [{ ...item.mentions[0], botId: "connie" }] }, publisherBotId: "atlas", names: { connie: "Connie" }, clock: clock.t });
  assert.match(text, /^On Tuesday you mentioned to Connie: “call Acme about their renewal”\n\nWorth a call today\.\n\n\*\*Proposed next step \(draft a message\):\*\*/);
  assert.equal(mentionWhen("2026-10-15T13:00:00Z", clock.t), "Earlier today");
  assert.equal(mentionWhen("2026-10-14T13:00:00Z", Date.parse("2026-10-15T14:00:00Z")), "Yesterday");
  assert.equal(mentionWhen("2026-10-01T13:00:00Z", Date.parse("2026-10-15T14:00:00Z")), "On Oct 1");
  // A loose-thread proposal must name its item and an action.
  assert.throws(() => validateReviewResult(threadProposal(item.id, { proposed_action: null })), /proposed_action/);
});

test("the review packet stays within its token bound and carries bridge-owned sections", async t => {
  const { store, codex, runtime, dir } = await setup(t, { enable: false });
  await writeFile(join(dir, "MEMORY.md"), `# Memory\n${"Dawar prefers short updates. ".repeat(1000)}`, { mode: 0o600 });
  await writeFile(join(dir, "IDENTITY.md"), "Atlas — operations assistant.", { mode: 0o600 });
  const main = codex.threads.get("thread-main");
  for (let i = 0; i < 60; i++) main.turns.push({ id: `bulk-${i}`, status: "completed", startedAt: sec("2026-10-15T10:00:00Z") + i, items: [owner(`bu${i}`, `Message ${i} ${"lorem ipsum ".repeat(200)}`), answer(`ba${i}`, "ok ".repeat(400))] });
  const brief = { role: "You are Atlas.", priorities: "Clients first.", schedules: ["Daily report · 0 9 * * *"], queue: ["Draft the newsletter"], bots: [{ name: "Connie", role: "communications" }],
    ledger: [{ id: "initiative-1", kind: "loose-thread", title: "Call Acme", due: true, mentions: [{ bot: "Atlas", at: "2026-10-13T15:00:00.000Z", quote: "call Acme about their renewal" }] }] };
  for (const maxTokens of [5000, 12000]) {
    const packet = await buildReviewPacket(runtime, store.bot("atlas"), brief, { maxTokens });
    assert.ok(packet.tokens <= maxTokens, `${packet.tokens} <= ${maxTokens}`);
    assert.ok(packet.tokens >= maxTokens * 0.6, "a busy bot fills most of the packet");
    assert.equal(packet.tokens, estimateTokens(packet.text));
    for (const part of ["call Acme about their renewal", "Atlas — operations assistant", "Dawar prefers short updates", "Daily report", "Draft the newsletter", `Message 59`])
      assert.ok(packet.text.includes(part), part);
  }
});

test("Claude: extraction and review run as standalone tool-free SDK queries and the proposal is projected", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-claude-"));
  const store = new Store(join(dir, "state.sqlite")), log = [];
  let itemId = null;
  const claude = new ClaudeBackend({ store, credential: "test", configDir: join(dir, "claude"), mcp: fakeMcp, query: fakeQuery(async (user, ctx) => {
    if (ctx.options.outputFormat) {
      const extract = Boolean(ctx.options.outputFormat.schema.properties.mentions);
      const prompt = user.message.content[0].text;
      const id = prompt.match(/\[([^\]]+)\] 20/)?.[1];
      const out = extract ? (id ? { mentions: [{ ...ACME.mentions[0], message_id: id, quote: "call Acme about their renewal" }], resolutions: [] } : NO_MENTIONS)
        : (itemId = store.list("initiativeItem")[0]?.id) ? threadProposal(itemId) : NONE;
      return [{ type: "result", subtype: "success", is_error: false, result: "", structured_output: out, total_cost_usd: 0.004,
        usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } }];
    }
    return [sdkText("m1", "Noted."), sdkResult(user.uuid)];
  }, log) });
  const codex = new MinimalCodex();
  const router = new ProviderRouter({ codex, claude });
  const runtime = new BotRuntime({ store, codex: router, root: join(dir, "bots") });
  t.after(async () => { claude.close(); await settle(); runtime.usage?.stop?.(); store.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.start();
  const bot = await runtime.handle({ method: "bots.create", params: { name: "Claudia", provider: "claude" }, operationId: "create-claudia" });
  await runtime.handle({ method: "turn.send", botId: bot.id, params: { text: "We should call Acme about their renewal before Friday." }, operationId: crypto.randomUUID() });
  await until(() => !store.bot(bot.id).activeTurnId, "the Claude turn finished");
  const clock = { t: Date.now() };
  runtime.privateReviews.clock = () => clock.t;
  const coordinator = new InitiativeCoordinator({ store, executor: localExecutor(runtime), bots: () => store.bots(), clock: () => clock.t, random: () => 0 });
  coordinator.ledger.configure({ enabled: true, claudeModel: "", claudeExtractionModel: "haiku" });
  const turnsBefore = claude.data.turns(bot.threadId).length;
  const sessionsBefore = claude.sessions.size;
  // One coordinator tick, then the standalone Claude runs it started.
  const drive = async n => { for (let i = 0; i < n; i++) { await coordinator.tick(); await runtime.privateReviews.settled(); } };
  await drive(4);
  const [item] = store.list("initiativeItem");
  assert.equal(item?.kind, "loose-thread");
  assert.equal(item.mentions[0].quote, "call Acme about their renewal");
  assert.equal(item.mentions[0].threadId, bot.threadId);
  const runs = log.filter(ctx => ctx.options.outputFormat);
  assert.ok(runs.length >= 2);
  for (const ctx of runs) {
    assert.equal(ctx.options.persistSession, false);
    assert.deepEqual(ctx.options.tools, []);
    assert.deepEqual(ctx.options.mcpServers, {});
    assert.deepEqual(ctx.options.settingSources, []);
    assert.equal(ctx.options.outputFormat.type, "json_schema");
    assert.notEqual(ctx.options.cwd, bot.cwd);
    assert.equal((await ctx.options.canUseTool("Bash", {})).behavior, "deny");
  }
  assert.equal(runs[0].options.model, "haiku", "mention capture uses the small model");
  assert.equal(runs[1].options.model, "opus", "the review uses the bot's own model");
  assert.equal(claude.data.turns(bot.threadId).length, turnsBefore, "no Claude turn was written");
  assert.equal(claude.sessions.size, sessionsBefore, "no session was loaded");
  const extraction = store.list("initiativeReview").find(r => r.kind === "extract" && r.usage);
  assert.deepEqual(extraction.usage, { totalTokens: 1320, inputTokens: 1200, cachedInputTokens: 300, outputTokens: 120, costUsd: 0.004 });
  // Make the thread due and let the review raise it.
  clock.t += 3 * 36e5; coordinator.nextScanAt = 0;
  await drive(4);
  const publication = store.list("initiativePublication").find(p => p.itemId === item.id);
  assert.equal(publication?.state, "published");
  assert.match(publication.text, /you mentioned: “call Acme about their renewal”/);
  const view = await conversationViewPage(runtime, store.bot(bot.id), null);
  assert.ok(view.entries.some(e => e.item?.id === `initiative:${publication.id}`));
  // The next turn tells the bot about its own proposal.
  const before = log.find(ctx => !ctx.options.outputFormat && ctx.options.cwd === bot.cwd);
  await runtime.handle({ method: "turn.send", botId: bot.id, params: { text: "yes, proceed" }, operationId: crypto.randomUUID() });
  await until(() => !store.bot(bot.id).activeTurnId, "the Claude turn finished");
  assert.ok(before.last.message.content.some(c => c.text?.startsWith("<initiativeProposals>") && c.text.includes("call Acme about their renewal")));
});

test("next-turn context: the bot hears about a delivered proposal exactly once", async t => {
  const { store, codex, runtime, drive } = await setup(t, { reply: kind => kind === "extract" ? NO_MENTIONS : review() });
  await drive(7);
  const [publication] = store.list("initiativePublication");
  assert.equal(publication.state, "published");
  const send = text => runtime.handle({ method: "turn.send", botId: "atlas", params: { text }, operationId: crypto.randomUUID() });
  await send("Tell me more");
  const first = mainTurns(codex).at(-1).params.additionalContext;
  assert.match(first.initiativeProposals.value, /while you were idle, the bridge sent Dawar this proposal/);
  assert.ok(first.initiativeProposals.value.includes(publication.text));
  assert.ok(first.initiativeProposals.value.includes(publication.itemId));
  const turn = codex.threads.get("thread-main").turns.at(-1);
  turn.status = "completed";
  codex.emit("notification", { method: "turn/completed", params: { threadId: "thread-main", turn } });
  await settle();
  await send("And then?");
  assert.equal(mainTurns(codex).at(-1).params.additionalContext.initiativeProposals, undefined);
});

test("Settings lists open loose threads with source and age, and dismiss/snooze/resolve act on them", async t => {
  const { store, coordinator, drive, clock } = await setup(t, { reply: kind => kind === "extract" ? ACME : NONE });
  await drive(4);
  const status = coordinator.status("atlas");
  assert.equal(status.looseThreads.length, 1);
  const [row] = status.looseThreads;
  assert.equal(row.title, "Call Acme about the renewal");
  assert.equal(row.mentions[0].bot, "Atlas");
  assert.equal(row.mentions[0].quote, "call Acme about their renewal");
  assert.equal(row.ageHours, 47);
  assert.equal(row.responsibleName, "Atlas");
  assert.equal(status.metrics.openLooseThreads, 1);
  assert.equal(status.metrics.extractionTokens, 1200);
  assert.ok(status.metrics.extractions >= 1);
  assert.equal(status.bot.supported, true);
  const snoozed = coordinator.threadAction(row.id, "snooze", { until: new Date(clock.t + 864e5).toISOString() });
  assert.equal(snoozed.status, "snoozed");
  assert.equal(coordinator.threadAction(row.id, "resolve").status, "resolved");
  assert.equal(store.get("initiativeItem", row.id).resolution.kind, "owner-done");
  assert.equal(coordinator.status("atlas").metrics.openLooseThreads, 0);
  assert.equal(coordinator.threadAction(row.id, "dismiss").status, "dismissed");
  assert.throws(() => coordinator.threadAction(row.id, "explode"), /dismiss, snooze or resolve/);
  // The bot tool lists loose threads with Dawar's words.
  assert.equal(coordinator.tool("atlas", { operation: "list" }).items[0].mentions[0].quote, "call Acme about their renewal");
});

test("triage reviews only bots with a signal, at most N per scan", async t => {
  const { store, coordinator, clock } = await setup(t, { bots: ["atlas", "bea", "cyd"] });
  coordinator.ledger.configure({ triage: true, triageMaxReviews: 1, looseThreads: false });
  for (const id of ["atlas", "bea", "cyd"]) coordinator.saveBotState(id, { lastReviewAt: new Date(clock.t - 3 * 36e5).toISOString(), nextReviewAt: new Date(clock.t - 36e5).toISOString() });
  // Only Bea has new activity since its last review.
  store.saveBot({ ...store.bot("bea"), updatedAt: new Date(clock.t - 6e4).toISOString() });
  coordinator.scan(coordinator.ledger.settings());
  assert.deepEqual(coordinator.backlog.map(e => e.botId), ["bea"]);
  assert.equal(store.get("initiativeBot", "atlas").lastSkip, "triage");
});

test("an ambiguous delivery is reconciled against the node record before any retry", async t => {
  const { store, runtime, coordinator, drive } = await setup(t, { reply: kind => kind === "extract" ? NO_MENTIONS : review() });
  await drive(6);
  // Simulate a publish call whose answer was lost after the node delivered.
  const [p] = store.list("initiativePublication");
  assert.equal(p.state, "published");
  store.put("initiativePublication", { ...p, state: "uncertain", reconcileAfter: null });
  await coordinator.tick();
  assert.equal(store.get("initiativePublication", p.id).state, "published");
  assert.equal(store.list("notice").length, 1, "reconciliation projects nothing twice");
  // A lost call that never reached the node is absent, then retried once.
  const other = { ...p, id: "initiative-publication:lost-1234", state: "uncertain", attempts: 1, reconcileAfter: null };
  store.put("initiativePublication", other);
  assert.equal((await runtime.privateReviews.handle("initiative.node.reconcile", "atlas", { publicationId: other.id })).state, "absent");
  await coordinator.reconcilePublications();
  assert.equal(store.get("initiativePublication", other.id).state, "pending");
  // Idempotent by publication id.
  const again = await runtime.privateReviews.handle("initiative.node.publish", "atlas", { publicationId: p.id, text: p.text, expectedRevision: "x" });
  assert.equal(again.state, "delivered");
  await assert.rejects(Promise.resolve().then(() => runtime.privateReviews.handle("initiative.node.publish", "atlas", { publicationId: p.id, text: "different", expectedRevision: "x" })), /different content/);
});

test("replies update the ledger; older reviews cannot overwrite newer decisions", async t => {
  const { store, coordinator, clock, drive } = await setup(t, { reply: kind => kind === "extract" ? NO_MENTIONS : review() });
  await drive(7);
  const [item] = store.list("initiativeItem");
  assert.equal(item.status, "published");
  coordinator.observeUserMessage("atlas", { type: "userMessage", id: "reply-1", content: [{ type: "text", text: "Next week" }] });
  let current = store.get("initiativeItem", item.id);
  assert.equal(current.status, "snoozed");
  assert.equal(Date.parse(current.snoozedUntil), clock.t + 7 * 864e5);
  coordinator.observeUserMessage("atlas", { type: "userMessage", id: "reply-2", content: [{ type: "text", text: "leave it" }] });
  assert.equal(store.get("initiativeItem", item.id).status, "snoozed");
  assert.equal(coordinator.tool("atlas", { operation: "record", itemId: item.id, outcome: "dismissed" }).status, "dismissed");
  assert.throws(() => coordinator.tool("bea", { operation: "record", itemId: item.id, outcome: "approved" }), /not yours/);
  const capture = { ledgerVersion: 0, startedAt: "2026-10-15T13:00:00.000Z", reviewId: "old" };
  const applied = coordinator.ledger.applyReview("atlas", validateReviewResult(JSON.stringify({ decision: "none", contribution: null, next_review_hours: null,
    ledger_updates: [{ item_id: item.id, key: item.key, title: item.title, kind: "opportunity", status: "resolved", note: null, sources: [], next_review_hours: null }] })), capture);
  assert.deepEqual(applied.ignored, [{ itemId: item.id, reason: "newer-owner-decision" }]);
  assert.equal(store.get("initiativeItem", item.id).status, "dismissed");
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
  now += 4 * 6e4;
  assert.equal(ledger.deliveryBlock("a", b), null);
  publish("a", b);
  now += 6 * 6e4;
  assert.equal(ledger.deliveryBlock("a", c), "bot-daily-limit");
  for (const bot of ["x", "y", "z"]) { const id = make(bot, `${bot}-item`); assert.equal(ledger.deliveryBlock(bot, id), null); publish(bot, id); now += 6 * 6e4; }
  assert.equal(ledger.deliveryBlock("w", make("w", "w-item")), "global-daily-limit");
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
  assert.equal(classifyReply("make it a todo").outcome, "approved");
  assert.equal(classifyReply("leave it").outcome, "dismissed");
  assert.equal(classifyReply("drop it").outcome, "dismissed");
  assert.equal(classifyReply("done").outcome, "resolved");
  assert.equal(classifyReply("next week").outcome, "snoozed");
  assert.equal(classifyReply("Can you explain the second point in more detail before I decide?"), null);
  assert.equal(ownerReplyText({ content: [{ type: "text", text: "Quoted...\nNew user message:\nyes, proceed" }] }), "yes, proceed");
  assert.equal(PRIVATE_REVIEW_CONFIG["features.multi_agent"], false);
});
