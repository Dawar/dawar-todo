import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';
import { historyViewPage, readHistoryView, readHistoryDetail } from '../bot-bridge/history-view.mjs';
import { historyTail, projectHistoryItem, historyKey } from '../lib/bot-history-view.ts';

const turn = (id, items) => ({ id, items, status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null, itemsView: 'full' });
const message = (id, text = 'Complete message') => ({ id, type: 'agentMessage', text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
const bot = { id: 'bot-a', threadId: 'native-thread', updatedAt: 'stable' };
const fakeRuntime = (turns) => ({ epoch: 'epoch', store: { cursor: () => 1, replay: () => [], list: () => [] },
  historyPage: async () => ({ data: turns, nextCursor: null }) });
const entry = (id, text) => projectHistoryItem(turn('turn-a', []), message(id, text));
const page = (entries, extra = {}) => ({ kind: 'page', entries, olderCursor: null, revision: 'v1', eventCursor: 0, attachments: [], complete: true, ...extra });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a huge tool turn projects a useful answer, bounds response and retains native full detail', async () => {
  const tool = { type: 'commandExecution', id: 'tool-a', command: 'synthetic', aggregatedOutput: 'x'.repeat(2_000_000), status: 'completed' };
  const runtime = fakeRuntime([turn('turn-a', [tool, message('answer', 'Useful latest answer')])]);
  const projected = await historyViewPage(runtime, bot);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 4096);
  assert.equal(projected.entries.at(-1).item.text, 'Useful latest answer');
  assert.equal(projected.entries[0].item, null); assert.equal(projected.entries[0].complete, false);
  let json = '', offset = 0, version;
  do {
    const detail = await readHistoryDetail(runtime, bot, { turnId: 'turn-a', itemId: 'tool-a', offset, version });
    assert.ok(Buffer.byteLength(JSON.stringify(detail)) < 128 * 1024);
    json += detail.json; offset = detail.nextOffset; version = detail.version;
  } while (offset !== null);
  assert.equal(JSON.parse(json).aggregatedOutput.length, 2_000_000);
});

test('pagination is item-bounded and anchored across new arrivals, without dropping messages', async () => {
  const items = Array.from({ length: 95 }, (_, i) => message(`item-${i}`));
  const runtime = fakeRuntime([turn('turn-a', items)]);
  const first = await historyViewPage(runtime, bot);
  assert.equal(first.entries.length, 40); assert.ok(first.olderCursor);
  items.push(message('new-live-item'));
  const second = await historyViewPage(runtime, bot, first.olderCursor);
  const third = await historyViewPage(runtime, bot, second.olderCursor);
  assert.deepEqual([...third.entries, ...second.entries, ...first.entries].map((e) => e.id), items.slice(0, 95).map((i) => i.id));
  assert.equal(third.olderCursor, null);
});

test('oversized messages explicitly offer complete detail, including Unicode', async () => {
  const original = message('long', '🙂完整答案'.repeat(12_000));
  const runtime = fakeRuntime([turn('turn-a', [original])]);
  const { entries } = await historyViewPage(runtime, bot);
  assert.equal(entries[0].complete, false); assert.ok(entries[0].item.text.length < original.text.length);
  assert.ok(Buffer.byteLength(JSON.stringify(entries)) < 128 * 1024);
  const a = await readHistoryDetail(runtime, bot, { turnId: 'turn-a', itemId: 'long' });
  original.text += ' changed';
  await assert.rejects(readHistoryDetail(runtime, bot, { turnId: 'turn-a', itemId: 'long', offset: a.nextOffset, version: a.version }), /changed/);
});

test('unchanged revision avoids native history IO and bounded reconnect replay avoids a page', async () => {
  const runtime = fakeRuntime([]); let reads = 0;
  runtime.historyPage = async () => { reads++; return { data: [], nextCursor: null }; };
  const first = await readHistoryView(runtime, bot, {});
  assert.equal((await readHistoryView(runtime, bot, { revision: first.revision })).kind, 'unchanged'); assert.equal(reads, 1);
  runtime.historyVersions = new Map([[bot.id, 2]]); runtime.store.cursor = () => 2;
  runtime.store.replay = () => [{ seq: 2, botId: bot.id, type: 'codex', data: { method: 'item/agentMessage/delta', params: { delta: 'new' } } }];
  assert.equal((await readHistoryView(runtime, bot, { revision: first.revision, after: 1 })).kind, 'events'); assert.equal(reads, 1);
});

