import assert from 'node:assert/strict';
import test from 'node:test';
import { runtime } from './helpers/load-ts.mjs';
import { attachmentRouteRuntime } from './fixtures/attachment-route-runtime.mjs';
const id = '12345678-1234-4234-8234-123456789012';
function fixture() {
  const server = attachmentRouteRuntime();
  const png = new Uint8Array(68); png.set([137,80,78,71,13,10,26,10]); png[19] = png[23] = 1;
  const webp = new Uint8Array(30); webp.set(new TextEncoder().encode('RIFFxxxxWEBPVP8X'));
  const env = runtime({ fetch: server.fetch, createImageBitmap: async () => ({ width: 1, height: 1, close() {} }) }, {
    './sync-diagnostics': { recordSyncDiagnostic() {} },
  });
  env.document.createElement = () => ({ getContext: () => ({ drawImage() {} }), toBlob: done => done(new Blob([webp], { type: 'image/webp' })) });
  const db = env.load('app/offline-store.ts'); const sync = env.load('app/attachment-sync.ts').syncQueuedAttachment;
  const seed = () => db.queueTaskAttachments(7, [{ localId: id, blob: new Blob([png]), kind: 'image', fileName: 'synthetic.png', mimeType: 'image/png', durationMs: 0 }]);
  return { ...server, db, sync, seed, png, state: env.load('app/attachment-queue.ts').attachmentQueueState };
}
test('serialized real recovery route with absent IMAGES drives real queue + helper + prepare/finalize', async () => {
  const f = fixture(); try {
    await f.seed(); await f.sync(id);
    assert.equal(f.calls.filter(c => c.type === 'multipart').length, 0);
    assert.equal(f.calls.filter(c => c.type === 'prepare').length, 1);
    assert.equal(f.calls.filter(c => c.type === 'finalize').length, 1);
    assert.equal((await f.db.listQueuedAttachments()).length, 0);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM todo_attachments WHERE upload_state='ready'").get().n, 1);
    assert.deepEqual(f.objects.get(`todo-images/${id}/original.png`), f.png);
  } finally { f.close(); }
});
test('stale capability true: explicit multipart image-binding 503 recovers with same identity', async () => {
  const f = fixture(); try {
    f.faults.capability = 'stale-true'; await f.seed(); await f.sync(id);
    assert.equal(f.calls.filter(c => c.type === 'multipart').length, 1);
    assert.equal(f.calls.filter(c => c.type === 'prepare').length, 1);
    assert.equal((await f.db.listQueuedAttachments()).length, 0);
    assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM todo_attachments WHERE upload_state='ready'").get().n, 1);
  } finally { f.close(); }
});
test('IDB lease updates return exactly the committed row and failure releases checking state', async () => {
  const f = fixture(); try {
    await f.seed(); const acquired = await f.db.acquireQueuedAttachment(id);
    const updated = await f.db.updateQueuedAttachment(id, acquired.leaseToken, { phase: 'uploading' });
    assert.equal(updated.phase, 'uploading'); assert.equal((await f.db.listQueuedAttachments())[0].phase, 'uploading');
    const released = await f.db.updateQueuedAttachment(id, acquired.leaseToken, { phase: undefined, leaseToken: undefined, leaseUntil: undefined, state: 'retry', nextAttemptAt: Date.now() + 2000 });
    assert.equal(released.leaseToken, undefined); assert.equal(f.state((await f.db.listQueuedAttachments())[0]), 'retry');
    assert.equal(await f.db.updateQueuedAttachment(id, acquired.leaseToken, { phase: 'checking' }), undefined);
  } finally { f.close(); }
});

test('absent capability defaults to browser; real finalize 503 retains bytes then reconciles without another prepare', async () => {
  const f = fixture(); try {
    f.faults.capability = 'absent'; f.faults.loseFinalize = true;
    await f.seed(); await f.sync(id);
    const row = (await f.db.listQueuedAttachments())[0];
    assert.equal(f.state(row), 'retry'); assert.equal(row.phase, undefined); assert.equal(row.leaseToken, undefined);
    assert.equal(row.lastStatus, 503); assert.deepEqual(new Uint8Array(await row.blob.arrayBuffer()), f.png);
    await f.db.retryQueuedAttachments(); await f.sync(id);
    assert.equal((await f.db.listQueuedAttachments()).length, 0);
    assert.equal(f.calls.filter(c => c.type === 'multipart').length, 0);
    assert.equal(f.calls.filter(c => c.type === 'prepare').length, 1);
    assert.equal(f.calls.filter(c => c.type === 'finalize').length, 1);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM todo_attachments').get().n, 1);
  } finally { f.close(); }
});

