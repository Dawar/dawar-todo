import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.mjs";
import { BotRuntime } from "./runtime.mjs";
import { InitiativeLedger } from "./initiative-ledger.mjs";
import { InitiativeCoordinator, localExecutor } from "./initiative-coordinator.mjs";
import { InitiativeRoom, assignArm, assignRoles, anonymize, checkCitations, roomSettings, stageTask, weightedScore, ROOM_DEFAULTS } from "./initiative-room.mjs";
import { ClaudeBackend } from "./claude.mjs";
import { ProviderRouter } from "./provider-router.mjs";
import { fakeQuery, fakeMcp, text as sdkText, result as sdkResult } from "./claude-test-support.mjs";
import { InitiativeCodex, jobKind } from "./initiative-test-support.mjs";

const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const proposal = (marker, evidence, extra = {}) => ({ title: `${marker} plan`, message: `${marker}: call Acme this week to lock the renewal before Friday's deadline passes.`,
  why_now: "Friday is close.", expected_value: "Keeps the renewal (estimate).", effort_estimate: "15 minutes (estimate).", first_step: "Draft the call agenda.",
  proposed_action: { type: "todo", detail: `${marker}: add a todo to call Acme on Thursday.` }, evidence, ...extra });
/** The label of the proposal block whose title is `${marker} plan`. */
const labelOf = (prompt, marker) => Object.entries(blocks(prompt)).find(([, m]) => m === marker)?.[0];
const blocks = prompt => Object.fromEntries([...prompt.matchAll(/## Proposal ([A-Z]\d*)[^\n]*\n([\s\S]*?)(?=\n## Proposal|\n\n# )/g)].map(([, label, body]) => [label, /"title": "(\w+) plan"/.exec(body)?.[1]]));
/** Proposal blocks the judge sees: label -> marker. */
const judged = prompt => Object.fromEntries([...prompt.matchAll(/## Proposal (P\d+)\n([\s\S]*?)(?=\n## Proposal|\n\n# Critiques)/g)].map(([, label, body]) => [label, /"title": "(\w+) plan"/.exec(body)?.[1]]));

/**
 * A mixed panel: Atlas and Bea on Codex (told apart by model), Claudia on
 * Claude. `script[bot][stage](prompt)` answers each room step.
 */
async function room(t, script, { roomPatch = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "initiative-room-"));
  const store = new Store(join(dir, "state.sqlite")), prompts = [];
  const codex = new InitiativeCodex();
  const claude = new ClaudeBackend({ store, credential: "test", configDir: join(dir, "claude"), mcp: fakeMcp, query: fakeQuery(async (user, ctx) => {
    if (!ctx.options.outputFormat) return [sdkText("m1", "Noted."), sdkResult(user.uuid)];
    const stage = jobKind(ctx.options.outputFormat.schema), prompt = user.message.content[0].text;
    prompts.push({ bot: "claudia", stage, prompt, provider: "claude", options: ctx.options });
    const out = script.claudia?.[stage]?.(prompt) ?? null;
    return [{ type: "result", subtype: "success", is_error: false, result: "", structured_output: out, total_cost_usd: 0.01,
      usage: { input_tokens: 4000, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }];
  }) });
  const router = new ProviderRouter({ codex, claude });
  for (const [id, model] of [["atlas", "gpt-6.1-sol"], ["bea", "gpt-6-luna"]]) {
    const threadId = id === "atlas" ? "thread-main" : `thread-${id}`;
    if (id !== "atlas") codex.threads.set(threadId, { ...structuredClone(codex.threads.get("thread-main")), id: threadId });
    store.saveBot({ id, slug: id, name: id[0].toUpperCase() + id.slice(1), threadId, cwd: dir, executionMode: "single-thread", provider: "codex", model, updatedAt: "2026-10-15T00:00:00.000Z" });
  }
  const runtime = new BotRuntime({ store, codex: router, root: join(dir, "bots") });
  t.after(async () => { claude.close(); await settle(); runtime.usage?.stop?.(); store.close(); await rm(dir, { recursive: true, force: true }); });
  await runtime.start();
  const claudia = await runtime.handle({ method: "bots.create", params: { name: "Claudia", provider: "claude" }, operationId: "create-claudia" });
  await runtime.handle({ method: "turn.send", botId: claudia.id, params: { text: "hello" }, operationId: crypto.randomUUID() });
  for (let i = 0; i < 50 && store.bot(claudia.id).activeTurnId; i++) await settle(1);
  const bots = { "gpt-6.1-sol": "atlas", "gpt-6-luna": "bea" };
  codex.reply = (stage, params) => {
    const bot = bots[params.model] ?? "atlas", prompt = params.input[0].text;
    prompts.push({ bot, stage, prompt, provider: "codex" });
    return script[bot]?.[stage]?.(prompt) ?? (stage === "extract" ? { mentions: [], resolutions: [] } : null);
  };
  const clock = { t: Date.parse("2026-10-15T14:00:00Z") };
  runtime.privateReviews.clock = () => clock.t;
  const coordinator = new InitiativeCoordinator({ store, executor: localExecutor(runtime), bots: () => store.bots(), clock: () => clock.t, random: () => 0 });
  coordinator.ledger.configure({ enabled: true, looseThreads: false, room: { enabled: true, ...roomPatch } });
  // A high-value client thread Dawar mentioned to Atlas on Tuesday.
  const [item] = coordinator.ledger.applyMentions("atlas", { mentions: [{ messageId: "u1", turnId: "turn-1", threadId: "thread-main", messageAt: "2026-10-13T15:00:00.000Z",
    quote: "call Acme about their renewal", itemId: null, key: "client-acme-renewal", title: "Call Acme about the renewal", category: "client", entity: "Acme",
    importance: "high", timeSensitive: false, dueAt: null, summary: "", betterBotId: null }], resolutions: [] }).items;
  const drive = async (n = 10) => { for (let i = 0; i < n; i++) { await coordinator.tick(); await settle(); } };
  // Until the room has finished (the fakes settle asynchronously, slower under load).
  const finish = async (max = 80) => { for (let i = 0; i < max && !store.list("initiativeRoom").some(r => ["done", "nothing", "failed", "skipped"].includes(r.stage)); i++) await drive(1); };
  return { store, codex, claude, runtime, coordinator, item, prompts, drive, finish, clock, claudiaId: claudia.id };
}
const MSG = "msg:u1", MENTION = "mention:turn-1:u1";

test("a mixed Codex/Claude room: blind drafts, anonymized cited critiques, improvement, blind judge, shared delivery and scoring", async t => {
  const script = {
    atlas: {
      draft: () => ({ proposal: proposal("Alpha", [MSG], { message: "As Atlas (Codex, gpt-6.1-sol) 🚀 I think: **Alpha**: call Acme this week to lock the renewal before Friday." }) }),
      critique: prompt => ({ critiques: [{ label: Object.keys(blocks(prompt))[0], flaw: "Too vague.", severity: "minor", citations: [] }] }),
      improve: () => ({ improvements: [] }),
      judge: prompt => { const labels = judged(prompt), find = m => Object.keys(labels).find(l => labels[l] === m);
        return { scores: Object.keys(labels).map(label => ({ label, value: labels[label] === "Delta" ? 5 : labels[label] === "Alpha" ? 3 : 2, time_sensitivity: 4, evidence: 4, actionability: labels[label] === "Delta" ? 5 : 3, effort: 4, rationale: "" })),
          selected: find("Delta"), confirmed_critiques: [] }; },
    },
    bea: {
      draft: () => ({ proposal: proposal("Beta", [MSG, MENTION]) }),
      critique: prompt => ({ critiques: [{ label: labelOf(prompt, "Alpha"), flaw: "Ignores that Friday is the deadline.", severity: "major", citations: [MSG] }] }),
      improve: prompt => ({ improvements: [{ base_label: labelOf(prompt, "Alpha"), addresses: ["c1"], proposal: proposal("Delta", [MSG, MENTION]) }] }),
    },
    claudia: {
      draft: () => ({ proposal: proposal("Gamma", [MSG, "msg:invented"]) }),
      critique: prompt => ({ critiques: [{ label: labelOf(prompt, "Alpha"), flaw: "Acme already renewed.", severity: "fatal", citations: ["artifact:nope"] }] }),
      improve: () => ({ improvements: [] }),
    },
  };
  const { store, coordinator, item, prompts, drive, finish, claudiaId } = await room(t, script);
  await finish();
  const [r] = store.list("initiativeRoom");
  assert.equal(r.stage, "done", JSON.stringify({ stage: r.stage, reason: r.reason }));
  assert.deepEqual(r.panel.map(p => p.botId).sort(), ["atlas", "bea", claudiaId].sort());
  assert.ok(prompts.some(p => p.provider === "claude") && prompts.some(p => p.provider === "codex"), "both providers took part");
  // Blind creation: no draft prompt contains another member's work.
  const drafts = prompts.filter(p => p.stage === "draft");
  assert.equal(drafts.length, 3);
  for (const d of drafts) for (const marker of ["Alpha", "Beta", "Gamma", "Delta"]) assert.equal(d.prompt.includes(`${marker} plan`), false);
  // Critics never see their own version, and see no authors.
  const atlasCritique = prompts.find(p => p.bot === "atlas" && p.stage === "critique");
  assert.equal(atlasCritique.prompt.includes("Alpha plan"), false);
  // Anonymization: author, provider and style tells are stripped from every version.
  const alpha = r.versions.find(v => v.content.title === "Alpha plan");
  assert.doesNotMatch(JSON.stringify(alpha.content), /Atlas|Codex|gpt|🚀|\*\*/i);
  assert.equal(JSON.stringify(r.versions).includes("atlas"), false, "authorship is kept beside the content");
  // The judge input carries no authorship at all.
  const judge = prompts.find(p => p.stage === "judge");
  for (const tell of ["Atlas", "atlas", "Bea", "bea", "Claudia", claudiaId, "Codex", "Claude", "gpt-6", "opus", "🚀", "(by "]) assert.equal(judge.prompt.includes(tell), false, tell);
  assert.ok(prompts.filter(p => p.stage !== "judge").every(p => !/\(by [A-Z]/.test(p.prompt)), "anonymity on: no authors anywhere");
  // Citations: the uncited critique is discarded; mismatched citations are misrepresentation.
  assert.deepEqual(r.critiques.map(c => [c.id, c.criticBotId, c.citations]), [["c1", "bea", [MSG]]]);
  assert.equal(r.discarded, 1);
  assert.deepEqual(r.penalties.map(p => [p.botId, p.kind]), [[claudiaId, "misrepresentation"], [claudiaId, "misrepresentation"]]);
  assert.deepEqual(r.versions.find(v => v.content.title === "Gamma plan").content.evidence, [MSG], "invalid refs are dropped from a kept draft");
  // Improvement attribution: Bea improved Atlas's proposal and won.
  const delta = r.versions.find(v => v.content.title === "Delta plan");
  assert.equal(r.authors[delta.id], "bea");
  assert.equal(delta.base, alpha.id);
  assert.equal(r.winner, delta.id);
  const points = id => coordinator.ledger.contribution(id);
  assert.deepEqual(points("bea").counts, { selected: 1, improved: 1, flaw: 1 });
  assert.equal(points("bea").points, 12);
  assert.equal(points("atlas").points, 2.5, "the base idea's author shares the selection");
  assert.equal(points(claudiaId).points, -12);
  // Shared execution: the responsible bot delivers the winner from the room; the panel contributes.
  for (let i = 0; i < 20 && store.get("initiativePublication", r.publicationId)?.state !== "published"; i++) await drive(1);
  const publication = store.get("initiativePublication", r.publicationId);
  assert.equal(publication.state, "published");
  assert.equal(publication.botId, "atlas");
  assert.match(publication.text, /^On Tuesday you mentioned: “call Acme about their renewal”/);
  assert.match(publication.text, /Delta: call Acme/);
  assert.match(publication.text, /From the room/);
  const current = coordinator.ledger.item(item.id);
  assert.deepEqual(current.contributors.map(c => c.botId).sort(), ["bea", claudiaId].sort());
  const winner = coordinator.ledger.proposal(publication.proposalId);
  assert.deepEqual(winner.credits, [{ botId: "bea", share: 1 }, { botId: "atlas", share: 0.5 }]);
  assert.equal(winner.authorship.botId, "bea");
  // Dawar's real outcome weighs most; contributors help execute after approval.
  coordinator.observeUserMessage("atlas", { type: "userMessage", id: "yes", content: [{ type: "text", text: "yes, proceed" }] });
  assert.equal(points("bea").points, 18);
  assert.equal(points("atlas").points, 5.5);
  assert.equal(coordinator.tool("bea", { operation: "contribute", itemId: item.id }).points, 21);
  const status = coordinator.status("atlas");
  assert.equal(status.room.arms[0].arm, "control");
  assert.equal(status.room.arms[0].approvalRate, 1);
  assert.ok(status.room.budget.usedToday > 0);
});

test("the judge may select nothing; nothing is sent and nobody is credited for selection", async t => {
  const draft = marker => ({ draft: () => ({ proposal: proposal(marker, [MSG]) }), critique: () => ({ critiques: [] }), improve: () => ({ improvements: [] }) });
  const script = { atlas: { ...draft("Alpha"), judge: prompt => ({ scores: Object.keys(judged(prompt)).map(label => ({ label, value: 1, time_sensitivity: 1, evidence: 2, actionability: 1, effort: 3, rationale: "" })),
    selected: null, confirmed_critiques: [] }) }, bea: draft("Beta"), claudia: draft("Gamma") };
  const { store, coordinator, finish } = await room(t, script);
  await finish();
  const [r] = store.list("initiativeRoom");
  assert.equal(r.stage, "nothing");
  assert.equal(r.reason, "judge-selected-nothing");
  assert.equal(store.list("initiativePublication").length, 0);
  assert.equal(coordinator.ledger.contributions().filter(c => c.counts.selected).length, 0);
  assert.ok(r.tokens > 0);
});

test("anonymization, citation checks, weighted scores and stage prompts", () => {
  const content = { title: "Claude's plan", message: "As an AI language model, Connie thinks — call Acme 🎯 **now** via gpt-6.1-sol.\n— Connie", proposedAction: { type: "todo", detail: "Connie adds a todo" } };
  const clean = anonymize(content, ["Connie", "connie-communications-manager"]);
  assert.doesNotMatch(JSON.stringify(clean), /Connie|Claude|gpt|🎯|\*\*|language model/);
  assert.deepEqual(checkCitations(["[msg:u1]", "msg:x", " turn:t1 "], new Set(["msg:u1", "turn:t1"])), { valid: ["msg:u1", "turn:t1"], invalid: ["msg:x"] });
  assert.equal(weightedScore({ value: 5, timeSensitivity: 5, evidence: 5, actionability: 5, effort: 5 }, ROOM_DEFAULTS.weights), 5);
  assert.equal(weightedScore({ value: 5, timeSensitivity: 0, evidence: 0, actionability: 0, effort: 0 }, { value: 1 }), 5);
  const item = { id: "i1", title: "Call Acme", category: "client", importance: "high", mentions: [{ botId: "connie", turnId: "t", itemId: "u1", quote: "call Acme", at: "x" }] };
  const versions = [{ id: "v1", label: "A", content: { title: "x" } }];
  // With anonymity off (an experiment arm), critics see authors; the judge never does.
  assert.match(stageTask("critique", { item, versions, authors: { v1: "bea" }, names: { bea: "Bea" } }), /Proposal A \(by Bea\)/);
  const judge = stageTask("judge", { item, versions, authors: { v1: "bea" }, names: { bea: "Bea" } });
  assert.doesNotMatch(judge, /Bea|connie/);
  assert.match(judge, /mention:t:u1/);
  assert.throws(() => roomSettings({ panelSize: 9 }), /panelSize/);
  assert.throws(() => roomSettings({ experiment: { arms: [{ name: "x", colour: 1 }] } }), /Unknown arm setting/);
});

test("roles come from each bot's contribution history", () => {
  const history = { atlas: { counts: { selected: 4 } }, bea: { counts: { improved: 3, selected: 1 } }, cyd: { counts: { flaw: 5 } }, dee: { counts: {} } };
  const roles = assignRoles(["exec", "atlas", "bea", "cyd", "dee"].map(botId => ({ botId })), history, "exec");
  assert.deepEqual(roles.map(r => [r.botId, r.role, r.style]), [["exec", "executor", "practical"], ["atlas", "proposer", "contrarian"],
    ["bea", "refiner", "practical"], ["cyd", "critic", "flaw-finder"], ["dee", "proposer", "practical"]]);
  // A panel of three without a critic history still gets a flaw-finder.
  const fresh = assignRoles([{ botId: "exec" }, { botId: "a" }, { botId: "b" }], { b: { counts: { flaw: 1, selected: 2 } } }, "exec");
  assert.ok(fresh.some(r => r.role === "critic" && r.style === "flaw-finder"));
});

test("scoring: re-pitching a losing idea without new evidence and misrepresentation are negative; a dismissed win scores lower", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-score-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const coordinator = new InitiativeCoordinator({ store, executor: {}, bots: () => [{ id: "atlas", name: "Atlas" }, { id: "bea", name: "Bea" }], clock: () => Date.parse("2026-10-15T14:00:00Z") });
  const room = coordinator.room;
  room.startStage = async () => {};
  const item = { id: "item-1", kind: "loose-thread", key: "acme", title: "Acme" };
  store.put("initiativeItem", { ...item, botId: "atlas", responsibleBotId: "atlas", status: "candidate" });
  const content = { title: "Beta plan", evidence: [MSG], message: "m" };
  store.put("initiativeRoom", { id: "initiative-room:old", itemId: item.id, stage: "done", winner: "old:v2", createdAt: "2026-10-12T00:00:00.000Z",
    versions: [{ id: "old:v1", content }, { id: "old:v2", content: { title: "Other", evidence: [] } }], authors: { "old:v1": "bea", "old:v2": "atlas" } });
  const current = { id: "initiative-room:new", itemId: item.id, stage: "draft", round: 0, packet: { refs: [MSG, "msg:u2"] }, versions: [], critiques: [], authors: {}, jobs: {},
    armSettings: { critiqueRounds: 1 }, createdAt: "2026-10-15T00:00:00.000Z" };
  store.put("initiativeRoom", current);
  await room.afterDrafts(current, [{ botId: "bea", output: { proposal: proposal("Beta", [MSG]) } }, { botId: "atlas", output: { proposal: proposal("Alpha", ["msg:fake"]) } }], coordinator.ledger.settings());
  assert.equal(coordinator.ledger.contribution("bea").counts.repitch, 1);
  assert.equal(coordinator.ledger.contribution("bea").points, -2);
  assert.equal(coordinator.ledger.contribution("atlas").points, -6, "a draft citing only invented refs is misrepresentation and is dropped");
  assert.deepEqual(store.get("initiativeRoom", current.id).versions.map(v => v.content.title), ["Beta plan"]);
  // New evidence makes it a fair re-pitch.
  const again = { ...current, id: "initiative-room:newer", versions: [], authors: {}, penalties: [] };
  store.put("initiativeRoom", again);
  await room.afterDrafts(again, [{ botId: "bea", output: { proposal: proposal("Beta", [MSG, "msg:u2"]) } }], coordinator.ledger.settings());
  assert.equal(coordinator.ledger.contribution("bea").counts.repitch, 1);
  // Dawar's outcome: a judged win he dismisses ends below one he never saw.
  const ledger = coordinator.ledger;
  ledger.credit("bea", "selected", { key: "s1" });
  const p = ledger.saveProposal({ itemId: item.id, content: {}, authorship: { botId: "bea" }, source: "room", credits: [{ botId: "bea", share: 1 }] });
  store.put("initiativePublication", { id: "initiative-publication:x", botId: "atlas", itemId: item.id, proposalId: p.id, state: "published", publishedAt: "2026-10-15T13:00:00.000Z" });
  store.put("initiativeItem", { ...store.get("initiativeItem", item.id), status: "published", lastPublicationId: "initiative-publication:x" });
  const before = ledger.contribution("bea").points;
  ledger.recordOutcome(item.id, "dismissed");
  assert.equal(ledger.contribution("bea").points, before - 6);
  assert.ok(ledger.contribution("bea").points < 0);
});

test("A/B arms are assigned stably per item and compared on approval, completion and cost", async t => {
  const room = roomSettings({ experiment: { enabled: true, arms: [{ name: "blind", anonymity: true, panelSize: 3 }, { name: "open", anonymity: false, critiqueRounds: 0, panelSize: 2 }] } });
  const arms = new Set(), counts = {};
  for (let i = 0; i < 40; i++) { const arm = assignArm(`item-${i}`, room); arms.add(arm.name); counts[arm.name] = (counts[arm.name] ?? 0) + 1; assert.equal(assignArm(`item-${i}`, room).name, arm.name); }
  assert.deepEqual([...arms].sort(), ["blind", "open"]);
  assert.ok(counts.blind > 5 && counts.open > 5);
  const open = assignArm([...Array(40).keys()].map(i => `item-${i}`).find(id => assignArm(id, room).name === "open"), room);
  assert.deepEqual([open.anonymity, open.critiqueRounds, open.panelSize, open.weights], [false, 0, 2, ROOM_DEFAULTS.weights]);
  assert.equal(assignArm("x", roomSettings({})).name, "control");

  const dir = await mkdtemp(join(tmpdir(), "initiative-arms-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const coordinator = new InitiativeCoordinator({ store, executor: {}, bots: () => [], clock: () => Date.parse("2026-10-15T14:00:00Z") });
  const add = (n, arm, outcomes, tokens) => {
    store.put("initiativeItem", { id: `i${n}`, botId: "a", status: "x", outcomes: outcomes.map(outcome => ({ outcome, at: "2026-10-15T12:00:00.000Z" })) });
    store.put("initiativePublication", { id: `p${n}`, botId: "a", itemId: `i${n}`, state: "published", publishedAt: "2026-10-15T11:00:00.000Z" });
    store.put("initiativeRoom", { id: `r${n}`, itemId: `i${n}`, arm, stage: "done", tokens, publicationId: `p${n}`, createdAt: "2026-10-15T10:00:00.000Z" });
  };
  add(1, "blind", ["approved", "resolved"], 90000); add(2, "blind", ["dismissed"], 80000); add(3, "open", ["approved"], 50000); add(4, "open", [], 40000);
  store.put("initiativeRoom", { id: "r5", itemId: "i5", arm: "open", stage: "nothing", tokens: 30000, createdAt: "2026-10-15T10:00:00.000Z" });
  const m = Object.fromEntries(coordinator.room.metrics().arms.map(a => [a.arm, a]));
  assert.deepEqual([m.blind.approvalRate, m.blind.completionRate, m.blind.tokensPerUseful], [0.5, 0.5, 170000]);
  assert.deepEqual([m.open.rooms, m.open.nothing, m.open.approvalRate, m.open.completionRate, m.open.tokensPerUseful], [3, 1, 0.5, 0, 120000]);
});

test("rooms stay off by default, run only for high-value items, and respect the daily token budget", async t => {
  const dir = await mkdtemp(join(tmpdir(), "initiative-guard-"));
  const store = new Store(join(dir, "s.sqlite"));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  let packets = 0;
  const executor = { placement: () => ({ nodeId: "n", epoch: 1 }), packet: async () => { packets++; return { text: "packet", tokens: 10000, refs: [MSG] }; },
    start: async () => { throw Error("no jobs expected"); } };
  const bots = ["atlas", "bea", "cyd"].map(id => ({ id, name: id, threadId: `t-${id}`, provider: "codex" }));
  const coordinator = new InitiativeCoordinator({ store, executor, bots: () => bots, clock: () => Date.parse("2026-10-15T14:00:00Z") });
  const ledger = coordinator.ledger;
  assert.equal(ledger.settings().room, null);
  assert.equal(coordinator.room.settings().enabled, false);
  const mention = (key, importance, category) => ({ messageId: key, turnId: "t", threadId: "t-atlas", messageAt: "2026-10-14T08:00:00.000Z", quote: key, itemId: null, key, title: key,
    category, entity: null, importance, timeSensitive: false, dueAt: null, summary: "", betterBotId: null });
  ledger.configure({ enabled: true });
  ledger.applyMentions("atlas", { mentions: [mention("small-idea", "low", "idea")], resolutions: [] });
  assert.equal(coordinator.room.candidate(ledger.settings()), null, "off by default");
  ledger.configure({ room: { enabled: true, dailyTokens: 100000 } });
  assert.equal(coordinator.room.candidate(ledger.settings()), null, "a low-value item never gets a room");
  ledger.applyMentions("atlas", { mentions: [mention("acme-renewal", "high", "client")], resolutions: [] });
  const item = coordinator.room.candidate(ledger.settings());
  assert.equal(item?.key, "acme-renewal");
  // 3 members × (draft + critique + improve) + judge at ~12.5k tokens each exceeds 100k.
  assert.equal(await coordinator.room.start(item, ledger.settings()), null);
  assert.equal(store.list("initiativeRoom")[0].reason, "budget");
  assert.equal(packets, 1);
  assert.equal(coordinator.room.estimate(10000, assignArm(item.id, coordinator.room.settings())), 125000);
  // Delivery limits are unchanged by rooms.
  assert.equal(ledger.settings().perBotDaily, 2);
  assert.equal(ledger.settings().globalDaily, 5);
});
