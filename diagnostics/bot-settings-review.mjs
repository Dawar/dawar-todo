// Focused, synthetic calculations for the three independent settings-review
// counterexamples. Real controller/client/runtime; no user account or network.
// Run: node diagnostics/bot-settings-review.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtime as browserRuntime } from '../tests/helpers/load-ts.mjs';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const bot = (changes = {}) => ({ id: 'synthetic', slug: 'synthetic', name: 'Synthetic',
  model: 'gpt-6-luna', effort: 'high', serviceTier: 'default', mode: 'default',
  updatedAt: '2026-01-01T00:00:00Z', ...changes });
const snapshot = (cursor, changes = {}) => ({ cursor, bots: [bot(changes)], pending: [], ready: true,
  account: { authenticated: true }, defaults: { model: 'gpt-6-luna', effort: 'high', serviceTier: 'priority' },
  models: [], schedules: [], runs: [] });

function fixture() {
  const disk = new Map();
  let writes = 0, refuse = () => false;
  const storage = {
    getItem: key => disk.get(key) ?? null,
    setItem(key, value) {
      if (key.endsWith(':settings:synthetic') && refuse(++writes, JSON.parse(value))) throw Error('Synthetic storage full');
      disk.set(key, value);
    },
    removeItem: key => disk.delete(key),
  };
  const env = browserRuntime({ localStorage: storage });
  const { botsClient: client, BotRpcError } = env.load('./app/bots/client.ts');
  const { ComposerSettingsController } = env.load('./app/bots/composer-settings-controller.ts');
  client.owner = 'synthetic-owner'; client.online = true; client.snapshot = snapshot(10);
  const calls = [], reads = [];
  client.rpc = (method, botId, params, operationId) => {
    if (method === 'snapshot') return new Promise(resolve => reads.push(resolve));
    if (method !== 'bots.update') return Promise.resolve({});
    const persisted = JSON.parse(disk.get('dawar-bots:synthetic-owner:settings:synthetic'));
    // Every transport entry must already have the exact identity and latest intent on disk.
    assert.equal(persisted.state.pending.operationId, operationId);
    assert.equal(JSON.stringify(persisted.state.pending.values), JSON.stringify(params));
    return new Promise((resolve, reject) => calls.push({ params, operationId, resolve, reject,
      persistedIntent: persisted.state.intent }));
  };
  const controller = new ComposerSettingsController(client.owner, 'synthetic');
  controller.observe(client.snapshot.bots[0], client.snapshot, true);
  return { client, controller, calls, reads, BotRpcError, disk,
    refuse(fn) { refuse = fn; },
    reload() { return new ComposerSettingsController(client.owner, 'synthetic'); },
    close() { client.flushSnapshot(); },
  };
}

