import assert from 'node:assert/strict';
import test from 'node:test';
import { runtime } from './helpers/load-ts.mjs';
const plain = (value) => JSON.parse(JSON.stringify(value));
const task = (id = 7, extra = {}) => ({ id, clientId: '0a332e4d-452a-45d6-a22d-f98c0f5a8901', title: 'Original', notes: '', status: 'open', priority: 3, dueDate: null, project: null, context: null, sourceKind: 'site', sourceId: null, completedAt: null, snoozedUntil: null, recurrenceCron: null, recurrenceLastFiredAt: null, pinned: false, sortOrder: -1024, createdAt: '2026-09-05T12:00:00.000Z', updatedAt: '2026-09-05T12:00:00.000Z', attachmentCount: 0, ...extra });
const local = (extra = {}) => ({ ...task(-7), localId: -7, attachments: [], ...extra });
const setup = () => { const env = runtime(); return { env, db: env.load('app/offline-store.ts') }; };

test('a local field and its retry record survive reopening as one atomic commit', async () => {
  const { env, db } = setup();
  await db.saveCachedServerState([task()], [], 5);
  await db.saveOfflineTodoMutation(7, { title: 'Saved offline' }, { title: '2026-09-05T12:01:00.000Z' });
  (await db.openDatabase()).close();
  const reopened = runtime({ indexedDB: env.indexedDB, window: Object.assign(new EventTarget(), { indexedDB: env.indexedDB }) }).load('app/offline-store.ts');
  assert.equal((await reopened.loadCachedServerState()).todos[0].title, 'Saved offline');
  assert.equal((await reopened.listOfflineTodoMutations())[0].patch.title, 'Saved offline');
});

test('a stale response preserves newer local edits and conditional acknowledgement', async () => {
  const { db } = setup();
  await db.saveCachedServerState([task()], [], 5);
  const sent = await db.saveOfflineTodoMutation(7, { title: 'First' }, { title: '2026-09-05T12:01:00.000Z' });
  await db.saveOfflineTodoMutation(7, { title: 'Second' }, { title: '2026-09-05T12:02:00.000Z' });
  await db.commitRemoteTasks({ todos: [task(7, { title: 'First' })], acknowledgeMutation: sent });
  assert.equal((await db.loadCachedServerState()).todos[0].title, 'Second');
  assert.equal((await db.listOfflineTodoMutations()).length, 1);
  await db.commitRemoteTasks({ todos: [task()], revision: 6 });
  assert.equal((await db.loadCachedServerState()).todos[0].title, 'Second');
});

test('creation promotion keeps newer text, stable identity, and independently queued blobs', async () => {
  const { db } = setup();
  const record = local({ attachments: [{ localId: crypto.randomUUID(), kind: 'file', fileName: 'note.txt', mimeType: 'text/plain', durationMs: 0, blob: new Blob(['note']) }] });
  await db.saveOfflineTodo(record);
  await db.updateOfflineTodo(-7, { title: 'Edited while creating', status: 'completed' });
  const promoted = await db.promoteOfflineTodo(record, task());
  assert.equal(promoted.title, 'Edited while creating');
  assert.equal(promoted.clientId, record.clientId);
  assert.equal(promoted.status, 'completed');
  assert.equal((await db.listOfflineTodos()).length, 0);
  assert.equal((await db.listQueuedAttachments())[0].blob.size, 4);
  assert.equal((await db.listOfflineTodoMutations())[0].patch.title, 'Edited while creating');
  // A timer scheduled before promotion still resolves the same UUID-backed task.
  await db.updateOfflineTodo(-7, { title: 'Later timer' });
  assert.equal((await db.loadCachedServerState()).todos[0].title, 'Later timer');
});

