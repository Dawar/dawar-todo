import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import ts from 'typescript';
import { secureBrowserFrame } from '../lib/secure-relay.ts';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { bridgeResponse } from '../bot-bridge/response.mjs';
import { runtime as browserRuntime } from './helpers/load-ts.mjs';
const { taskRequestFrame } = browserRuntime().load('lib/task-request-relay.ts');

// Execute the exact pre-certainty relay published with the v135 baseline, not a
// hand-written approximation of its allowlist. No Cloudflare/service is started.
const oldRef = '80a3826e3617a2fa39ba6a7a051d82d95d0e304d';
const oldRelaySource = execFileSync('git', ['show', `${oldRef}:bots-relay/src/index.ts`], { encoding: 'utf8' });
function compile(source, extra = {}) {
  const exports = {};
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInNewContext(js, { exports, crypto, Date, JSON, Buffer, TextEncoder, TextDecoder, btoa, atob, Error, ...extra });
  return exports;
}
function relayClass(source) {
  return compile(source, { WebSocket: { OPEN: 1 }, require(name) {
    if (name === 'cloudflare:workers') return { DurableObject: class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } };
    if (name === '../../lib/bots-auth') return { secretMatches() { throw new Error('Unexpected authentication path'); }, verifyBotTicket() { throw new Error('Unexpected authentication path'); } };
    if (name === '../../lib/secure-relay') return { secureBrowserFrame };
    if (name === '../../lib/task-request-relay') return { taskRequestFrame };
    throw new Error(`Unexpected relay import ${name}`);
  } }).BotRelay;
}
const OldRelay = relayClass(oldRelaySource);
const NewRelay = relayClass(await readFile('bots-relay/src/index.ts', 'utf8'));
const serviceSource = ts.createSourceFile('service.mjs', await readFile('bot-bridge/service.mjs', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const sendLargeNode = serviceSource.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'sendLarge');
assert.ok(sendLargeNode);
// Invoke the actual production serializer body without starting the service.
const sendLarge = vm.runInNewContext(`(${sendLargeNode.getText(serviceSource)})`, { Buffer });
const entries = () => {
  const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null };
};
class Native extends EventEmitter {
  calls = []; threads = []; queue = []; commits = 0; fault = '';
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'model/list') return { data: [{ model: 'gpt-6-luna', isDefault: true, supportedReasoningEfforts: [{reasoningEffort: 'high'}], serviceTiers: [{id: 'priority', name: 'Fast'}] }], nextCursor: null };
    if (method === 'thread/start') { const thread = { id: `thread-${this.threads.length}`, cwd: params.cwd, turns: [] }; this.threads.push(thread); return { thread }; }
    if (method === 'thread/read') return { thread: this.threads.find((t) => t.id === params.threadId) };
    if (method === 'thread/turns/list') return { data: [...this.threads.find((t) => t.id === params.threadId).turns].reverse(), nextCursor: null };
    if (method === 'thread/queue/list') return { data: this.queue, nextCursor: null };
    if (method === 'thread/queue/add') {
      const item = { id: `queue-${++this.commits}`, input: params.input, clientUserMessageId: params.clientUserMessageId };
      this.queue.push(item);
      if (this.fault === 'queue-add-EPIPE') throw new Error('write EPIPE after queue commit');
      return { queuedSubmission: item };
    }
    if (method === 'thread/queue/update') {
      if (this.fault === 'queue-rejection') throw Object.assign(new Error('Native queue validation error'), { definite: true });
      const item = this.queue.find((q) => q.id === params.queuedSubmissionId); item.input = params.input; this.commits++;
      if (this.fault === 'queue-update-EPIPE') throw new Error('write EPIPE after queue update');
      return { queuedSubmission: item };
    }
    if (method === 'turn/start') {
      if (this.fault === 'native-rejection') throw Object.assign(new Error('Explicit native validation error'), { definite: true });
      const turn = { id: `native-commit-${++this.commits}`, status: 'inProgress', items: [{ id: 'native-user-message', type: 'userMessage', clientId: params.clientUserMessageId, content: params.input }] };
      this.threads.find((t) => t.id === params.threadId).turns.push(turn);
      if (this.fault === 'EPIPE') throw new Error('write EPIPE');
      if (this.fault === 'parser') return {};
      return { turn };
    }
    return {};
  }
}
async function setup(t, { relay = OldRelay, transform = (r) => r } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'bots-envelope-'));
  const journal = new Store(join(dir, 'state.sqlite')), native = new Native();
  t.after(async () => { journal.close(); await rm(dir, { recursive: true, force: true }); });
  const runtime = new BotRuntime({ store: journal, codex: native, root: join(dir, 'bots') });
  await runtime.start();
  runtime.newBotDefaults = { model: 'gpt-6-luna', effort: 'high' }; // Match this synthetic catalog, not production defaults.
  t.after(() => runtime.secure?.close());
  const bot = await runtime.handle({ method: 'bots.create', params: { name: 'Envelope test' }, operationId: 'create-envelope-bot' });
  const timers = new Map(); let timerId = 0;
  const env = browserRuntime({ Error, TypeError, btoa, atob, localStorage: entries(), WebSocket: { OPEN: 1 },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) });
  const { BotsClient } = env.load('app/bots/client.ts');
  const { BotDraftStore } = env.load('app/bots/draft-store.ts');
  const { BotComposer } = env.load('app/bots/composer-controller.ts');
  const client = new BotsClient(); client.owner = 'synthetic-owner'; client.online = true;
  const requests = [], bridgeReplies = [], browserReplies = [], frames = [], parserErrors = [], pipelineErrors = [];
  const socket = (id, role, onSend) => ({ readyState: 1, deserializeAttachment: () => ({ id, role, owner: client.owner, expiresAt: Date.now() + 60000 }), close() { this.readyState = 3; }, send: onSend });
  const browserSocket = socket('browser', 'browser', (json) => {
    const response = JSON.parse(json); browserReplies.push(response);
    try { client.receive(response); } catch (error) { parserErrors.push(error); for (const fn of [...timers.values()]) fn(); }
  });
  const machineSocket = socket('machine', 'machine', (json) => {
    const request = JSON.parse(json); requests.push(request);
    void bridgeResponse(runtime, request).then(async (response) => {
      bridgeReplies.push(response);
      const outgoing = transform(structuredClone(response), request);
      const chunks = []; sendLarge({ send(json) { frames.push(json); chunks.push(json); } }, outgoing);
      for (const chunk of chunks) await instance.webSocketMessage(machineSocket, chunk);
    }).catch((error) => { pipelineErrors.push(error); for (const fn of [...timers.values()]) fn(); });
  });
  const instance = new relay({ getWebSockets: () => [browserSocket, machineSocket] }, {});
  client.socket = { readyState: 1, close() {}, send: (json) => { void instance.webSocketMessage(browserSocket, json); } };
  const drafts = new BotDraftStore(env.indexedDB); const composer = new BotComposer(client.owner, bot.id, drafts, client); await composer.open();
  t.after(() => assert.deepEqual(pipelineErrors, []));
  return { runtime, native, journal, bot, composer, client, drafts, requests, bridgeReplies, browserReplies, frames, parserErrors, machineSocket };
}