test('durable cache survives a fresh instance, scopes owners, and evicts metadata without touching drafts', async () => {
  const env = runtime({ IDBKeyRange });
  const { createTimelineCache } = env.load('app/bots/timeline-cache.ts');
  const cache = createTimelineCache(env.indexedDB);
  for (let i = 0; i < 14; i++) {
    const e = entry('item', `history ${i}`);
    await cache.write({ owner: 'owner-a', botId: `bot-${i}`, order: [historyKey(e.turnId, e.id)], revision: 'v1', eventCursor: i,
      olderCursor: 'older-cursor', complete: false, attachments: [], touched: i }, [e]);
  }
  await cache.close(); const reopened = createTimelineCache(env.indexedDB);
  assert.equal(await reopened.read('owner-a', 'bot-0'), null); assert.equal(await reopened.read('owner-a', 'bot-1'), null);
  assert.equal((await reopened.read('owner-a', 'bot-13')).entries[0].item.text, 'history 13');
  assert.equal(await reopened.read('owner-b', 'bot-13'), null);
  assert.equal((await reopened.read('owner-a', 'bot-2')).metadata.olderCursor, 'older-cursor');
  await reopened.clearOwner('owner-b'); assert.ok(await reopened.read('owner-a', 'bot-13'));
  await reopened.clearOwner('owner-a'); assert.equal(await reopened.read('owner-a', 'bot-13'), null);
  await reopened.close();
});

test('same-thread requests deduplicate and a delayed page cannot erase newer live text or older pages', async () => {
  const env = runtime({ IDBKeyRange }); const { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  let resolve, calls = 0; const writes = [];
  const cache = { read: async () => ({ metadata: { revision: 'old', eventCursor: 0, attachments: [], olderCursor: 'older', complete: false }, entries: [entry('old'), entry('live', 'prefix')] }),
    write: async (meta, dirty) => writes.push({ meta, dirty }) };
  const transport = { owner: 'owner', online: true, rpc: () => { calls++; return new Promise((r) => { resolve = r; }); } };
  const controller = new BotTimeline('owner', 'bot-a', transport, cache);
  const first = controller.refresh(), second = controller.refresh(); await pause(0); assert.equal(calls, 1);
  controller.receive({ type: 'codex', botId: 'bot-a', seq: 2, data: { method: 'item/agentMessage/delta', params: { turnId: 'turn-a', itemId: 'live', delta: '-live' } } });
  resolve(page([entry('live', 'stale')], { eventCursor: 1 })); await Promise.all([first, second]);
  assert.deepEqual(controller.getSnapshot().entries.map((e) => e.item.text), ['Complete message', 'prefix-live']);
  await controller.flush(); assert.ok(writes.at(-1).dirty.some((e) => e.item.text === 'prefix-live'));
  await controller.dispose();
});

test('100 ordered deltas coalesce into one dirty-item write and keep other item identity', async () => {
  const env = runtime({ IDBKeyRange }); const { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const writes = []; const cache = { read: async () => null, write: async (meta, dirty) => writes.push({ meta, dirty }) };
  const controller = new BotTimeline('owner', 'bot-a', { owner: 'owner', online: true, rpc: async () => page([entry('unchanged'), entry('live', '')]) }, cache);
  await controller.refresh(); await controller.flush(); writes.length = 0;
  const unchanged = controller.getSnapshot().entries[0]; let publishes = 0; controller.subscribe(() => publishes++);
  for (let i = 1; i <= 100; i++) controller.receive({ type: 'codex', botId: 'bot-a', seq: i, data: { method: 'item/agentMessage/delta', params: { turnId: 'turn-a', itemId: 'live', delta: `${i},` } } });
  await pause(25); assert.equal(publishes, 1); await controller.flush();
  assert.equal(writes.length, 1); assert.equal(writes[0].dirty.length, 1);
  assert.equal(controller.getSnapshot().entries[0], unchanged);
  assert.equal(controller.getSnapshot().entries[1].item.text, Array.from({ length: 100 }, (_, i) => `${i + 1},`).join(''));
  await controller.dispose();
});
