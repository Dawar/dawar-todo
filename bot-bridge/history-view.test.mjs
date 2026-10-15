import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { BotRuntime } from './runtime.mjs';
import { nativeItemsPage } from './test-helpers/native-items.mjs';

test('runtime history reads are scoped, nonmutating, conditional and recover full native details', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'bot-history-view-'));
  const store = new Store(join(root, 'state.sqlite')), codex = new EventEmitter(), calls = [];
  const item = { type: 'commandExecution', id: 'tool', command: 'synthetic', aggregatedOutput: 'x'.repeat(100000), status: 'completed' };
  const turns = [{ id: 'turn', items: [item], status: 'completed', startedAt: 1 }];
  codex.call = async (method, params) => { calls.push({ method, params }); if (method === 'thread/resume') return {}; if (method === 'thread/items/list') return nativeItemsPage(turns, params); return { data: turns, nextCursor: null }; };
  const runtime = new BotRuntime({ store, codex, root });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const bot = store.saveBot({ id: 'bot', threadId: 'thread', name: 'Synthetic', cwd: root, slug: 'synthetic', archived: false, updatedAt: 'stable' });
  const read = (method, params = {}, botId = bot.id) => runtime.handle({ method, botId, params });
  const page = await read('history.view'); assert.equal(page.entries[0].item, null);
  // history.view is a read-only path; it must not thread/resume (runtime.mjs case "history.view").
  assert.ok(!calls.some((call) => call.method === 'thread/resume'), 'loading chat never wakes or reconfigures a bot');
  const before = calls.length; assert.equal((await read('history.view', { revision: page.revision })).kind, 'unchanged'); assert.equal(calls.length, before);
  const event = runtime.emitEvent('codex', { method: 'item/commandExecution/outputDelta', params: { turnId: 'turn', itemId: 'tool', delta: 'new' } }, bot.id);
  const replay = await read('history.view', { revision: page.revision, after: page.eventCursor }); assert.equal(replay.kind, 'events'); assert.equal(replay.events[0].seq, event.seq);
  const detail = await read('history.detail', { turnId: 'turn', itemId: 'tool' }); assert.ok(detail.nextOffset); const scans = calls.length;
  await read('history.detail', { turnId: 'turn', itemId: 'tool', offset: detail.nextOffset, version: detail.version }); assert.equal(calls.length, scans);
  const unchanged = await read('history.detail', { turnId: 'turn', itemId: 'tool', knownVersion: detail.version }); assert.equal(unchanged.notModified, true);
  await assert.rejects(read('history.view', {}, 'missing-bot'), /found|Unknown|exist/i);
  assert.ok(calls.every((call) => ['thread/turns/list', 'thread/items/list'].includes(call.method)));
});

