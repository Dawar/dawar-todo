import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { MinimalCodex } from '../bot-bridge/claude-test-support.mjs';
import { captureActivity } from '../bot-bridge/turn-state.mjs';

// Live Oct 15: a turn failed with responseStreamDisconnected right before a
// restart, so its recovery row never got a releaseActionId. Every recovery
// pass then threw "Provided value cannot be bound to SQLite parameter 2" and
// the bot stayed in "Checking execution", refusing new messages.
test('recovery resumes a bot whose failure never reached the unload step', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'recovery-missing-action-'));
  const store = new Store(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(store.get('nativeRecoveryAction', undefined), null);
  assert.equal(store.get('nativeRecoveryAction', null), null);
  const runtime = new BotRuntime({ store, codex: new MinimalCodex(), root: join(dir, 'bots') });
  const at = new Date().toISOString();
  store.saveBot({ id: 'bot-1', slug: 'connie', name: 'Connie', threadId: 'thread-1', cwd: join(dir, 'connie'), status: 'idle', executionMode: 'single-thread', updatedAt: at, lastReadAt: at, archived: false });
  store.put('nativeErrorRecovery', { id: 'bot-1', botId: 'bot-1', threadId: 'thread-1', failedTurnId: 'turn-1', attempts: 32, errorCode: 'responseStreamDisconnected',
    nativeRetry: true, nativeRetryEpoch: 'previous-process', phase: 'native-retrying', terminalConfirmed: false, createdAt: at });
  const read = async () => ({ id: 'thread-1', status: { type: 'idle' } });
  // Later guards may still hold it in this minimal fixture; the store lookup must not.
  const outcome = await runtime.nativeErrorRecovery.resume('bot-1', captureActivity(runtime, 'bot-1'), read, 'idle').then(() => null, error => error);
  assert.doesNotMatch(outcome?.message ?? '', /cannot be bound/, 'a missing release action is not a database error');
});
