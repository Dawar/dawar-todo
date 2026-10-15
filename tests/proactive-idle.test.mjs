import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { MinimalCodex } from '../bot-bridge/claude-test-support.mjs';

// Proactive reviews and memory maintenance share this idle predicate. Live,
// 28 of 30 bots were never reviewed because past queue items in "delivered"
// or "merged" state counted as pending work.
test('queue history does not keep a bot busy; waiting queue items do', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'proactive-idle-'));
  const store = new Store(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const runtime = new BotRuntime({ store, codex: new MinimalCodex(), root: join(dir, 'bots') });
  const at = new Date().toISOString();
  store.saveBot({ id: 'bot-1', slug: 'atlas', name: 'Atlas', threadId: 'thread-1', cwd: join(dir, 'atlas'), status: 'idle', executionMode: 'single-thread', updatedAt: at, lastReadAt: at, archived: false });
  const idle = () => runtime.memoryMaintenance.idle(store.bot('bot-1'));
  assert.equal(idle(), true);
  for (const [i, state] of ['delivered', 'merged', 'consumed', 'deleted', 'failed', 'cancelled'].entries())
    store.put('promptQueue', { id: `history-${i}`, botId: 'bot-1', state, createdAt: at });
  assert.equal(idle(), true, 'delivered and merged queue history is not pending work');
  for (const state of ['queued', 'staged', 'dispatching', 'uncertain', 'native-queued']) {
    store.put('promptQueue', { id: 'waiting', botId: 'bot-1', state, createdAt: at });
    assert.equal(idle(), false, `${state} is still waiting to reach the bot`);
  }
});
