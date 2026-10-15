import { EventEmitter } from "node:events";

// Claude-owned native identifiers are prefixed so routing never needs state:
// thread IDs (`claude:<uuid>`) and server-request IDs (`claude:<n>`).
export const CLAUDE_PREFIX = "claude:";
export const isClaudeId = (id) => typeof id === "string" && id.startsWith(CLAUDE_PREFIX);
export const BOT_PROVIDERS = ["codex", "claude"];
export const botProvider = (bot) => (bot?.provider === "claude" ? "claude" : "codex");
// Runtime call sites that are not addressed by a thread ID (thread/start,
// thread/list by reserved cwd) name the provider explicitly. Codex bots send
// nothing extra, so the Codex request shape is unchanged.
export const providerParams = (bot) => (botProvider(bot) === "claude" ? { provider: "claude" } : {});

const EVENTS = ["notification", "request", "recoveryReceipt"];

/**
 * Presents the existing Codex client surface to BotRuntime while routing
 * Claude-owned threads and requests to a second backend. The Codex child stays
 * authoritative for process health: its disconnect/fault still restart the
 * service. A Claude backend failure only makes Claude bots unavailable.
 */
export class ProviderRouter extends EventEmitter {
  constructor({ codex, claude = null }) {
    super();
    this.codex = codex;
    this.claude = claude;
    // In-flight Claude RPCs, shaped like Codex pending entries so maintenance
    // drains and per-thread work views see both providers.
    this.claudePending = new Map();
    this.claudeSequence = 0;
    for (const event of [...EVENTS, "disconnect", "fault"])
      codex.on(event, (...args) => this.emit(event, ...args));
    if (claude) {
      for (const event of EVENTS) claude.on(event, (...args) => this.emit(event, ...args));
      claude.on("fault", (error) => this.emit("claudeFault", error));
    }
  }
  get ready() { return this.codex.ready; }
  get claudeReady() { return Boolean(this.claude?.ready); }
  get process() { return this.codex.process; }
  get pending() {
    if (!this.claudePending.size) return this.codex.pending;
    return new Map([...(this.codex.pending ?? new Map()), ...this.claudePending]);
  }
  trackClaude(method, params, promise) {
    const key = `${CLAUDE_PREFIX}call:${++this.claudeSequence}`;
    this.claudePending.set(key, { method, threadId: params.threadId ?? null });
    const settle = () => { this.claudePending.delete(key); };
    return Promise.resolve(promise).finally(settle);
  }
  get admissionGuard() { return this.codex.admissionGuard; }
  set admissionGuard(guard) { this.codex.admissionGuard = guard; }
  async start() {
    await this.codex.start();
    if (this.claude)
      await this.claude.start().catch((error) => this.emit("claudeFault", error));
  }
  backend(method, params = {}) {
    if (params.provider === "claude" || isClaudeId(params.threadId)) {
      if (!this.claude)
        throw Object.assign(new Error("Claude bots are not enabled on this machine."), { definite: true });
      return this.claude;
    }
    return this.codex;
  }
  call(method, params = {}, ...rest) {
    let backend;
    try { backend = this.backend(method, params); } catch (error) { return Promise.reject(error); }
    const { provider, ...native } = params;
    // Idle/maintenance checks must see loaded Claude sessions too.
    if (method === "thread/loaded/list" && backend === this.codex && this.claudeReady && !native.cursor)
      return backend.call(method, native, ...rest).then(async (page) =>
        ({ ...page, data: [...page.data, ...(await this.trackClaude(method, {}, this.claude.call(method, {}))).data] }));
    if (backend === this.claude) {
      let promise;
      try { promise = backend.call(method, native, ...rest); } catch (error) { promise = Promise.reject(error); }
      return this.trackClaude(method, native, promise);
    }
    return backend.call(method, native, ...rest);
  }
  respond(id, result) { return (isClaudeId(id) ? this.claude : this.codex).respond(id, result); }
  reject(id, message) { return (isClaudeId(id) ? this.claude : this.codex).reject(id, message); }
  // Private initiative jobs: a Codex ephemeral thread, or a standalone Claude query.
  startPrivateThread(params) { return this.codex.startPrivateThread(params); }
  startPrivateReviewTurn(params) { return this.codex.startPrivateReviewTurn(params); }
  privateRun(params) {
    if (!this.claude?.ready) return Promise.reject(Object.assign(new Error("Claude bots are not enabled on this machine."), { definite: true }));
    const { provider, ...rest } = params;
    return this.claude.privateRun(rest);
  }
  close() {
    this.claude?.close();
    this.codex.close();
  }
  closeForShutdown() {
    return Promise.all([this.claude?.closeForShutdown?.(), this.codex.closeForShutdown()]).then(([, codex]) => codex);
  }
}
