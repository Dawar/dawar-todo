import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../bot-bridge/store.mjs';
import { IDBKeyRange } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';
import { historyViewPage, readHistoryView, readHistoryDetail } from '../bot-bridge/history-view.mjs';
import { historyTail, projectHistoryItem, historyKey } from '../lib/bot-history-view.ts';

const turn = (id, items) => ({ id, items, status: 'completed', startedAt: 1, completedAt: 2, durationMs: 1, error: null, itemsView: 'full' });
const message = (id, text = 'Complete message') => ({ id, type: 'agentMessage', text, phase: 'final_answer', memoryCitation: null, delivery: null, questions: null });
const bot = { id: 'bot-a', threadId: 'native-thread', updatedAt: 'stable' };
// Real empty metadata indexes support the adapter's bounded attachment queries.
const metadataRoot = mkdtempSync(join(tmpdir(), 'bot-timeline-metadata-')), metadataStore = new Store(join(metadataRoot, 'state.sqlite'));
after(() => { metadataStore.close(); rmSync(metadataRoot, { recursive: true, force: true }); });
const fakeRuntime = (turns) => ({ epoch: 'epoch', store: { db: metadataStore.db, cursor: () => 1, replay: () => [], list: () => [] },
  historyPage: async () => ({ data: turns, nextCursor: null }) });
const entry = (id, text) => projectHistoryItem(turn('turn-a', []), message(id, text));
const page = (entries, extra = {}) => ({ kind: 'page', entries, olderCursor: null, revision: 'v1', eventCursor: 0, attachments: [], complete: true, ...extra });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test('a huge tool turn projects a useful answer, bounds response and retains native full detail', async () => {
  const tool = { type: 'commandExecution', id: 'tool-a', command: 'synthetic', aggregatedOutput: 'x'.repeat(2_000_000), status: 'completed' };
  const runtime = fakeRuntime([turn('turn-a', [tool, message('answer', 'Useful latest answer')])]);
  let nativeReads = 0; const read = runtime.historyPage; runtime.historyPage = (...args) => { nativeReads++; return read(...args); };
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
  assert.equal(nativeReads, 2, "one projection read and one detail read, independent of continuation count");
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
  const continuation = await readHistoryDetail(runtime, bot, { turnId: 'turn-a', itemId: 'long', offset: a.nextOffset, version: a.version });
  assert.equal(continuation.version, a.version, 'continuation uses one consistent snapshot');
  runtime.historyContentVersions = new Map([[bot.id, 2]]);
  const changed = await readHistoryDetail(runtime, bot, { turnId: 'turn-a', itemId: 'long' });
  assert.notEqual(changed.version, a.version);
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
  assert.deepEqual(Array.from(controller.getSnapshot().entries, (e) => e.item.text), ['Complete message', 'prefix-live']);
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

test('disjoint cached/new tails retain a durable gap until every intervening item is reachable', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const { createTimelineCache } = env.load('app/bots/timeline-cache.ts'), cache = createTimelineCache(env.indexedDB);
  const items = Array.from({ length: 400 }, (_, i) => message(`item-${i}`)), native = fakeRuntime([turn('turn-a', items)]);
  const old = items.slice(0, 40).map((item) => projectHistoryItem(turn('turn-a', []), item));
  await cache.write({ owner: 'owner', botId: bot.id, order: old.map((e) => historyKey(e.turnId, e.id)), revision: 'old', eventCursor: 0, olderCursor: null, complete: true, attachments: [], touched: 1 }, old);
  const transport = { owner: 'owner', online: true, rpc: async (_, id, params) => ({ kind: 'page', ...await historyViewPage(native, bot, params.cursor), revision: 'v2', eventCursor: 0 }) };
  let controller = new BotTimeline('owner', bot.id, transport, cache);
  await controller.refresh(); assert.equal(controller.getSnapshot().gaps.length, 1); await controller.dispose(); await cache.close();
  controller = new BotTimeline('owner', bot.id, transport, createTimelineCache(env.indexedDB));
  await controller.hydrate(); assert.equal(controller.getSnapshot().gaps.length, 1);
  let count = 0;
  while (controller.getSnapshot().gaps.length) { await controller.fillGap(controller.getSnapshot().gaps[0]); assert.ok(++count < 20); }
  assert.deepEqual(Array.from(controller.getSnapshot().entries, (e) => e.id), items.map((i) => i.id));
  await controller.flush(); await controller.dispose();
});

test('sparse completion settles existing entries and command status is independent of parent status', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const tool = projectHistoryItem({ ...turn('turn-a', []), status: 'inProgress' }, { id: 'tool', type: 'commandExecution', command: 'synthetic', status: 'completed' });
  assert.equal(tool.status, 'completed');
  const live = { ...entry('live'), status: 'inProgress' };
  const controller = new BotTimeline('owner', bot.id, { owner: 'owner', online: true, rpc: async () => page([live, tool]) }, { read: async () => null, write: async () => {} });
  await controller.refresh();
  controller.receive({ seq: 1, botId: bot.id, type: 'codex', data: { method: 'turn/completed', params: { turn: turn('turn-a', []) } } });
  assert.ok(controller.getSnapshot().entries.every((e) => e.status === 'completed')); await controller.dispose();
});

