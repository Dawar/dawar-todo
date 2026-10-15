import { createHash, randomUUID } from "node:crypto";
import { PROPOSED_ACTIONS, limitDay, looseThreadPriority, normalizeKey } from "./initiative-ledger.mjs";

// The writers' room: for one high-value agenda item (a due loose thread the
// triage pass ranks highly), a panel of bots works it through
//   draft    — each drafts its best proposal, blind to the others;
//   critique — each criticises the others' anonymized versions, citing packet refs;
//   improve  — each may submit an improved version of any proposal;
//   judge    — a separate call scores the anonymous final versions on a fixed
//              rubric and may select nothing.
// The best-fit bot delivers the winner "from the room"; the panel become
// contributors. Competition during discovery, cooperation after selection.
//
// Every step is an ordinary private job (kind "room") on the panelist's own
// node, provider and model, so it inherits the tool-free, hidden, bounded
// execution of reviews. Authorship never enters a judge prompt, and with
// anonymity on never enters any prompt about another bot's version.

export const ROOM_DEFAULTS = Object.freeze({
  enabled: false, panelSize: 3, anonymity: true, critiqueRounds: 1, dailyTokens: 400000, minPriority: 4.5, cooldownHours: 72,
  judgeModel: "", minScore: 2.5,
  weights: Object.freeze({ value: 3, timeSensitivity: 2, evidence: 2, actionability: 2, effort: 1 }),
  experiment: Object.freeze({ enabled: false, arms: [] }),
});
const RUBRIC = ["value", "timeSensitivity", "evidence", "actionability", "effort"];
const RUBRIC_FIELDS = { value: "value", timeSensitivity: "time_sensitivity", evidence: "evidence", actionability: "actionability", effort: "effort" };
const STAGES = ["draft", "critique", "improve", "judge"];
const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const text = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
const hashOf = value => createHash("sha256").update(String(value)).digest();

/** Validated room settings; `patch` merges into `current`. */
export function roomSettings(patch = {}, current = ROOM_DEFAULTS) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw Error("Room settings must be an object.");
  const next = { ...ROOM_DEFAULTS, ...current, weights: { ...ROOM_DEFAULTS.weights, ...current.weights }, experiment: { ...ROOM_DEFAULTS.experiment, ...current.experiment } };
  const num = (key, value, min, max, int = true) => { if (!Number.isFinite(value) || value < min || value > max) throw Error(`room.${key} must be between ${min} and ${max}.`); return int ? Math.round(value) : value; };
  const weights = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("room.weights must be an object.");
    const out = {};
    for (const [k, v] of Object.entries(value)) { if (!RUBRIC.includes(k)) throw Error(`Unknown rubric weight ${k}.`); out[k] = num(`weights.${k}`, v, 0, 10, false); }
    return out;
  };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "enabled" || key === "anonymity") { if (typeof value !== "boolean") throw Error(`room.${key} must be true or false.`); next[key] = value; }
    else if (key === "panelSize") next.panelSize = num(key, value, 2, 6);
    else if (key === "critiqueRounds") next.critiqueRounds = num(key, value, 0, 3);
    else if (key === "dailyTokens") next.dailyTokens = num(key, value, 0, 10_000_000);
    else if (key === "minPriority") next.minPriority = num(key, value, 0, 100, false);
    else if (key === "cooldownHours") next.cooldownHours = num(key, value, 1, 24 * 30, false);
    else if (key === "minScore") next.minScore = num(key, value, 0, 5, false);
    else if (key === "judgeModel") { if (typeof value !== "string" || !/^[a-zA-Z0-9._:[\]-]{0,80}$/.test(value)) throw Error("Invalid room.judgeModel."); next.judgeModel = value; }
    else if (key === "weights") next.weights = { ...next.weights, ...weights(value) };
    else if (key === "experiment") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("room.experiment must be an object.");
      const exp = { ...next.experiment };
      if ("enabled" in value) { if (typeof value.enabled !== "boolean") throw Error("room.experiment.enabled must be true or false."); exp.enabled = value.enabled; }
      if ("arms" in value) {
        if (!Array.isArray(value.arms) || value.arms.length > 4) throw Error("room.experiment.arms must be a list of at most 4 arms.");
        const names = new Set();
        exp.arms = value.arms.map(arm => {
          if (!arm || typeof arm !== "object" || !/^[a-z0-9-]{1,32}$/.test(arm.name ?? "") || names.has(arm.name)) throw Error("Each arm needs a unique lowercase name.");
          names.add(arm.name);
          const out = { name: arm.name };
          if ("panelSize" in arm) out.panelSize = num("arm.panelSize", arm.panelSize, 2, 6);
          if ("anonymity" in arm) { if (typeof arm.anonymity !== "boolean") throw Error("arm.anonymity must be true or false."); out.anonymity = arm.anonymity; }
          if ("critiqueRounds" in arm) out.critiqueRounds = num("arm.critiqueRounds", arm.critiqueRounds, 0, 3);
          if ("weights" in arm) out.weights = weights(arm.weights);
          for (const k of Object.keys(arm)) if (!["name", "panelSize", "anonymity", "critiqueRounds", "weights"].includes(k)) throw Error(`Unknown arm setting ${k}.`);
          return out;
        });
      }
      next.experiment = exp;
    } else throw Error(`Unknown room setting ${key}.`);
  }
  return next;
}

