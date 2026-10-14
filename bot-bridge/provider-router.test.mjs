import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ProviderRouter, providerParams, botProvider } from "./provider-router.mjs";
import { ClaudeBackend } from "./claude.mjs";

class Recorder extends EventEmitter {
  constructor(name) { super(); Object.assign(this, { name, ready: true, calls: [], responses: [] }); }
  async start() {}
  async call(method, params) { this.calls.push({ method, params }); return { backend: this.name }; }
  respond(id, result) { this.responses.push({ id, result }); }
  reject(id, message) { this.responses.push({ id, error: message }); }
  close() { this.closed = true; }
  async closeForShutdown() { this.closed = true; return "closed"; }
}

test("Codex bots keep their exact native request shape", async () => {
  const codex = new Recorder("codex"), claude = new Recorder("claude");
  const router = new ProviderRouter({ codex, claude });
  assert.deepEqual(providerParams({ id: "a" }), {});
  assert.equal(botProvider({}), "codex");
  await router.call("thread/start", { cwd: "/bots/a", ...providerParams({}) });
  await router.call("turn/start", { threadId: "019a-native" });
  assert.deepEqual(codex.calls.map((c) => c.method), ["thread/start", "turn/start"]);
  assert.deepEqual(codex.calls[0].params, { cwd: "/bots/a" });
  assert.equal(claude.calls.length, 0);
});

test("Claude-owned threads, creation and requests route to the Claude backend", async () => {
  const codex = new Recorder("codex"), claude = new Recorder("claude");
  const router = new ProviderRouter({ codex, claude });
  const bot = { provider: "claude" };
  assert.equal((await router.call("thread/start", { cwd: "/bots/c", ...providerParams(bot) })).backend, "claude");
  assert.equal((await router.call("thread/list", { cwd: "/bots/c", ...providerParams(bot) })).backend, "claude");
  assert.equal((await router.call("turn/start", { threadId: "claude:1234" })).backend, "claude");
  // The routing hint never reaches a backend.
  assert.ok(claude.calls.every((c) => !("provider" in c.params)));
  router.respond("claude:7", { ok: true });
  router.respond(7, { ok: true });
  assert.deepEqual(claude.responses, [{ id: "claude:7", result: { ok: true } }]);
  assert.deepEqual(codex.responses, [{ id: 7, result: { ok: true } }]);
});

test("Claude events merge into the runtime stream; Claude faults stay isolated", () => {
  const codex = new Recorder("codex"), claude = new Recorder("claude");
  const router = new ProviderRouter({ codex, claude });
  const seen = [];
  for (const e of ["notification", "request", "fault", "claudeFault"]) router.on(e, () => seen.push(e));
  claude.emit("notification", { method: "turn/started" });
  claude.emit("request", { id: "claude:1", method: "item/tool/requestUserInput" });
  claude.emit("fault", new Error("sdk"));
  codex.emit("notification", { method: "turn/started" });
  assert.deepEqual(seen, ["notification", "request", "claudeFault", "notification"]);
});

test("Without a Claude backend, Claude work is refused definitively and Codex is unaffected", async () => {
  const codex = new Recorder("codex");
  const router = new ProviderRouter({ codex });
  assert.equal(router.claudeReady, false);
  await assert.rejects(router.call("thread/start", { provider: "claude", cwd: "/bots/c" }), (e) => e.definite === true);
  await assert.rejects(router.call("turn/start", { threadId: "claude:1" }), (e) => e.definite === true);
  assert.equal(codex.calls.length, 0);
  router.admissionGuard = () => {};
  assert.equal(typeof codex.admissionGuard, "function");
});

test("The Claude backend needs a credential before it reports ready", async () => {
  const claude = new ClaudeBackend({ credential: "" });
  await assert.rejects(claude.start(), /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(claude.ready, false);
  await assert.rejects(claude.call("thread/start", {}), (e) => e.definite === true);
});
