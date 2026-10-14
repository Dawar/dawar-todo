import assert from 'node:assert/strict';
import test from 'node:test';
import { runtime } from './helpers/load-ts.mjs';
import { tasks } from './perf-baseline-7c578085.mjs';
const task = (id = 1) => ({ ...tasks(3)[id - 1], id, clientId: null });
const record = (id, title = 'capture') => ({ ...task(1), clientId: `client-${id}`, localId: -id, title, project: null, attachments: [], createdAt: new Date().toISOString() });
async function until(check) { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('condition timed out'); }
const statusError = status => Object.assign(new Error('synthetic rejection'), { status });

test('real engine parks rejected edits/creates, preserves intent and blocks only related actions', async () => {
  const calls = []; let reject = true;
  const env = runtime({}, { './sync-request': {
    retryableSyncError: e => e.status >= 500, syncRetryDelay: () => 100,
    request: async (path, options) => {
      const body = options?.body ? JSON.parse(options.body) : null; calls.push({ path, body });
      if (path === '/api/todos/1' && reject) throw statusError(422);
      if (path === '/api/todos' && body.title === 'bad' && reject) throw statusError(400);
      if (path === '/api/todos') return { todo: { ...task(3), clientId: body.clientId, title: body.title } };
      if (path === '/api/todos/1') return { todo: { ...task(1), title: body.title }, appliedFields: ['title'] };
      if (path === '/api/todos/2') return { todo: { ...task(2), title: body.title }, appliedFields: ['title'] };
      if (path === '/api/todos/bulk') return { todos: [], undoToken: 'undo' };
      if (path === '/api/todos/undo') return {};
      if (path === '/api/bootstrap') return { todos: [task(1), task(2), task(3)], projects: [], revision: 1 };
      return { todos: [], deletedIds: [], reset: false, revision: 1 };
    },
  }, './sync-diagnostics': { recordSyncDiagnostic() {} } });
  const db = env.load('app/offline-store.ts'); await db.saveCachedServerState([task(1), task(2)], [], 1);
  const rejected = await db.saveOfflineTodoMutation(1, { title: 'bad edit' }, { title: '2026-09-26T23:00:00Z' });
  await db.saveOfflineTodoMutation(2, { title: 'good edit' }, { title: '2026-09-26T23:00:00Z' });
  await db.saveOfflineTodo(record(1, 'bad')); await db.saveOfflineTodo(record(2, 'good'));
  for (const id of [1, 2]) await db.saveOfflineTaskAction({ operationId: `action-${id}`, taskIds: [id], path: '/api/todos/bulk', method: 'POST', body: { ids: [id], action: 'complete' }, kind: 'bulk', createdAt: new Date().toISOString() });
  await db.markOfflineTaskActionUndo('action-1');
  const engine = env.load('app/task-sync.ts').createTaskSyncEngine(); engine.start();
  try {
    await until(async () => (await db.listOfflineTodos()).length === 1 && (await db.listOfflineTaskActions()).length === 1);
    const parked = (await db.listOfflineTodoMutations()).find(m => m.todoId === 1);
    assert.equal(parked.rejected.status, 422); assert.equal(parked.mutationId, rejected.mutationId);
    assert.equal(parked.fieldTimestamps.title, rejected.fieldTimestamps.title);
    assert.equal((await db.listOfflineTodos())[0].rejected.status, 400);
    assert.equal((await db.listOfflineTaskActions())[0].undoRequested, true);
    assert.ok(!calls.some(c => c.path === '/api/todos/bulk' && c.body.ids[0] === 1));
    assert.ok(calls.some(c => c.path === '/api/todos/bulk' && c.body.ids[0] === 2));
    reject = false;
    await db.retryOfflineTaskIntent('edit', 1);
    await until(async () => !(await db.listOfflineTaskActions()).length);
    assert.equal(calls.filter(c => c.path === '/api/todos/1').at(-1).body.mutation.mutationId, rejected.mutationId);
    assert.ok(calls.some(c => c.path === '/api/todos/undo'));
  } finally { engine.stop(); }
});

test('late rejection cannot park a newer edit/create and a remote deletion retains rejected intent', async () => {
  const db = runtime().load('app/offline-store.ts'); await db.saveCachedServerState([task()], [], 1);
  const sent = await db.saveOfflineTodoMutation(1, { title: 'first' }, { title: '2026-01-01' });
  const newer = await db.saveOfflineTodoMutation(1, { title: 'second' }, { title: '2026-01-02' });
  await db.rejectOfflineTaskIntent(sent, 422);
  assert.equal((await db.listOfflineTodoMutations())[0].rejected, undefined);
  await db.commitRemoteTasks({ todos: [], deletedIds: [1], revision: 2 });
  assert.equal((await db.listOfflineTodoMutations())[0].mutationId, newer.mutationId);
  assert.equal((await db.listOfflineTodoMutations())[0].rejected.status, 404);
  const create = record(4); await db.saveOfflineTodo(create);
  await db.updateOfflineTodo(-4, { project: 'new project' });
  await db.rejectOfflineTaskIntent(create, 422);
  assert.equal((await db.listOfflineTodos())[0].rejected, undefined);
});

