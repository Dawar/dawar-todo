import assert from 'node:assert/strict';
import test from 'node:test';
import { runtime } from './helpers/load-ts.mjs';

function setup() {
  const env = runtime({ Error, TypeError });
  const { BotDraftStore } = env.load('app/bots/draft-store.ts');
  const { BotComposer } = env.load('app/bots/composer-controller.ts');
  const store = new BotDraftStore(env.indexedDB);
  const transport = { owner: 'synthetic-owner', online: true, rpc: async () => ({}), upload: async () => {}, download: async () => {} };
  return { store, create: (rpc) => new BotComposer(transport.owner, 'synthetic-bot', store, { ...transport, rpc }) };
}
const failUncertain = async () => { throw new Error('EPIPE after possible native commit'); };

test('confirmation in another tab retires the uncertainty warning with its operation', async () => {
  const { create } = setup();
  const a = create(failUncertain); await a.open(); a.setText('submitted'); await a.flush(); await a.send();
  assert.match(a.operation.error, /acknowledgement is unconfirmed/);
  const id = a.operation.id;
  const b = create(async (_method, _bot, _params, operationId) => { assert.equal(operationId, id); return {}; });
  await b.open(); await b.send(); await a.refresh();
  assert.equal(a.operation, undefined); assert.equal(a.draft.text, '');
  assert.equal(a.actionError, '', 'the original tab must not retain a stale acknowledgement warning');
});

test('late uncertain callback after another tab confirmed cannot restore an operation or a false warning', async () => {
  const { create, store } = setup();
  let fail, started;
  const dispatched = new Promise((resolve) => { started = resolve; });
  const a = create(() => new Promise((_resolve, reject) => { fail = reject; started(); }));
  await a.open(); a.setText('submitted'); await a.flush();
  const sending = a.send(); await dispatched;
  const b = create(async () => ({})); await b.open();
  b.setText('newer text in second tab'); await b.flush(); await b.send();
  fail(new Error('late connection loss')); await sending;
  assert.equal(a.operation, undefined); assert.equal(a.actionError, '');
  assert.equal(a.draft.text, 'newer text in second tab');
  assert.equal(Object.keys((await store.get('synthetic-owner', 'synthetic-bot')).operations).length, 0);
});

test('definitive rejection still gives correction guidance after retiring the operation', async () => {
  const { create } = setup();
  const c = create(async () => { throw Object.assign(new Error('invalid attachment'), { outcome: 'rejected' }); });
  await c.open(); c.setText('correctable draft'); await c.flush(); await c.send();
  assert.equal(c.operation, undefined); assert.equal(c.draft.text, 'correctable draft');
  assert.equal(c.actionError, 'Not sent: invalid attachment');
});
