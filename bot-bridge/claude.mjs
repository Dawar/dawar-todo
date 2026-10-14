import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { homedir } from "node:os";
import { ClaudeTurn, resultStatus, DYNAMIC_SERVER } from "./claude-items.mjs";
import { ClaudeStore, view } from "./claude-store.mjs";
import { CLAUDE_PREFIX } from "./provider-router.mjs";

// Claude Agent SDK backend for Claude-powered bots. It answers the subset of
// the Codex app-server protocol that BotRuntime uses, in Codex shapes, so the
// browser contract, history projection and recovery code stay unchanged.
//
// One long-lived SDK query (streaming input) per loaded thread. The SDK keeps
// the model-side session JSONL; the bridge keeps the displayable transcript
// (claude-store.mjs), written before each notification is emitted.

export const CLAUDE_SDK_VERSION = "0.3.287";
const IDLE_UNLOAD_MS = Number(process.env.BOTS_CLAUDE_IDLE_MS ?? 10 * 60 * 1000);
const INTERRUPT_GRACE_MS = 15000;
const EMPTY = { data: [], nextCursor: null };
// Reads the bridge issues for Codex-only features. Claude threads have none of
// that state, so the honest answer is empty; mutations are refused below.
const EMPTY_READS = {
  "thread/goal/get": () => ({ goal: null }),
  "thread/queue/list": () => EMPTY,
  "thread/backgroundTerminals/list": () => EMPTY,
  "thread/settings/update": () => ({}),
};
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// Used only when the SDK model catalog cannot be read at startup.
const FALLBACK_MODELS = [
  { value: "opus", displayName: "Opus", description: "Most capable Claude model", supportedEffortLevels: EFFORTS },
  { value: "sonnet", displayName: "Sonnet", description: "Fast, capable Claude model", supportedEffortLevels: EFFORTS.slice(0, 4) },
  { value: "haiku", displayName: "Haiku", description: "Fastest Claude model", supportedEffortLevels: [] },
];
const IMAGE_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const definite = (message) => Object.assign(new Error(message), { definite: true, rpcCode: -32600 });

class InputQueue {
  constructor() { this.items = []; this.waiters = []; this.done = false; }
  push(message) {
    if (this.done) throw definite("The Claude session closed before this input was sent.");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }
  end() {
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => this.items.length ? Promise.resolve({ value: this.items.shift(), done: false })
        : this.done ? Promise.resolve({ value: undefined, done: true })
        : new Promise((resolve) => this.waiters.push(resolve)),
      return: () => { this.end(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

/** Codex `config` dotted keys → SDK stdio MCP servers (manager/desktop tools). */
export function mcpServersFrom(config = {}) {
  const servers = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    const name = /^mcp_servers\.([^.]+)$/.exec(key)?.[1];
    if (!name || !value?.command || value.enabled === false) continue;
    servers[name] = { type: "stdio", command: value.command, args: value.args ?? [], env: value.env ?? {} };
  }
  return servers;
}

/** Codex `dynamicTools` → the stored subset the in-process MCP server needs. */
export function dynamicToolSpecs(tools = []) {
  return (Array.isArray(tools) ? tools : []).filter((t) => typeof t?.name === "string")
    .map(({ name, description, inputSchema }) => ({ name, description: description ?? "", inputSchema: inputSchema ?? { type: "object" } }));
}

/** Codex `Model` row for an SDK `ModelInfo`. */
export function nativeModel(info, isDefault = false) {
  const levels = (info.supportedEffortLevels ?? []).filter((e) => EFFORTS.includes(e));
  return {
    id: `${CLAUDE_PREFIX}${info.value}`, model: info.value, provider: "claude", upgrade: null, upgradeInfo: null,
    availabilityNux: null, displayName: info.displayName ?? info.value, description: info.description ?? "",
    modelSpecialty: null, hidden: false,
    supportedReasoningEfforts: levels.map((e) => ({ reasoningEffort: e, description: e })),
    defaultReasoningEffort: levels.includes("high") ? "high" : levels[0] ?? "medium",
    supportsAdaptiveThinking: info.supportsAdaptiveThinking === true,
    inputModalities: ["text", "image"], supportsPersonality: false, multiAgentVersion: null,
    additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availableAccessPrograms: null, isDefault,
  };
}

async function sdkContent(input = [], additionalContext = {}) {
  const content = [];
  for (const [key, entry] of Object.entries(additionalContext ?? {}))
    if (typeof entry?.value === "string" && entry.value)
      content.push({ type: "text", text: `<${key}>\n${entry.value}\n</${key}>` });
  for (const part of input) {
    if (part.type === "text") content.push({ type: "text", text: part.text });
    else if (part.type === "localImage") {
      const mediaType = IMAGE_TYPES[extname(part.path).toLowerCase()];
      if (!mediaType) content.push({ type: "text", text: `Attached image: ${part.path}` });
      else content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: (await readFile(part.path)).toString("base64") } });
    } else if (part.type === "image" && part.url) content.push({ type: "image", source: { type: "url", url: part.url } });
    else if (part.type === "mention" || part.type === "skill") content.push({ type: "text", text: `${part.name}: ${part.path}` });
  }
  if (!content.length) throw definite("Claude input is empty.");
  return content;
}