test('typed unavailability remains sticky after prepare failure despite a stale positive capability', async () => {
  const f = fixture(); try {
    f.faults.capability = 'stale-true'; f.faults.rejectPrepare = true;
    await f.seed(); await f.sync(id);
    const row = (await f.db.listQueuedAttachments())[0];
    assert.equal(row.imageBindingAvailable, false); assert.equal(row.serverPhase, 'image-binding');
    assert.equal(row.transport, 'browser'); assert.equal(f.state(row), 'retry'); assert.equal(row.leaseToken, undefined);
    assert.deepEqual(new Uint8Array(await row.blob.arrayBuffer()), f.png);
    f.faults.rejectPrepare = false; await f.db.retryQueuedAttachments(); await f.sync(id);
    assert.equal(f.calls.filter(c => c.type === 'multipart').length, 1);
    assert.equal(f.calls.filter(c => c.type === 'prepare').length, 2);
    assert.equal((await f.db.listQueuedAttachments()).length, 0);
    assert.equal(f.sql.prepare('SELECT COUNT(*) AS n FROM todo_attachments').get().n, 1);
  } finally { f.close(); }
});

test('expired lease cannot renew after suspension; explicit retry preserves original identity and bytes', async () => {
  const f = fixture(); try {
    await f.seed(); const lease = await f.db.acquireQueuedAttachment(id);
    await f.db.updateQueuedAttachment(id, lease.leaseToken, { leaseUntil: Date.now() - 1 });
    assert.equal(await f.db.updateQueuedAttachment(id, lease.leaseToken, { leaseUntil: Date.now() + 120000, phase: 'uploading' }), undefined);
    const expired = (await f.db.listQueuedAttachments())[0]; assert.equal(f.state(expired), 'interrupted');
    await f.db.retryQueuedAttachments(id); const retry = (await f.db.listQueuedAttachments())[0];
    assert.equal(retry.localId, id); assert.equal(retry.leaseToken, undefined); assert.equal(f.state(retry), 'queued');
    assert.deepEqual(new Uint8Array(await retry.blob.arrayBuffer()), f.png);
    const next = await f.db.acquireQueuedAttachment(id); assert.notEqual(next.leaseToken, lease.leaseToken);
    assert.equal(await f.db.updateQueuedAttachment(id, lease.leaseToken, { state: 'retry', leaseToken: undefined }), undefined);
    assert.equal(await f.db.finishQueuedAttachment(id, lease.leaseToken), false);
  } finally { f.close(); }
});

test('IDB abort does not acknowledge phase update and legacy ownerless/nonfinite leases do not block recovery', async () => {
  const f = fixture(); try {
    await f.seed(); const lease = await f.db.acquireQueuedAttachment(id); const database = await f.db.openDatabase();
    const native = database.transaction.bind(database);
    database.transaction = (...args) => {
      const tx = native(...args); if (args[1] === 'readwrite') {
        const original = tx.objectStore.bind(tx); tx.objectStore = name => {
          const store = original(name), put = store.put.bind(store);
          store.put = value => { const request = put(value); request.addEventListener('success', () => tx.abort()); return request; }; return store;
        };
      } return tx;
    };
    await assert.rejects(() => f.db.updateQueuedAttachment(id, lease.leaseToken, { phase: 'uploading' }));
    database.transaction = native;
    assert.equal((await f.db.listQueuedAttachments())[0].phase, 'checking');
    for (const broken of [{ leaseToken: undefined, leaseUntil: Date.now() + 120000 }, { leaseToken: 'legacy', leaseUntil: Infinity }]) {
      await f.db.taskTransaction(['attachment-outbox'], tx => tx.objectStore('attachment-outbox').put({ ...lease, ...broken }));
      assert.notEqual(f.state((await f.db.listQueuedAttachments())[0]), 'checking');
      await f.db.retryQueuedAttachments(id); assert.equal((await f.db.listQueuedAttachments())[0].leaseToken, undefined);
      assert.deepEqual(new Uint8Array(await (await f.db.listQueuedAttachments())[0].blob.arrayBuffer()), f.png);
    }
  } finally { f.close(); }
});

test('existing typed 503 rows skip multipart without rewriting identity or original bytes', async () => {
  const f = fixture(); try {
    await f.seed(); const [row] = await f.db.listQueuedAttachments();
    await f.db.taskTransaction(['attachment-outbox'], tx => tx.objectStore('attachment-outbox').put({ ...row, lastStatus: 503, serverPhase: 'image-binding', phase: 'checking', transport: 'multipart', nextAttemptAt: Infinity, state: 'blocked', draftToken: 'keep-draft-token' }));
    f.faults.capability = 'stale-true'; await f.db.retryQueuedAttachments(id); await f.sync(id);
    assert.equal(f.calls.filter(c => c.type === 'multipart').length, 0);
    assert.equal(f.calls.filter(c => c.type === 'prepare').length, 1);
    assert.deepEqual(f.objects.get(`todo-images/${id}/original.png`), f.png);
    assert.equal(f.sql.prepare('SELECT id FROM todo_attachments').get().id, id);
    assert.equal((await f.db.listQueuedAttachments()).length, 0);
  } finally { f.close(); }
});
