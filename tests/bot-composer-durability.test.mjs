import assert from 'node:assert/strict';
import test from 'node:test';
import { IDBObjectStore } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';

function storage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  return { get length() { return entries.size; }, key: (i) => [...entries.keys()][i] ?? null,
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, String(value)), removeItem: (key) => entries.delete(key), entries };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise((r) => setTimeout(r, 2)); } assert.fail('condition did not settle'); }
function setup(legacy = storage()) {
  const env = runtime({ localStorage: legacy, Error, TypeError });
  const { BotDraftStore, DRAFT_DATABASE } = env.load('app/bots/draft-store.ts');
  const { BotComposer } = env.load('app/bots/composer-controller.ts');
  const store = new BotDraftStore(env.indexedDB, legacy);
  const calls = [];
  const transport = {
    owner: 'alice', online: false,
    rpc: async (...args) => { calls.push(args); return {}; },
    upload: async (botId, file, progress, id) => { calls.push(['upload', botId, file, id]); return { id, botId, name: file.name, mimeType: file.type, size: file.size, ready: true }; },
    download: async () => ({ blob: new Blob(['legacy'], { type: 'image/png' }) }),
  };
  const composer = (id = 'bot-a', owner = 'alice') => new BotComposer(owner, id, store, transport);
  return { ...env, store, composer, transport, calls, legacy, BotDraftStore, DRAFT_DATABASE };
}
const staged = (id, extra = {}) => ({ id, name: `${id}.png`, mimeType: 'image/png', size: 5, hasBytes: true, ...extra });
const text = (value, version, base = 'legacy', slot = 'normal') => ({ kind: 'text', slot, text: value, version, base });
async function abortPuts(run, name = 'drafts') {
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    const request = original.apply(this, args);
    if (this.name === name) request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try { await run(); } finally { IDBObjectStore.prototype.put = original; }
}

test('migration commits only on transaction completion and keeps legacy originals through failure and success', async () => {
  const legacy = storage({ 'dawar-bots:alice:draft:bot-a': JSON.stringify('old text'), 'dawar-bots:alice:uploads:bot-a': JSON.stringify([{ id: 'old-image', botId: 'bot-a', name: 'old.png', mimeType: 'image/png', size: 6, ready: true }]) });
  const { store } = setup(legacy);
  await store.get('alice', 'bot-a');
  await abortPuts(async () => {
    await assert.rejects(store.load('alice', 'bot-a'));
    assert.equal(await store.get('alice', 'bot-a'), undefined);
    assert.equal(JSON.parse(legacy.getItem('dawar-bots:alice:draft:bot-a')), 'old text');
  });
  const record = await store.load('alice', 'bot-a');
  assert.equal(record.slots.normal.text, 'old text');
  assert.equal(record.slots.normal.files[0].hasBytes, false);
  await store.change('alice', 'bot-a', text('new text', 'new'));
  assert.equal((await store.load('alice', 'bot-a')).slots.normal.text, 'new text');
  assert.ok(legacy.getItem('dawar-bots:alice:uploads:bot-a'));
});

test('invalid or unavailable legacy storage blocks migration, preserving originals', async () => {
  const legacy = storage({ 'dawar-bots:alice:draft:bot-a': '{corrupt' });
  const { store, composer } = setup(legacy);
  const c = composer(); await c.open();
  assert.equal(c.ready, false); assert.match(c.storageError, /original/);
  assert.equal(await store.get('alice', 'bot-a'), undefined);
  assert.equal(legacy.getItem('dawar-bots:alice:draft:bot-a'), '{corrupt');
  legacy.setItem('dawar-bots:alice:draft:bot-a', '"repaired"');
  await c.retry(); assert.equal(c.draft.text, 'repaired');
});