test('deleting an in-flight create persists a tombstone and queues the server deletion', async () => {
  const { db } = setup(); const record = local();
  await db.saveOfflineTodo(record);
  await db.deleteOfflineTodo(record.clientId);
  assert.equal((await db.loadCachedServerState()).todos.length, 0);
  assert.equal(await db.promoteOfflineTodo(record, task()), null);
  assert.equal((await db.listOfflineTaskActions())[0].body.action, 'delete');
  assert.equal((await db.listOfflineTodos()).length, 0);
});

test('undo racing an action response remains durable and keeps its restored task', async () => {
  const { db } = setup();
  await db.saveCachedServerState([task()], [], 5);
  await db.saveOfflineTaskAction({ operationId: 'complete', taskIds: [7], path: '/api/todos/bulk', method: 'POST', body: { ids: [7], action: 'complete' }, kind: 'bulk', optimisticPatches: { 7: { status: 'completed' } }, createdAt: '2026-09-05T12:01:00Z' });
  await db.markOfflineTaskActionUndo('complete');
  const ack = await db.commitRemoteTasks({ todos: [task(7, { status: 'completed' })], acknowledgeAction: { operationId: 'complete', undoRequested: false } });
  assert.equal(ack, false);
  assert.equal((await db.loadCachedServerState()).todos[0].status, 'open');
  assert.equal((await db.listOfflineTaskActions())[0].undoRequested, true);
});

test('typing only notifies its row and promotion retains that subscription', () => {
  const env = runtime(); const { createTaskStore } = env.load('app/task-store.ts');
  const store = createTaskStore(); const one = task(-7); const two = task(8, { clientId: null });
  store.setAll([one, two]);
  let lists = 0, edited = 0, unrelated = 0;
  store.subscribe(() => lists++); store.subscribeRow(one.clientId, () => edited++); store.subscribeRow('server:8', () => unrelated++);
  for (let i = 0; i < 50; i++) { store.setDraft(one.clientId, { title: `Typing ${i}` }); store.setAll([task(-7, { title: `Typing ${i}` }), two]); }
  assert.equal(lists, 0); assert.equal(unrelated, 0); assert.equal(edited, 50);
  store.setAll([task(7), two]);
  assert.equal(store.get(one.clientId).title, 'Typing 49');
  assert.equal(store.get(one.clientId).id, 7);
  store.clearDraft(one.clientId, { title: 'Typing 48' });
  assert.equal(store.get(one.clientId).title, 'Typing 49');
  store.clearDraft(one.clientId, { title: 'Typing 49' });
  assert.equal(store.getList()[0].title, 'Typing 49');
});

test('revision streams emit change hints and release polling when cancelled', async () => {
  const { revisionEventStream } = runtime().load('worker/sync-events.ts');
  let reads = 0;
  const reader = revisionEventStream({ signal: new AbortController().signal, after: 1, intervalMs: 2, lifetimeMs: 100, readRevision: async () => { reads++; return 2; } }).getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: revision\ndata: 2/);
  await reader.cancel(); const count = reads;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, count);
});

