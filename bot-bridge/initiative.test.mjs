import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { BotRuntime } from "./runtime.mjs";
import { managedExecutionParams, PRIVATE_REVIEW } from "./execution-access.mjs";
import { readSettings, configureSettings, upgradeSettings, validateThought, mergeLoops, nextThinkDelay, inQuietHours, quietEndsAt, localTime } from "./mind.mjs";
import { InitiativeCoordinator, localExecutor } from "./initiative-coordinator.mjs";
import { claudeNearLimit, pushPreview } from "./initiative-node.mjs";
import { recentConversation } from "./initiative-packet.mjs";
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
    { id: "turn-1", status: "completed", startedAt: sec("2026-10-15T13:00:00Z"), itemsView: "full", items: [
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
        const kind = params.outputSchema?.properties?.thought ? "think" : "speak";
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

const QUIET = { thought: "Acme renewal is on Friday; nothing scheduled yet, but it's only Thursday morning.", loops: [{ id: null, title: "Acme renewal call", status: "open", note: "before Friday" }],
  decision: "quiet", message: null, check_back_minutes: null };
const SPEAK = { thought: "Friday is close and the Acme call still isn't on his calendar; worth a nudge.", loops: [{ id: null, title: "Acme renewal call", status: "raised", note: "asked him to book it" }],
  decision: "speak", message: "The Acme renewal is Friday and there's no call booked yet. Want me to put a 20-minute slot on your calendar for tomorrow morning?", check_back_minutes: null };
const SPOKEN = { message: "Quick one: the Acme renewal is Friday and nothing's booked. Shall I hold 20 minutes tomorrow at 9 for the call?" };
const thinkReply = (thought = QUIET, speech = SPOKEN) => kind => kind === "think" ? thought : speech;

async function setup(t, { bots = ["atlas"], reply = thinkReply(), enable = true, at = "2026-10-15T14:00:00Z" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "mind-test-"));
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
  const clock = { t: Date.parse(at) };
  runtime.privateReviews.clock = () => clock.t;
  const coordinator = new InitiativeCoordinator({ store, executor: localExecutor(runtime), bots: () => store.bots(), clock: () => clock.t, random: () => 0 });
  if (enable) coordinator.ledger.configure({ enabled: true });
  // One coordinator tick, then every job reply and node finish it caused.
  const drive = async (n = 4) => { for (let i = 0; i < n; i++) { await coordinator.tick(); await codex.settled(); await runtime.privateReviews.settled(); } };
  return { dir, store, codex, runtime, coordinator, clock, drive };
}
const jobStarts = codex => codex.calls.filter(c => c.method === "thread/start" && c.params.ephemeral);
const jobTurns = codex => codex.calls.filter(c => c.method === "turn/start" && c.params.threadId.startsWith("job-"));
const mainTurns = codex => codex.calls.filter(c => c.method === "turn/start" && c.params.threadId === "thread-main");
const kinds = store => store.list("initiativeReview").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(r => `${r.kind}:${r.state}`);
const journal = (store, botId = "atlas") => store.list("mindEntry", botId).sort((a, b) => a.at.localeCompare(b.at));

test("settings: off by default, light thinking models, and older settings keep only what still applies", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mind-off-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const d = readSettings(store);
  assert.equal(d.enabled, false);
  assert.deepEqual([d.model, d.claudeModel, d.effort, d.speakWithBotModel], ["gpt-6-luna", "haiku", "medium", true]);
  assert.deepEqual([d.activeMinutes, d.idleMinutes, d.nightMinutes, d.quietStart, d.quietEnd, d.timeZone], [30, 60, 180, "21:00", "08:00", "America/Toronto"]);
  // A version 2 review-system record: on/off, coverage, switches and priorities survive; nothing else.
  store.meta("initiative-settings", { version: 2, enabled: true, coverage: "selected", priorities: "Clients first", revision: 7, baselineMinutes: 360, looseThreads: true,
    perBotDaily: 9, bots: { pilot: { enabled: true, baselineMinutes: 60, priorities: "Acme" } } });
  const s = readSettings(store);
  assert.deepEqual([s.enabled, s.coverage, s.priorities, s.revision, s.perBotDaily], [true, "selected", "Clients first", 7, 4]);
  assert.equal(s.messagesEnabled, false, "upgrading starts with messages paused: a test run");
  assert.equal(d.messagesEnabled, true);
  assert.deepEqual(s.bots, { pilot: { enabled: true, priorities: "Acme" } });
  assert.equal("baselineMinutes" in s || "looseThreads" in s, false);
  assert.deepEqual(upgradeSettings({ version: 3, enabled: true }), { version: 3, enabled: true });
  configureSettings(store, { quietStart: "22:30", activeMinutes: 20 }, 7);
  assert.equal(readSettings(store).revision, 8);
  assert.throws(() => configureSettings(store, { quietStart: "late" }), /21:00/);
  assert.throws(() => configureSettings(store, { looseThreads: true }), /Unknown/);
  assert.throws(() => configureSettings(store, { enabled: false }, 1), /changed elsewhere/);
  configureSettings(store, { enabled: false });
  const calls = [];
  const coordinator = new InitiativeCoordinator({ store, bots: () => [{ id: "b", threadId: "t" }], executor: new Proxy({}, { get: (_, k) => (...a) => { calls.push(k); return { idle: true }; } }) });
  await coordinator.tick();
  assert.deepEqual(calls.filter(k => k !== "placement"), []);
});