test('large native events are compact before storage/wire; real client refreshes only open detail and settles completion', async (t) => {
  const { runtime: browserRuntime } = await import('../tests/helpers/load-ts.mjs');
  const { IDBKeyRange } = await import('fake-indexeddb');
  const root = await mkdtemp(join(tmpdir(), 'bot-live-bound-')), store = new Store(join(root, 'state.sqlite')), codex = new EventEmitter();
  let nativeItem = { type: 'commandExecution', id: 'tool', command: 'synthetic', aggregatedOutput: 'initial', status: 'inProgress' }, scans = 0;
  const turns = () => [{ id: 'turn', items: [nativeItem], status: nativeItem.status === 'inProgress' ? 'inProgress' : 'completed', startedAt: 1 }];
  const methods = [];
  codex.call = async (method, params) => { scans++; methods.push(method); if (method === 'thread/items/list') return nativeItemsPage(turns(), params); return { data: turns(), nextCursor: null }; };
  const runtime = new BotRuntime({ store, codex, root });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.saveBot({ id: 'bot', threadId: 'thread', name: 'Synthetic', cwd: root, slug: 'synthetic', archived: false, updatedAt: 'stable' }); runtime.loaded.add('thread');
  const env = browserRuntime({ IDBKeyRange, localStorage: { getItem: () => null, setItem() {} } });
  const { BotsClient } = env.load('app/bots/client.ts'), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const client = new BotsClient(); client.owner = 'synthetic-owner'; client.online = true;
  const requests = [], responses = []; client.rpc = async (method, botId, params) => {
    requests.push(method); const json = JSON.stringify(await runtime.handle({ method, botId, params }));
    responses.push({ method, bytes: Buffer.byteLength(json) }); return JSON.parse(json);
  };
  const timeline = new BotTimeline(client.owner, 'bot', client, { read: async () => null, write: async () => {} });
  client.events.add((event) => timeline.receive(event));
  const events = []; runtime.on('event', (event) => { events.push(event); client.receive({ type: 'event', event: JSON.parse(JSON.stringify(event)) }); });
  await timeline.refresh(); const descriptor = timeline.getSnapshot().entries[0];
  // Closed output: full native item remains recoverable, no page/detail request.
  nativeItem = { ...nativeItem, aggregatedOutput: 'large synthetic tool output\n'.repeat(50000) };
  const rawItem = { method: 'item/completed', params: { turnId: 'turn', item: { ...nativeItem, status: 'completed' } } };
  runtime.emitEvent('codex', rawItem, 'bot');
  const rawDelta = { method: 'item/commandExecution/outputDelta', params: { turnId: 'turn', itemId: 'tool', delta: 'next output'.repeat(100000) } };
  for (let i = 0; i < 10; i++) runtime.emitEvent('codex', rawDelta, 'bot');
  await new Promise((r) => setTimeout(r, 300)); assert.deepEqual(requests, ['history.view']);
  assert.ok(events.every((event) => Buffer.byteLength(JSON.stringify(event)) < 16384));
  assert.ok(store.replay(0).every((event) => !JSON.stringify(event).includes(rawDelta.params.delta)));
  const unsubscribe = timeline.subscribeDetail(descriptor, () => {}); await timeline.detail(descriptor); const before = scans, beforeResponses = responses.length;
  const initialDetailBytes = responses.filter((response) => response.method === 'history.detail').reduce((n, response) => n + response.bytes, 0);
  nativeItem = { ...nativeItem, status: 'completed', aggregatedOutput: nativeItem.aggregatedOutput + '\nFINAL AUTHORITATIVE OUTPUT' };
  runtime.emitEvent('codex', { method: 'item/completed', params: { turnId: 'turn', item: nativeItem } }, 'bot');
  runtime.emitEvent('codex', { method: 'turn/completed', params: { turn: { id: 'turn', status: 'completed', items: [] } } }, 'bot');
  await new Promise((r) => setTimeout(r, 1300));
  assert.match(timeline.detailItem(descriptor).aggregatedOutput, /FINAL AUTHORITATIVE OUTPUT$/);
  assert.equal(timeline.detailItem(descriptor).status, 'completed'); assert.equal(timeline.getSnapshot().entries[0].status, 'completed');
  // Since f7f4e98: completion refreshes the page (summary turns/list + one bounded tail items/list for a
  // turn without final text), and the open detail is one coalesced exact lookup made of two anchored items/list reads.
  assert.deepEqual(methods.slice(before).sort(), ['thread/items/list', 'thread/items/list', 'thread/items/list', 'thread/turns/list'], 'one coalesced full native lookup for open final detail');
  const rawBytes = Buffer.byteLength(JSON.stringify(rawItem)) + 10 * Buffer.byteLength(JSON.stringify(rawDelta));
  const wireBytes = events.slice(0, 11).reduce((n, event) => n + Buffer.byteLength(JSON.stringify(event)), 0);
  const finalDetail = responses.slice(beforeResponses).filter((response) => response.method === 'history.detail');
  console.log(JSON.stringify({ scenario: 'large closed-tool item plus 10 output deltas', nativePayloadBytes: rawBytes, compactWireBytes: wireBytes, persistedReplayBytes: Buffer.byteLength(JSON.stringify(store.replay(0))), closedDetailRequests: 0,
    initialDetailBytes, openFinalNativeScans: scans - before, openFinalDetailBytes: finalDetail.reduce((n, response) => n + response.bytes, 0), openFinalDetailChunks: finalDetail.length }));
  unsubscribe(); await timeline.dispose();
});
