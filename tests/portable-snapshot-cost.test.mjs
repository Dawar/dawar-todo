import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { MinimalCodex } from '../bot-bridge/claude-test-support.mjs';
import { agentSnapshot } from '../portable/agent-snapshot.mjs';
import { NodeJournal } from '../portable/control-store.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'snapshot-cost-'));
  const store = new Store(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const at = i => new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
  for (const [i, name] of ['Atlas', 'Bea', 'Cy'].entries())
    store.saveBot({ id: `bot-${i}`, slug: name.toLowerCase(), name, threadId: `thread-${i}`, cwd: join(dir, name), status: 'idle', updatedAt: at(i), lastReadAt: at(i), archived: false });
  // Finished history, queued runs (some waiting on a decision) and timestamp ties.
  for (let i = 0; i < 150; i++)
    store.put('run', { id: `run-${i}`, botId: `bot-${i % 3}`, scheduleId: `s-${i % 4}`, title: `Run ${i}`, scheduledAt: at(i % 40),
      status: i % 7 === 0 ? 'queued' : 'completed', ...(i % 14 === 0 ? { decision: { state: 'required' } } : {}) });
  store.put('pending', { id: 'p-1', botId: 'bot-1', key: 'question' });
  store.put('schedule', { id: 's-1', botId: 'bot-2', prompt: 'daily' });
  return { dir, store, runtime: new BotRuntime({ store, codex: new MinimalCodex(), root: join(dir, 'bots') }) };
}

test('a bot-scoped snapshot equals the full snapshot filtered for that bot', async t => {
  const { store, runtime } = await fixture(t);
  for (const bot of store.bots()) {
    const raw = runtime.snapshot(bot.id);
    // Only this bot is built; hub-owned catalogs are not read at all.
    assert.deepEqual(raw.bots.map(b => b.id), [bot.id]);
    assert.deepEqual([raw.runs, raw.schedules], [[], []]);
    assert.deepEqual(agentSnapshot(raw, bot.id), agentSnapshot(runtime.snapshot(), bot.id), bot.id);
  }
  // The portable read path asks for the scoped form through dispatch.
  assert.deepEqual(await runtime.dispatch('snapshot', 'bot-1', { botScope: true }), runtime.snapshot('bot-1'));
  assert.deepEqual((await runtime.dispatch('snapshot', 'bot-1', {})).bots.length, 3);
});

test('queued-only run reads keep background counts and lists unchanged', async t => {
  const { store, runtime } = await fixture(t);
  const queued = store.list('run').filter(run => run.status === 'queued');
  assert.deepEqual(store.runsWithStatus('queued').map(run => run.id).sort(), queued.map(run => run.id).sort());
  assert.deepEqual(store.runsWithStatus('queued', 'bot-1').map(run => run.id).sort(), queued.filter(run => run.botId === 'bot-1').map(run => run.id).sort());
  for (const bot of store.bots()) {
    const counts = runtime.runs.counts(bot.id);
    assert.equal(counts.needsInput, queued.filter(run => run.botId === bot.id && run.decision?.state === 'required').length);
  }
});

test('recent runs keep the previous newest-first order, ties included', async t => {
  const { store } = await fixture(t);
  const ids = ['bot-0', 'bot-1', 'bot-2'];
  const previous = ids.flatMap(id => store.list('run', id)).sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)).slice(0, 100);
  assert.deepEqual(store.recentRuns(ids, 100), previous);
  assert.deepEqual(store.recentRuns(['bot-2'], 5), store.list('run', 'bot-2').sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt)).slice(0, 5));
  assert.deepEqual(store.recentRuns([], 100), []);
  assert.equal(store.recentRuns(null, 1000).length, 150);
});

test('pending node events are read through their partial index', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'journal-index-'));
  const journal = new NodeJournal(join(dir, 'journal.sqlite'));
  t.after(async () => { journal.close(); await rm(dir, { recursive: true, force: true }); });
  const plan = journal.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM node_events WHERE acked=0 ORDER BY sequence LIMIT 40').all().map(row => row.detail).join(' ');
  assert.match(plan, /node_events_pending/);
  journal.recordEvent('event-1', { botId: 'bot-0', epoch: 1, event: { type: 'x' } });
  journal.recordEvent('event-2', { botId: 'bot-0', epoch: 1, event: { type: 'y' } });
  journal.acknowledgeEvent('event-1');
  assert.deepEqual(journal.pendingEvents().map(row => row.event_id), ['event-2']);
});