test('empty deltas touch only metadata, emit no task changes and never serialize tasks', async () => {
  const env = runtime(); const db = env.load('app/offline-store.ts'); await db.saveCachedServerState(tasks(2890), [], 7);
  let events = 0; const off = env.load('app/offline-events.ts').subscribeOfflineChanges(() => events++);
  const database = await db.openDatabase(); const native = database.transaction.bind(database); const touched = [];
  database.transaction = (stores, ...rest) => { touched.push(...stores); return native(stores, ...rest); };
  await db.commitRemoteTasks({ todos: [], deletedIds: [], revision: 7 });
  assert.deepEqual(touched, ['cached-state']); assert.equal(events, 0);
  off(); database.close();
});

test('capture original bytes/text/token survive reopening; Add transfers them atomically exactly once', async () => {
  const env = runtime(); const { TaskCaptureSession } = env.load('app/task-capture.ts');
  const session = new TaskCaptureSession(); const start = await session.load();
  const file = { localId: crypto.randomUUID(), kind: 'file', fileName: 'original.bin', mimeType: 'application/octet-stream', durationMs: 0, blob: new Blob([new Uint8Array([0, 255, 7, 8])]) };
  const draft = { key: 'quick-add', text: 'unsent text', clientId: 'client', version: 'v1', updatedAt: '2026-09-26' };
  await session.save({ ...start, draft, attachments: [file] });
  const reopen = new TaskCaptureSession(); const saved = await reopen.load();
  assert.equal(saved.token, start.token); assert.equal(saved.draft.text, draft.text); assert.equal(saved.attachments[0].localId, file.localId);
  assert.deepEqual([...new Uint8Array(await saved.attachments[0].blob.arrayBuffer())], [0, 255, 7, 8]);
  const create = { ...record(1, draft.text), draftToken: saved.token, attachments: saved.attachments };
  await reopen.consume(create);
  await assert.rejects(() => session.consume({ ...create, clientId: 'other' }), /another tab/);
  const db = env.load('app/offline-store.ts'); assert.equal((await db.listOfflineTodos()).length, 1);
  assert.equal((await db.listOfflineTodos())[0].attachments[0].blob.size, 4);
  assert.equal((await new TaskCaptureSession().load()).attachments.length, 0);
});

test('aborted capture checkpoint never acknowledges saved; other-tab conflict never overwrites bytes', async () => {
  const env = runtime(); const db = env.load('app/offline-store.ts'); const { TaskCaptureSession } = env.load('app/task-capture.ts');
  const a = new TaskCaptureSession(), b = new TaskCaptureSession(); const first = await a.load(); await b.load();
  const database = await db.openDatabase(); const native = database.transaction.bind(database);
  database.transaction = (...args) => { const tx = native(...args); if (args[1] === 'readwrite') { const objectStore = tx.objectStore.bind(tx); tx.objectStore = name => { const store = objectStore(name); const put = store.put.bind(store); store.put = (...values) => { const request = put(...values); request.addEventListener('success', () => tx.abort()); return request; }; return store; }; } return tx; };
  await assert.rejects(() => a.save({ ...first, project: 'aborted' }));
  assert.equal(a.snapshot().revision, ''); database.transaction = native;
  await a.save({ ...first, project: 'durable' });
  await assert.rejects(() => b.save({ ...first, project: 'stale' }), /another tab/);
  assert.equal((await new TaskCaptureSession().load()).project, 'durable');
});