/** Stable A/B arm for an item; "control" when no experiment runs. */
export function assignArm(itemId, room) {
  const arms = room.experiment?.enabled ? room.experiment.arms ?? [] : [];
  if (!arms.length) return { name: "control", panelSize: room.panelSize, anonymity: room.anonymity, critiqueRounds: room.critiqueRounds, weights: room.weights };
  const arm = arms[hashOf(`arm:${itemId}`).readUInt32BE(0) % arms.length];
  return { name: arm.name, panelSize: arm.panelSize ?? room.panelSize, anonymity: arm.anonymity ?? room.anonymity,
    critiqueRounds: arm.critiqueRounds ?? room.critiqueRounds, weights: { ...room.weights, ...arm.weights } };
}

// ---- schemas -------------------------------------------------------------------
const nullable = schema => ({ anyOf: [schema, { type: "null" }] });
const str = { type: "string" }, strs = { type: "array", items: str };
const PROPOSAL = { type: "object", additionalProperties: false,
  required: ["title", "message", "why_now", "expected_value", "effort_estimate", "first_step", "proposed_action", "evidence"],
  properties: { title: str, message: str, why_now: str, expected_value: str, effort_estimate: str, first_step: str,
    proposed_action: { type: "object", additionalProperties: false, required: ["type", "detail"], properties: { type: { type: "string", enum: PROPOSED_ACTIONS }, detail: str } },
    evidence: strs } };
const score = { type: "number", minimum: 0, maximum: 5 };
export const ROOM_SCHEMAS = Object.freeze({
  draft: { type: "object", additionalProperties: false, required: ["proposal"], properties: { proposal: nullable(PROPOSAL) } },
  critique: { type: "object", additionalProperties: false, required: ["critiques"], properties: { critiques: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["label", "flaw", "severity", "citations"], properties: { label: str, flaw: str, severity: { type: "string", enum: ["minor", "major", "fatal"] }, citations: strs } } } } },
  improve: { type: "object", additionalProperties: false, required: ["improvements"], properties: { improvements: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["base_label", "addresses", "proposal"], properties: { base_label: str, addresses: strs, proposal: PROPOSAL } } } } },
  judge: { type: "object", additionalProperties: false, required: ["scores", "selected", "confirmed_critiques"], properties: {
    scores: { type: "array", items: { type: "object", additionalProperties: false, required: ["label", "value", "time_sensitivity", "evidence", "actionability", "effort", "rationale"],
      properties: { label: str, value: score, time_sensitivity: score, evidence: score, actionability: score, effort: score, rationale: str } } },
    selected: nullable(str), confirmed_critiques: strs } },
});

