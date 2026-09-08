import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { runtime } from './helpers/load-ts.mjs';
import { createSyncHealth, liveSyncDelay } from '../app/sync-health.ts';

const root = new URL('../', import.meta.url);
function offlineStore() {
  const env = runtime();
  return { ...env.load('app/offline-store.ts'), indexedDB: env.indexedDB };
}

test('healthy startup and brief failures stay quiet; sustained failures and recovery are accurate', () => {
  const health = createSyncHealth();
  assert.equal(health.browser(true), 'online');
  assert.equal(health.failure({ requestStartedAt: 0 }, true, 100), 'online');
  assert.equal(health.failure({ requestStartedAt: 1_000 }, true, 1_100), 'online');
  assert.equal(health.failure({ requestStartedAt: 11_000 }, true, 11_100), 'degraded');
  assert.equal(health.success(12_000), 'online');
  assert.equal(health.failure({ requestStartedAt: 9_000 }, true, 13_000), 'online');
  assert.equal(health.browser(false), 'offline');
  assert.equal(health.browser(true), 'online');
  assert.equal(health.failure({ name: 'AbortError' }, true, 14_000), 'online');
  assert.equal(health.failure({ status: 401 }, true, 15_000), 'auth');
  assert.equal(health.success(16_000), 'online');
  assert.equal(health.failure({ status: 503 }, true, 17_000), 'online');
  assert.equal(health.failure({ status: 503 }, true, 28_000), 'unavailable');
});

test('polling backs off on errors and idle periods, then returns to responsive intervals', () => {
  assert.equal(liveSyncDelay(0, 0), 3_000);
  assert.equal(liveSyncDelay(0, 10), 10_000);
  assert.equal(liveSyncDelay(4, 0), 24_000);
  assert.equal(liveSyncDelay(99, 0), 60_000);
  assert.equal(liveSyncDelay(0, 0), 3_000);
});

test('simultaneous local edits merge atomically and an old acknowledgement retains the newer edit', async () => {
  const store = offlineStore();
  const [first, second] = await Promise.all([
    store.saveOfflineTodoMutation(7, { title: 'New title' }, { title: '2026-09-05T12:00:00.000Z' }),
    store.saveOfflineTodoMutation(7, { notes: 'New notes' }, { notes: '2026-09-05T12:00:01.000Z' }),
  ]);
  assert.equal(await store.deleteOfflineTodoMutation(7, first.mutationId), false);
  const [pending] = await store.listOfflineTodoMutations();
  assert.deepEqual(JSON.parse(JSON.stringify(pending.patch)), { title: 'New title', notes: 'New notes' });
  assert.equal(pending.mutationId, second.mutationId);
  assert.equal(await store.deleteOfflineTodoMutation(7, second.mutationId), true);
  assert.equal((await store.listOfflineTodoMutations()).length, 0);
});

test('a transaction that aborts after a successful put is never reported as saved', async () => {
  const store = offlineStore();
  // Initialize through the real migration first.
  await store.listOfflineTodoMutations();
  const open = store.indexedDB.open('dawar-todo-offline', 9);
  const db = await new Promise((resolve, reject) => { open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
  const probe = db.transaction('pending-mutations', 'readwrite').objectStore('pending-mutations');
  const prototype = Object.getPrototypeOf(probe);
  const original = prototype.put;
  prototype.put = function (...args) {
    const request = original.apply(this, args);
    request.addEventListener('success', () => this.transaction.abort());
    return request;
  };
  try {
    await assert.rejects(store.saveOfflineTodoMutation(8, { title: 'Uncommitted' }, { title: '2026-09-05T12:00:00.000Z' }));
    assert.equal((await store.listOfflineTodoMutations()).length, 0);
  } finally { prototype.put = original; db.close(); }
});

test('upload checkpoints cannot overwrite a title edited at the same time', async () => {
  const store = offlineStore();
  await store.saveOfflineTodo({ clientId: 'local-task', localId: -42, title: 'Original', notes: '', createdAt: '2026-09-05T12:00:00Z', attachments: [{ localId: 'file', blob: new Blob(['data']) }] });
  await Promise.all([
    store.updateOfflineTodo(-42, { title: 'Edited while uploading' }),
    store.markOfflineTodoAttachmentUploaded(-42, 'file', 'remote-file', 'draft'),
  ]);
  const task = await store.getOfflineTodoByLocalId(-42);
  assert.equal(task.title, 'Edited while uploading');
  assert.equal(task.attachments[0].remoteAttachmentId, 'remote-file');
});

test('backoff updates preserve an undo requested concurrently', async () => {
  const store = offlineStore();
  await store.saveOfflineTaskAction({ operationId: 'action', taskIds: [7], createdAt: '2026-09-05T12:00:00Z' });
  await Promise.all([store.markOfflineTaskActionUndo('action'), store.deferOfflineTaskAction('action', 1, 10_000)]);
  const [action] = await store.listOfflineTaskActions();
  assert.equal(action.undoRequested, true);
  assert.equal(action.attempts, 1);
});

test('an action acknowledgement cannot erase an undo requested during its network call', async () => {
  const store = offlineStore();
  await store.saveOfflineTaskAction({ operationId: 'inflight', taskIds: [7], createdAt: '2026-09-05T12:00:00Z' });
  await store.markOfflineTaskActionUndo('inflight');
  assert.equal(await store.deleteOfflineTaskAction('inflight', false), false);
  assert.equal((await store.listOfflineTaskActions())[0].undoRequested, true);
  assert.equal(await store.deleteOfflineTaskAction('inflight', true), true);
  assert.equal((await store.listOfflineTaskActions()).length, 0);
});