test('text and staged bytes survive rapid bot switches, hidden navigation and new controllers offline', async () => {
  const { store, composer } = setup();
  const a = composer(), b = composer('bot-b'); await Promise.all([a.open(), b.open()]);
  for (let i = 0; i < 40; i++) { a.setText(`a ${i}`); b.setText(`b ${i}`); }
  a.addFiles([new File(['image bytes'], 'pasted.png', { type: 'image/png' }), new File(['document'], 'notes.txt', { type: 'text/plain' })]);
  await Promise.all([a.flush(), b.flush()]);
  const reloadedA = composer(), reloadedB = composer('bot-b');
  await Promise.all([reloadedA.open(), reloadedB.open()]);
  assert.equal(reloadedA.draft.text, 'a 39'); assert.equal(reloadedB.draft.text, 'b 39');
  assert.equal(reloadedA.files.size, 2);
  const id = reloadedA.draft.files[0].id;
  assert.equal(await (await store.file('alice', 'bot-a', id)).text(), 'image bytes');
  assert.equal(await reloadedA.files.get(id).text(), 'image bytes');
  assert.equal(reloadedB.files.size, 0);
});

test('file bytes and draft metadata roll back together; failed saving retains in-memory files for retry and never uploads', async () => {
  const { store, composer, transport, calls } = setup();
  const c = composer(); await c.open(); transport.online = true;
  await abortPuts(async () => {
    c.addFiles([new File(['keep me'], 'photo.png', { type: 'image/png' })]);
    await assert.rejects(c.flush());
    const id = c.draft.files[0].id;
    assert.equal(await store.file('alice', 'bot-a', id), undefined);
    assert.equal((await store.get('alice', 'bot-a')).slots.normal.files.length, 0);
    assert.equal(await c.files.get(id).text(), 'keep me');
    assert.match(c.storageError, /Retry saving/); assert.equal(calls.length, 0);
  });
  await c.retry(); await c.flush();
  assert.equal(c.draft.files[0].remote.ready, true); assert.equal(c.saved, true);
});

test('upload failure retains bytes across reload, retries same upload identity, and permits offline removal', async () => {
  const env = setup(); const { composer, transport, store } = env;
  const c = composer(); await c.open();
  c.addFiles([new File(['recoverable'], 'failed.png', { type: 'image/png' })]); await c.flush();
  const id = c.draft.files[0].id;
  const uploads = [];
  transport.online = true;
  transport.upload = async (...args) => { uploads.push(args[3]); throw new Error('interrupted'); };
  await c.resumeUploads(); await c.flush();
  assert.match(c.draft.files[0].error, /interrupted/);
  const recovered = composer(); await recovered.open();
  assert.equal(await recovered.files.get(id).text(), 'recoverable');
  transport.upload = async (botId, file, progress, stableId) => { uploads.push(stableId); return { id: stableId, botId, ready: true, name: file.name, mimeType: file.type, size: file.size }; };
  await recovered.retry();
  assert.deepEqual(uploads, [id, id]);
  transport.online = false; recovered.removeFile(id); await recovered.flush();
  assert.equal(await store.file('alice', 'bot-a', id), undefined);
});

test('late upload cannot resurrect a removed attachment or affect another bot', async () => {
  const { composer, transport } = setup(); const a = composer(), b = composer('bot-b'); await Promise.all([a.open(), b.open()]);
  const upload = deferred(); transport.upload = () => upload.promise; transport.online = true;
  a.addFiles([new File(['x'], 'late.png', { type: 'image/png' })]); await a.flush();
  await until(() => a.transferring.size === 1);
  const id = a.draft.files[0].id; a.removeFile(id); b.setText('untouched'); await Promise.all([a.flush(), b.flush()]);
  upload.resolve({ id, botId: 'bot-a', ready: true }); await until(() => a.transferring.size === 0); await a.flush();
  assert.equal(a.draft.files.length, 0); assert.equal(b.draft.text, 'untouched'); assert.equal(b.draft.files.length, 0);
});

