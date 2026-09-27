import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Store } from './store.mjs';
import { BotRuntime } from './runtime.mjs';
import { bridgeResponse } from './response.mjs';
import { registerNativeItem } from './artifact-outputs.mjs';
import { artifactMetadata } from './artifact-library.mjs';
import { HISTORY_ATTACHMENT_BYTES, HISTORY_ATTACHMENT_LIMIT } from './history-attachments.mjs';
import { runtime as browserRuntime } from '../tests/helpers/load-ts.mjs';
import { syntheticArtifactPdf } from '../tests/fixtures/bot-artifact-files.mjs';

const agent = (id, text) => ({ id, type: 'agentMessage', text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
const tool = (id) => ({ id, type: 'imageGeneration', status: 'completed', result: 'native body is not metadata', savedPath: null });
const turn = (id, items) => ({ id, items, status: 'completed', startedAt: 100, completedAt: 101 });
const ids = (response) => response.attachments.map((a) => a.id).sort();

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'history-artifact-contract-')), store = new Store(join(root, 'state.sqlite'));
  const codex = new EventEmitter(); codex.turns = []; codex.calls = [];
  codex.call = async (method, params) => {
    codex.calls.push({ method, params }); assert.equal(method, 'thread/turns/list');
    return { data: codex.turns, nextCursor: null };
  };
  const runtime = new BotRuntime({ store, codex, root }), bots = [];
  for (const id of ['alpha', 'beta']) {
    const bot = { id, slug: id, threadId: 'thread-' + id, name: id, color: '#123456', cwd: join(root, id), archived: false, updatedAt: 'stable' };
    await mkdir(bot.cwd); store.saveBot(bot); runtime.loaded.add(bot.threadId); bots.push(bot);
  }
  const env = browserRuntime({ Error, WebSocket: { OPEN: 1 } });
  const client = new (env.load('app/bots/client.ts').BotsClient)(); client.owner = 'synthetic-owner'; client.online = true;
  const requests = [];
  client.socket = { readyState: 1, send(json) {
    const request = JSON.parse(json); requests.push(request);
    void bridgeResponse(runtime, request).then((reply) => client.receive(JSON.parse(JSON.stringify(reply))));
  } };
  const rpc = (method, params = {}, bot = bots[0]) => client.rpc(method, bot.id, params, undefined, { owner: client.owner });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, store, codex, runtime, bots, client, rpc, requests };
}
function metadata(store, bot, id, values = {}) {
  return store.put('attachment', { id, botId: bot.id, name: id + '.pdf', mimeType: 'application/pdf', size: 123,
    ready: true, artifact: true, createdAt: '2026-08-10T10:00:00+02:00', path: join(bot.cwd, 'not-opened', id), ...values });
}
function prohibitHydration(store, runtime) {
  store.list = () => { throw new Error('History must not hydrate any library.'); };
  runtime.readAttachment = () => { throw new Error('History must not load file bytes.'); };
}

