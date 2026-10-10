import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBObjectStore } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';

function storage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return { get length() { return entries.size; }, key: (i) => [...entries.keys()][i] ?? null,
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key) };
}
function setup(seed = {}, extra = {}) {
  const timers = new Map(), intervals = new Map(); let timerId = 0;
  const localStorage = storage(seed);
  const sockets = [];
  class Socket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    sent = [];
    constructor() { sockets.push(this); }
    send(value) { this.sent.push(value === "ping" ? value : JSON.parse(value)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const env = runtime({ localStorage, btoa, atob, WebSocket: Socket, Element: class {}, Error, TypeError,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id),
    setInterval: (fn) => { intervals.set(++timerId, fn); return timerId; }, clearInterval: (id) => intervals.delete(id),
    ...extra,
  });
  const { BotsClient, BotRpcError } = env.load('app/bots/client.ts');
  const client = new BotsClient();
  return { ...env, client, localStorage, timers, intervals, sockets, Socket, BotRpcError };
}
const session = (owner) => ({ owner, ticket: 'test-only', timeZone: 'UTC', machineId: 'machine', url: 'wss://example.invalid' });
const snapshot = (owner) => ({ bots: [{ id: `${owner}-bot` }], pending: [], defaults: {}, ready: true });

test('established owner restores cached bots synchronously offline; auth denial locks access without deleting drafts', async () => {
  const env = setup({ 'dawar-bots:last-owner': 'alice', 'dawar-bots:alice:snapshot': JSON.stringify(snapshot('alice')), 'dawar-bots:alice:draft:bot-a': '"kept"', 'dawar-bots:alice:uploads:bot-a': '[{"kept":true}]' });
  const { client, localStorage } = env;
  client.session = async () => { throw new TypeError('offline'); };
  client.start(); assert.equal(client.owner, 'alice'); assert.equal(client.snapshot.bots[0].id, 'alice-bot');
  await Promise.resolve(); client.clearOwnerCache();
  assert.equal(client.owner, ''); assert.equal(client.snapshot, null); assert.equal(localStorage.getItem('dawar-bots:last-owner'), null);
  assert.equal(localStorage.getItem('dawar-bots:alice:draft:bot-a'), '"kept"'); assert.ok(localStorage.getItem('dawar-bots:alice:uploads:bot-a'));
});

test('confirmed owner change rejects pending old operations, replaces cached bots, and ignores old socket messages', async () => {
  const { client, sockets, localStorage } = setup({ 'dawar-bots:alice:snapshot': JSON.stringify(snapshot('alice')), 'dawar-bots:bob:snapshot': JSON.stringify(snapshot('bob')) });
  client.session = async () => session('alice'); await client.connect(); client.online = true;
  const oldSocket = sockets[0];
  const pending = client.rpc('turn.send', 'alice-bot', { text: 'private' }, 'stable-old-operation', { owner: 'alice', managed: true });
  const rejected = assert.rejects(pending, (e) => e.outcome === 'uncertain');
  client.session = async () => session('bob'); await client.connect(); await rejected;
  assert.equal(client.owner, 'bob'); assert.equal(client.snapshot.bots[0].id, 'bob-bot');
  oldSocket.onmessage({ data: JSON.stringify({ type: 'event', event: { type: 'bot', data: { id: 'private-old-bot' } } }) });
  assert.equal(client.snapshot.bots[0].id, 'bob-bot');
  assert.equal(localStorage.getItem('dawar-bots:last-owner'), 'bob');
  client.clearOwnerCache();
});

test('managed operation timeout and reconnect replay keep stable request identity and avoid legacy double replay', async () => {
  const { client, Socket, timers } = setup({ 'dawar-bots:alice:operations': JSON.stringify({ legacy: { method: 'turn.send', operationId: 'legacy-stable-send', botId: 'bot-a', params: { text: 'old' } } }) });
  client.owner = 'alice'; client.online = true; client.socket = new Socket();
  const pending = client.rpc('turn.send', 'bot-a', { text: 'submitted' }, 'same-stable-operation', { owner: 'alice', managed: true });
  const failure = assert.rejects(pending, (e) => e.outcome === 'uncertain');
  client.replayPending();
  assert.equal(client.socket.sent.length, 2); assert.equal(client.socket.sent[0].operationId, client.socket.sent[1].operationId);
  [...timers.values()][0](); await failure;
  assert.equal(client.pending.size, 0); client.clearOwnerCache();
});

test('upload restart uses stable begin/chunk/finish IDs with identical payloads', async () => {
  const { client } = setup(); client.owner = 'alice'; const calls = [];
  client.rpc = async (...args) => { calls.push(args); return { id: 'upload-stable-id', ready: args[0] === 'attachments.finish' }; };
  const file = new File(['abc'.repeat(100000)], 'image.png', { type: 'image/png' });
  await client.upload('bot-a', file, () => {}, 'upload-stable-id', 'alice', 'legacy'); const first = calls.splice(0);
  await client.upload('bot-a', file, () => {}, 'upload-stable-id', 'alice', 'legacy');
  assert.deepEqual(calls, first); assert.deepEqual(calls.map((c) => c[3]), ['upload-stable-id', 'upload-stable-id:chunk:0', 'upload-stable-id:chunk:262144', 'upload-stable-id:finish']);
  for (const call of calls) assert.equal(call[4].owner, 'alice');
});

test('malformed response after dispatch is uncertain; definitive runtime rejection is distinct', async () => {
  const { client, Socket } = setup(); client.owner = 'alice'; client.online = true; client.socket = new Socket();
  const invalid = client.rpc('turn.send', 'bot-a', {}, 'stable-id-invalid', { managed: true });
  const invalidCheck = assert.rejects(invalid, (e) => e.outcome === 'uncertain');
  client.receive({ type: 'response', id: client.socket.sent.at(-1).id, result: { __chunk: true, offset: 10, total: 100 } }); await invalidCheck;
  const failed = client.rpc('turn.send', 'bot-a', {}, 'stable-id-failed', { managed: true });
  const failedCheck = assert.rejects(failed, (e) => e.outcome === 'rejected');
  client.receive({ type: 'response', id: client.socket.sent.at(-1).id, error: 'Bot is archived.', outcome: 'rejected' }); await failedCheck;
  client.clearOwnerCache();
});

test('401/403 revokes access even if an error response is malformed JSON', async () => {
  const { client } = setup({}, { fetch: async () => new Response('not-json', { status: 403 }) });
  client.owner = 'alice'; client.snapshot = snapshot('alice');
  await assert.rejects(client.session()); assert.equal(client.owner, ''); assert.equal(client.snapshot, null);
});

test('bounded durable history cache opens offline after a new runtime, and failed migration retains legacy history', async () => {
  const legacyKey = 'dawar-bots:alice:history:bot-a';
  const history = { turns: [{ id: 'old', items: [] }], attachments: [] };
  const { load, localStorage, indexedDB } = setup({ [legacyKey]: JSON.stringify(history) });
  const cache = load('app/bots/history-cache.ts');
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = original.apply(this, args);
    if (this.name === 'histories') request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try {
    assert.equal((await cache.readBotHistory('alice', 'bot-a')).turns[0].id, 'old');
    await assert.rejects(cache.saveBotHistory('alice', 'bot-a', history));
    assert.ok(localStorage.getItem(legacyKey));
  } finally { IDBObjectStore.prototype.put = original; }
  await cache.saveBotHistory('alice', 'bot-a', history); assert.equal(localStorage.getItem(legacyKey), null);
  const reloaded = runtime({ indexedDB, localStorage }).load('app/bots/history-cache.ts');
  assert.equal((await reloaded.readBotHistory('alice', 'bot-a')).turns[0].id, 'old');
  assert.equal(await reloaded.readBotHistory('bob', 'bot-a'), null);
  const huge = { turns: Array.from({ length: 1000 }, (_, i) => ({ id: String(i), items: [{ text: 'x'.repeat(10000) }] })), attachments: [] };
  const bounded = cache.boundedHistory(huge); assert.ok(bounded.turns.length < 100); assert.equal(bounded.turns.at(-1).id, '999');
  const newestTooLarge = { turns: [{ items: [{ text: 'x'.repeat(600000) }] }], attachments: [] };
  assert.equal(cache.boundedHistory(newestTooLarge), null);
  await cache.saveBotHistory('alice', 'bot-a', newestTooLarge);
  assert.equal((await reloaded.readBotHistory('alice', 'bot-a')).turns[0].id, 'old');
  localStorage.setItem(legacyKey, JSON.stringify(history));
  await cache.saveBotHistory('alice', 'bot-a', newestTooLarge);
  assert.ok(localStorage.getItem(legacyKey));
});

test('actual client response/parser/reconnect failures retain a composer operation across retry', async () => {
  const env = setup();
  const { client, Socket, load, indexedDB, localStorage, timers } = env;
  const { BotDraftStore } = load('app/bots/draft-store.ts');
  const { BotComposer } = load('app/bots/composer-controller.ts');
  const store = new BotDraftStore(indexedDB, localStorage);
  client.owner = 'alice'; client.online = true; client.socket = new Socket();
  const c = new BotComposer('alice', 'bot-a', store, client); await c.open(); c.setText('submitted once'); await c.flush();
  const untilSent = async (count) => { for (let i = 0; i < 100; i++) { if (client.socket.sent.length >= count) return; await new Promise((r) => setTimeout(r, 2)); } assert.fail('request not sent'); };
  const errors = ['The VM is offline. Your draft has been kept.', 'Unexpected end of JSON input', 'write EPIPE', 'The runtime restarted.', 'Cannot read properties of undefined', 'Invalid response transfer.', 'Native state could not be loaded.', 'Restore this bot first.'];
  let operationId;
  for (const error of errors) {
    const before = client.socket.sent.length;
    const sending = c.send(); await untilSent(before + 1);
    const request = client.socket.sent.at(-1); operationId ??= request.operationId;
    assert.equal(request.operationId, operationId);
    client.receive({ type: 'response', id: request.id, error }); await sending;
    assert.equal(c.operation.id, operationId); assert.equal(c.draft.text, 'submitted once');
  }
  // A syntactically valid but structurally invalid success is not an ack.
  let before = client.socket.sent.length; let sending = c.send(); await untilSent(before + 1);
  client.receive({ type: 'response', id: client.socket.sent.at(-1).id, result: {} }); await sending;
  assert.equal(c.operation.id, operationId);
  // Reassembly/parser failures retain the request until its uncertain timeout.
  before = client.socket.sent.length; sending = c.send(); await untilSent(before + 1);
  assert.throws(() => client.receive({ type: 'response', id: client.socket.sent.at(-1).id, result: { __chunk: true, total: 1, offset: 0, data: btoa('{') } }));
  for (const timeout of [...timers.values()]) timeout(); await sending;
  assert.equal(c.operation.id, operationId);
  before = client.socket.sent.length; sending = c.send(); await untilSent(before + 1);
  client.receive({ type: 'response', id: client.socket.sent.at(-1).id, result: { turn: { id: 'native-committed-once' } } }); await sending;
  assert.equal(c.operation, undefined); assert.equal(c.draft.text, '');
  assert.equal(new Set(client.socket.sent.map((r) => r.operationId)).size, 1);
  client.clearOwnerCache();
});

test('heartbeat detects half-open sockets, pong extends liveness and reconnect retains original mutation identity', async () => {
  let clock = 1000;
  class ClockDate extends Date { static now() { return clock; } }
  const { client, sockets, intervals } = setup({}, { Date: ClockDate });
  client.session = async () => session('alice');
  client.refresh = async () => snapshot('alice');
  await client.connect();
  const first = sockets[0];
  client.receive({ type: 'authenticated', online: true });
  const sending = client.rpc('turn.send', 'bot-a', {}, 'original-send', { managed: true });
  const request = first.sent.at(-1);
  const pulse = [...intervals.values()][0];
  clock += 25000; pulse(); assert.equal(first.readyState, 1);
  first.onmessage({ data: 'pong' });
  clock += 40000; pulse(); assert.equal(first.readyState, 1, 'pong keeps a quiet connection alive');
  clock += 21000; pulse();
  assert.equal(first.readyState, 3); assert.equal(client.online, false);
  assert.equal(client.pending.size, 1, 'a transport failure is not native rejection');
  assert.ok(client.reconnectTimer);
  await client.connect();
  client.receive({ type: 'authenticated', online: true });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(sockets[1].sent.find(value => value.operationId === 'original-send').operationId, request.operationId);
  const active = [...client.pending.keys()][0];
  client.receive({ type: 'response', id: active, result: { turn: { id: 'native-once' } } });
  assert.equal((await sending).turn.id, 'native-once');
  client.clearOwnerCache();
});

test('latest connection attempt owns the socket, superseded sockets close and unauthenticated setup times out', async () => {
  const { client, sockets, timers } = setup();
  const pendingSessions = [];
  client.session = () => new Promise(resolve => pendingSessions.push(resolve));
  const oldAttempt = client.connect(), newAttempt = client.connect();
  pendingSessions[1](session('alice')); await newAttempt;
  pendingSessions[0](session('alice')); await oldAttempt;
  assert.equal(sockets.length, 1, 'late older session cannot replace the winning socket');
  client.session = async () => session('alice');
  await client.connect();
  assert.equal(sockets[0].readyState, 3, 'replacement closes superseded transport');
  const socket = sockets[1];
  const handshake = timers.get(client.handshakeTimer);
  handshake();
  assert.equal(socket.readyState, 3);
  assert.ok(client.reconnectTimer);
  assert.match(client.error, /setup timed out/);
  client.clearOwnerCache();
});

test('socket replacement discards partial transfer bytes and settles only the replayed original operation', async () => {
  const { client } = setup();
  client.session = async () => session('alice');
  await client.connect(); client.online = true;
  const result = client.rpc('turn.send', 'bot-a', {}, 'same-operation', { managed: true });
  const id = [...client.pending.keys()][0];
  const bytes = new TextEncoder().encode(JSON.stringify({ turn: { id: 'native-turn' } }));
  const encode = bytes => btoa(String.fromCharCode(...bytes));
  client.receive({ type: 'response', id, result: { __chunk: true, total: bytes.length, offset: 0, data: encode(bytes.slice(0, 4)) } });
  assert.equal(client.pending.get(id).received, 4);
  client.eventChunks.set(1, { bytes: new Uint8Array(10), received: 4 });
  await client.connect();
  assert.equal(client.pending.get(id).received, undefined);
  assert.equal(client.eventChunks.size, 0);
  client.receive({ type: 'response', id, result: { __chunk: true, total: bytes.length, offset: 0, data: encode(bytes) } });
  assert.equal((await result).turn.id, 'native-turn');
  client.clearOwnerCache();
});