test('late send acknowledgement clears only submitted text revision/files on its originating bot', async () => {
  const { composer, transport, store } = setup(); const a = composer(), b = composer('bot-b'); await Promise.all([a.open(), b.open()]);
  a.setText('submitted'); a.addFiles([new File(['one'], 'one.png', { type: 'image/png' })]); await a.flush();
  transport.online = true; await a.resumeUploads();
  const ack = deferred(); const sent = []; transport.rpc = (...args) => { sent.push(args); return ack.promise; };
  const send = a.send(); await until(() => sent.length === 1);
  const oldId = a.draft.files[0].id;
  a.setText('newer typing'); a.addFiles([new File(['two'], 'two.png', { type: 'image/png' })]); b.setText('other bot');
  await Promise.all([a.flush(), b.flush()]); ack.resolve({}); await send;
  assert.equal(a.draft.text, 'newer typing'); assert.equal(a.draft.files.length, 1); assert.equal(a.draft.files[0].name, 'two.png');
  assert.equal(b.draft.text, 'other bot'); assert.equal(await store.file('alice', 'bot-a', oldId), undefined);
  assert.equal(Object.keys((await store.get('alice', 'bot-a')).operations).length, 0);
});

test('edit back to same text still has a newer revision and survives acknowledgement', async () => {
  const { composer, transport } = setup(); const c = composer(); await c.open(); c.setText('same'); await c.flush(); transport.online = true;
  const ack = deferred(); let called = false; transport.rpc = () => { called = true; return ack.promise; };
  const send = c.send(); await until(() => called); c.setText('changed'); c.setText('same');
  ack.resolve({}); await send; await c.flush(); assert.equal(c.draft.text, 'same');
});

test('uncertain send survives restart; check/reconnect reuses its frozen operation and never sends unsubmitted newer typing', async () => {
  const { composer, transport, calls } = setup(); const c = composer(); await c.open(); c.setText('submitted'); await c.flush(); transport.online = true;
  transport.rpc = async (...args) => { calls.push(args); throw new Error('lost acknowledgement'); };
  await c.send(); const id = c.operation.id; c.setText('new unsubmitted text'); await c.flush();
  const recovered = composer(); await recovered.open();
  assert.equal(recovered.operation.id, id); await recovered.reconcile();
  assert.equal(calls[1][3], id); assert.equal(calls[1][2].text, 'submitted');
  transport.rpc = async (...args) => { calls.push(args); return {}; };
  await recovered.send(); assert.equal(calls[2][3], id); assert.equal(recovered.draft.text, 'new unsubmitted text');
  await recovered.reconcile(); assert.equal(calls.length, 3);
});

test('a failure before redispatch does not retire an already uncertain operation', async () => {
  const { composer, transport } = setup(); const c = composer(); await c.open(); c.setText('submitted'); await c.flush(); transport.online = true;
  transport.rpc = async () => { throw new Error('ack lost'); }; await c.send(); const id = c.operation.id;
  transport.rpc = async () => { throw Object.assign(new Error('socket closed'), { outcome: 'not-sent' }); };
  await c.send(); assert.equal(c.operation?.id, id);
});

test('queue editing is durable and independent; successful queue save restores normal text and attachments', async () => {
  const { composer, transport } = setup(); const c = composer(); await c.open();
  c.setText('normal draft'); c.addFiles([new File(['normal'], 'normal.png', { type: 'image/png' })]); await c.flush();
  c.edit({ id: 'q1', input: [{ type: 'text', text: 'queue original' }], attachments: [] }); c.setText('queue edited'); await c.flush();
  const reloaded = composer(); await reloaded.open(); assert.equal(reloaded.draft.queueId, 'q1'); assert.equal(reloaded.draft.text, 'queue edited');
  reloaded.select('normal'); await reloaded.flush(); assert.equal(reloaded.draft.text, 'normal draft'); assert.equal(reloaded.draft.files.length, 1);
  reloaded.edit({ id: 'q1', input: [{ type: 'text', text: 'stale history' }], attachments: [] }); await reloaded.flush(); assert.equal(reloaded.draft.text, 'queue edited');
  transport.online = true; await reloaded.send(true);
  assert.equal(reloaded.record.active, 'normal'); assert.equal(reloaded.draft.text, 'normal draft'); assert.equal(reloaded.draft.files.length, 1);
});