export class ClaudeBackend extends EventEmitter {
  constructor({ store = null, query = null, mcp = null, credential = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY,
    configDir = process.env.BOTS_CLAUDE_CONFIG_DIR ?? join(process.env.BOTS_STATE_DIR ?? join(homedir(), ".local/share/dawar-todo-bots"), "claude"),
    now = Date.now } = {}) {
    super();
    Object.assign(this, { credential, configDir, now, query, mcp });
    // Open server requests (questions, bridge tool calls) by request ID.
    this.requests = new Map();
    // MCP launch config per thread. It carries the manager's process-lifetime
    // token, so it is held in memory only; the runtime re-sends it on resume.
    this.mcpConfig = new Map();
    this.data = store ? new ClaudeStore(store) : null;
    this.sessions = new Map();
    this.outbox = [];
    this.flushing = false;
    this.models = [];
    this.ready = false;
    this.counter = 0;
  }
  async start() {
    if (!this.credential)
      throw new Error("Claude bots need CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in the bots environment.");
    if (!this.data) throw new Error("Claude bots need the bridge state store.");
    if (!this.query || !this.mcp) {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      this.query ??= sdk.query;
      this.mcp ??= { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, fromJSONSchema: (await import("zod")).fromJSONSchema };
    }
    this.recoverInterruptedTurns();
    this.models = await this.readModels().catch(() => FALLBACK_MODELS.map((m, i) => nativeModel(m, i === 0)));
    this.ready = true;
  }
  env() {
    const env = { ...process.env, CLAUDE_CONFIG_DIR: this.configDir };
    // Only the configured credential reaches the child, never both kinds.
    delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN;
    env[this.credential === process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN ? "ANTHROPIC_API_KEY" : "CLAUDE_CODE_OAUTH_TOKEN"] = this.credential;
    return env;
  }
  /** A restart loses the SDK child; its unfinished turns end as interrupted, never replayed. */
  recoverInterruptedTurns() {
    for (const thread of this.data.threads())
      for (const record of this.data.turns(thread.id)) {
        if (record.turn.status !== "inProgress") continue;
        const turn = new ClaudeTurn({ threadId: thread.id, cwd: thread.cwd, now: this.now, record: { turn: record.turn, times: record.times ?? {} } });
        turn.finish("interrupted", "The bots service restarted during this Claude turn. Review the conversation before retrying.");
        this.data.saveTurn(thread.id, turn.state);
      }
  }
  async readModels() {
    const input = new InputQueue();
    const q = this.query({ prompt: input, options: { cwd: homedir(), settingSources: [], env: this.env(), persistSession: false } });
    try {
      const infos = await Promise.race([q.supportedModels(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000).unref())]);
      if (!infos?.length) throw new Error("Empty Claude model catalog.");
      return infos.map((info) => nativeModel(info, info.value === "opus"));
    } finally {
      input.end();
      q.close?.();
    }
  }
  record(threadId) {
    const record = this.data.thread(threadId);
    if (!record) throw definite("Unknown Claude thread.");
    return record;
  }
  status(threadId) {
    const session = this.sessions.get(threadId);
    if (!session) return { type: "notLoaded" };
    if (session.turn) return { type: "active",
      activeFlags: [...this.requests.values()].some((r) => r.threadId === threadId && r.kind === "question") ? ["waitingOnUserInput"] : [] };
    return { type: "idle" };
  }
  /**
   * One ordered outbox for every notification, flushed after the current
   * call returns: callers see a response before its notifications (as with
   * Codex), and SDK events can never overtake an earlier turn/started.
   */
  send(notes, event = "notification") {
    if (!notes.length) return;
    this.outbox.push(...notes.map((message) => ({ event, message })));
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      for (const { event, message } of this.outbox.splice(0)) this.emit(event, message);
    });
  }
  persistAndSend(session, notes) {
    if (!notes.length) return;
    if (session.turn) this.data.saveTurn(session.threadId, session.turn.state);
    this.send(notes);
  }
  setStatus(threadId) {
    this.send([{ method: "thread/status/changed", params: { threadId, status: this.status(threadId) } }]);
  }
  load(record) {
    const existing = this.sessions.get(record.id);
    if (existing) return existing;
    const input = new InputQueue();
    const options = {
      cwd: record.cwd,
      model: record.model ?? undefined,
      ...(EFFORTS.includes(record.effort) ? { effort: record.effort } : {}),
      // Summarized thinking gives the reasoning rows real text, like Codex summaries.
      ...(this.models.find((m) => m.model === record.model)?.supportsAdaptiveThinking ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      ...(record.sessionStarted ? { resume: record.sessionId } : { sessionId: record.sessionId }),
      systemPrompt: { type: "preset", preset: "claude_code", ...(record.instructions ? { append: record.instructions } : {}) },
      settingSources: [],
      includePartialMessages: true,
      permissionMode: "default",
      canUseTool: (toolName, toolInput, context) => this.canUseTool(record.id, toolName, toolInput, context),
      mcpServers: { ...(this.mcpConfig.get(record.id) ?? {}), ...this.dynamicServer(record) },
      env: this.env(),
      stderr: (data) => { if (process.env.BOTS_DEBUG === "1") process.stderr.write(data); },
    };
    const session = { threadId: record.id, input, query: this.query({ prompt: input, options }), turn: null,
      pending: new Set(), interrupted: false, idleTimer: null, closed: false };
    this.sessions.set(record.id, session);
    session.pump = this.pump(session);
    return session;
  }
  async canUseTool(threadId, toolName, input, context = {}) {
    // Mirrors the Codex bots' never-ask / full-access execution policy; only
    // questions reach the owner, as native request cards.
    if (toolName === "AskUserQuestion") return this.ask(threadId, input, context);
    return { behavior: "allow", updatedInput: input };
  }
  /**
   * Opens a server request the runtime handles exactly like a Codex one. It
   * settles once: by respond/reject, by SDK abort, or when its turn ends.
   */
  open(threadId, kind, message, settle) {
    return new Promise((resolve) => {
      const finish = (value) => {
        if (!this.requests.delete(message.id)) return;
        resolve(value);
        if (kind === "question") this.send([{ method: "serverRequest/resolved", params: { threadId, requestId: message.id } }]);
      };
      this.requests.set(message.id, { threadId, kind, finish, ...settle });
      this.send([message], "request");
    });
  }
  ask(threadId, input, { signal, toolUseID } = {}) {
    const turn = this.sessions.get(threadId)?.turn;
    const asked = Array.isArray(input?.questions) ? input.questions : [];
    if (!turn || !asked.length) return { behavior: "deny", message: "There is no active conversation turn to ask in." };
    const questions = asked.map((q, i) => ({ id: `q${i + 1}`, header: String(q.header ?? ""), question: String(q.question ?? ""),
      isOther: true, isSecret: false, options: (q.options ?? []).map((o) => ({ label: String(o.label), description: String(o.description ?? "") })) }));
    const id = this.nextRequestId();
    const pending = this.open(threadId, "question",
      { id, method: "item/tool/requestUserInput", params: { threadId, turnId: turn.id, itemId: toolUseID ?? id, questions, isBlocking: true, autoResolutionMs: null } },
      {
        answer: (result) => {
          // SDK answers are keyed by question text; several picks join with ", ".
          const answers = {};
          questions.forEach((q, i) => { answers[asked[i].question] = (result?.answers?.[q.id]?.answers ?? []).join(", "); });
          return { behavior: "allow", updatedInput: { ...input, answers } };
        },
        refuse: (message) => ({ behavior: "deny", message }),
      });
    signal?.addEventListener("abort", () => this.requests.get(id)?.finish({ behavior: "deny", message: "The question was cancelled." }), { once: true });
    return pending;
  }
  /** In-process MCP server exposing the bridge dynamic tools as mcp__bots__<name>. */
  dynamicServer(record) {
    const tools = record.dynamicTools ?? [];
    if (!tools.length || !this.mcp) return {};
    const definitions = tools.map((spec) => {
      let shape = {};
      try { shape = this.mcp.fromJSONSchema(spec.inputSchema ?? { type: "object" }).shape ?? {}; } catch { /* Accept any arguments. */ }
      return this.mcp.tool(spec.name, spec.description ?? "", shape, (args, extra) => this.callTool(record.id, spec.name, args, extra));
    });
    return { [DYNAMIC_SERVER]: this.mcp.createSdkMcpServer({ name: DYNAMIC_SERVER, version: "1.0.0", tools: definitions }) };
  }
  callTool(threadId, tool, args) {
    const turn = this.sessions.get(threadId)?.turn;
    if (!turn) return Promise.resolve({ content: [{ type: "text", text: "There is no active conversation turn." }], isError: true });
    const id = this.nextRequestId();
    return this.open(threadId, "tool",
      { id, method: "item/tool/call", params: { threadId, turnId: turn.id, callId: id, namespace: null, tool, arguments: args ?? {} } },
      {
        answer: (result) => ({ isError: result?.success === false, content: (result?.contentItems ?? []).map((c) =>
          c.type === "inputImage" && /^data:([^;]+);base64,/.test(c.imageUrl ?? "")
            ? { type: "image", mimeType: /^data:([^;]+);/.exec(c.imageUrl)[1], data: c.imageUrl.slice(c.imageUrl.indexOf(",") + 1) }
            : { type: "text", text: c.text ?? c.imageUrl ?? c.audioUrl ?? "" }) }),
        refuse: (message) => ({ content: [{ type: "text", text: message }], isError: true }),
      });
  }
  /** Settle every open request of a thread whose turn ended or session closed. */
  cancelRequests(threadId, reason) {
    for (const request of [...this.requests.values()])
      if (request.threadId === threadId) request.finish(request.refuse(reason));
  }
  async pump(session) {
    let failure = null;
    try {
      for await (const message of session.query) this.handle(session, message);
    } catch (error) {
      failure = error;
    }
    this.unload(session, failure ? `The Claude session stopped: ${failure.message}` : "The Claude session ended.");
  }
  handle(session, message) {
    if (message.type === "system" && message.subtype === "init") {
      const record = this.data.thread(session.threadId);
      if (record && !record.sessionStarted) this.data.saveThread({ ...record, sessionStarted: true });
      return;
    }
    if (message.type === "rate_limit_event") { this.rateLimit = message.rate_limit_info; return; }
    const turn = session.turn;
    if (!turn) return;
    if (message.type === "result") {
      for (const uuid of message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : [...session.pending]))
        session.pending.delete(uuid);
      // A steer that was not folded into this run produces its own result.
      if (session.pending.size && !session.interrupted) return;
      const { status, error } = resultStatus(message, session.interrupted);
      this.complete(session, status, error);
      return;
    }
    this.persistAndSend(session, turn.consume(message));
  }
  complete(session, status, error) {
    const turn = session.turn;
    if (!turn) return;
    clearTimeout(session.interruptTimer);
    this.cancelRequests(session.threadId, "The turn ended before this was answered.");
    const notes = turn.finish(status, error);
    this.data.saveTurn(session.threadId, turn.state);
    session.turn = null;
    session.pending.clear();
    session.interrupted = false;
    // turn/completed is the terminal proof. A bare idle status cannot be tied
    // to a turn and would force the runtime into a current-state re-read.
    this.send(notes);
    this.scheduleIdle(session);
  }
  scheduleIdle(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => { if (!session.turn) this.close(session.threadId); }, IDLE_UNLOAD_MS);
    session.idleTimer.unref?.();
  }
  unload(session, reason) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.idleTimer);
    clearTimeout(session.interruptTimer);
    if (session.turn) {
      const interrupted = session.interrupted;
      this.complete(session, interrupted ? "interrupted" : "failed", interrupted ? null : reason);
    }
    if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId);
    this.setStatus(session.threadId);
  }
  startResponse(record) {
    return { thread: this.data.nativeThread(record, this.status(record.id)), model: record.model ?? "", modelProvider: "anthropic",
      serviceTier: null, disabledPluginIds: [], cwd: record.cwd, runtimeWorkspaceRoots: [], instructionSources: [],
      approvalPolicy: "never", approvalsReviewer: "user", sandbox: { type: "dangerFullAccess" }, activePermissionProfile: null,
      reasoningEffort: record.effort ?? null, collaborationMode: null, multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null };
  }
  async call(method, params = {}) {
    if (!this.ready) throw definite("Claude bots are not ready.");
    if (EMPTY_READS[method]) { this.record(params.threadId); return EMPTY_READS[method](params); }
    switch (method) {
      case "model/list": return { data: this.models, nextCursor: null };
      case "thread/start": return this.threadStart(params);
      case "thread/resume": return this.threadResume(params);
      case "thread/read": {
        const record = this.record(params.threadId);
        const turns = params.includeTurns ? this.data.turns(record.id).map((r) => view(r.turn)) : [];
        return { thread: this.data.nativeThread(record, this.status(record.id), turns) };
      }
      case "thread/list": {
        const archived = params.archived === true;
        const data = this.data.threads()
          .filter((t) => (!params.cwd || t.cwd === params.cwd) && Boolean(t.archived) === archived)
          .map((t) => this.data.nativeThread(t, this.status(t.id)));
        return { data, nextCursor: null, backwardsCursor: null };
      }
      case "thread/loaded/list": return { data: [...this.sessions.keys()], nextCursor: null };
      case "thread/turns/list": this.record(params.threadId); return this.data.turnsPage(params.threadId, params);
      case "thread/items/list": this.record(params.threadId); return this.data.itemsPage(params.threadId, params);
      case "thread/name/set": {
        const record = this.record(params.threadId);
        this.data.saveThread({ ...record, name: String(params.name ?? "") });
        this.send([{ method: "thread/name/updated", params: { threadId: record.id, threadName: params.name } }]);
        return {};
      }
      case "thread/archive":
      case "thread/unarchive": {
        const record = this.record(params.threadId);
        if (this.sessions.get(record.id)?.turn) throw definite("Stop this Claude turn before archiving.");
        this.close(record.id);
        const archived = method === "thread/archive";
        this.data.saveThread({ ...record, archived });
        this.send([{ method: archived ? "thread/archived" : "thread/unarchived", params: { threadId: record.id } }]);
        return {};
      }
      case "thread/unsubscribe": {
        this.record(params.threadId);
        if (this.sessions.get(params.threadId)?.turn) return { status: "notSubscribed" };
        return { status: this.close(params.threadId) ? "unsubscribed" : "notLoaded" };
      }
      case "turn/start": return this.turnStart(params);
      case "turn/steer": return this.turnSteer(params);
      case "turn/interrupt": return this.turnInterrupt(params);
      default:
        throw Object.assign(new Error(`Claude bots do not support ${method} yet.`), { definite: true, rpcCode: -32601 });
    }
  }
  threadStart(params) {
    const sessionId = randomUUID();
    this.mcpConfig.set(`${CLAUDE_PREFIX}${sessionId}`, mcpServersFrom(params.config));
    const record = this.data.saveThread({
      id: `${CLAUDE_PREFIX}${sessionId}`, sessionId, cwd: params.cwd, name: null, model: params.model ?? null,
      effort: params.effort ?? params.config?.model_reasoning_effort ?? null, instructions: params.developerInstructions ?? null,
      dynamicTools: dynamicToolSpecs(params.dynamicTools), archived: false, preview: "", sessionStarted: false, nextSeq: 1,
      createdAt: this.now(),
    });
    this.load(record);
    return this.startResponse(record);
  }
  threadResume(params) {
    let record = this.record(params.threadId);
    if (record.archived) throw definite("Restore this Claude thread before resuming it.");
    const loaded = this.sessions.has(record.id);
    if (!loaded && params.config) this.mcpConfig.set(record.id, mcpServersFrom(params.config));
    // Settings captured at resume apply when the SDK session is (re)started.
    if (!loaded) record = this.data.saveThread({ ...record,
      ...(params.model ? { model: params.model } : {}),
      ...(params.developerInstructions ? { instructions: params.developerInstructions } : {}),
      ...(params.dynamicTools ? { dynamicTools: dynamicToolSpecs(params.dynamicTools) } : {}) });
    this.load(record);
    return this.startResponse(this.data.thread(record.id));
  }
  async userMessage(session, params, priority) {
    const content = await sdkContent(params.input, params.additionalContext);
    const uuid = randomUUID();
    return { uuid, message: { type: "user", message: { role: "user", content }, parent_tool_use_id: null, uuid,
      session_id: this.record(session.threadId).sessionId, ...(priority ? { priority } : {}) } };
  }
  async turnStart(params) {
    const record = this.record(params.threadId);
    const session = this.sessions.get(record.id) ?? this.load(record);
    if (session.turn) throw definite("A Claude turn is already running in this conversation.");
    const { uuid, message } = await this.userMessage(session, params);
    if (session.turn) throw definite("A Claude turn is already running in this conversation.");
    clearTimeout(session.idleTimer);
    if (params.model && params.model !== record.model) {
      await session.query.setModel?.(params.model);
      this.data.saveThread({ ...this.data.thread(record.id), model: params.model });
    }
    const turn = new ClaudeTurn({ threadId: record.id, turnId: randomUUID(), cwd: record.cwd, now: this.now });
    session.turn = turn;
    session.pending = new Set([uuid]);
    const notes = [...turn.begin(), ...turn.user({ id: `user:${uuid}`, clientId: params.clientUserMessageId, content: params.input })];
    this.data.saveTurn(record.id, turn.state);
    const preview = params.input.find((p) => p.type === "text")?.text?.slice(0, 160);
    if (preview && !record.preview) this.data.saveThread({ ...this.data.thread(record.id), preview });
    session.input.push(message);
    this.send(notes);
    return { turn: { ...view(turn.turn), items: [] } };
  }
  async turnSteer(params) {
    const session = this.sessions.get(params.threadId);
    if (!session?.turn || session.turn.id !== params.expectedTurnId)
      throw definite("The Claude turn you are steering is no longer running.");
    const { uuid, message } = await this.userMessage(session, params, "now");
    if (session.turn?.id !== params.expectedTurnId) throw definite("The Claude turn you are steering is no longer running.");
    session.pending.add(uuid);
    session.input.push(message);
    this.persistAndSend(session, session.turn.user({ id: `user:${uuid}`, clientId: params.clientUserMessageId, content: params.input }));
    return { turnId: session.turn.id };
  }
  async turnInterrupt(params) {
    const session = this.sessions.get(params.threadId);
    if (!session?.turn || (params.turnId && session.turn.id !== params.turnId)) return {};
    session.interrupted = true;
    clearTimeout(session.interruptTimer);
    // If the SDK never reports the interrupted result, settle the turn anyway.
    session.interruptTimer = setTimeout(() => this.complete(session, "interrupted", null), INTERRUPT_GRACE_MS);
    session.interruptTimer.unref?.();
    await session.query.interrupt?.();
    return {};
  }
  nextRequestId() { return `${CLAUDE_PREFIX}${this.epoch ??= randomUUID().slice(0, 8)}:${++this.counter}`; }
  respond(id, result) {
    const request = this.requests.get(id);
    request?.finish(request.answer(result));
  }
  reject(id, message) {
    const request = this.requests.get(id);
    request?.finish(request.refuse(String(message ?? "Declined.")));
  }
  forkPrivateReview() { return Promise.reject(definite("Claude bots do not support private reviews yet.")); }
  startPrivateReviewTurn() { return Promise.reject(definite("Claude bots do not support private reviews yet.")); }
  close(threadId) {
    if (threadId !== undefined) return this.closeSession(threadId);
    for (const id of [...this.sessions.keys()]) this.closeSession(id);
    this.ready = false;
  }
  closeSession(threadId) {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    // A turn we close ourselves (shutdown) was stopped, not failed by Claude.
    session.interrupted = true;
    session.input.end();
    session.query.close?.();
    this.unload(session, "The Claude session was closed.");
    return true;
  }
  async closeForShutdown() { this.close(); }
}