async function confirmationAndSnapshotGap() {
  const f = fixture();
  f.controller.edit({ mode: 'plan' });
  // A newer unrelated field must remain live while the saved response carries an old value.
  f.client.receive({ type: 'event', event: { seq: 11, type: 'bot', data: bot({ effort: 'ultra' }) } });
  f.calls[0].resolve(bot({ mode: 'plan', effort: 'high' }));
  await settle();
  assert.equal(f.controller.displayed().mode, 'plan');
  assert.equal(f.controller.displayed().effort, 'ultra');
  assert.deepEqual(Object.keys(f.controller.getSnapshot().confirmed.values), ['mode']);
  f.client.receive({ type: 'event', event: { seq: 13, type: 'codex', data: { method: 'synthetic/unrelated' } } });
  f.reads.shift()(snapshot(12, { mode: 'plan', effort: 'ultra' }));
  await settle();
  assert.equal(f.client.snapshot.cursor, 13);
  assert.equal(f.client.snapshot.bots[0].mode, 'plan');
  assert.equal(f.controller.displayed().mode, 'plan');
  assert.equal(f.controller.displayed().effort, 'ultra');
  assert.equal(f.controller.getSnapshot().confirmed, null);
  // Confirmed fields must also follow genuinely later authoritative changes.
  f.client.receive({ type: 'event', event: { seq: 14, type: 'bot', data: bot({ mode: 'default', effort: 'medium' }) } });
  assert.equal(f.controller.displayed().mode, 'default');
  assert.equal(f.controller.displayed().effort, 'medium');
  const stale = f.client.refresh(); f.reads.shift()(snapshot(11)); await stale;
  assert.equal(f.client.snapshot.bots[0].effort, 'medium');
  // A full response must heal missing earlier fields without undoing a newer
  // entity event received while that read was in flight.
  const current = f.client.refresh(); f.reads.shift()(snapshot(13, { mode: 'plan', effort: 'ultra' })); await current;
  assert.equal(f.client.snapshot.bots[0].mode, 'default');
  assert.equal(f.client.snapshot.bots[0].effort, 'medium');
  // Even a provisional disk cursor larger than a response cannot block full hydration.
  const reloaded = fixture(); reloaded.client.snapshot = snapshot(99);
  const hydration = reloaded.client.refresh();
  reloaded.reads.shift()(snapshot(12, { mode: 'plan' })); await hydration;
  assert.equal(reloaded.client.snapshot.bots[0].mode, 'plan');
  assert.equal(reloaded.client.snapshot.cursor, 12);
  // A completed operation's causal read can contain a later external choice.
  // Neither unrelated event values nor a provisional cursor may freeze it.
  const external = fixture(); external.client.snapshot = snapshot(99);
  external.controller.edit({ mode: 'plan' }); external.calls[0].resolve(bot({ mode: 'plan' })); await settle();
  assert.equal(external.controller.displayed().mode, 'plan');
  external.reads.shift()(snapshot(12, { mode: 'default', effort: 'medium' })); await settle();
  assert.equal(external.controller.getSnapshot().confirmed, null);
  assert.equal(external.controller.displayed().mode, 'default');
  assert.equal(external.controller.displayed().effort, 'medium');
  f.close(); reloaded.close(); external.close();
  return { gap: 'cached 10 + event 13 + full 12 => Plan on / cursor 13',
    unrelatedEffort: 'ultra preserved; later medium observed', provisionalCache: '99 repaired by full 12',
    newerEntity: 'event 14 retained over full 13', externalChange: 'post-terminal full read reconciles submitted fields, no frozen overlay' };
}

async function storageGate() {
  const first = fixture(); first.refuse(() => true);
  first.controller.edit({ mode: 'plan' });
  assert.equal(first.calls.length, 0);
  assert.equal(first.controller.displayed().mode, 'plan');
  assert.ok(first.controller.getSnapshot().storageError);
  first.controller.retryStorage(); assert.equal(first.calls.length, 0);
  first.refuse(() => false); first.controller.retryStorage();
  assert.equal(first.calls.length, 1);
  first.close();

  const f = fixture(); f.refuse(write => write === 2); // Intent saves; exact pending-operation write fails.
  f.controller.edit({ mode: 'plan' });
  const blockedId = f.controller.getSnapshot().pending.operationId;
  assert.equal(f.calls.length, 0);
  assert.equal(f.controller.getSnapshot().pending.phase, 'storage');
  f.controller.edit({ mode: 'default', serviceTier: 'priority' });
  assert.equal(f.calls.length, 0);
  f.controller.retryStorage();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].operationId, blockedId);
  assert.equal(f.calls[0].persistedIntent.mode, 'default');
  assert.equal(f.calls[0].persistedIntent.serviceTier, 'priority');
  f.calls[0].reject(new f.BotRpcError('Synthetic uncertain reply', 'uncertain')); await settle();
  f.refuse(() => true); f.controller.retry();
  assert.equal(f.calls.length, 1); // No retry escapes failed storage either.
  assert.equal(f.controller.getSnapshot().pending.phase, 'storage');
  f.refuse(() => false); f.controller.retryStorage();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].operationId, blockedId);
  f.close();
  return { failedIntentWrites: '0 RPCs', failedPendingWrite: '0 RPCs',
    recovery: 'same ID and full latest intent persisted before dispatch', failedRetryWrite: '0 additional RPCs' };
}