test('queue acknowledgement keeps newer queue edits and cannot close another edited queue item', async () => {
  const { composer, transport } = setup(); const c = composer(); await c.open();
  c.edit({ id: 'q1', input: [{ type: 'text', text: 'one' }], attachments: [] }); await c.flush(); transport.online = true;
  const ack = deferred(); let called = false; transport.rpc = () => { called = true; return ack.promise; }; const send = c.send(true); await until(() => called);
  c.setText('newer queue one'); c.edit({ id: 'q2', input: [{ type: 'text', text: 'two' }], attachments: [] }); await c.flush();
  ack.resolve({}); await send; assert.equal(c.draft.queueId, 'q2'); assert.equal(c.draft.text, 'two'); assert.equal(c.record.slots['queue:q1'].text, 'newer queue one');
});

test('concurrent tabs preserve conflicting text versions and both sets of staged bytes', async () => {
  const { composer, store } = setup(); const a = composer(), b = composer(); await Promise.all([a.open(), b.open()]);
  a.setText('tab one'); b.setText('tab two'); await Promise.all([a.flush(), b.flush()]);
  const record = await store.get('alice', 'bot-a'); const texts = Object.values(record.slots).map((d) => d.text);
  assert.ok(texts.includes('tab one')); assert.ok(texts.includes('tab two'));
  a.addFiles([new File(['a'], 'a.png', { type: 'image/png' })]); b.addFiles([new File(['b'], 'b.png', { type: 'image/png' })]); await Promise.all([a.flush(), b.flush()]);
  const current = await store.get('alice', 'bot-a'); assert.equal(current.slots.normal.files.length, 2);
  for (const file of current.slots.normal.files) assert.ok(await store.file('alice', 'bot-a', file.id));
});

test('two tabs share the first operation while it is outstanding and compare-and-clear is idempotent', async () => {
  const { composer, transport, store } = setup(); const a = composer(); await a.open(); a.setText('shared'); await a.flush();
  const b = composer(); await b.open(); const ack = deferred(); const ids = []; transport.online = true;
  transport.rpc = (...args) => { ids.push(args[3]); return ack.promise; };
  const first = a.send(), second = b.send(); await until(() => ids.length === 2); assert.equal(ids[0], ids[1]);
  ack.resolve({}); await Promise.all([first, second]); assert.equal((await store.get('alice', 'bot-a')).slots.normal.text, '');
});

test('owner namespaces isolate drafts and a late acknowledgement only settles the old owner', async () => {
  const { composer, transport, store } = setup(); const alice = composer(); await alice.open(); alice.setText('alice'); await alice.flush(); transport.online = true;
  const ack = deferred(); let called = false; transport.rpc = () => { called = true; return ack.promise; }; const send = alice.send(); await until(() => called);
  transport.owner = 'bob'; const bob = composer('bot-a', 'bob'); await bob.open(); assert.equal(bob.draft.text, ''); bob.setText('bob'); await bob.flush();
  alice.setText('must not write while locked'); ack.resolve({}); await send;
  assert.equal((await store.get('alice', 'bot-a')).slots.normal.text, ''); assert.equal((await store.get('bob', 'bot-a')).slots.normal.text, 'bob');
  assert.equal((await store.list('bob')).length, 1);
});

test('six image and twelve file limits count offline staged attachments', async () => {
  const { composer } = setup(); const c = composer(); await c.open();
  c.addFiles(Array.from({ length: 6 }, (_, i) => new File(['x'], `${i}.png`, { type: 'image/png' }))); await c.flush();
  c.addFiles([new File(['x'], 'extra.png', { type: 'image/png' })]); assert.match(c.actionError, /6 images/); assert.equal(c.draft.files.length, 6);
  c.addFiles(Array.from({ length: 6 }, (_, i) => new File(['x'], `${i}.txt`))); await c.flush();
  c.addFiles([new File(['x'], 'extra.txt')]); assert.match(c.actionError, /12 files/); assert.equal(c.draft.files.length, 12);
});

