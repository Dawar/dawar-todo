import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/load-ts.mjs';

const env = runtime();
const chapters = env.load('lib/bot-chapters.ts');
const trace = env.load('lib/trace-state.ts');
const target = { botId: 'bot', threadId: 'thread', turnId: 'turn-1', itemId: 'item-1' };
const pin = (extra = {}) => ({ action: 'pin', ...target, title: 'Plan agreed', messageAt: 100, ...extra });

test('chapter titles come from the first heading or readable line, bounded and deterministic', () => {
  assert.equal(chapters.chapterTitle('Intro line\n\n## Release **plan**\nbody'), 'Release plan');
  assert.equal(chapters.chapterTitle('```js\nconst hidden = 1\n```\n- [Shipped](https://x) the `fix`'), 'Shipped the fix');
  assert.equal(chapters.chapterTitle('   \n'), 'AI response');
  const long = chapters.chapterTitle('word '.repeat(60));
  assert.ok([...long].length <= 81 && long.endsWith('…'));
  assert.equal(chapters.chapterTitle('A\u0007B'), 'A B');
});

test('only exact chapter mutations are accepted; synthetic rows never become chapters', () => {
  assert.ok(chapters.validChapterMutation(pin()));
  assert.ok(chapters.validChapterMutation({ action: 'unpin', ...target }));
  assert.ok(chapters.validChapterMutation({ action: 'rename', ...target, title: 'New' }));
  assert.equal(chapters.validChapterMutation(pin({ itemId: 'finding:abc' })), false);
  assert.equal(chapters.validChapterMutation(pin({ itemId: 'client:abc' })), false);
  assert.equal(chapters.validChapterMutation(pin({ text: 'whole response' })), false);
  assert.equal(chapters.validChapterMutation(pin({ title: 'x'.repeat(121) })), false);
  assert.equal(chapters.validChapterMutation({ action: 'rename', ...target, title: '  ' }), false);
});

test('pin is idempotent, rename keeps identity, unpin removes, order follows the conversation', () => {
  let list = chapters.applyChapterMutation([], pin(), '2026-10-15T00:00:00.000Z');
  list = chapters.applyChapterMutation(list, pin({ title: 'Duplicate' }), '2026-10-15T00:01:00.000Z');
  assert.equal(list.length, 1); assert.equal(list[0].title, 'Plan agreed');
  list = chapters.applyChapterMutation(list, pin({ turnId: 'turn-0', itemId: 'item-0', messageAt: 50, title: 'Earlier' }), '2026-10-15T00:02:00.000Z');
  assert.deepEqual(Array.from(list, c => c.title), ['Earlier', 'Plan agreed']);
  list = chapters.applyChapterMutation(list, { action: 'rename', ...target, title: 'Decision' }, 'x');
  assert.equal(list[1].title, 'Decision'); assert.equal(list[1].itemId, 'item-1');
  list = chapters.applyChapterMutation(list, { action: 'unpin', ...target }, 'x');
  assert.deepEqual(Array.from(list, c => c.itemId), ['item-0']);
});

test('eligibility uses producer type and scope, never prose', () => {
  const entry = (extra = {}, item = {}) => ({ id: 'item', turnId: 'turn', type: 'agentMessage', complete: true, scheduled: false, status: 'completed', startedAt: 1,
    item: { type: 'agentMessage', id: 'item', text: 'Answer', phase: 'final_answer', ...item }, ...extra });
  assert.ok(chapters.chapterEligible(entry(), 'thread'));
  assert.ok(chapters.chapterEligible(entry({ sourceThreadId: 'thread' }), 'thread'));
  assert.equal(chapters.chapterEligible(entry({}, { phase: 'commentary' }), 'thread'), false);
  assert.equal(chapters.chapterEligible(entry({ sourceThreadId: 'other' }), 'thread'), false);
  assert.equal(chapters.chapterEligible(entry({ audience: 'finding', id: 'finding:1' }), 'thread'), false);
  assert.equal(chapters.chapterEligible(entry({ itemStatus: 'inProgress' }), 'thread'), false);
  assert.equal(chapters.chapterEligible(entry({ type: 'userMessage', item: { type: 'userMessage', id: 'item', content: [{ type: 'text', text: 'Assistant: answer' }] } }), 'thread'), false);
  assert.equal(chapters.chapterEligible(entry(), null), false);
});