test('v10 blocks upgrade with visible guidance then resumes; superseded v11 document cannot write v12', async () => {
  const env = runtime();
  const old = await new Promise((resolve, reject) => { const r = env.indexedDB.open('dawar-todo-offline', 10); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const db = env.load('app/offline-store.ts'); const lifecycle = env.load('app/pwa-lifecycle.ts');
  const opening = db.openDatabase(); await until(() => lifecycle.getPwaLifecycle().storage === 'blocked');
  old.close(); const database = await opening;
  assert.equal(database.version, 11); assert.equal(lifecycle.getPwaLifecycle().storage, 'ready');
  assert.equal(lifecycle.getPwaLifecycle().upgradedFrom, 10);
  await assert.rejects(new Promise((resolve, reject) => { const r = env.indexedDB.open('dawar-todo-offline', 10); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }), e => e.name === 'VersionError');
  const future = await new Promise((resolve, reject) => { const r = env.indexedDB.open('dawar-todo-offline', 12); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  assert.equal(lifecycle.getPwaLifecycle().storage, 'superseded');
  await assert.rejects(() => db.saveOfflineTodo(record(1)), /older database version/);
  const oldPage = runtime({ indexedDB: env.indexedDB }).load('app/offline-store.ts');
  await assert.rejects(() => oldPage.openDatabase(), e => e.name === 'VersionError');
  future.close();
});

test('capture hydration retries a failed read without clearing the saved draft', async () => {
  const env = runtime(); const db = env.load('app/offline-store.ts'); const { TaskCaptureSession } = env.load('app/task-capture.ts');
  const original = new TaskCaptureSession(); const start = await original.load(); await original.save({ ...start, project: 'keep' });
  const database = await db.openDatabase(); const native = database.transaction.bind(database);
  database.transaction = () => { throw new DOMException('synthetic temporary failure', 'UnknownError'); };
  const retry = new TaskCaptureSession(); await assert.rejects(retry.load());
  database.transaction = native;
  assert.equal((await retry.load()).project, 'keep');
});

test('capture admission waits for delayed files before Add and queues late picker results after Add', async () => {
  const { TaskCaptureGate } = runtime().load('app/task-capture.ts'); const gate = new TaskCaptureGate();
  let releaseFile; let phase = 'hydrate'; const seen = [];
  const early = gate.prepare(async () => { seen.push(phase); await new Promise(r => releaseFile = r); });
  assert.equal(gate.beginAdd(), false); gate.hydrate(); phase = 'files'; await Promise.resolve();
  assert.equal(gate.beginAdd(), false); releaseFile(); await early;
  assert.equal(gate.beginAdd(), true); phase = 'adding';
  const late = gate.prepare(async () => { seen.push(phase); });
  assert.deepEqual(seen, ['files']); phase = 'next draft'; gate.endAdd(); await late;
  assert.deepEqual(seen, ['files', 'next draft']);
});

test('rejected-entity barriers propagate through overlapping actions without periodic retry timers', () => {
  const { taskActionRetryDelay, uploadWaitingForTaskAction } = runtime().load('app/task-queue-order.ts');
  const actions = [
    { taskIds: [1, 2], body: { action: 'merge' }, nextAttemptAt: '2026-01-01' },
    { taskIds: [2, 3], body: { action: 'complete' }, nextAttemptAt: '2026-01-01' },
  ];
  assert.equal(taskActionRetryDelay(actions, [{ todoId: 1, rejected: { status: 422 } }], Date.now()), Infinity);
  assert.equal(uploadWaitingForTaskAction({ todoId: 2 }, actions), true);
  assert.equal(taskActionRetryDelay([...actions, { taskIds: [4], body: {}, nextAttemptAt: '2026-01-01' }], [{ todoId: 1, rejected: {} }], Date.now()), 500);
});

test('first healthy heartbeat replaces only fallback polling, never an immediate pending edit wake', async () => {
  let stream; let lastDelay;
  class Stream extends EventTarget { constructor() { super(); stream = this; } close() {} }
  const env = runtime({ EventSource: Stream, setTimeout: (fn, delay) => { lastDelay = delay; return setTimeout(fn, delay); } }, {
    './sync-request': { request: async () => ({ todos: [], projects: [], deletedIds: [], revision: 1 }), retryableSyncError: () => true, syncRetryDelay: () => 100 },
    './sync-diagnostics': { recordSyncDiagnostic() {} },
  });
  const engine = env.load('app/task-sync.ts').createTaskSyncEngine(); engine.start();
  try {
    await until(() => stream);
    engine.wake(250); assert.equal(lastDelay, 250);
    stream.dispatchEvent(new Event('heartbeat'));
    assert.equal(lastDelay, 250);
  } finally { engine.stop(); }
});

test('v10 to v11 compatibility fence preserves rejected intent, legacy text, file IDs and original bytes', async () => {
  const env = runtime(); const request = env.indexedDB.open('dawar-todo-offline', 10);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('pending-mutations', { keyPath: 'todoId' }).put({ todoId: 1, mutationId: 'keep-id', patch: { title: 'retained' }, fieldTimestamps: { title: '2026-09-26' }, createdAt: '2026-09-26', rejected: { status: 404, at: '2026-09-26' } });
    request.result.createObjectStore('attachment-outbox', { keyPath: 'localId' }).put({ localId: 'keep-file-id', todoId: 1, blob: new Blob(['original bytes']), fileName: 'synthetic.txt', nextAttemptAt: Infinity });
    request.result.createObjectStore('capture-draft', { keyPath: 'key' }).put({ key: 'quick-add', text: 'unsent legacy text', version: 'legacy', updatedAt: '2026-09-26', clientId: 'legacy' });
  };
  const previous = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); previous.close();
  const db = env.load('app/offline-store.ts');
  const [mutation] = await db.listOfflineTodoMutations();
  assert.equal(mutation.mutationId, 'keep-id'); assert.equal(mutation.rejected.status, 404); assert.equal(mutation.fieldTimestamps.title, '2026-09-26');
  const [file] = await db.listQueuedAttachments(); assert.equal(file.localId, 'keep-file-id'); assert.equal(file.nextAttemptAt, Infinity); assert.equal(await file.blob.text(), 'original bytes');
  assert.equal((await db.loadOfflineCaptureDraft()).text, 'unsent legacy text');
});