test('fresh real history responses deliver published PDF, native image and input metadata through the real client', async (t) => {
  const { store, codex, runtime, bots: [bot], rpc } = await setup(t);
  const pdf = syntheticArtifactPdf(), image = await sharp({ create: { width: 8, height: 5, channels: 3, background: '#ff3300' } }).png().toBuffer();
  await writeFile(join(bot.cwd, 'report.pdf'), pdf);
  const published = await runtime.publishArtifact(bot, { path: 'report.pdf' }, { key: 'publication', turnId: 'turn', itemId: 'publish-call' });
  await registerNativeItem(runtime, bot, 'turn', { ...tool('native-image'), result: image.toString('base64') });
  const native = store.db.prepare("SELECT json FROM records WHERE kind='attachment' AND json_extract(json,'$.source')='native'").get();
  const nativeId = JSON.parse(native.json).id;
  const input = await runtime.beginUpload(bot, { name: 'input.png', mimeType: 'image/png', size: image.length }, 'input-image');
  await runtime.uploadChunk(bot, { id: input.id, offset: 0, data: image.toString('base64') }); await runtime.finishUpload(bot, { id: input.id });
  const inputItem = { id: 'user', type: 'userMessage', content: [{ type: 'localImage', path: input.path }] };
  codex.turns = [turn('turn', [inputItem, tool('native-image'), agent('answer', '[Report](bot-artifact:' + published.attachmentId + ')')])];
  const originalRead = runtime.readAttachment.bind(runtime); prohibitHydration(store, runtime);
  const page = await rpc('history.view'); assert.equal(page.kind, 'page');
  assert.deepEqual(ids(page), [input.id, nativeId, published.attachmentId].sort());
  assert.equal(page.entries.find((e) => e.id === 'native-image').item, null, 'provenance works for collapsed native entries');
  for (const a of page.attachments) {
    const stored = store.get('attachment', a.id), expected = artifactMetadata(stored, bot);
    assert.equal(a.botId, bot.id); assert.equal(a.ready, true); assert.deepEqual(a.preview, expected.preview);
    assert.equal(a.createdAt, expected.createdAt); assert.equal(a.name, stored.name); assert.equal(a.size, stored.size);
    assert.equal('sha256' in a, false); assert.equal('received' in a, false); assert.equal('data' in a, false);
    if (a.id === input.id) { assert.equal(a.path, input.path); assert.equal(a.direction, 'input'); }
    else { assert.equal('path' in a, false); assert.equal(a.direction, 'output'); assert.equal(a.artifact, true); }
  }
  const detail = await rpc('history.detail', { turnId: 'turn', itemId: 'answer' }); assert.deepEqual(ids(detail), [published.attachmentId]);
  const nativeDetail = await rpc('history.detail', { turnId: 'turn', itemId: 'native-image' }); assert.deepEqual(ids(nativeDetail), [nativeId]);
  const userDetail = await rpc('history.detail', { turnId: 'turn', itemId: 'user' }); assert.deepEqual(ids(userDetail), [input.id]); assert.equal(userDetail.attachments[0].path, input.path);
  assert.equal(codex.calls.length, 4, 'only the requested page and three detail reads, no discovery');
  // Use the actual history metadata in the lazy preview/read contract; not a
  // library response injected into the message fixture.
  runtime.readAttachment = originalRead;
  for (const a of page.attachments.filter((a) => a.direction === 'output')) {
    const preview = await rpc('artifacts.preview', { id: a.id, version: a.preview.version });
    assert.equal(preview.status, 'ready', preview.reason); assert.equal(preview.mimeType, 'image/webp');
    const original = await rpc('attachments.read', { id: a.id });
    assert.deepEqual(Buffer.from(original.data, 'base64'), a.id === nativeId ? image : pdf);
  }
});

test('context links, full-detail-only links and ready turn/item provenance are scoped without path or cross-bot disclosure', async (t) => {
  const { store, codex, runtime, bots: [bot, other], rpc } = await setup(t);
  const context = metadata(store, bot, 'context-pdf'), deep = metadata(store, bot, 'deep-pdf');
  const native = metadata(store, bot, 'native-output', { source: 'native', createdAt: null, provenance: { threadId: bot.threadId, turnId: 'turn', itemId: 'native-39' } });
  metadata(store, bot, 'published-output', { provenance: { turnId: 'turn', itemId: 'native-38' } });
  metadata(store, bot, 'wrong-thread', { provenance: { threadId: other.threadId, turnId: 'turn', itemId: 'native-39' } });
  metadata(store, bot, 'wrong-turn', { provenance: { turnId: 'other-turn', itemId: 'native-39' } });
  metadata(store, bot, 'pending', { ready: false, provenance: native.provenance });
  metadata(store, other, 'foreign', { provenance: native.provenance });
  metadata(store, bot, 'arbitrary-path');
  const answer = agent('answer', '[Context](bot-artifact:' + context.id + ') [Foreign](bot-artifact:foreign) [Pending](bot-artifact:pending) /bot-artifact:arbitrary-path/file.pdf ' + 'x'.repeat(20000) + ' [Full](bot-artifact:' + deep.id + ')');
  codex.turns = [turn('turn', [answer, ...Array.from({ length: 41 }, (_, i) => tool('native-' + i))])];
  prohibitHydration(store, runtime);
  const page = await rpc('history.view'); assert.equal(page.entries.length, 40); assert.equal(page.contextEntries[0].id, answer.id);
  assert.deepEqual(ids(page), ['context-pdf', 'native-output', 'published-output']);
  assert.equal(page.attachments.find((a) => a.id === native.id).createdAt, null);
  const detail = await rpc('history.detail', { turnId: 'turn', itemId: answer.id });
  assert.deepEqual(ids(detail), ['context-pdf', 'deep-pdf']); assert.equal(JSON.parse(detail.json).text, answer.text);
  assert.ok(page.attachments.every((a) => !('path' in a) && a.botId === bot.id));
  await assert.rejects(rpc('history.view', {}, { id: 'unknown-bot' }), /not found/);
  codex.turns = [turn('turn', [answer, tool('native-39')])];
  const foreignPage = await rpc('history.view', {}, other);
  assert.deepEqual(ids(foreignPage), ['foreign'], 'explicit owned IDs work but never disclose the other bot');
});