test("a bot thinks privately on a light model, keeps a journal and loops, and stays quiet when nothing is worth saying", async t => {
  const { store, codex, coordinator, clock, drive } = await setup(t);
  const eventsBefore = store.cursor();
  await drive(3);
  assert.deepEqual(kinds(store), ["think:accepted"]);
  const [job] = jobStarts(codex);
  assert.equal(job.params.ephemeral, true);
  assert.equal(job.params.sandbox, "read-only");
  assert.equal(job.params.approvalPolicy, "never");
  assert.equal(job.params.model, "gpt-6-luna", "thinking uses the light model, not the bot's own");
  for (const server of ["codex_manager", "bot_desktop", "linux_computer_use", "bot_desktop_linus"]) assert.equal(job.params.config[`mcp_servers.${server}`].enabled, false);
  assert.notEqual(job.params.cwd, store.bot("atlas").cwd, "jobs run outside the bot workspace");
  const [turn] = jobTurns(codex);
  assert.equal(turn.params.sandboxPolicy.type, "readOnly");
  const prompt = turn.params.input[0].text;
  assert.match(prompt, /You are Atlas/);
  assert.match(prompt, /We should call Acme/, "it reads its own recent conversation");
  assert.match(prompt, /Your earlier thoughts[^\n]*\n\(none\)/, "no thoughts yet");
  assert.match(prompt, /It is Thursday, Oct 15, 10:00 AM/, "it knows the local day and time");
  assert.equal(mainTurns(codex).length, 0, "the main conversation is never touched");
  assert.equal(codex.calls.filter(c => c.method === "thread/fork").length, 0);
  assert.equal(store.replay(eventsBefore).filter(e => JSON.stringify(e).includes("job-")).length, 0, "job events never reach chat");
  const [entry] = journal(store);
  assert.equal(entry.thought, QUIET.thought);
  assert.equal(entry.decision, "quiet");
  assert.equal(store.list("initiativePublication").length, 0);
  const state = coordinator.botState("atlas");
  assert.deepEqual(state.loops.map(l => [l.title, l.status]), [["Acme renewal call", "open"]]);
  // Ordinary rhythm: an hour, jittered (random 0 → 75%), since no conversation in the last 3 hours.
  assert.equal(Date.parse(state.nextThinkAt) - clock.t, 45 * 6e4);
  await drive(2);
  assert.equal(jobStarts(codex).length, 1, "not due yet");
  // The next thought builds on the last one, and keeps the loop's id.
  const loopId = state.loops[0].id;
  codex.reply = kind => kind === "think" ? { ...QUIET, thought: "Still quiet on Acme; I'll raise it after lunch if nothing moves.", loops: [{ id: loopId, title: "Acme renewal call", status: "open", note: "watch it" }], check_back_minutes: 120 } : null;
  clock.t += 46 * 6e4;
  await drive(3);
  const second = jobTurns(codex).at(-1).params.input[0].text;
  assert.match(second, /Your earlier thoughts[\s\S]*Acme renewal is on Friday; nothing scheduled yet/);
  assert.match(second, new RegExp(`\\[${loopId}\\] Acme renewal call — open`));
  assert.equal(coordinator.botState("atlas").loops.length, 1, "the same loop, updated");
  assert.equal(Date.parse(coordinator.botState("atlas").nextThinkAt) - clock.t, 120 * 6e4, "it asked to think again in two hours");
  assert.equal(store.list("initiativeReview").find(r => r.kind === "think").usage.totalTokens, 1200);
});

