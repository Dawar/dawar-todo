import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBKeyRange } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';
import { turnAudience, projectConversationItem } from '../lib/bot-conversation.ts';
import { projectHistoryItem } from '../lib/bot-history-view.ts';

const peer = { type: 'userMessage', id: 'peer-input', clientId: 'peer:request', content: [{ type: 'text', text: 'Internal peer envelope', text_elements: [] }] };
const progress = { type: 'agentMessage', id: 'progress', text: 'Linus has reported that the fix is ready.', phase: 'commentary', memoryCitation: null, delivery: null, questions: null };
const thinking = { type: 'reasoning', id: 'thinking', summary: ['Checking the reported fix.'], content: ['Unrendered internal content'] };
const turn = { id: 'peer-turn', status: 'completed', startedAt: 1, completedAt: 2, items: [peer, thinking, progress] };

test('peer-triggered progress and reasoning summaries appear in history without the peer envelope', () => {
  const audience = turnAudience(turn.items);
  assert.equal(audience.kind, 'conversation');
  const entries = turn.items.map(item => projectConversationItem(turn, item, audience)).filter(Boolean);
  assert.deepEqual(entries.map(entry => entry.id), ['thinking', 'progress']);
  assert.deepEqual(entries[0].item.summary, thinking.summary); assert.deepEqual(entries[0].item.content, []);
});

test('routine schedules remain quiet even when peer input is also present', () => {
  const scheduled = { ...peer, id: 'schedule-input', clientId: 'schedule:nightly' };
  const audience = turnAudience([scheduled, ...turn.items]);
  assert.equal(audience.kind, 'activity'); assert.equal(projectConversationItem(turn, progress, audience), null);
  assert.equal(projectConversationItem(turn, thinking, audience), null);
  assert.equal(turnAudience(turn.items, 'known-schedule-run').kind, 'activity');
});

test('legacy peer activity classification is repaired while hiding peer requests and internal reasoning content', () => {
  const env = runtime(), { conversationEntries } = env.load('app/bots/history-reconcile.ts');
  const entries = turn.items.map(item => projectHistoryItem(turn, item));
  const audiences = new Map([[turn.id, { kind: 'activity' }]]);
  const readable = conversationEntries(entries, audiences);
  assert.deepEqual(Array.from(readable, entry => entry.id), ['thinking', 'progress']);
  assert.equal(audiences.get(turn.id).kind, 'conversation'); assert.equal(readable[0].item.content.length, 0);
});

test('live peer events display summary and progress and hide the incoming peer message', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const { createTimelineCache } = env.load('app/bots/timeline-cache.ts');
  const cache = createTimelineCache(env.indexedDB);
  const timeline = new BotTimeline('owner', 'bot', { owner: 'owner', online: false, rpc: async () => { throw Error('offline'); } }, cache);
  try {
    let seq = 0;
    for (const item of turn.items) timeline.receive({ type: 'codex', botId: 'bot', seq: ++seq, data: { method: 'item/completed', params: { turnId: turn.id, item } } });
    assert.deepEqual(Array.from(timeline.getSnapshot().entries, entry => entry.id), ['thinking', 'progress']);
    assert.equal(timeline.getSnapshot().entries[0].item.content.length, 0);
  } finally { await timeline.dispose(); await cache.close(); }
});

test('a replayed reasoning summary delta paints even when item-started was missed', async () => {
  const env = runtime({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const { createTimelineCache } = env.load('app/bots/timeline-cache.ts');
  const cache = createTimelineCache(env.indexedDB);
  const timeline = new BotTimeline('owner', 'bot', { owner: 'owner', online: false, rpc: async () => { throw Error('offline'); } }, cache);
  try {
    timeline.receive({ type: 'codex', botId: 'bot', seq: 1, data: { method: 'item/reasoning/summaryTextDelta', params: { turnId: 'live', itemId: 'missed-start', summaryIndex: 0, delta: 'Checking the queue.' } } });
    const entry = timeline.getSnapshot().entries.find(entry => entry.id === 'missed-start');
    assert.ok(entry); assert.equal(entry.item.summary[0], 'Checking the queue.'); assert.equal(entry.item.content.length, 0);
  } finally { await timeline.dispose(); await cache.close(); }
});