// ---- prompts ---------------------------------------------------------------------
export const ROOM_INSTRUCTIONS = `You are one member of an AI writers' room working privately for Dawar. Nothing you write is shown to him; only the room's selected proposal may later be sent, as an ordinary bot message. You have no tools. Answer with the requested JSON only.
Principle: competition during discovery, cooperation after selection. Be fiercely ambitious about the quality of your own ideas and unselfish about which idea wins.
Cite evidence only with refs that appear in the packet in square brackets (for example msg:…, turn:…, mention:…, item:…, schedule:…, artifact:…), without the brackets. A claim you cannot cite is discarded; a citation that does not match the packet counts as misrepresentation.`;
const ROLE_TEXT = {
  proposer: "Your role: proposer — bring the boldest well-grounded idea.", critic: "Your role: critic — find the real flaws others miss.",
  refiner: "Your role: refiner — turn the best idea into the most useful version.", executor: "Your role: executor — you will carry out the winner; keep it doable.",
};
const STYLE_TEXT = { contrarian: "Style: contrarian — question the obvious move.", practical: "Style: practical — favour what Dawar can act on today.", "flaw-finder": "Style: flaw-finder — rigorous about evidence and risk." };
const proposalFields = `title, message (the finished note to Dawar, in a neutral voice, without quoting his original words — the bridge adds the quote), why_now, expected_value, effort_estimate (labelled estimate), first_step, proposed_action {type: todo|draft-message|schedule|research|drop|other, detail}, evidence (packet refs)`;
/** A mention ref without the bot it was said to: rooms never name bots. */
export const neutralRef = m => `mention:${m.turnId ?? "?"}:${m.itemId}`;
function agendaText(item) {
  return `# Agenda item ${item.id}\n${item.title} (${item.category ?? item.kind}, ${item.importance ?? ""} importance)\nDawar's words: ${(item.mentions ?? []).slice(-3).map(m => `“${m.quote}” [${neutralRef(m)}] ${m.at}`).join("; ") || "(none)"}`;
}
export function versionText(versions, { authors = null, names = {} } = {}) {
  return versions.map(v => `## Proposal ${v.label}${authors?.[v.id] ? ` (by ${names[authors[v.id]] ?? authors[v.id]})` : ""}\n${JSON.stringify(v.content, null, 1)}`).join("\n\n");
}
export function stageTask(stage, { item, role, style, versions = [], critiques = [], authors = null, names = {} }) {
  const who = [ROLE_TEXT[role], STYLE_TEXT[style]].filter(Boolean).join(" ");
  if (stage === "draft") return `${agendaText(item)}\n\n# Task: draft\n${who}\nWorking alone, draft your single best proposal for this agenda item: what Dawar should do next and why now. Fields: ${proposalFields}. If nothing is worth raising, return proposal null.`;
  if (stage === "critique") return `${agendaText(item)}\n\n# Proposals from other members\n${versionText(versions, { authors, names })}\n\n# Task: critique\n${who}\nFor each proposal above, name its most important genuine flaws (wrong facts, missed evidence, weak timing, unclear action, too much effort). Every critique must cite packet refs. Return an empty list rather than an uncited or petty critique.`;
  if (stage === "improve") return `${agendaText(item)}\n\n# Proposals\n${versionText(versions, { authors, names })}\n\n# Critiques\n${critiques.map(c => `- ${c.id} on ${c.label} (${c.severity}): ${c.flaw} [${c.citations.join(", ")}]`).join("\n") || "(none)"}\n\n# Task: improve\n${who}\nYou may submit improved versions of any proposal, including other members' — whichever idea is best. Name base_label, the critique ids it addresses, and the full improved proposal (fields: ${proposalFields}). Return an empty list if nothing improves.`;
  return `${agendaText(item)}\n\n# Final proposals (anonymous)\n${versionText(versions)}\n\n# Critiques raised\n${critiques.map(c => `- ${c.id} on ${c.label} (${c.severity}): ${c.flaw} [${c.citations.join(", ")}]`).join("\n") || "(none)"}\n\n# Task: judge\nYou are the room's independent judge. Score every proposal 0–5 on: value to Dawar, time_sensitivity, evidence (checked against the packet refs), actionability, and effort (5 = least effort). Then select the single label most worth sending now, or null if nothing is worth raising. List the critique ids you confirm as genuine flaws.`;
}