test("deciding to speak: the bot's own model writes the message, delivered as its ordinary message with a push", async t => {
  const { store, codex, runtime, coordinator, drive } = await setup(t, { reply: thinkReply(SPEAK) });
  const eventsBefore = store.cursor();
  await drive(4);
  assert.deepEqual(kinds(store), ["think:accepted", "speak:accepted"]);
  const [, speak] = jobStarts(codex);
  assert.equal(speak.params.model, "gpt-6.1-sol", "the message is written with the bot's own model");
  const speakPrompt = jobTurns(codex).at(-1).params.input[0].text;
  assert.match(speakPrompt, /What you were just thinking\n.*worth a nudge/);
  assert.match(speakPrompt, /rough draft\)\n.*no call booked yet/);
  const [p] = store.list("initiativePublication");
  assert.equal(p.state, "published");
  assert.equal(p.text, SPOKEN.message);
  assert.equal(p.draft, SPEAK.message);
  // A projection only: no native write, no model turn.
  assert.equal(codex.calls.filter(c => c.method === "thread/inject_items").length, 0);
  assert.equal(mainTurns(codex).length, 0);
  const notices = store.list("notice");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, "Atlas");
  assert.match(notices[0].body, /^Quick one: the Acme renewal is Friday/);
  assert.match(store.bot("atlas").preview, /Acme renewal/);
  assert.ok(store.replay(eventsBefore).some(e => JSON.stringify(e).includes(`initiative:${p.id}`)));
  const view = await conversationViewPage(runtime, store.bot("atlas"), null);
  assert.ok(view.entries.some(e => e.item?.id === `initiative:${p.id}`));
  const [entry] = journal(store);
  assert.deepEqual([entry.messageState, entry.message], ["delivered", SPOKEN.message]);
  assert.equal(coordinator.botState("atlas").loops[0].status, "raised");
  // The next thought sees what it said.
  codex.reply = thinkReply(QUIET);
  coordinator.saveBotState("atlas", { nextThinkAt: coordinator.at() });
  await drive(3);
  assert.match(jobTurns(codex).at(-1).params.input[0].text, /You said to Dawar: “Quick one: the Acme renewal/);
  assert.match(jobTurns(codex).at(-1).params.input[0].text, /Messages you sent him on your own\n- .*Quick one/);
});

