// Translates one Claude Agent SDK turn into Codex app-server shapes: a native
// `Turn` with `ThreadItem`s plus the notifications Codex would have emitted.
// Pure: no I/O, so fixtures can pin every mapping (see claude.test.mjs).

const OUTPUT_LIMIT = 64 * 1024;
const clip = (text) => (text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… output truncated` : text);
const seconds = (ms) => Math.floor(ms / 1000);
const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
// Claude Code plumbing (loading deferred tool schemas) with nothing to show.
const HIDDEN_TOOLS = new Set(["ToolSearch"]);
// SDK tools that are bridge dynamic tools (in-process `bots` MCP server).
export const DYNAMIC_SERVER = "bots";

export function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" ? part.text : part?.type === "image" ? "[image]" : "")).join("\n");
}

function fileChanges(name, input) {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (name === "Write") return [{ path, kind: { type: "add" }, diff: clip(String(input.content ?? "")) }];
  const edits = name === "MultiEdit" ? input.edits ?? [] : [input];
  const diff = edits.map((e) => `-${String(e.old_string ?? "").replaceAll("\n", "\n-")}\n+${String(e.new_string ?? e.new_source ?? "").replaceAll("\n", "\n+")}`).join("\n");
  return [{ path, kind: { type: "update", move_path: null }, diff: clip(diff) }];
}

/** Map a `tool_use` block to an in-progress Codex item. */
export function toolItem(block, cwd) {
  const { id, name, input = {} } = block;
  if (name === "Bash")
    return { type: "commandExecution", id, pluginId: null, scriptPath: null, command: String(input.command ?? ""), cwd,
      processId: null, source: "agent", status: "inProgress", commandActions: [{ type: "unknown", command: String(input.command ?? "") }],
      aggregatedOutput: null, exitCode: null, durationMs: null };
  if (FILE_TOOLS.has(name)) return { type: "fileChange", id, changes: fileChanges(name, input), status: "inProgress" };
  if (name === "WebSearch") return { type: "webSearch", id, query: String(input.query ?? ""), action: null, results: null };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp?.[1] === DYNAMIC_SERVER)
    return { type: "dynamicToolCall", id, namespace: null, tool: mcp[2], arguments: input, status: "inProgress",
      contentItems: null, success: null, durationMs: null };
  return { type: "mcpToolCall", id, server: mcp ? mcp[1] : "claude", tool: mcp ? mcp[2] : name, status: "inProgress",
    arguments: input, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null };
}

/** Complete an in-progress tool item with its `tool_result`. */
export function completeTool(item, result, durationMs) {
  const text = clip(resultText(result.content));
  const failed = result.is_error === true;
  switch (item.type) {
    case "commandExecution":
      return { ...item, status: failed ? "failed" : "completed", aggregatedOutput: text, exitCode: failed ? 1 : 0, durationMs };
    case "fileChange":
      return { ...item, status: failed ? "failed" : "completed" };
    case "webSearch":
      return item;
    case "dynamicToolCall":
      return { ...item, status: failed ? "failed" : "completed", success: !failed, contentItems: [{ type: "inputText", text }], durationMs };
    default:
      return { ...item, status: failed ? "failed" : "completed", durationMs,
        result: failed ? null : { content: [{ type: "text", text }], structuredContent: null, _meta: null },
        error: failed ? { message: text } : null };
  }
}

/**
 * Accumulates one turn. `consume()` and `finish()` return the notifications to
 * emit, in order; `turn` is always the current persisted snapshot.
 */
export class ClaudeTurn {
  constructor({ threadId, turnId, cwd, now = Date.now, record = null }) {
    this.threadId = threadId;
    this.cwd = cwd;
    this.now = now;
    this.state = record ?? {
      turn: { id: turnId, rootTurnId: null, items: [], itemsView: "full", status: "inProgress", error: null,
        startedAt: seconds(now()), completedAt: null, durationMs: null },
      times: {}, // itemId -> {startedAtMs, completedAtMs}
    };
    this.streams = new Map(); // `${messageId}:${index}` -> itemId while streaming
    this.streamed = new Map(); // itemId -> streamed text, kept when a final block arrives empty
    this.claimed = new Map(); // messageId -> number of finished blocks claimed
    this.tools = new Map(); // tool_use_id -> startedAtMs
    this.held = null; // last agentMessage, held until we know whether it is final
  }
  get turn() { return this.state.turn; }
  get id() { return this.state.turn.id; }
  note(method, params) { return { method, params: { threadId: this.threadId, ...params } }; }
  find(id) { return this.turn.items.findIndex((item) => item.id === id); }
  start(item, out) {
    const at = this.now();
    this.state.times[item.id] = { startedAtMs: at, completedAtMs: null };
    if (this.find(item.id) < 0) this.turn.items.push(item);
    out.push(this.note("item/started", { item, turnId: this.id, startedAtMs: at }));
  }
  complete(item, out) {
    const at = this.now();
    const i = this.find(item.id);
    if (i < 0) this.start(item, out);
    this.turn.items[this.find(item.id)] = item;
    (this.state.times[item.id] ??= { startedAtMs: at }).completedAtMs = at;
    out.push(this.note("item/completed", { item, turnId: this.id, completedAtMs: at }));
  }
  drop(id) {
    const i = this.find(id);
    if (i >= 0) this.turn.items.splice(i, 1);
    delete this.state.times[id];
  }
  begin() {
    return [this.note("turn/started", { turn: { ...this.turn, items: [] } })];
  }
  /** A user input accepted into this turn (the first message or a steer). */
  user({ id, clientId, content }) {
    const out = [];
    this.flush(out, "commentary");
    this.complete({ type: "userMessage", id, clientId: clientId ?? null, content }, out);
    return out;
  }
  flush(out, phase) {
    if (!this.held) return;
    const item = { ...this.held, phase };
    this.held = null;
    this.complete(item, out);
  }
  blockId(messageId) {
    const n = this.claimed.get(messageId) ?? 0;
    this.claimed.set(messageId, n + 1);
    return this.streams.get(`${messageId}:${n}`) ?? `${messageId}:${n}`;
  }
  consume(message) {
    const out = [];
    if (message.parent_tool_use_id) return out; // Subagent internals stay inside the Agent tool item.
    if (message.type === "stream_event") this.stream(message, out);
    else if (message.type === "assistant") this.assistant(message, out);
    else if (message.type === "user") this.toolResults(message, out);
    else if (message.type === "system" && message.subtype === "compact_boundary") {
      this.flush(out, "commentary");
      this.complete({ type: "contextCompaction", id: message.uuid }, out);
    }
    return out;
  }
  stream({ event }, out) {
    if (event.type === "message_start") this.messageId = event.message.id;
    else if (event.type === "content_block_start") {
      const key = `${this.messageId}:${event.index}`;
      const type = event.content_block?.type;
      if (type !== "text" && type !== "thinking") return;
      // Stream indices count every block in the API message; claims count
      // finished blocks in order. Both are sequential, so they agree.
      const id = `${this.messageId}:${event.index}`;
      this.streams.set(key, id);
      this.flush(out, "commentary");
      // Thinking may be omitted entirely; announce its row only once it has text.
      if (type === "text") this.start({ type: "agentMessage", id, text: "", phase: null, memoryCitation: null, delivery: null, questions: null }, out);
    } else if (event.type === "content_block_delta") {
      const id = this.streams.get(`${this.messageId}:${event.index}`);
      if (!id) return;
      const delta = event.delta.text ?? event.delta.thinking;
      if (!delta) return;
      if (event.delta.type === "thinking_delta" && !this.streamed.has(id))
        this.start({ type: "reasoning", id, summary: [], content: [] }, out);
      this.streamed.set(id, (this.streamed.get(id) ?? "") + delta);
      if (event.delta.type === "text_delta")
        out.push(this.note("item/agentMessage/delta", { turnId: this.id, itemId: id, delta: event.delta.text }));
      else if (event.delta.type === "thinking_delta")
        out.push(this.note("item/reasoning/summaryTextDelta", { turnId: this.id, itemId: id, delta: event.delta.thinking, summaryIndex: 0 }));
    }
  }
  assistant(message, out) {
    const messageId = message.message?.id ?? message.uuid;
    for (const block of message.message?.content ?? []) {
      if (block.type === "text") {
        if (!block.text) { this.blockId(messageId); continue; }
        this.flush(out, "commentary");
        this.held = { type: "agentMessage", id: this.blockId(messageId), text: block.text, phase: null,
          memoryCitation: null, delivery: null, questions: null };
      } else if (block.type === "thinking" || block.type === "redacted_thinking") {
        const id = this.blockId(messageId);
        const thinking = block.thinking || this.streamed.get(id);
        this.flush(out, "commentary");
        // Omitted/redacted thinking has no displayable text; drop its row.
        if (!thinking) { this.drop(id); continue; }
        this.complete({ type: "reasoning", id, summary: [thinking], content: [] }, out);
      } else if (block.type === "tool_use") {
        this.blockId(messageId);
        if (HIDDEN_TOOLS.has(block.name)) continue;
        this.flush(out, "commentary");
        if (block.name === "TodoWrite") {
          const text = (block.input?.todos ?? []).map((t) => `${t.status === "completed" ? "[x]" : "[ ]"} ${t.content}`).join("\n");
          out.push(this.note("turn/plan/updated", { turnId: this.id, explanation: null,
            plan: (block.input?.todos ?? []).map((t) => ({ step: t.content, status: t.status === "in_progress" ? "inProgress" : t.status })) }));
          this.complete({ type: "plan", id: block.id, text }, out);
          continue;
        }
        this.tools.set(block.id, this.now());
        this.start(toolItem(block, this.cwd), out);
      } else this.blockId(messageId);
    }
  }
  toolResults(message, out) {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const i = this.find(block.tool_use_id);
      if (i < 0) continue;
      const item = this.turn.items[i];
      if (item.type === "plan") continue;
      const started = this.tools.get(block.tool_use_id) ?? this.now();
      this.tools.delete(block.tool_use_id);
      this.complete(completeTool(item, block, this.now() - started), out);
    }
  }
  /** Close the turn. Unfinished tool items are marked failed, not left running. */
  finish(status, error = null) {
    const out = [];
    this.flush(out, status === "completed" ? "final_answer" : "commentary");
    for (const item of this.turn.items)
      if (item.status === "inProgress")
        this.complete({ ...item, status: "failed", ...(item.type === "mcpToolCall" ? { error: { message: "Turn ended before the tool finished." } } : {}) }, out);
    const at = this.now();
    Object.assign(this.turn, {
      status, completedAt: seconds(at), durationMs: at - this.turn.startedAt * 1000,
      error: error ? { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null,
    });
    out.push(this.note("turn/completed", { turn: this.turn }));
    return out;
  }
}

/** Decide the terminal status for an SDK `result` message. */
export function resultStatus(result, interrupted) {
  if (interrupted) return { status: "interrupted", error: null };
  if (result.subtype === "success" && !result.is_error) return { status: "completed", error: null };
  const error = result.errors?.join("\n") || (result.subtype === "success" ? result.result : null) || result.subtype;
  return { status: "failed", error: String(error).slice(0, 2000) };
}
