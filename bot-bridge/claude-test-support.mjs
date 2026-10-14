// Test doubles shared by the Claude bridge and portable tests. Not loaded by
// the service: a fake Agent SDK query, fake SDK MCP helpers and a small Codex.
import { EventEmitter } from "node:events";
import { fromJSONSchema } from "zod";

// `script(userMessage, ctx)` returns the SDK messages for one user input.
export function fakeQuery(script, log = []) {
  return ({ prompt, options }) => {
    const ctx = { options, interrupted: false, wake: null };
    log.push(ctx);
    const out = [];
    let waiting = null;
    const deliver = (m) => { if (waiting) { const w = waiting; waiting = null; w({ value: m, done: false }); } else out.push(m); };
    let ended = false;
    (async () => {
      deliver({ type: "system", subtype: "init", session_id: options.sessionId ?? options.resume });
      for await (const user of prompt) {
        ctx.last = user;
        for (const m of await script(user, ctx)) deliver(m);
      }
      ended = true;
      if (waiting) waiting({ value: undefined, done: true });
    })();
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => out.length ? Promise.resolve({ value: out.shift(), done: false })
        : ended ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => (waiting = r)),
      return: async () => ({ value: undefined, done: true }),
      interrupt: async () => { ctx.interrupted = true; ctx.wake?.(); },
      setModel: async (m) => { ctx.model = m; },
      supportedModels: async () => [{ value: "opus", displayName: "Opus", description: "", supportedEffortLevels: ["low", "high", "max"] }],
      close: () => {},
    };
  };
}

export const fakeMcp = {
  createSdkMcpServer: ({ name, tools }) => ({ type: "sdk", name, tools }),
  tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
  fromJSONSchema,
};
export const text = (id, t) => ({ type: "assistant", parent_tool_use_id: null, message: { id, content: [{ type: "text", text: t }] } });
export const result = (uuid, extra = {}) => ({ type: "result", subtype: "success", is_error: false, result: "", user_message_uuids: [uuid], ...extra });

/** Enough of the Codex app-server for runtime startup and Codex bot creation. */
export class MinimalCodex extends EventEmitter {
  ready = true;
  calls = [];
  threads = [];
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === "account/read") return { account: { type: "chatgpt" } };
    if (method === "model/list") return { data: [
      { model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], serviceTiers: [{ id: "priority" }] },
      { model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "high" }], serviceTiers: [{ id: "priority" }] },
    ], nextCursor: null };
    if (method === "thread/start") {
      const thread = { id: `codex-thread-${this.threads.length + 1}`, cwd: params.cwd, status: { type: "idle" }, turns: [] };
      this.threads.push(thread);
      return { thread };
    }
    if (method === "thread/list") return { data: this.threads.filter((t) => !params.cwd || t.cwd === params.cwd), nextCursor: null };
    if (method === "thread/loaded/list") return { data: [], nextCursor: null };
    return {};
  }
  respond() {} reject() {} close() {}
  async closeForShutdown() {}
}
