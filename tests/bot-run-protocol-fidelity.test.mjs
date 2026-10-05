import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/load-ts.mjs';

test('retained run pages preserve independent item results on both terminal event envelopes', () => {
  const { updateRunPage } = runtime().load('app/bots/run-page-events.ts');
  const context = { runId: 'run', laneId: 'lane', threadId: 'native' };
  const page = { context, eventCursor: 1, entries: [
    { id: 'tool', turnId: 'turn', type: 'commandExecution', label: 'Checked', item: null, complete: true,
      scheduled: true, startedAt: 1, status: 'completed', itemStatus: 'completed', turnStatus: 'inProgress' },
    { id: 'answer', turnId: 'turn', type: 'agentMessage', label: 'Answer', item: { type: 'agentMessage', id: 'answer', text: 'partial answer' }, complete: true,
      scheduled: true, startedAt: 1, status: 'inProgress', turnStatus: 'inProgress' },
  ] };
  for (const status of ['failed', 'interrupted']) for (const type of ['run.codex', 'run.state']) {
    const turn = { id: 'turn', status, items: [], itemsView: 'notLoaded', error: { message: 'native terminal reason' } };
    const event = { seq: 2, type, data: type === 'run.codex'
      ? { ...context, message: { method: 'turn/completed', params: { turn } } }
      : { ...context, historyRefresh: { reason: 'large-native-event', method: 'turn/completed', turnId: 'turn', turn } } };
    const next = updateRunPage(page, [event], 'turn');
    assert.equal(next.entries.find(entry => entry.id === 'tool').status, 'completed');
    assert.ok(next.entries.every(entry => entry.turnStatus === status));
    assert.equal(next.entries.find(entry => entry.id === 'answer').status, status);
    assert.ok(next.entries.every(entry => entry.turnError === 'native terminal reason'));
    assert.equal(page.entries[0].turnStatus, 'inProgress', 'original page is immutable');
  }
});