async function exactRecovery() {
  const f = fixture();
  f.controller.edit({ mode: 'plan' }); f.controller.edit({ mode: 'default' });
  const original = f.calls[0];
  original.reject(new f.BotRpcError('Synthetic lost reply', 'uncertain')); await settle();
  // Matching values are not operation evidence, even in a fresh full snapshot.
  const read = f.client.refresh(); f.reads.shift()(snapshot(12, { mode: 'plan' })); await read;
  f.controller.observe(f.client.snapshot.bots[0], f.client.snapshot, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.controller.getSnapshot().pending.operationId, original.operationId);
  assert.equal(f.controller.getSnapshot().pending.phase, 'checking');
  assert.equal(f.controller.displayed().mode, 'default');
  const recovered = f.reload(); recovered.observe(f.client.snapshot.bots[0], f.client.snapshot, true);
  assert.equal(f.calls.length, 1);
  assert.equal(recovered.getSnapshot().pending.operationId, original.operationId);
  recovered.retry();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].operationId, original.operationId);
  assert.equal(JSON.stringify(f.calls[1].params), JSON.stringify(original.params));
  // Offline at the retry boundary is not proof the original did not execute.
  f.calls[1].reject(new f.BotRpcError('Synthetic socket closed', 'not-sent')); await settle();
  assert.equal(f.calls.length, 2);
  assert.equal(recovered.getSnapshot().pending.operationId, original.operationId);
  assert.equal(recovered.getSnapshot().pending.phase, 'checking');
  recovered.retry();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].operationId, original.operationId);
  f.calls[2].resolve(bot({ mode: 'plan' })); await settle();
  assert.equal(f.calls.length, 4);
  assert.notEqual(f.calls[3].operationId, original.operationId);
  assert.equal(f.calls[3].params.mode, 'default');
  assert.equal(recovered.displayed().mode, 'default');
  f.close();
  return { matchingFullSnapshot: 'queue remains blocked', reload: 'same ID retained, no automatic RPC',
    explicitRetry: 'same ID / same params', retryNotSent: 'original uncertainty retained, no successor',
    successor: 'new ID only after terminal original result' };
}

async function runtimeIdentity() {
  const dir = await mkdtemp(join(tmpdir(), 'bot-setting-identity-'));
  const store = new Store(join(dir, 'state.sqlite'));
  const codex = new EventEmitter(), calls = [];
  codex.call = (method, params) => new Promise(resolve => calls.push({ method, params, resolve }));
  const bridge = new BotRuntime({ store, codex, root: dir });
  bridge.models = [{ model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [] }];
  store.saveBot(bot({ cwd: dir, threadId: 'synthetic-native' }));
  try {
    const request = { method: 'bots.update', botId: 'synthetic', operationId: 'synthetic-same-operation', params: { mode: 'plan' } };
    const original = bridge.handle(request); await settle();
    const retry = bridge.handle(request); await settle();
    assert.equal(calls.length, 1);
    assert.equal(store.operation(request.operationId).status, 'dispatching');
    calls[0].resolve({});
    assert.equal((await original).mode, 'plan'); assert.equal((await retry).mode, 'plan');
    assert.equal(calls.length, 1);
    assert.equal(store.operation(request.operationId).status, 'done');
    await bridge.handle(request); assert.equal(calls.length, 1);
    return { concurrentSameId: '1 native mutation', completedSameId: 'stored terminal result, 0 additional native mutations' };
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
}

console.log(JSON.stringify({
  confirmation: await confirmationAndSnapshotGap(),
  storage: await storageGate(),
  recovery: await exactRecovery(),
  runtime: await runtimeIdentity(),
}, null, 2));
