import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBKeyRange } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';

// Native Codex turn IDs are UUIDv7: their first 48 bits are the native start
// in milliseconds (e.g. 01a13b2f-5684-… is started_at 1791994320).
const v7 = ms => `${ms.toString(16).padStart(12, '0').replace(/^(.{8})(.{4})$/, '$1-$2')}-7000-8000-000000000000`;
const A = v7(1791994117533), B = v7(1791994200000), C = v7(1791994320516);
const page = entries => ({ kind: 'page', entries, attachments: [], olderCursor: null, revision: 'native:thread:conversation-v8', eventCursor: 0, complete: true });
const answer = id => ({ id, type: 'agentMessage', text: id, phase: 'final_answer' });
const human = (id, text) => ({ id, type: 'userMessage', clientId: `client-${id}`, content: [{ type: 'text', text, text_elements: [] }] });
function setup() {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const { projectHistoryItem } = env.load('lib/bot-history-view.ts');
  const { chronologicalTurns } = env.load('app/bots/history-reconcile.ts');
  let read = async () => page([]);
  const transport = { owner: 'owner', online: true, snapshot: { bots: [{ id: 'bot', threadId: 'thread' }] }, rpc: (...args) => read(...args) };
  const timeline = new BotTimeline('owner', 'bot', transport, { read: async () => null, write: async () => {} });
  const turn = (id, startedAt) => ({ id, status: 'completed', startedAt, completedAt: startedAt + 5, items: [], itemsView: 'full' });
  return { timeline, projectHistoryItem, chronologicalTurns, turn, setRead: value => { read = value; } };
}
const event = (seq, method, params) => ({ seq, type: 'codex', botId: 'bot', data: { method, params: { threadId: 'thread', ...params } } });
const ids = timeline => Array.from(timeline.getSnapshot().entries, e => e.id);

test('a missed live turn/started plus a late non-overlapping page keeps native turn order', async () => {
  const s = setup();
  // Cached/hydrated older turn A.
  s.setRead(async () => page([s.projectHistoryItem(s.turn(A, 1791994117), answer('a'))]));
  await s.timeline.refreshLatest();
  // Live output for the newest turn C arrives, but its turn/started was missed
  // (reconnect), so the row has no recorded start time.
  s.timeline.receive(event(10, 'item/completed', { turnId: C, item: answer('c') }));
  // A history page read before C started now lands; it holds only turn B.
  s.setRead(async () => page([s.projectHistoryItem(s.turn(B, 1791994200), human('b-user', 'middle')), s.projectHistoryItem(s.turn(B, 1791994200), answer('b'))]));
  await s.timeline.refreshLatest();
  assert.deepEqual(ids(s.timeline), ['a', 'b-user', 'b', 'c'], 'later output never appears above earlier messages');
  await s.timeline.dispose();
});

test('within a turn, received-time rows do not reorder native-timed rows', () => {
  const s = setup();
  const base = { turnId: C, status: 'completed', startedAt: 1791994320, complete: true, scheduled: false, label: '' };
  const entries = [
    { ...base, id: 'u1', type: 'userMessage', itemStartedAtMs: 1791994320600 },
    { ...base, id: 'commentary', type: 'agentMessage', timeBasis: 'received', messageAt: 1791994330 },
    { ...base, id: 'tool', type: 'commandExecution', itemStartedAtMs: 1791994325000 },
  ];
  assert.deepEqual(Array.from(s.chronologicalTurns(entries), e => e.id), ['u1', 'commentary', 'tool'], 'native page order is canonical');
});

test('turns with recorded starts and UUIDv7 identities sort by native start; others keep their slots', () => {
  const s = setup();
  const row = (turnId, id, startedAt) => ({ turnId, id, type: 'agentMessage', status: 'completed', startedAt, complete: true, scheduled: false, label: '' });
  const out = s.chronologicalTurns([row(C, 'c', null), row('legacy-turn', 'x', null), row(A, 'a', 1791994117), row(B, 'b', null)]);
  assert.deepEqual(Array.from(out, e => e.id), ['a', 'x', 'b', 'c']);
});

test('cold reopen repairs a cache written in the wrong order before the first page arrives', async () => {
  const s = setup();
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  // An older client cached C's live rows ahead of B.
  const cached = [s.projectHistoryItem(s.turn(A, 1791994117), answer('a')), { ...s.projectHistoryItem(s.turn(C, null), answer('c')), startedAt: null },
    s.projectHistoryItem(s.turn(B, 1791994200), answer('b'))];
  const cache = { read: async () => ({ entries: cached, metadata: { revision: 'native:thread:conversation-v8', order: cached.map(e => `${e.turnId}:${e.id}`), gaps: [], olderCursor: null, eventCursor: 0, attachments: [], complete: true } }), write: async () => {} };
  let release; const blocked = new Promise(r => { release = r; });
  const transport = { owner: 'owner', online: true, snapshot: { bots: [{ id: 'bot', threadId: 'thread' }] }, rpc: async () => { await blocked; return page([]); } };
  const timeline = new BotTimeline('owner', 'bot', transport, cache);
  await timeline.hydrate();
  assert.deepEqual(ids(timeline), ['a', 'b', 'c'], 'cached rows display in native order immediately');
  release(); await timeline.dispose();
});

test('switching bots never moves another bot\'s live events into this conversation', async () => {
  const s = setup();
  s.setRead(async () => page([s.projectHistoryItem(s.turn(A, 1791994117), answer('a'))]));
  await s.timeline.refreshLatest();
  s.timeline.receive({ ...event(5, 'item/completed', { turnId: C, item: answer('other-bot-output') }), botId: 'other' });
  s.timeline.receive(event(6, 'item/completed', { turnId: C, item: answer('c') }));
  assert.deepEqual(ids(s.timeline), ['a', 'c']);
  await s.timeline.dispose();
});

test('a plan-only completed turn recovered from native history keeps its identity and place after a missed live event', async () => {
  const s = setup();
  s.setRead(async () => page([s.projectHistoryItem(s.turn(A, 1791994117), answer('a'))]));
  await s.timeline.refreshLatest();
  s.timeline.receive(event(10, 'item/completed', { turnId: C, item: answer('c') }));
  // The plan item's live events were missed; reconnect reads it from history.
  const plan = { id: `${B}-plan`, type: 'plan', text: '1. Inspect\n2. Fix' };
  s.setRead(async () => page([s.projectHistoryItem(s.turn(B, 1791994200), plan)]));
  await s.timeline.refreshLatest();
  const entries = s.timeline.getSnapshot().entries;
  assert.deepEqual(Array.from(entries, e => e.id), ['a', `${B}-plan`, 'c']);
  assert.equal(entries[1].item.type, 'plan'); assert.equal(entries[1].turnId, B);
  await s.timeline.dispose();
});