test("with the bot's own model off, the thought's message goes out as written; a failed rewrite falls back to it", async t => {
  const { store, codex, coordinator, drive } = await setup(t, { reply: thinkReply(SPEAK, "not json") });
  coordinator.ledger.configure({ speakWithBotModel: false });
  await drive(3);
  assert.deepEqual(kinds(store), ["think:accepted"]);
  assert.equal(store.list("initiativePublication")[0].text, SPEAK.message);
  // Rewrite on, but it fails: the draft is sent.
  coordinator.ledger.configure({ speakWithBotModel: true });
  coordinator.saveBotState("atlas", { nextThinkAt: coordinator.at() });
  coordinator.store.meta("initiative-next-delivery-at", null);
  await drive(4);
  const second = store.list("initiativePublication").sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  assert.ok(kinds(store).includes("speak:invalid"));
  assert.equal(second.text, SPEAK.message);
  assert.ok(second.draftError);
  assert.ok(jobStarts(codex).length >= 3);
});

test("quiet hours: a bot thinks overnight at a slower rhythm, and what it decides waits for the morning", async t => {
  // 02:00 in Toronto.
  const { store, coordinator, clock, drive } = await setup(t, { reply: thinkReply(SPEAK), at: "2026-10-16T06:00:00Z" });
  await drive(4);
  const [p] = store.list("initiativePublication");
  assert.equal(p.state, "held");
  assert.equal(p.reason, "quiet-hours");
  assert.equal(store.list("notice").length, 0, "no push at night");
  assert.equal(Date.parse(coordinator.botState("atlas").nextThinkAt) - clock.t, 135 * 6e4, "overnight rhythm: 3 hours, jittered");
  assert.match(store.list("initiativeReview")[0].kind, /think/);
  const s = coordinator.settings();
  assert.equal(inQuietHours(clock.t, s), true);
  assert.equal(localTime(quietEndsAt(clock.t, s), s.timeZone), "Friday, Oct 16, 8:00 AM");
  // 08:00: it goes out (within the 12-hour window), without thinking again first.
  coordinator.ledger.configure({ nightMinutes: 600 });
  clock.t = Date.parse("2026-10-16T12:00:00Z");
  await drive(1);
  assert.equal(store.get("initiativePublication", p.id).state, "published");
});

test("Dawar writing first: a thought in progress is kept but not spoken, and a queued message is dropped", async t => {
  const { store, codex, coordinator, clock, drive } = await setup(t, { reply: kind => kind === "think" ? null : SPOKEN });
  await drive(2);
  const running = store.list("privateReview").find(r => r.state === "running");
  clock.t += 1000;
  coordinator.observeUserMessage("atlas", owner("u-late", "actually, I booked Acme already"));
  codex.finishJob(running.jobThreadId, running.turnId, JSON.stringify(SPEAK));
  await settle();
  await drive(1);
  const [entry] = journal(store);
  assert.equal(entry.thought, SPEAK.thought, "the thought is kept");
  assert.deepEqual([entry.messageState, entry.reason], ["withheld", "owner-spoke"]);
  assert.equal(store.list("initiativePublication").length, 0);
  assert.equal(Date.parse(coordinator.botState("atlas").nextThinkAt) - clock.t, 5 * 6e4, "it thinks again soon, with his message in view");
  // A message already queued is dropped when he writes before it goes out.
  coordinator.store.meta("initiative-next-delivery-at", new Date(clock.t + 36e5).toISOString());
  codex.reply = thinkReply(SPEAK);
  clock.t += 6 * 6e4;
  await drive(4);
  const [queued] = store.list("initiativePublication");
  assert.equal(queued.state, "held");
  assert.equal(queued.reason, "spacing");
  clock.t += 1000;
  coordinator.observeUserMessage("atlas", owner("u-2", "and one more thing"));
  await drive(1);
  assert.deepEqual([store.get("initiativePublication", queued.id).state, store.get("initiativePublication", queued.id).reason], ["abandoned", "owner-spoke"]);
  assert.equal(journal(store).at(-1).messageState, "dropped");
  assert.equal(store.list("notice").length, 0);
  // Schedules, peers and notices are not Dawar writing.
  const before = coordinator.botState("atlas").lastOwnerMessageAt;
  coordinator.observeUserMessage("atlas", { type: "userMessage", id: "s", clientId: "schedule:daily", content: [] });
  assert.equal(coordinator.botState("atlas").lastOwnerMessageAt, before);
});