function storeHarness() {
  const memory = new Map(), storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: k => memory.delete(k) };
  const server = [], calls = [];
  let fail = null;
  const transport = {
    read: async (owner, scope) => { calls.push(['read']); if (fail) throw fail; return { version: 1, owner, ...scope, chapters: server.filter(c => c.threadId === scope.threadId) }; },
    write: async (owner, mutation) => {
      calls.push([mutation.action]); if (fail) throw fail;
      const next = chapters.applyChapterMutation(server.splice(0), mutation, '2026-10-15T00:00:00.000Z'); server.push(...next);
      return { version: 1, owner, chapter: next.find(c => chapters.chapterKey(c) === chapters.chapterKey(mutation)) ?? null };
    },
  };
  const { ChapterStore, ChapterRequestError } = env.load('app/bots/chapter-store.ts');
  return { memory, storage, server, calls, transport, ChapterStore, ChapterRequestError, setFail: value => { fail = value; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('chapter store syncs pins and keeps offline changes on this device until replayed in order', async () => {
  const h = storeHarness(), scope = { botId: 'bot', threadId: 'thread' };
  const store = new h.ChapterStore('owner', h.transport, h.storage);
  await store.load(scope);
  h.setFail(Error('offline'));
  store.mutate(pin()); store.mutate({ action: 'rename', ...target, title: 'Renamed offline' });
  await settle();
  let view = store.view(scope);
  assert.equal(view.pending, 2); assert.equal(view.chapters[0].title, 'Renamed offline');
  assert.match(view.error, /on this device/);
  assert.equal(h.server.length, 0);
  // A reload restores the unconfirmed changes from local storage, in order.
  const reloaded = new h.ChapterStore('owner', h.transport, h.storage);
  h.setFail(null);
  await reloaded.load(scope); await settle();
  view = reloaded.view(scope);
  assert.equal(view.pending, 0); assert.equal(view.error, '');
  assert.deepEqual(Array.from(h.server, c => c.title), ['Renamed offline']);
  assert.deepEqual(h.calls.filter(c => c[0] !== 'read').map(c => c[0]), ['pin', 'pin', 'rename']);
});

test('a rejected change is dropped with its message; other owners and threads never mix', async () => {
  const h = storeHarness(), scope = { botId: 'bot', threadId: 'thread' };
  const store = new h.ChapterStore('owner', h.transport, h.storage);
  h.setFail(new h.ChapterRequestError('This conversation already has 200 chapters. Unpin one first.', true));
  store.mutate(pin()); await settle();
  assert.equal(store.view(scope).pending, 0);
  assert.match(store.view(scope).error, /200 chapters/);
  h.setFail(null);
  store.mutate(pin()); await settle();
  assert.equal(store.view({ botId: 'bot', threadId: 'other' }).chapters.length, 0);
  assert.equal(new h.ChapterStore('other-owner', h.transport, h.storage).view(scope).chapters.length, 0);
  assert.equal(store.view(scope).chapters.length, 1);
  assert.equal(store.view(scope), store.view(scope), 'snapshot is referentially stable');
});

test('Trace state follows producer evidence and leaves missing status unknown', () => {
  assert.equal(trace.traceState('inProgress'), 'running');
  assert.equal(trace.traceState('completed'), 'completed');
  assert.equal(trace.traceState('completed', { exitCode: 2 }), 'failed');
  assert.equal(trace.traceState('completed', { success: false }), 'failed');
  assert.equal(trace.traceState('declined'), 'declined');
  assert.equal(trace.traceState(undefined), 'unknown');
  assert.equal(trace.traceState('mystery'), 'unknown');
  assert.deepEqual(['+++ b/a', '@@ -1 +1 @@', '+x', '-y', ' z', 'diff --git a b'].map(trace.diffLineKind), ['meta', 'hunk', 'add', 'remove', 'context', 'meta']);
  assert.equal(trace.codeLanguage('language-ts'), 'ts');
  assert.equal(trace.codeLanguage('language-<script>'), '');
});