test('late attachment metadata replays without a history fetch and refreshes conditional/chunked detail independently of text', async (t) => {
  const { store, codex, runtime, bots: [bot], rpc } = await setup(t);
  codex.turns = [turn('turn', [agent('answer', '[Late](bot-artifact:late) ' + 'a'.repeat(100000)), tool('native')])];
  prohibitHydration(store, runtime);
  const page = await rpc('history.view'), first = await rpc('history.detail', { turnId: 'turn', itemId: 'answer' });
  assert.deepEqual(page.attachments, []); assert.deepEqual(first.attachments, []); assert.ok(first.nextOffset);
  const before = codex.calls.length;
  const late = metadata(store, bot, 'late'), native = metadata(store, bot, 'native', { source: 'native', provenance: { threadId: bot.threadId, turnId: 'turn', itemId: 'native' } });
  for (const a of [late, native]) runtime.emitEvent('attachment', runtime.publicAttachment(a), bot.id);
  const replay = await rpc('history.view', { revision: page.revision, after: page.eventCursor });
  assert.equal(replay.kind, 'events'); assert.equal(replay.events.length, 2); assert.notEqual(replay.revision, page.revision);
  for (const event of replay.events) { assert.equal(event.type, 'attachment'); assert.ok(event.data.preview.version); assert.equal(event.data.direction, 'output'); assert.equal('path' in event.data, false); }
  const refreshed = await rpc('history.detail', { turnId: 'turn', itemId: 'answer', knownVersion: first.version });
  assert.equal(refreshed.notModified, true); assert.equal(refreshed.json, ''); assert.equal(refreshed.version, first.version); assert.deepEqual(ids(refreshed), ['late']);
  assert.equal(refreshed.eventCursor, first.eventCursor, 'metadata refresh must not advance the native text cursor');
  const continued = await rpc('history.detail', { turnId: 'turn', itemId: 'answer', version: first.version, offset: first.nextOffset });
  assert.equal(continued.version, first.version); assert.equal(continued.attachments, undefined);
  const unchanged = await rpc('history.view', { revision: replay.revision, after: replay.eventCursor });
  assert.equal(unchanged.kind, 'unchanged'); assert.equal(codex.calls.length, before);
  // Metadata lookups do not depend on a cached event or the original item read.
  metadata(store, bot, 'late', { name: 'corrected.pdf', mimeType: 'application/octet-stream', size: 456 });
  const corrected = await rpc('history.detail', { turnId: 'turn', itemId: 'answer', knownVersion: first.version });
  assert.equal(corrected.attachments[0].name, 'corrected.pdf'); assert.equal(corrected.attachments[0].mimeType, 'application/pdf');
  assert.notEqual(corrected.attachments[0].preview.version, refreshed.attachments[0].preview.version); assert.equal(codex.calls.length, before);
  const fresh = await rpc('history.view'); assert.deepEqual(ids(fresh), ['late', 'native']);
});

test('publication during a native read preserves replay and a text event during detail lookup cannot bless stale text', async (t) => {
  const { store, codex, runtime, bots: [bot], rpc } = await setup(t);
  let unblock, started;
  let pending = new Promise((resolve) => { started = resolve; });
  const block = () => new Promise((resolve) => { unblock = resolve; started(); });
  let current = agent('answer', '[Arriving](bot-artifact:arriving)');
  codex.call = async () => { const snapshot = current; await block(); return { data: [turn('turn', [snapshot])], nextCursor: null }; };
  prohibitHydration(store, runtime);
  const opening = rpc('history.view'); await pending;
  const a = metadata(store, bot, 'arriving'); const event = runtime.emitEvent('attachment', runtime.publicAttachment(a), bot.id);
  unblock(); const page = await opening;
  assert.deepEqual(ids(page), [a.id]); assert.ok(page.eventCursor < event.seq);
  assert.equal((await rpc('history.view', { revision: page.revision, after: page.eventCursor })).events[0].seq, event.seq);
  pending = new Promise((resolve) => { started = resolve; });
  const reading = rpc('history.detail', { turnId: 'turn', itemId: 'answer' }); await pending;
  current = agent('answer', 'New authoritative text.');
  runtime.emitEvent('codex', { method: 'item/completed', params: { turnId: 'turn', item: current } }, bot.id);
  unblock(); const detail = await reading; assert.match(JSON.parse(detail.json).text, /Arriving/);
  codex.call = async () => ({ data: [turn('turn', [current])], nextCursor: null });
  const corrected = await rpc('history.detail', { turnId: 'turn', itemId: 'answer', knownVersion: detail.version });
  assert.equal(corrected.notModified, undefined); assert.notEqual(corrected.version, detail.version); assert.equal(JSON.parse(corrected.json).text, current.text);
});