// ---- anonymization -------------------------------------------------------------------
const PROVIDER_TELLS = /\b(codex|claude(?:[-\w.]*)?|openai|anthropic|chatgpt|gpt[-\w.]*|o[1-9](?:-\w+)?|opus|sonnet|haiku|fable)\b/gi;
const SELF_AI = /\bas an? (?:ai|language model|large language model|assistant)\b[^.]*\.?/gi;
/** Strip author, style and provider tells from a proposal's text fields. */
export function anonymize(content, names = []) {
  const who = names.filter(n => typeof n === "string" && n.trim().length > 1).sort((a, b) => b.length - a.length)
    .map(n => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"));
  const clean = value => {
    let s = String(value ?? "");
    for (const re of who) s = s.replace(re, "a bot");
    return s.replace(SELF_AI, "").replace(PROVIDER_TELLS, "").replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/(\*\*|__|\*|`)/g, "").replace(/^\s*[-—–]\s*\S+\s*$/gm, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  };
  const out = {};
  for (const [k, v] of Object.entries(content)) out[k] = typeof v === "string" ? clean(v) : k === "proposedAction" && v ? { ...v, detail: clean(v.detail) } : v;
  return out;
}

// ---- validation --------------------------------------------------------------------------
const ref = value => String(value ?? "").trim().replace(/^\[|\]$/g, "");
/** Split citations into packet refs and everything else. */
export function checkCitations(list, refs) {
  const valid = [], invalid = [];
  for (const c of Array.isArray(list) ? list : []) { const r = ref(c); if (!r) continue; (refs.has(r) ? valid : invalid).push(r); }
  return { valid: [...new Set(valid)], invalid };
}
function proposalContent(raw, item) {
  if (!raw || typeof raw !== "object") return null;
  const message = text(raw.message, 6000), action = raw.proposed_action;
  if (message.length < 40 || !action || !PROPOSED_ACTIONS.includes(action.type) || !text(action.detail, 1000)) return null;
  return { kind: item.kind, itemId: item.id, key: item.key, title: text(raw.title, 200) || item.title, message, whyNow: text(raw.why_now, 2000),
    expectedValue: text(raw.expected_value, 1000), effortEstimate: text(raw.effort_estimate, 500), firstStep: text(raw.first_step, 1000),
    proposedAction: { type: action.type, detail: text(action.detail, 1000) }, evidence: [], changedCircumstances: false };
}
const parse = raw => { if (raw && typeof raw === "object") return raw; try { return JSON.parse(String(raw ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return null; } };
const words = value => new Set(normalizeKey(value).split("-").filter(w => w.length > 2));
const similar = (a, b) => { const x = words(a), y = words(b), union = new Set([...x, ...y]).size; return union ? [...x].filter(w => y.has(w)).length / union : 0; };
/** Weighted rubric score (0–5) for one judged version. */
export function weightedScore(s, weights) {
  let sum = 0, total = 0;
  for (const k of RUBRIC) { const w = Number(weights[k] ?? 0), v = Number(s?.[k]); if (w > 0 && Number.isFinite(v)) { sum += w * Math.max(0, Math.min(5, v)); total += w; } }
  return total ? Math.round(sum / total * 100) / 100 : 0;
}

// ---- panels and roles ---------------------------------------------------------------------
/**
 * Roles from each bot's contribution history: the strongest category picks
 * the role (selected → proposer, improved → refiner, flaw → critic); the bot
 * that will deliver is the executor. One contrarian at most; a panel of three
 * or more always has a flaw-finder.
 */
export function assignRoles(panel, contributions, executorId) {
  const strength = (botId, kind) => contributions[botId]?.counts?.[kind] ?? 0;
  const out = panel.map(p => {
    if (p.botId === executorId) return { ...p, role: "executor", style: "practical" };
    const ranked = [["proposer", strength(p.botId, "selected") + strength(p.botId, "approved")], ["refiner", strength(p.botId, "improved")], ["critic", strength(p.botId, "flaw")]]
      .sort((a, b) => b[1] - a[1]);
    return { ...p, role: ranked[0][1] > 0 ? ranked[0][0] : "proposer" };
  });
  if (out.length >= 3 && !out.some(p => p.role === "critic")) {
    const pick = out.filter(p => p.role !== "executor").sort((a, b) => strength(b.botId, "flaw") - strength(a.botId, "flaw"))[0];
    if (pick) pick.role = "critic";
  }
  let contrarian = false;
  for (const p of out) {
    if (p.role === "executor") continue;
    if (p.role === "critic") p.style = "flaw-finder";
    else if (p.role === "refiner") p.style = "practical";
    else { p.style = contrarian ? "practical" : "contrarian"; contrarian = true; }
  }
  return out;
}

export class InitiativeRoom {
  constructor(coordinator) { this.c = coordinator; }
  get store() { return this.c.store; }
  get ledger() { return this.c.ledger; }
  at() { return this.c.at(); }
  settings(settings = this.ledger.settings()) { return roomSettings({}, settings.room ?? ROOM_DEFAULTS); }
  rooms() { return this.store.list("initiativeRoom"); }
  active() { return this.rooms().find(r => !["done", "nothing", "failed", "skipped"].includes(r.stage)) ?? null; }
  activeFor(itemId) { return this.rooms().some(r => r.itemId === itemId && !["done", "nothing", "failed", "skipped"].includes(r.stage)); }
  tokensToday(settings) {
    const today = limitDay(this.c.clock(), settings.limitTimeZone);
    return this.store.list("initiativeReview").filter(r => r.kind === "room" && limitDay(r.createdAt, settings.limitTimeZone) === today)
      .reduce((sum, r) => sum + (Number(r.usage?.totalTokens) || 0), 0);
  }
  /**
   * Triage for the room: the highest-priority due loose thread at or above
   * `minPriority`, outside its cooldown, when no room is running.
   */
  candidate(settings) {
    const room = this.settings(settings);
    if (!room.enabled || this.active()) return null;
    const t = this.c.clock(), recent = new Map();
    for (const r of this.rooms()) recent.set(r.itemId, Math.max(recent.get(r.itemId) ?? 0, Date.parse(r.createdAt)));
    return this.ledger.dueThreads(null, settings).filter(i => looseThreadPriority(i, t) >= room.minPriority && t - (recent.get(i.id) ?? 0) >= room.cooldownHours * 36e5)[0] ?? null;
  }
  /** Panel: the responsible bot, then the best contributors by record, mixing providers. */
  choosePanel(item, size, settings) {
    const bots = this.c.eligibleBots(settings), contributions = Object.fromEntries(this.ledger.contributions().map(c => [c.botId, c]));
    const score = b => (contributions[b.id]?.points ?? 0) + (item.contributors?.some(c => c.botId === b.id) ? 5 : 0);
    const pool = bots.filter(b => b.id !== item.responsibleBotId).sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    const panel = bots.filter(b => b.id === item.responsibleBotId);
    const provider = b => b.provider === "claude" ? "claude" : "codex";
    while (panel.length < size && pool.length) {
      const missing = ["codex", "claude"].find(p => !panel.some(b => provider(b) === p) && pool.some(b => provider(b) === p));
      const next = missing ? pool.find(b => provider(b) === missing) : pool[0];
      pool.splice(pool.indexOf(next), 1); panel.push(next);
    }
    return assignRoles(panel.map(b => ({ botId: b.id, provider: provider(b) })), contributions, item.responsibleBotId);
  }
  estimate(packetTokens, arm) {
    const n = arm.panelSize, calls = n + arm.critiqueRounds * 2 * n + 1;
    return Math.round(calls * (packetTokens + 2500));
  }
  /** Start a room for `item`. Returns the room, or null when it cannot run (recorded). */
  async start(item, settings) {
    const room = this.settings(settings), arm = assignArm(item.id, room), id = `initiative-room:${randomUUID()}`;
    const skip = reason => { this.store.put("initiativeRoom", { id, itemId: item.id, arm: arm.name, stage: "skipped", reason, createdAt: this.at(), finishedAt: this.at() }); return null; };
    const panel = this.choosePanel(item, arm.panelSize, settings);
    if (panel.length < 2) return skip("panel-too-small");
    const host = item.responsibleBotId;
    let packet;
    try {
      // One shared packet without any bot's identity or memory; each member adds its own.
      // The agenda item only, with neutral refs: no bot names or ids anywhere.
      const view = this.ledger.threadView(item, null, { names: {}, settings });
      const agenda = { ...view, responsibleBot: undefined, yours: undefined,
        mentions: (item.mentions ?? []).slice(-3).map(m => ({ at: m.at, quote: m.quote, ref: neutralRef(m) })) };
      packet = await this.c.executor.packet(host, { brief: { role: "This packet is shared by every member of the room.", priorities: this.ledger.botSettings(host, settings).priorities,
        ledger: [agenda], schedules: [], queue: [], bots: [], shared: true }, maxTokens: settings.packetTokens });
    } catch (error) { return skip(`packet:${error.message}`); }
    const estimate = this.estimate(packet.tokens, arm);
    if (room.dailyTokens && this.tokensToday(settings) + estimate > room.dailyTokens) return skip("budget");
    const record = this.store.put("initiativeRoom", { id, itemId: item.id, botId: host, arm: arm.name, armSettings: arm, panel, stage: "draft", round: 0,
      packet: { text: packet.text, refs: packet.refs, tokens: packet.tokens }, estimate, versions: [], critiques: [], authors: {}, jobs: {}, penalties: [], createdAt: this.at() });
    await this.startStage(record, "draft", settings);
    return this.store.get("initiativeRoom", id);
  }
  names() { const n = this.c.names(); return n; }
  /** Versions a member may see: never its own, with authors only when anonymity is off. */
  visibleTo(room, botId, versions) { return versions.filter(v => room.authors[v.id] !== botId); }
  async startStage(room, stage, settings) {
    room = { ...this.store.get("initiativeRoom", room.id), stage, stageStartedAt: this.at() };
    const arm = room.armSettings, latest = this.finalVersions(room), names = this.names();
    const members = stage === "judge" ? [{ botId: room.botId, role: "judge" }] : room.panel;
    room.jobs = { ...room.jobs };
    this.store.put("initiativeRoom", room);
    for (const member of members) {
      const shown = stage === "critique" || stage === "improve" ? (stage === "critique" ? this.visibleTo(room, member.botId, latest) : latest) : stage === "judge" ? this.judgeVersions(room) : [];
      if ((stage === "critique" || stage === "improve") && !shown.length) continue;
      const task = stageTask(stage, { item: this.ledger.item(room.itemId), role: member.role, style: member.style, versions: shown,
        critiques: stage === "draft" || stage === "critique" ? [] : stage === "judge" ? this.judgeCritiques(room) : room.critiques.map(({ criticBotId, ...c }) => c),
        authors: stage !== "judge" && !arm.anonymity ? room.authors : null, names });
      const bot = this.c.bots().find(b => b.id === member.botId), claude = bot?.provider === "claude";
      const settingsFor = stage === "judge" ? { model: this.settings(settings).judgeModel || (claude ? settings.claudeModel : settings.model), effort: settings.effort, withProfile: false }
        : { model: claude ? settings.claudeModel : settings.model, effort: settings.effort, withProfile: true };
      const reviewId = `initiative-review:${randomUUID()}`;
      const review = this.store.put("initiativeReview", { id: reviewId, botId: member.botId, kind: "room", roomId: room.id, stage, round: room.round, provider: claude ? "claude" : "codex",
        state: "starting", trigger: "room", capture: { startedAt: this.at() }, createdAt: this.at() });
      room.jobs[reviewId] = { botId: member.botId, stage, round: room.round, state: "starting" };
      this.store.put("initiativeRoom", room);
      try {
        const v = await this.c.executor.start(member.botId, { reviewId, kind: "room", brief: { ledger: [] }, expectedRevision: null,
          settings: { ...settingsFor, timeoutSeconds: settings.reviewTimeoutSeconds },
          room: { stage, instructions: ROOM_INSTRUCTIONS, packet: room.packet.text, task } });
        if (["refused", "failed"].includes(v.state)) this.c.endReview(review, v.state === "refused" ? "cancelled" : "failed", { reason: v.reason ?? null, error: v.error ?? null });
        else if (v.state === "completed") this.c.endReview(review, "accepted", { usage: v.usage ?? null, output: v.output });
        else this.store.put("initiativeReview", { ...review, state: "running" });
      } catch (error) { this.c.endReview(review, "failed", { error: error.message }); }
    }
    await this.maybeAdvance(room.id, settings);
  }
  /** A room job finished (any state). Stores its output and advances when the stage is complete. */
  async onJob(review, v, settings) {
    const state = v.state === "completed" ? "accepted" : v.state === "cancelled" ? "cancelled" : "failed";
    this.c.endReview(review, state, { usage: v.usage ?? null, output: state === "accepted" ? v.output : null, error: v.error ?? null });
    await this.maybeAdvance(review.roomId, settings);
  }
  async maybeAdvance(roomId, settings) {
    const room = this.store.get("initiativeRoom", roomId);
    if (!room || ["done", "nothing", "failed", "skipped"].includes(room.stage)) return;
    const jobs = Object.keys(room.jobs).map(id => this.store.get("initiativeReview", id)).filter(r => r && r.stage === room.stage && r.round === room.round);
    if (jobs.some(r => ["starting", "running", "uncertain"].includes(r.state))) return;
    const results = jobs.filter(r => r.state === "accepted").map(r => ({ botId: r.botId, output: parse(r.output) }));
    if (room.stage === "draft") return this.afterDrafts(room, results, settings);
    if (room.stage === "critique") return this.afterCritiques(room, results, settings);
    if (room.stage === "improve") return this.afterImprovements(room, results, settings);
    return this.afterJudge(room, results[0]?.output ?? null, settings);
  }
  penalize(room, botId, kind, note) {
    room.penalties = [...(room.penalties ?? []), { botId, kind, note }];
    this.ledger.credit(botId, kind, { itemId: room.itemId, roomId: room.id, note, key: `${kind}:${room.id}:${botId}:${room.penalties.length}` });
  }
  addVersion(room, botId, content, { base = null, stage }) {
    const refs = new Set(room.packet.refs);
    const label = LABELS[room.versions.length] ?? `X${room.versions.length}`;
    const v = { id: `${room.id}:v${room.versions.length + 1}`, label, base, stage, round: room.round,
      content: anonymize({ ...content, evidence: content.evidence.filter(r => refs.has(r)) }, this.tellNames()) };
    room.versions = [...room.versions, v];
    // Authorship lives beside the content, never in it.
    room.authors = { ...room.authors, [v.id]: botId };
    return v;
  }
  tellNames() {
    return this.c.bots().flatMap(b => [b.name, b.slug, b.id, ...(String(b.name ?? "").split(/\s+/).filter(w => w.length > 2))]).filter(Boolean);
  }
  async afterDrafts(room, results, settings) {
    const item = this.ledger.item(room.itemId), refs = new Set(room.packet.refs);
    // Shuffle so labels reveal nothing about panel order.
    const shuffled = [...results].sort((a, b) => hashOf(`${room.id}:${a.botId}`).compare(hashOf(`${room.id}:${b.botId}`)));
    for (const { botId, output } of shuffled) {
      const content = proposalContent(output?.proposal, item);
      if (!content) continue;
      const cites = checkCitations(output.proposal.evidence, refs);
      if (cites.invalid.length) { this.penalize(room, botId, "misrepresentation", `draft cited ${cites.invalid.slice(0, 3).join(", ")}`); if (!cites.valid.length) continue; }
      content.evidence = cites.valid;
      if (this.repitch(room, botId, content)) this.penalize(room, botId, "repitch", content.title);
      this.addVersion(room, botId, content, { stage: "draft" });
    }
    this.store.put("initiativeRoom", room);
    if (!room.versions.length) return this.finish(room, "nothing", { reason: "no-drafts" });
    return this.startStage(room, room.armSettings.critiqueRounds > 0 && room.versions.length > 1 ? "critique" : "judge", settings);
  }
  /** A losing idea pitched again by the same bot without any new evidence. */
  repitch(room, botId, content) {
    for (const prior of this.rooms()) {
      if (prior.id === room.id || prior.itemId !== room.itemId || !prior.versions) continue;
      for (const v of prior.versions) {
        if (prior.authors?.[v.id] !== botId || prior.winner === v.id) continue;
        if ((normalizeKey(v.content.title) === normalizeKey(content.title) || similar(v.content.title, content.title) >= 0.5) &&
            content.evidence.every(r => v.content.evidence.includes(r))) return true;
      }
    }
    return false;
  }
  async afterCritiques(room, results, settings) {
    const refs = new Set(room.packet.refs), labels = new Map(this.finalVersions(room).map(v => [v.label, v]));
    for (const { botId, output } of results) {
      for (const c of (Array.isArray(output?.critiques) ? output.critiques : []).slice(0, 6)) {
        const target = labels.get(text(c?.label, 8));
        if (!target || room.authors[target.id] === botId || !text(c.flaw, 1000)) continue;
        const cites = checkCitations(c.citations, refs);
        // Uncited claims are discarded; mismatched citations are misrepresentation.
        if (cites.invalid.length) { this.penalize(room, botId, "misrepresentation", `critique cited ${cites.invalid.slice(0, 3).join(", ")}`); continue; }
        if (!cites.valid.length) { room.discarded = (room.discarded ?? 0) + 1; continue; }
        room.critiques = [...room.critiques, { id: `c${room.critiques.length + 1}`, label: target.label, versionId: target.id, flaw: anonymize({ f: text(c.flaw, 1000) }, this.tellNames()).f,
          severity: ["minor", "major", "fatal"].includes(c.severity) ? c.severity : "minor", citations: cites.valid, round: room.round, criticBotId: botId }];
      }
    }
    this.store.put("initiativeRoom", room);
    return this.startStage(room, "improve", settings);
  }
  async afterImprovements(room, results, settings) {
    const item = this.ledger.item(room.itemId), refs = new Set(room.packet.refs), labels = new Map(this.finalVersions(room).map(v => [v.label, v]));
    for (const { botId, output } of results) {
      for (const imp of (Array.isArray(output?.improvements) ? output.improvements : []).slice(0, 2)) {
        const base = labels.get(text(imp?.base_label, 8)), content = proposalContent(imp?.proposal, item);
        if (!base || !content) continue;
        const cites = checkCitations(imp.proposal.evidence, refs);
        if (cites.invalid.length) { this.penalize(room, botId, "misrepresentation", `improvement cited ${cites.invalid.slice(0, 3).join(", ")}`); continue; }
        content.evidence = cites.valid.length ? cites.valid : base.content.evidence;
        const v = this.addVersion(room, botId, content, { base: base.id, stage: "improve" });
        v.addresses = (Array.isArray(imp.addresses) ? imp.addresses : []).filter(id => room.critiques.some(c => c.id === id));
      }
    }
    room.round += 1;
    this.store.put("initiativeRoom", room);
    return this.startStage(room, room.round < room.armSettings.critiqueRounds ? "critique" : "judge", settings);
  }
  /** Latest version of each line of improvement plus every original. */
  finalVersions(room) { return room.versions; }
  /** Fresh neutral labels for the judge; no author, base or stage. */
  judgeVersions(room) {
    const order = [...room.versions].sort((a, b) => hashOf(`judge:${room.id}:${a.id}`).compare(hashOf(`judge:${room.id}:${b.id}`)));
    room.judgeLabels = Object.fromEntries(order.map((v, i) => [`P${i + 1}`, v.id]));
    this.store.put("initiativeRoom", room);
    return order.map((v, i) => ({ id: v.id, label: `P${i + 1}`, content: anonymize(v.content, this.tellNames()) }));
  }
  judgeCritiques(room) {
    const byVersion = Object.fromEntries(Object.entries(room.judgeLabels ?? {}).map(([label, id]) => [id, label]));
    return room.critiques.map(({ criticBotId, versionId, ...c }) => ({ ...c, label: byVersion[versionId] ?? c.label }));
  }
  async afterJudge(room, judged, settings) {
    const arm = room.armSettings, byLabel = room.judgeLabels ?? {};
    const scores = {};
    for (const s of Array.isArray(judged?.scores) ? judged.scores : []) {
      const id = byLabel[text(s?.label, 8)];
      if (id) scores[id] = weightedScore(Object.fromEntries(RUBRIC.map(k => [k, s[RUBRIC_FIELDS[k]]])), arm.weights);
    }
    room.scores = scores;
    if (!judged) return this.finish(room, "failed", { reason: "judge-failed" });
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const winner = judged.selected && byLabel[judged.selected] && ranked.length && ranked[0][1] >= this.settings(settings).minScore ? ranked[0][0] : null;
    // Credit: improvements the judge preferred to their base, and confirmed flaws.
    const confirmed = new Set((Array.isArray(judged.confirmed_critiques) ? judged.confirmed_critiques : []).filter(id => room.critiques.some(c => c.id === id)));
    for (const v of room.versions.filter(v => v.base)) {
      if ((scores[v.id] ?? 0) > (scores[v.base] ?? 0)) {
        if (room.authors[v.id] !== room.authors[v.base]) this.ledger.credit(room.authors[v.id], "improved", { itemId: room.itemId, roomId: room.id, key: `improved:${room.id}:${v.id}` });
        for (const id of v.addresses ?? []) confirmed.add(id);
      }
    }
    for (const c of room.critiques) if (confirmed.has(c.id)) this.ledger.credit(c.criticBotId, "flaw", { itemId: room.itemId, roomId: room.id, key: `flaw:${room.id}:${c.id}` });
    room.confirmedCritiques = [...confirmed];
    if (!winner) return this.finish(room, "nothing", { reason: judged.selected ? "below-threshold" : "judge-selected-nothing" });
    const version = room.versions.find(v => v.id === winner), author = room.authors[winner], baseAuthor = version.base ? room.authors[version.base] : null;
    const credits = [{ botId: author, share: 1 }, ...(baseAuthor && baseAuthor !== author ? [{ botId: baseAuthor, share: 0.5 }] : [])];
    this.ledger.credit(author, "selected", { itemId: room.itemId, roomId: room.id, key: `selected:${room.id}:${author}` });
    if (baseAuthor && baseAuthor !== author) this.ledger.credit(baseAuthor, "selected", { itemId: room.itemId, roomId: room.id, share: 0.5, key: `selected:${room.id}:${baseAuthor}` });
    // Shared execution: the best-fit (responsible) bot delivers; the panel helps.
    const item = this.ledger.item(room.itemId), deliverer = item.responsibleBotId;
    this.ledger.addContributors(item.id, room.panel.map(p => p.botId).filter(id => id !== deliverer), "room");
    let probe = null;
    try { probe = await this.c.executor.probe(deliverer); } catch { probe = null; }
    const proposal = this.ledger.saveProposal({ itemId: item.id, content: version.content, source: "room", roomId: room.id, credits,
      authorship: { botId: author, roomId: room.id, versionId: version.id, base: baseAuthor, provider: room.panel.find(p => p.botId === author)?.provider ?? null } });
    const publication = probe?.revision ? this.c.publish(proposal, { botId: deliverer, revision: probe.revision, roomId: room.id }, settings) : null;
    return this.finish(room, "done", { winner, proposalId: proposal.id, publicationId: publication?.id ?? null, deliverer });
  }
  finish(room, stage, fields = {}) {
    const usage = Object.keys(room.jobs).map(id => this.store.get("initiativeReview", id)).reduce((sum, r) => sum + (Number(r?.usage?.totalTokens) || 0), 0);
    return this.store.put("initiativeRoom", { ...room, ...fields, stage, tokens: usage, finishedAt: this.at() });
  }
  /** Per-arm experiment results: approval, completion and cost per useful proposal. */
  metrics(settings = this.ledger.settings()) {
    const arms = {};
    for (const r of this.rooms().filter(r => r.stage !== "skipped")) {
      const a = arms[r.arm] ??= { arm: r.arm, rooms: 0, delivered: 0, approved: 0, completed: 0, dismissed: 0, nothing: 0, tokens: 0 };
      a.rooms++; a.tokens += Number(r.tokens) || 0;
      if (r.stage === "nothing") a.nothing++;
      const p = r.publicationId && this.store.get("initiativePublication", r.publicationId);
      if (p?.state !== "published") continue;
      a.delivered++;
      const outcomes = this.ledger.item(r.itemId)?.outcomes?.filter(o => o.at >= p.publishedAt).map(o => o.outcome) ?? [];
      if (outcomes.includes("approved") || outcomes.includes("resolved")) a.approved++;
      if (outcomes.includes("resolved")) a.completed++;
      if (outcomes.includes("dismissed")) a.dismissed++;
    }
    const room = this.settings(settings);
    return { budget: { dailyTokens: room.dailyTokens, usedToday: this.tokensToday(settings) },
      arms: Object.values(arms).map(a => ({ ...a, approvalRate: a.delivered ? a.approved / a.delivered : null, completionRate: a.delivered ? a.completed / a.delivered : null,
        tokensPerUseful: a.approved ? Math.round(a.tokens / a.approved) : null })) };
  }
}