test('long streaming flushes periodically, and owner revocation masks a late reply', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const writes = [], transport = { owner: 'owner', online: true, rpc: async () => page([entry('live', '')]) };
  const controller = new BotTimeline('owner', bot.id, transport, { read: async () => null, write: async (meta, dirty) => writes.push({ meta, dirty }) });
  await controller.refresh(); await controller.flush(); writes.length = 0;
  for (let seq = 1; seq <= 12; seq++) { controller.receive({ seq, botId: bot.id, type: 'codex', data: { method: 'item/agentMessage/delta', params: { turnId: 'turn-a', itemId: 'live', delta: 'x' } } }); await pause(50); }
  assert.ok(writes.length >= 2, 'writes continue during sustained tokens'); await controller.dispose();
  let resolve; transport.rpc = () => new Promise((r) => { resolve = r; });
  const second = new BotTimeline('owner', bot.id, transport, { read: async () => null, write: async () => {} });
  const request = second.refresh(); await pause(0); transport.owner = 'other'; await second.dispose(); resolve(page([entry('secret')])); await request;
  assert.equal(second.getSnapshot().entries.length, 0);
});

test('a tools-only newest window keeps useful readable context without losing native access', async () => {
  const user = { id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Useful user request', text_elements: [] }] };
  const items = [user, message('answer', 'Useful earlier explanation'), ...Array.from({ length: 90 }, (_, i) => ({ type: 'commandExecution', id: `tool-${i}`, command: 'synthetic', status: 'inProgress', aggregatedOutput: 'tool output '.repeat(100000) }))];
  const page = await historyViewPage(fakeRuntime([turn('turn-a', items)]), bot);
  assert.equal(page.entries.length, 40); assert.equal(page.contextEntries.length, 2);
  assert.match(JSON.stringify(page.contextEntries), /Useful user request/); assert.match(JSON.stringify(page.contextEntries), /Useful earlier explanation/);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 96 * 1024); assert.ok(page.olderCursor);
});