test('metadata work and bytes stay bounded with a large unrelated library and deterministic indexed provenance lookups', async (t) => {
  const { store, codex, runtime, bots: [bot], rpc } = await setup(t);
  store.transaction(() => {
    for (let i = 0; i < 4000; i++) metadata(store, bot, 'unrelated-' + i, { provenance: { turnId: 'old-turn', itemId: 'old-item' } });
    for (let i = 0; i < 200; i++) metadata(store, bot, 'linked-' + String(i).padStart(3, '0'), { name: 'long-'.repeat(150) + i + '.pdf' });
    for (let i = 0; i < 100; i++) metadata(store, bot, 'native-' + String(i).padStart(3, '0'), { provenance: { threadId: bot.threadId, turnId: 'turn', itemId: 'native' } });
  });
  const prepare = store.db.prepare.bind(store.db), queries = [];
  store.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!/^SELECT (?:id,)?json FROM records/.test(sql)) return statement;
    return Object.fromEntries(['get', 'all'].map((method) => [method, (...args) => {
      const result = statement[method](...args); queries.push({ sql, args, rows: method === 'get' ? Number(Boolean(result)) : result.length }); return result;
    }]));
  };
  const text = Array.from({ length: 200 }, (_, i) => '[File](bot-artifact:linked-' + String(i).padStart(3, '0') + ')').join(' ');
  codex.turns = [turn('turn', [agent('answer', text), tool('native')])]; prohibitHydration(store, runtime);
  const page = await rpc('history.view');
  assert.ok(page.attachments.length > 0 && page.attachments.length <= HISTORY_ATTACHMENT_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(page.attachments)) <= HISTORY_ATTACHMENT_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 96 * 1024);
  assert.equal(page.attachments.some((a) => a.id === 'linked-064'), false, 'at most 64 explicit IDs selected');
  assert.ok(queries.reduce((n, q) => n + q.rows, 0) <= 71, 'no whole-library hydration');
  assert.ok(queries.length <= 68);
  for (const q of queries) {
    const plan = prepare('EXPLAIN QUERY PLAN ' + q.sql).all(...q.args).map((row) => row.detail).join('\n');
    assert.match(plan, /SEARCH records USING INDEX/); assert.doesNotMatch(plan, /SCAN records|TEMP B-TREE/);
  }
  const before = queries.length, calls = codex.calls.length;
  assert.equal((await rpc('history.view', { revision: page.revision, after: page.eventCursor })).kind, 'unchanged');
  assert.equal(queries.length, before); assert.equal(codex.calls.length, calls);
  codex.turns = [turn('turn', [tool('native')])];
  const nativePage = await rpc('history.view'); assert.deepEqual(ids(nativePage), Array.from({ length: 7 }, (_, i) => 'native-00' + i));
  assert.deepEqual(ids(await rpc('history.detail', { turnId: 'turn', itemId: 'native' })), ids(nativePage));
  const commands = Array.from({ length: 40 }, (_, i) => ({ id: 'command-' + i, type: 'commandExecution', command: '\u0001'.repeat(140), aggregatedOutput: '', status: 'completed' }));
  const links = Array.from({ length: 12 }, (_, i) => '[F](bot-artifact:linked-' + String(i).padStart(3, '0') + ')').join(' ');
  codex.turns = [turn('turn', [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: '\u0001'.repeat(4096) }] }, agent('context', links + '\u0001'.repeat(4096)), ...commands])];
  const escaped = await rpc('history.view'); assert.equal(escaped.contextEntries.length, 2);
  assert.ok(escaped.attachments.length > 0 && escaped.attachments.length < 12, 'metadata also respects the remaining serialized page budget');
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) < 96 * 1024);
});