async function until(predicate, message = 'condition') {
  const deadline = Date.now() + 2_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('headless sync creates tasks before files and saves edits while an upload is blocked', async () => {
  let server = task(); const calls = []; let releaseUpload; let uploads = 0;
  const request = async (path, options) => {
    calls.push(path);
    if (path === '/api/todos') return { todo: server };
    if (path === '/api/todos/7') { server = { ...server, ...JSON.parse(options.body) }; return { todo: server, appliedFields: ['title'] }; }
    if (path === '/api/bootstrap') return { todos: [server], projects: [], revision: 1, captureDraft: null, settings: { snoozeTimeZone: 'UTC', snoozeQuickPresets: [] } };
    return { reset: false, todos: [server], deletedIds: [], revision: 2 };
  };
  const env = runtime({}, {
    './sync-request': { request, retryableSyncError: () => true, syncRetryDelay: () => 50 },
    './attachment-upload-client': { uploadTaskAttachmentMultipart: async () => { uploads++; await new Promise((resolve) => { releaseUpload = resolve; }); return { id: 'file' }; } },
    './sync-diagnostics': { recordSyncDiagnostic() {} },
  });
  const db = env.load('app/offline-store.ts');
  await db.saveOfflineTodo(local({ attachments: [{ localId: crypto.randomUUID(), kind: 'file', fileName: 'large.bin', mimeType: 'application/octet-stream', durationMs: 0, blob: new Blob(['data']) }] }));
  const engine = env.load('app/task-sync.ts').createTaskSyncEngine();
  engine.start();
  try {
    await until(() => uploads === 1, 'upload starts after create');
    assert.equal(calls[0], '/api/todos');
    await db.saveOfflineTodoMutation(7, { title: 'Edit during upload' }, { title: new Date().toISOString() });
    engine.wake();
    await until(() => server.title === 'Edit during upload', 'independent edit');
    assert.equal((await db.listQueuedAttachments()).length, 1);
    releaseUpload();
    await until(async () => (await db.listQueuedAttachments()).length === 0, 'upload acknowledgement');
  } finally { releaseUpload?.(); engine.stop(); }
});

test('the engine starts no network calls offline or hidden, and wakes after reconnect', async () => {
  let requests = 0;
  const env = runtime({}, {
    './sync-request': { request: async () => { requests++; return { todos: [], projects: [], revision: 0, captureDraft: null, settings: {} }; }, retryableSyncError: () => true, syncRetryDelay: () => 50 },
    './sync-diagnostics': { recordSyncDiagnostic() {} },
  });
  env.navigator.onLine = false;
  const engine = env.load('app/task-sync.ts').createTaskSyncEngine(); engine.start();
  try {
    await until(() => !engine.getSnapshot().loading);
    engine.wake(); await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(requests, 0);
    env.navigator.onLine = true; env.document.visibilityState = 'hidden'; env.window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 15)); assert.equal(requests, 0);
    env.document.visibilityState = 'visible'; env.document.dispatchEvent(new Event('visibilitychange'));
    await until(() => requests > 0);
  } finally { engine.stop(); }
});

test('two tabs share one task writer and broadcast committed local changes', async () => {
  const held = new Set();
  const locks = { async request(name, _options, callback) { if (held.has(name)) return callback(null); held.add(name); try { return await callback({ name }); } finally { held.delete(name); } } };
  const channels = new Set();
  class Channel {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const channel of channels) if (channel !== this && channel.name === this.name) queueMicrotask(() => channel.onmessage?.({ data })); }
  }
  let server = task(); let creates = 0;
  const mocks = {
    './sync-request': { request: async (path, options) => {
      if (path === '/api/todos') { creates++; await new Promise((resolve) => setTimeout(resolve, 15)); return { todo: server }; }
      if (path === '/api/todos/7') { server = { ...server, ...JSON.parse(options.body) }; return { todo: server, appliedFields: ['title'] }; }
      return { reset: true, todos: [server], projects: [], revision: 1, captureDraft: null, settings: {} };
    }, retryableSyncError: () => true, syncRetryDelay: () => 50 },
    './sync-diagnostics': { recordSyncDiagnostic() {} },
  };
  const first = runtime({ navigator: { onLine: true, locks }, BroadcastChannel: Channel }, mocks);
  const second = runtime({ indexedDB: first.indexedDB, navigator: { onLine: true, locks }, BroadcastChannel: Channel }, mocks);
  const db = first.load('app/offline-store.ts'); await db.saveOfflineTodo(local());
  const a = first.load('app/task-sync.ts').createTaskSyncEngine(); const b = second.load('app/task-sync.ts').createTaskSyncEngine();
  const secondStore = second.load('app/task-store.ts').taskStore;
  a.start(); b.start();
  try {
    await until(() => secondStore.getById(7));
    assert.equal(creates, 1);
    await db.saveOfflineTodoMutation(7, { title: 'Shared edit' }, { title: new Date().toISOString() });
    await until(() => secondStore.getById(7)?.title === 'Shared edit', 'cross-tab local edit');
  } finally { a.stop(); b.stop(); }
});