test("pacing: a random gap between any two messages, per-bot and total daily caps, one delivery per tick", async t => {
  const { store, coordinator, clock, drive } = await setup(t, { bots: ["atlas", "bea", "cy"], reply: thinkReply(SPEAK) });
  coordinator.ledger.configure({ spacingMinMinutes: 10, spacingMaxMinutes: 10, perBotDaily: 1, globalDaily: 2, concurrency: 3 });
  await drive(5);
  const published = () => store.list("initiativePublication").filter(p => p.state === "published");
  assert.equal(published().length, 1);
  assert.ok(store.list("initiativePublication").filter(p => p.state === "held").every(p => p.reason === "spacing"));
  clock.t += 9 * 6e4; await drive(1);
  assert.equal(published().length, 1, "still inside the gap");
  clock.t += 2 * 6e4; await drive(1);
  assert.equal(published().length, 2);
  clock.t += 11 * 6e4; await drive(1);
  assert.equal(published().length, 2, "total daily cap");
  assert.equal(store.list("initiativePublication").find(p => p.state === "held").reason, "daily-limit");
  assert.equal(coordinator.status("atlas").metrics.messagesToday, 2);
  // The thought knows how many it can still send.
  const sender = published()[0].botId;
  assert.equal(coordinator.brief(store.bot(sender), coordinator.settings()).remaining, 0);
});

test("a busy bot thinks privately; its message waits until it is free", async t => {
  const { store, codex, runtime, coordinator, drive } = await setup(t, { reply: thinkReply(SPEAK) });
  runtime.saveBot(store.bot("atlas"), { activeTurnId: "turn-live", status: "running" });
  await drive(5);
  assert.deepEqual(kinds(store), ["think:accepted", "speak:accepted"]);
  assert.equal(mainTurns(codex).length, 0);
  const [p] = store.list("initiativePublication");
  assert.equal(p.state, "held");
  runtime.saveBot(store.bot("atlas"), { activeTurnId: null, status: "idle" });
  await drive(2);
  assert.equal(store.get("initiativePublication", p.id).state, "published");
  // With thinking-while-busy off, a busy bot waits and the skip is recorded.
  coordinator.ledger.configure({ reviewWhileBusy: false });
  runtime.saveBot(store.bot("atlas"), { activeTurnId: "turn-live", status: "running" });
  coordinator.saveBotState("atlas", { nextThinkAt: coordinator.at() });
  const starts = jobStarts(codex).length;
  await drive(1);
  assert.equal(jobStarts(codex).length, starts);
  assert.equal(coordinator.botState("atlas").lastSkip, "not-idle");
});

test("tool requests are refused and any tool item makes a thought invalid", async t => {
  const { store, codex, coordinator, drive } = await setup(t, { reply: () => null });
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
  assert.equal(coordinator.botState("atlas").failures, 1);
  assert.ok(Date.parse(coordinator.botState("atlas").backoffUntil) > coordinator.clock());
  assert.equal(journal(store).length, 0);
});