// This assertion pins the deployed fixture independently of current relay edits.
test('deployed old relay fixture is the v135 response allowlist', () => {
  assert.equal(execFileSync('git', ['rev-parse', `${oldRef}:bots-relay/src/index.ts`], { encoding: 'utf8' }).trim(), '9081b8b72eb9c49e3266457cc64c88006335447d');
});

test('runtime validation -> serializer -> deployed old relay -> real client allows corrected retry', async (t) => {
  const h = await setup(t); const { composer, runtime, journal, bot } = h;
  runtime.saveBot(bot, { archived: true });
  composer.setText('retained invalid draft'); await composer.flush(); await composer.send();
  assert.equal(h.bridgeReplies[0].outcome, 'rejected');
  assert.equal(h.browserReplies[0].outcome, undefined);
  assert.deepEqual(Object.keys(h.browserReplies[0]).sort(), ['error', 'id', 'result', 'type']);
  assert.equal(h.browserReplies[0].result.__dawarBotFailure.outcome, 'rejected');
  assert.equal(h.browserReplies[0].result.__dawarBotFailure.operationId, h.requests[0].operationId);
  assert.equal(composer.operation, undefined); assert.equal(composer.draft.text, 'retained invalid draft');
  runtime.saveBot(journal.bot(bot.id), { archived: false }); composer.setText('corrected draft'); await composer.flush(); await composer.send();
  assert.notEqual(h.requests[0].operationId, h.requests[1].operationId); assert.equal(h.native.commits, 1); assert.equal(composer.draft.text, '');
});

