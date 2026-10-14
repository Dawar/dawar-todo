import assert from 'node:assert/strict';
import test from 'node:test';
import { runtime } from './helpers/load-ts.mjs';

const queued = (extra = {}) => ({ id: 'q1', revision: 3, state: 'queued', input: [{ type: 'text', text: 'Original queued message' }], attachments: [], ...extra });
function setup() {
  const env = runtime({ Error, TypeError });
  const { BotDraftStore } = env.load('app/bots/draft-store.ts');
  const { BotComposer } = env.load('app/bots/composer-controller.ts');
  const store = new BotDraftStore(env.indexedDB), calls = [];
  const transport = { owner: 'owner', online: true,
    rpc: async (...args) => { calls.push(args); return { deleted: true }; },
    download: async () => ({ blob: new Blob(['file bytes']) }), upload: async () => {} };
  return { store, transport, calls, create: () => new BotComposer('owner', 'bot', store, transport) };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('checkout saves text and attachments before removal and opens only after positive acknowledgement', async () => {
  const { create, store, transport, calls } = setup(), c = create(); await c.open(); c.setText('Unrelated normal draft'); await c.flush();
  const ack = deferred(), started = deferred();
  transport.rpc = async (...args) => {
    calls.push(args); const saved = await store.get('owner', 'bot');
    assert.equal(saved.slots['recovered:queue:q1:3'].text, 'Original queued message');
    assert.equal(saved.slots['recovered:queue:q1:3'].files[0].remote.id, 'file');
    assert.equal(saved.operations[args[3]].method, 'queue.delete'); started.resolve(); return ack.promise;
  };
  const file = { id: 'file', botId: 'bot', name: 'notes.txt', mimeType: 'text/plain', size: 10, ready: true };
  const checking = c.checkout(queued({ attachments: [file] })); await started.promise;
  assert.equal(c.record.active, 'normal'); assert.equal(c.operation.method, 'queue.delete');
  assert.equal(c.record.slots['recovered:queue:q1:3'].queueSource.removed, false);
  ack.resolve({ deleted: true }); assert.equal(await checking, true);
  assert.equal(c.draft.text, 'Original queued message'); assert.equal(c.draft.queueId, undefined);
  assert.equal(c.draft.files.length, 1); assert.equal(c.draft.queueSource, undefined);
  assert.equal(c.record.active, 'normal'); assert.ok(Object.values(c.record.slots).some(draft=>draft.text==='Unrelated normal draft')); assert.equal(calls.length, 1);
  assert.equal(calls[0][2].expectedRevision, 3);
});

test('lost removal acknowledgement survives reload and retries the original identity without sending', async () => {
  const { create, transport, calls } = setup(), c = create(); await c.open();
  transport.rpc = async (...args) => { calls.push(args); throw Error('lost ack'); };
  assert.equal(await c.checkout(queued()), false); const id = c.operation.id;
  const restored = create(); await restored.open(); assert.equal(restored.operation.id, id);
  transport.rpc = async (...args) => { calls.push(args); return { deleted: true }; };
  await restored.send(); assert.equal(calls.length, 2); assert.equal(calls[1][3], id);
  assert.ok(calls.every(call => call[0] === 'queue.delete'));
  assert.equal(restored.draft.queueSource, undefined); assert.equal(restored.draft.text, 'Original queued message');
});

test('a storage failure never removes the queued original', async () => {
  const { create, store, calls } = setup(), c = create(); await c.open();
  store.change = async () => { throw Error('disk full'); };
  assert.equal(await c.checkout(queued()), false); assert.equal(calls.length, 0); assert.match(c.storageError, /disk full/);
});

test('already-starting or rejected removals never enable the saved copy for submission', async () => {
  const { create, transport, calls } = setup(), c = create(); await c.open();
  assert.equal(await c.checkout(queued({ state: 'dispatching' })), false); assert.equal(calls.length, 0);
  transport.rpc = async (...args) => { calls.push(args); throw Object.assign(Error('already started'), { outcome: 'rejected' }); };
  assert.equal(await c.checkout(queued()), false); assert.equal(c.record.active, 'normal');
  c.select('recovered:queue:q1:3'); await c.flush(); await c.send(true);
  assert.equal(calls.length, 1); assert.match(c.actionError, /Removal was not confirmed/);
});

test('named-list checkout becomes a normal draft and only explicit queueing adds it to the default queue', async () => {
  const { create, calls } = setup(), c = create(); await c.open();
  assert.equal(await c.checkout(queued({ listId: 'nightly' })), true); c.setText('Edited nightly work'); await c.flush();
  assert.equal(calls.length, 1); await c.reconcile(); assert.equal(calls.length, 1);
  await c.send(true); assert.equal(calls[1][0], 'queue.add'); assert.equal(calls[1][2].listId, undefined);
  assert.equal(calls[1][2].text, 'Edited nightly work'); assert.equal(calls[1][2].id, undefined);
});

test('two tabs share one removal identity and a late lost response cannot undo confirmation', async () => {
  const { create, transport, calls } = setup(), a = create(); await a.open();
  const ack = deferred(), started = deferred(); transport.rpc = (...args) => { calls.push(args); started.resolve(); return ack.promise; };
  const checking = a.checkout(queued()); await started.promise; const id = a.operation.id;
  const b = create(); await b.open(); transport.rpc = async (...args) => { calls.push(args); return { deleted: true }; };
  await b.send(); ack.reject(Error('late lost ack')); await checking; await a.refresh();
  assert.equal(calls[1][3], id); assert.equal(a.operation, undefined);
  assert.equal(a.record.checkedOut['recovered:queue:q1:3'], true); assert.equal(a.record.active,'normal'); assert.equal(a.actionError, '');
});

test('a positively rejected removal can be retried without replacing its saved draft', async () => {
  const { create, transport, calls } = setup(), c = create(); await c.open();
  transport.rpc = async (...args) => { calls.push(args); throw Object.assign(Error('temporarily rejected'), { outcome: 'rejected' }); };
  assert.equal(await c.checkout(queued()), false);
  const version = c.record.slots['recovered:queue:q1:3'].textVersion;
  transport.rpc = async (...args) => { calls.push(args); return { deleted: true }; };
  assert.equal(await c.checkout(queued()), true); assert.equal(c.draft.textVersion, version);
  assert.notEqual(calls[0][3], calls[1][3], 'only a positively rejected action permits a fresh retry identity');
  assert.equal(c.draft.queueSource, undefined);
});