test('opened tool detail applies ordered deltas, persists completed detail, and validates unchanged versions cheaply', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const tool = { type: 'commandExecution', id: 'tool', command: 'synthetic', status: 'completed', aggregatedOutput: 'initial' };
  const projected = projectHistoryItem(turn('turn-a', []), tool), native = fakeRuntime([turn('turn-a', [tool])]);
  const responses = [];
  const transport = { owner: 'owner', online: true, rpc: async (method, _, params) => { const response = method === 'history.detail' ? await readHistoryDetail(native, bot, params) : page([projected]); responses.push(response); return response; } };
  const controller = new BotTimeline('owner', bot.id, transport, { read: async () => null, write: async () => {} });
  await controller.refresh(); const unsubscribe = controller.subscribeDetail(projected, () => {});
  await controller.detail(projected); await pause(30);
  for (let i = 2; i <= 4; i++) controller.receive({ seq: i, botId: bot.id, type: 'codex', data: { method: 'item/commandExecution/outputDelta', params: { turnId: 'turn-a', itemId: 'tool', delta: String(i) } } });
  assert.equal(controller.detailItem(projected).aggregatedOutput, 'initial234'); unsubscribe();
  await controller.detail(projected); assert.equal(responses.at(-1).notModified, true);
  transport.online = false;
  assert.equal((await controller.detail(projected)).aggregatedOutput, 'initial');
  transport.owner = 'other'; await assert.rejects(controller.detail(projected), /owner changed/); await controller.dispose();
});

test('live work plans and turn diffs remain explicitly available without putting large diffs into the timeline cache', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const controller = new BotTimeline('owner', bot.id, { owner: 'owner', online: true, rpc: async () => page([]) }, { read: async () => null, write: async () => {} });
  const diff = 'large complete diff\n'.repeat(10000);
  controller.receive({ seq: 1, botId: bot.id, type: 'codex', data: { method: 'turn/diff/updated', params: { turnId: 'turn-a', diff } } });
  const entry = controller.getSnapshot().entries[0]; assert.equal(entry.item, null);
  assert.equal((await controller.detail(entry)).text, '```diff\n' + diff + '\n```');
  controller.receive({ seq: 2, botId: bot.id, type: 'codex', data: { method: 'turn/plan/updated', params: { turnId: 'turn-a', plan: [{ step: 'Preserved work step', status: 'inProgress' }] } } });
  assert.match((await controller.detail(controller.getSnapshot().entries[1])).text, /Preserved work step/); await controller.dispose();
});

test('cache keeps a distant reading anchor plus latest messages and an explicit eviction gap', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const { createTimelineCache } = env.load('app/bots/timeline-cache.ts'), cache = createTimelineCache(env.indexedDB);
  const entries = Array.from({ length: 500 }, (_, i) => entry(`item-${i}`));
  const controller = new BotTimeline('owner', bot.id, { owner: 'owner', online: true, rpc: async () => page(entries) }, cache);
  await controller.refresh(); await controller.flush();
  controller.position({ anchor: historyKey('turn-a', 'item-50'), offset: 15, following: false }); await controller.flush(); await controller.dispose();
  const stored = await cache.read('owner', bot.id);
  assert.ok(stored.entries.some((e) => e.id === 'item-50')); assert.equal(stored.entries.at(-1).id, 'item-499');
  assert.ok(stored.entries.length <= 240); assert.equal(stored.metadata.gaps.length, 1); assert.ok(stored.metadata.olderCursor);
  await cache.close();
});

test('scheduled turn access pages inside one huge turn and does not transfer neighbouring turns', async () => {
  const items = Array.from({ length: 95 }, (_, i) => message(`scheduled-${i}`));
  const native = fakeRuntime([turn('newer', [message('newer-item')]), turn('scheduled', items), turn('older', [message('older-item')])]);
  const first = await historyViewPage(native, bot, null, 'scheduled');
  const second = await historyViewPage(native, bot, first.olderCursor);
  const third = await historyViewPage(native, bot, second.olderCursor);
  assert.equal(third.olderCursor, null); assert.deepEqual([...third.entries, ...second.entries, ...first.entries].map((e) => e.id), items.map((i) => i.id));
});