test('native boundary certainty and same IDs survive the deployed old relay', async (t) => {
  for (const fault of ['native-rejection', 'EPIPE', 'parser', 'local-after-commit', 'journal-after-commit']) await t.test(fault, async (t) => {
    const h = await setup(t); const { composer, native, runtime, journal } = h;
    native.fault = fault;
    const echo = runtime.emitUserMessage.bind(runtime), save = journal.saveOperation.bind(journal);
    if (fault === 'local-after-commit') runtime.emitUserMessage = () => { throw Object.assign(new Error('Local error after native commit'), { definite: true, outcome: 'rejected' }); };
    if (fault === 'journal-after-commit') journal.saveOperation = (...args) => { if (args[2] === 'done') throw new Error('Operation journal completion failed'); return save(...args); };
    composer.setText('submitted once'); await composer.flush(); await composer.send();
    const id = h.requests[0].operationId;
    native.fault = ''; runtime.emitUserMessage = echo; journal.saveOperation = save;
    if (fault === 'native-rejection') {
      assert.equal(h.browserReplies[0].result.__dawarBotFailure.outcome, 'rejected'); assert.equal(composer.operation, undefined);
      assert.equal(native.commits, 0); composer.setText('corrected'); await composer.flush(); await composer.send();
      assert.notEqual(h.requests[1].operationId, id);
    } else {
      assert.equal(h.browserReplies[0].result.__dawarBotFailure.outcome, 'uncertain'); assert.equal(composer.operation.id, id);
      composer.setText('newer unsubmitted draft'); await composer.flush(); await composer.reconcile();
      assert.equal(h.requests[1].operationId, id); assert.equal(composer.operation, undefined); assert.equal(composer.draft.text, 'newer unsubmitted draft');
      assert.equal(native.calls.filter((c) => c.method === 'turn/start').length, 1);
    }
    assert.equal(native.commits, 1);
  });
});

const invalid = {
  missing: (r) => { delete r.result; },
  null: (r) => { r.result = null; },
  unknownVersion: (r) => { r.result.__dawarBotFailure.version = 2; },
  stringVersion: (r) => { r.result.__dawarBotFailure.version = '1'; },
  unknownOutcome: (r) => { r.result.__dawarBotFailure.outcome = 'failed'; },
  wrongOperation: (r) => { r.result.__dawarBotFailure.operationId = 'another-operation'; },
  missingOperation: (r) => { delete r.result.__dawarBotFailure.operationId; },
  extraMetadata: (r) => { r.result.__dawarBotFailure.definite = true; },
  extraResult: (r) => { r.result.turn = { id: 'looks-successful' }; },
  array: (r) => { r.result = [{ __dawarBotFailure: r.result.__dawarBotFailure }]; },
  malformedChunk: (r) => { r.result = { __chunk: true, offset: 0, total: 1, data: btoa('{') }; },
};
test('missing/malformed/unknown old-relay metadata cannot retire a durable ID', async (t) => {
  for (const [label, damage] of Object.entries(invalid)) await t.test(label, async (t) => {
    const h = await setup(t, { transform(r) { damage(r); return r; } });
    h.runtime.saveBot(h.bot, { archived: true }); h.composer.setText('kept'); await h.composer.flush();
    await h.composer.send(); const id = h.composer.operation.id; await h.composer.reconcile();
    assert.equal(h.requests.length, 2); assert.equal(h.requests[0].operationId, id); assert.equal(h.requests[1].operationId, id);
    assert.equal(h.composer.operation.id, id); assert.equal(h.composer.draft.text, 'kept'); assert.equal(h.native.commits, 0);
    if (label === 'malformedChunk') assert.equal(h.parserErrors.length, 2);
  });
});

test('current optional-top-field relay preserves valid metadata and detects contradictory channels', async (t) => {
  for (const [label, damage, outcome] of [
    ['agree', () => {}, 'rejected'],
    ['conflict', (r) => { r.outcome = 'uncertain'; }, 'uncertain'],
    ['unknown top', (r) => { r.outcome = 'future-outcome'; }, 'uncertain'],
    ['opposite conflict', (r) => { r.result.__dawarBotFailure.outcome = 'uncertain'; }, 'uncertain'],
    ['malformed metadata despite rejected top', (r) => { r.result.__dawarBotFailure.version = 9; }, 'uncertain'],
  ]) await t.test(label, async (t) => {
    const h = await setup(t, { relay: NewRelay, transform(r) { damage(r); return r; } });
    h.runtime.saveBot(h.bot, { archived: true }); h.composer.setText('kept'); await h.composer.flush(); await h.composer.send();
    assert.equal(Boolean(h.composer.operation), outcome === 'uncertain'); assert.equal(h.native.commits, 0);
  });
});