test("thought validation repairs small slips; loops merge by id and closed ones are kept a week", () => {
  const id = () => "loop-new";
  const v = validateThought(JSON.stringify({ thought: "  hmm  ", loops: [{ id: "loop-x", title: "Keep", status: "open", note: "" }, { id: "made-up", title: "New", status: "weird", note: "" }],
    decision: "speak", message: "", check_back_minutes: 0 }), { newId: id, knownLoops: [{ id: "loop-x" }] });
  assert.deepEqual([v.thought, v.decision, v.message, v.checkBackMinutes], ["hmm", "quiet", null, null], "speak without a message becomes quiet");
  assert.deepEqual(v.loops.map(l => [l.id, l.status]), [["loop-x", "open"], ["loop-new", "open"]]);
  const m = validateThought({ thought: "say it", loops: [], decision: "speak", message: "Hi Dawar.\n\n_Ref initiative-123: reply yes_", check_back_minutes: 90 });
  assert.equal(m.message, "Hi Dawar.");
  assert.equal(m.checkBackMinutes, 90);
  assert.throws(() => validateThought("{\"thought\":\"\"}"), /empty/);
  const at = "2026-10-15T14:00:00.000Z";
  const merged = mergeLoops([{ id: "a", title: "A", status: "open", createdAt: "2026-10-01T00:00:00Z" }, { id: "b", title: "B", status: "open" }],
    [{ id: "a", title: "A", status: "raised", note: "asked" }, { id: "c", title: "C", status: "done", note: "" }], at);
  assert.deepEqual(merged.map(l => [l.id, l.status]), [["a", "raised"], ["b", "open"], ["c", "done"]].sort((x, y) => (x[1] === "done") - (y[1] === "done")));
  assert.equal(merged.find(l => l.id === "a").raisedAt, at);
  assert.equal(merged.find(l => l.id === "a").createdAt, "2026-10-01T00:00:00Z");
  const later = mergeLoops(merged, [], "2026-10-23T14:00:00.000Z");
  assert.equal(later.some(l => l.id === "c"), false, "a closed loop is forgotten after a week");
  const s = { ...readSettings({ meta: () => null }) };
  assert.equal(nextThinkDelay(s, { now: Date.parse(at), lastConversationAt: "2026-10-15T13:30:00Z", random: () => 0.5 }), 30 * 6e4, "right after a conversation");
  assert.equal(nextThinkDelay(s, { now: Date.parse(at), checkBackMinutes: 5 }), 15 * 6e4, "never sooner than 15 minutes");
  assert.equal(nextThinkDelay(s, { now: Date.parse(at), checkBackMinutes: 5000 }), 24 * 36e5, "never later than a day");
});

test("the bot's tool reads its own mind and notes what Dawar settled; Think now and status", async t => {
  const { store, coordinator, clock, drive } = await setup(t);
  await drive(3);
  const [loop] = coordinator.botState("atlas").loops;
  const read = coordinator.tool("atlas", { operation: "read" });
  assert.equal(read.thoughts[0].thought, QUIET.thought);
  assert.equal(read.loops[0].id, loop.id);
  clock.t += 6e4;
  coordinator.tool("atlas", { operation: "note", loopId: loop.id, status: "done", note: "Dawar booked the Acme call himself." });
  assert.equal(coordinator.botState("atlas").loops[0].status, "done");
  assert.equal(journal(store).at(-1).kind, "note");
  assert.throws(() => coordinator.tool("atlas", { operation: "note", loopId: "nope", status: "done" }), /not in your mind/);
  assert.throws(() => coordinator.tool("atlas", { operation: "note" }), /Write a note/);
  const status = coordinator.thinkNow("atlas");
  assert.equal(Date.parse(coordinator.botState("atlas").nextThinkAt), clock.t);
  assert.equal(status.bot.journal.length, 2);
  assert.equal(status.bot.journal[0].kind, "note", "newest first");
  assert.equal(status.bots[0].lastThought, QUIET.thought);
  assert.equal(status.metrics.thoughtsToday, 1);
});

test("messages paused: bots keep thinking and journal what they would have said; nothing is sent", async t => {
  const { store, codex, coordinator, drive } = await setup(t, { reply: thinkReply(SPEAK) });
  coordinator.ledger.configure({ messagesEnabled: false });
  await drive(4);
  assert.deepEqual(kinds(store), ["think:accepted"], "no rewrite while paused");
  assert.match(jobTurns(codex)[0].params.input[0].text, /Messages are paused right now/);
  const [entry] = journal(store);
  assert.deepEqual([entry.decision, entry.messageState, entry.reason, entry.message], ["speak", "withheld", "paused", SPEAK.message]);
  assert.equal(store.list("initiativePublication").length, 0);
  assert.equal(store.list("notice").length, 0);
});