test('real history refresh cannot overwrite newer typing or another owner composer', async () => {
  const env = setup(), c = env.composer(); await c.open(); c.setText('before'); await c.flush();
  const { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const response = deferred(); env.transport.online = true; env.transport.rpc = () => response.promise;
  const timeline = new BotTimeline('alice', 'bot-a', env.transport, { read: async () => null, write: async () => {} });
  const loading = timeline.refresh(); await new Promise((r) => setTimeout(r, 0));
  c.setText('typing during history'); await c.flush(); env.transport.owner = 'bob';
  response.resolve({ kind: 'page', entries: [], attachments: [], olderCursor: null, revision: 'v1', eventCursor: 0, complete: true });
  await loading;
  assert.equal(c.draft.text, 'typing during history');
  assert.equal((await env.store.load('alice', 'bot-a')).slots.normal.text, 'typing during history');
  assert.equal(timeline.getSnapshot().cached, false); await timeline.dispose();
});

test('send identity transaction failure prevents dispatch; reconciliation also waits for commit', async () => {
  const { composer, transport, calls } = setup(); const c = composer(); await c.open(); c.setText('must persist first'); await c.flush(); transport.online = true;
  await abortPuts(async () => {
    const send = c.send(); const reconnect = c.reconcile(); await Promise.all([send, reconnect]);
    assert.equal(calls.length, 0); assert.equal(c.draft.text, 'must persist first'); assert.match(c.storageError, /Retry saving/);
  });
  await c.flush(); await c.reconcile(); assert.equal(calls.length, 1);
});

test('acknowledgement transaction abort retains durable submission and bytes for safe reload reconciliation', async () => {
  const { composer, transport, store } = setup(); const c = composer(); await c.open();
  c.setText('submit'); c.addFiles([new File(['preserve'], 'file.txt')]); await c.flush(); transport.online = true; await c.resumeUploads();
  const ack = deferred(); let called = false; transport.rpc = () => { called = true; return ack.promise; };
  const send = c.send(); await until(() => called); const id = c.operation.id, fileId = c.draft.files[0].id;
  await abortPuts(async () => {
    ack.resolve({}); await send;
    assert.ok((await store.get('alice', 'bot-a')).operations[id]);
    assert.equal(await (await store.file('alice', 'bot-a', fileId)).text(), 'preserve');
  });
  const restarted = composer(); await restarted.open(); assert.equal(restarted.operation.id, id);
  transport.rpc = async () => ({}); await restarted.reconcile();
  assert.equal(restarted.draft.text, ''); assert.equal(await store.file('alice', 'bot-a', fileId), undefined);
});

test('explicit upload restart recovers a lost server checkpoint without replacing local file bytes', async () => {
  const { composer, transport, store } = setup(); const c = composer(); await c.open();
  c.addFiles([new File(['offline source'], 'source.txt')]); await c.flush(); const fileId = c.draft.files[0].id;
  transport.online = true; const attempts = [];
  transport.upload = async (botId, file, progress, id) => {
    attempts.push(id);
    if (id === fileId) throw new Error('The incomplete server upload could not be reconciled.');
    assert.equal((await store.get('alice', 'bot-a')).slots.normal.files[0].uploadId, id);
    return { id, botId, ready: true, name: file.name, mimeType: file.type, size: file.size };
  };
  await c.resumeUploads(); await c.flush(); await c.restartFailedUploads();
  assert.equal(attempts.length, 2); assert.notEqual(attempts[1], fileId);
  assert.equal(c.draft.files[0].id, fileId); assert.equal(c.draft.files[0].remote.id, attempts[1]);
  assert.equal(await (await store.file('alice', 'bot-a', fileId)).text(), 'offline source');
});