test('oversized error remains a bounded plain-string error with metadata through actual sendLarge and old relay', async (t) => {
  const h = await setup(t);
  h.runtime.dispatch = async () => { throw new Error('\u0000'.repeat(400000)); };
  h.composer.setText('kept'); await h.composer.flush(); await h.composer.send();
  assert.equal(h.frames.length, 1); assert.ok(Buffer.byteLength(h.frames[0]) < 380000);
  assert.equal(typeof h.browserReplies[0].error, 'string'); assert.match(h.browserReplies[0].error, /truncated/);
  assert.equal(h.composer.operation, undefined); assert.equal(h.composer.draft.text, 'kept');
});

test('success payload remains unchanged through chunking and cannot be interpreted as failure metadata', async (t) => {
  const h = await setup(t);
  const result = { turn: { id: 'native-success' }, text: 'x'.repeat(400000), __dawarBotFailure: { version: 1, operationId: 'wrong-id', outcome: 'rejected' } };
  h.runtime.handle = async () => result;
  const response = await h.client.rpc('turn.send', h.bot.id, {}, 'success-stable-id', { managed: true });
  assert.equal(JSON.stringify(response), JSON.stringify(result)); assert.ok(h.frames.length > 1);
  assert.equal(h.browserReplies.every((r) => r.error === undefined), true);
});


test('queue add/update retain native certainty and same-ID behavior through old relay', async (t) => {
  const h = await setup(t); const { composer, native } = h;
  native.fault = 'queue-add-EPIPE'; composer.setText('queue once'); await composer.flush(); await composer.send(true);
  const addId = composer.operation.id; native.fault = ''; await composer.reconcile();
  assert.equal(h.requests[1].operationId, addId); assert.equal(composer.operation, undefined); assert.equal(native.commits, 1);
  const queued = (await h.runtime.queueList(h.journal.bot(h.bot.id)))[0];
  composer.edit({ ...queued, attachments: [] }); await composer.flush();
  native.fault = 'queue-rejection'; composer.setText('invalid queue edit'); await composer.flush(); await composer.send();
  const rejectedId = h.requests.at(-1).operationId;
  assert.equal(composer.operation, undefined); assert.equal(composer.draft.text, 'invalid queue edit');
  native.fault = 'queue-update-EPIPE'; composer.setText('corrected queue edit'); await composer.flush(); await composer.send();
  const updateId = composer.operation.id; assert.notEqual(updateId, rejectedId);
  native.fault = ''; await composer.reconcile();
  assert.equal(composer.operation.id, updateId); assert.equal(h.requests.at(-1).operationId, updateId);
  assert.equal(native.commits, 2); // Queue update cannot be proven after lost acknowledgement; never repeat it.
  assert.equal(native.calls.filter((c) => c.method === 'thread/queue/update').length, 2); // rejection + one commit
});

test('v135 client still receives a plain readable error through the old relay', async () => {
  const OldClient = compile(execFileSync('git', ['show', `${oldRef}:app/bots/client.ts`], { encoding: 'utf8' }), {
    localStorage: entries(), WebSocket: { OPEN: 1 }, setTimeout: () => 1, clearTimeout() {},
  }).BotsClient;
  const client = new OldClient(); client.owner = 'synthetic-old-owner'; client.online = true;
  const browserSocket = { deserializeAttachment: () => ({ id: 'old-browser', role: 'browser', expiresAt: Date.now() + 60000 }), send: (json) => client.receive(JSON.parse(json)) };
  const machineSocket = { deserializeAttachment: () => ({ id: 'machine', role: 'machine', expiresAt: Date.now() + 60000 }) };
  const relay = new OldRelay({ getWebSockets: () => [browserSocket, machineSocket] }, {});
  let request;
  client.socket = { readyState: 1, send: (json) => { request = JSON.parse(json); } };
  for (const outcome of ['rejected', 'uncertain']) {
    const pending = client.rpc('turn.send', 'bot', { text: 'old client draft' }, `old-client-${outcome}`);
    const text = `Readable ${outcome} error`;
    const assertion = assert.rejects(pending, (error) => error.message === text);
    const response = await bridgeResponse({ handle: async () => { throw Object.assign(new Error(text), { outcome }); } }, { ...request, clientId: 'old-browser' });
    const frames = []; sendLarge({ send: (json) => frames.push(json) }, response);
    for (const frame of frames) await relay.webSocketMessage(machineSocket, frame);
    await assertion;
  }
});