test("messages queued by the earlier review system are retired, never sent", async t => {
  const { store, drive } = await setup(t);
  store.put("initiativePublication", { id: "initiative-publication:legacy-1", botId: "atlas", itemId: "initiative-x", text: "Old proposal", state: "pending", createdAt: "2026-10-15T13:59:00.000Z" });
  await drive(2);
  assert.deepEqual([store.get("initiativePublication", "initiative-publication:legacy-1").state, store.get("initiativePublication", "initiative-publication:legacy-1").reason],
    ["abandoned", "replaced-by-inner-monologue"]);
  assert.equal(store.list("notice").length, 0);
});

test("next-turn context: the bot hears about what it said on its own exactly once", async t => {
  const { store, codex, runtime, drive } = await setup(t, { reply: thinkReply(SPEAK) });
  await drive(4);
  const [publication] = store.list("initiativePublication");
  assert.equal(publication.state, "published");
  const send = text => runtime.handle({ method: "turn.send", botId: "atlas", params: { text }, operationId: crypto.randomUUID() });
  await send("Yes please");
  const first = mainTurns(codex).at(-1).params.additionalContext;
  assert.match(first.initiativeProposals.value, /you sent Dawar this message on your own \(from your inner monologue\)/);
  assert.ok(first.initiativeProposals.value.includes(publication.text));
  const turn = codex.threads.get("thread-main").turns.at(-1);
  turn.status = "completed";
  codex.emit("notification", { method: "turn/completed", params: { threadId: "thread-main", turn } });
  await settle();
  await send("And then?");
  assert.equal(mainTurns(codex).at(-1).params.additionalContext.initiativeProposals, undefined);
});

test("an ambiguous delivery is reconciled against the node record before any retry", async t => {
  const { store, runtime, coordinator, drive } = await setup(t, { reply: thinkReply(SPEAK) });
  await drive(4);
  const [p] = store.list("initiativePublication");
  assert.equal(p.state, "published");
  store.put("initiativePublication", { ...p, state: "uncertain", reconcileAfter: null });
  await coordinator.tick();
  assert.equal(store.get("initiativePublication", p.id).state, "published");
  assert.equal(store.list("notice").length, 1, "reconciliation projects nothing twice");
  const other = { ...p, id: "initiative-publication:lost-1234", state: "uncertain", attempts: 1, reconcileAfter: null };
  store.put("initiativePublication", other);
  assert.equal((await runtime.privateReviews.handle("initiative.node.reconcile", "atlas", { publicationId: other.id })).state, "absent");
  await coordinator.reconcilePublications();
  assert.equal(store.get("initiativePublication", other.id).state, "pending");
  const again = await runtime.privateReviews.handle("initiative.node.publish", "atlas", { publicationId: p.id, text: p.text, expectedRevision: "x" });
  assert.equal(again.state, "delivered");
  await assert.rejects(Promise.resolve().then(() => runtime.privateReviews.handle("initiative.node.publish", "atlas", { publicationId: p.id, text: "different", expectedRevision: "x" })), /different content/);
});

