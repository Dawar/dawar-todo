import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBKeyRange } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';

// A streamed answer starts as an empty native item, which the conversation
// projection omits. Its temporary reading fallback must not outlive it: once
// the answer has text it is its own anchor, so a reading window ending at it
// (scroll up, then back down) still renders it.
function setup() {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const { historyKey } = env.load('lib/bot-history-view.ts');
  const page = { kind: 'page', entries: [], attachments: [], olderCursor: null, revision: 'native:thread:conversation-v8', eventCursor: 0, complete: true };
  const transport = { owner: 'owner', online: true, snapshot: { bots: [{ id: 'bot', threadId: 'thread' }] }, rpc: async () => page };
  const timeline = new BotTimeline('owner', 'bot', transport, { read: async () => null, write: async () => {} });
  let seq = 0;
  const live = (method, params) => timeline.receive({ seq: ++seq, type: 'codex', botId: 'bot', data: { method, params: { threadId: 'thread', turnId: 'turn', ...params } } });
  return { timeline, historyKey, live };
}

test('a streamed answer that began empty resolves to itself, not to the preceding message', async () => {
  const { timeline, historyKey, live } = setup();
  await timeline.refreshLatest();
  live('turn/started', { turn: { id: 'turn', status: 'inProgress', startedAt: 100, items: [], itemsView: 'full' } });
  live('item/completed', { item: { id: 'question', type: 'userMessage', clientId: 'c-1', content: [{ type: 'text', text: 'Question', text_elements: [] }] } });
  live('item/started', { item: { id: 'answer', type: 'agentMessage', text: '', phase: 'final_answer' } });
  live('item/agentMessage/delta', { itemId: 'answer', delta: 'Streamed ' });
  live('item/agentMessage/delta', { itemId: 'answer', delta: 'answer' });
  live('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'Streamed answer', phase: 'final_answer' } });
  live('turn/completed', { turn: { id: 'turn', status: 'completed', startedAt: 100, completedAt: 110, items: [], itemsView: 'summary' } });
  const entries = timeline.getSnapshot().entries;
  assert.deepEqual(Array.from(entries, e => e.id), ['question', 'answer']);
  const answer = historyKey('turn', 'answer');
  assert.equal(timeline.resolveKey(answer), answer);
  assert.equal(timeline.resolveKey(historyKey('turn', 'question')), historyKey('turn', 'question'));
  await timeline.dispose();
});