test('mounted text previews never fetch full detail on completion; oversized text deltas coalesce bounded view refresh', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const requests = [], preview = { ...entry('live', 'preview'), status: 'inProgress' };
  const controller = new BotTimeline('owner', bot.id, { owner: 'owner', online: true, rpc: async (method) => {
    requests.push(method); return page([preview], { eventCursor: requests.length === 1 ? 0 : 11 });
  } }, { read: async () => null, write: async () => {} });
  await controller.refresh(); const unsubscribe = controller.subscribeDetail(preview, () => {});
  for (let seq = 1; seq <= 10; seq++) controller.receive({ seq, botId: bot.id, type: 'history.refresh', data: {
    reason: 'large-native-event', method: 'item/agentMessage/delta', turnId: 'turn-a', itemId: 'live',
  } });
  controller.receive({ seq: 11, botId: bot.id, type: 'codex', data: { method: 'turn/completed', params: { turn: turn('turn-a', []) } } });
  await pause(1200);
  assert.deepEqual(requests, ['history.view', 'history.view']);
  assert.equal(controller.detailPending(preview), false);
  unsubscribe(); await controller.dispose();
});

test('reconnect retains exact failed/interrupted states on older rows and tool results remain independent', async () => {
  for (const status of ['failed', 'interrupted']) {
    const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
    const parent = { ...turn('turn-a', []), status: 'inProgress' };
    const older = projectHistoryItem(parent, message('older'));
    const tool = projectHistoryItem(parent, { id: 'tool', type: 'commandExecution', command: 'checked', status: 'completed' });
    const newest = projectHistoryItem(parent, message('newest'));
    let nextPage = page([older, tool, newest]);
    const writes = [];
    const controller = new BotTimeline('owner', bot.id, { owner: 'owner', online: true, rpc: async () => nextPage }, { read: async () => null, write: async (_metadata, dirty) => writes.push(dirty) });
    await controller.refresh();
    nextPage = page([{ ...newest, turnStatus: status, status, turnError: 'native terminal reason' }]);
    await controller.refresh();
    const entries = controller.getSnapshot().entries;
    assert.ok(entries.every(entry => entry.turnStatus === status));
    assert.equal(entries.find(entry => entry.id === 'older').status, status);
    assert.equal(entries.find(entry => entry.id === 'older').turnError, 'native terminal reason');
    await controller.flush();
    assert.equal(writes.at(-1).find(entry => entry.id === 'older').turnStatus, status, 'terminal state is durable in older cached rows too');
    const { withTurnState } = env.load('lib/bot-history-view.ts');
    assert.equal(withTurnState(tool, { status }).status, 'completed');
    controller.receive({ seq: 2, botId: bot.id, type: 'history.refresh', data: { reason: 'large-native-event', method: 'turn/completed', turn: { ...turn('turn-a', []), status } } });
    assert.equal(controller.getSnapshot().entries.find(entry => entry.id === 'older').turnStatus, status);
    await controller.dispose();
  }
});

test('main timeline rejects unrelated delta channels while live plan completion replaces its draft', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const parent = { ...turn('turn-a', []), status: 'inProgress' };
  const plan = projectHistoryItem(parent, { type: 'plan', id: 'plan', text: 'draft' });
  const answer = projectHistoryItem(parent, message('answer', 'answer'));
  const controller = new BotTimeline('owner', bot.id, { owner: 'owner', online: true, rpc: async () => page([plan, answer]) }, { read: async () => null, write: async () => {} });
  await controller.refresh();
  const apply = (seq, method, params) => controller.receive({ seq, type: 'codex', botId: bot.id, data: { method, params: { turnId: 'turn-a', ...params } } });
  apply(1, 'item/commandExecution/outputDelta', { itemId: 'answer', delta: 'tool output' });
  assert.equal(controller.getSnapshot().entries.find(entry => entry.id === 'answer').item.text, 'answer');
  apply(2, 'item/plan/delta', { itemId: 'plan', delta: '-stream' });
  assert.equal(controller.getSnapshot().entries.find(entry => entry.id === 'plan').item.text, 'draft-stream');
  apply(3, 'item/completed', { item: { type: 'plan', id: 'plan', text: 'final native content' } });
  assert.equal(controller.getSnapshot().entries.find(entry => entry.id === 'plan').item.text, 'final native content');
  await controller.dispose();
});