test("Claude: thinking and speaking run as standalone tool-free SDK queries, and the message is projected", async t => {
  const dir = await mkdtemp(join(tmpdir(), "mind-claude-"));
  const store = new Store(join(dir, "state.sqlite")), log = [];
  const claude = new ClaudeBackend({ store, credential: "test", configDir: join(dir, "claude"), mcp: fakeMcp, query: fakeQuery(async (user, ctx) => {
    if (ctx.options.outputFormat) {
      const out = ctx.options.outputFormat.schema.properties.thought ? SPEAK : SPOKEN;
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
  // Midday in Toronto, outside quiet hours.
  const clock = { t: Date.parse("2026-10-15T16:00:00Z") };
  runtime.privateReviews.clock = () => clock.t;
  const coordinator = new InitiativeCoordinator({ store, executor: localExecutor(runtime), bots: () => store.bots(), clock: () => clock.t, random: () => 0 });
  coordinator.ledger.configure({ enabled: true });
  const turnsBefore = claude.data.turns(bot.threadId).length, sessionsBefore = claude.sessions.size;
  const drive = async n => { for (let i = 0; i < n; i++) { await coordinator.tick(); await runtime.privateReviews.settled(); } };
  await drive(4);
  const runs = log.filter(ctx => ctx.options.outputFormat);
  assert.equal(runs.length, 2);
  for (const ctx of runs) {
    assert.equal(ctx.options.persistSession, false);
    assert.deepEqual(ctx.options.tools, []);
    assert.deepEqual(ctx.options.mcpServers, {});
    assert.deepEqual(ctx.options.settingSources, []);
    assert.notEqual(ctx.options.cwd, bot.cwd);
    assert.equal((await ctx.options.canUseTool("Bash", {})).behavior, "deny");
  }
  assert.equal(runs[0].options.model, "haiku", "thinking uses the light model");
  assert.equal(runs[0].options.effort, undefined, "Haiku has no reasoning-effort levels, so none is passed");
  assert.equal(runs[1].options.model, "opus", "the message is written with the bot's own model");
  assert.equal(claude.data.turns(bot.threadId).length, turnsBefore, "no Claude turn was written");
  assert.equal(claude.sessions.size, sessionsBefore, "no session was loaded");
  assert.deepEqual(store.list("initiativeReview").find(r => r.kind === "think").usage, { totalTokens: 1320, inputTokens: 1200, cachedInputTokens: 300, outputTokens: 120, costUsd: 0.004 });
  const [publication] = store.list("initiativePublication");
  assert.equal(publication.state, "published");
  assert.equal(publication.text, SPOKEN.message);
  const view = await conversationViewPage(runtime, store.bot(bot.id), null);
  assert.ok(view.entries.some(e => e.item?.id === `initiative:${publication.id}`));
});

test("recent conversation: the last 72 hours of high-level exchange only", async t => {
  const { store, codex, runtime, clock } = await setup(t, { enable: false });
  codex.threads.get("thread-main").turns.unshift({ id: "turn-old", status: "completed", startedAt: (clock.t - 5 * 864e5) / 1000, items: [owner("u-old", "an ancient request"), answer("a-old", "ok")] });
  codex.threads.get("thread-main").turns.push({ id: "turn-new", status: "completed", startedAt: (clock.t - 36e5) / 1000, items: [owner("u-new", "a fresh request"), answer("a-new", "on it")] });
  const before = codex.calls.length;
  const text = await recentConversation(runtime, store.bot("atlas"), 20000, { hours: 72, clock: () => clock.t });
  assert.match(text, /Dawar: a fresh request\nYou: on it/);
  assert.doesNotMatch(text, /ancient request/);
  const reads = codex.calls.slice(before).filter(c => c.method === "thread/turns/list");
  assert.ok(reads.length && reads.every(c => c.params.itemsView === "summary"), "summary view: no tool payloads");
});

test("pushes carry the message itself; Claude thinking pauses near the subscription limit", () => {
  assert.equal(pushPreview("**Quick nudge** on **the vendor quote** — they owe us pricing.\n\nMore detail."), "Quick nudge on the vendor quote — they owe us pricing.");
  assert.equal(pushPreview("x".repeat(400)).length, 180);
  const router = rateLimits => ({ claude: { usage: () => ({ rateLimits }) } });
  assert.equal(claudeNearLimit(router([{ status: "allowed", utilization: 0.85 }]), 80), true);
  assert.equal(claudeNearLimit(router([{ status: "allowed", utilization: 0.5 }]), 80), false);
  assert.equal(claudeNearLimit(router([{ status: "rejected" }]), 80), true);
  assert.equal(claudeNearLimit({}, 80), false);
});
