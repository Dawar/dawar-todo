import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runtime } from './helpers/load-ts.mjs';

const id = '12345678-1234-4234-8234-123456789012';
const remoteId = '87654321-1234-4234-8234-123456789012';
const attachment = (extra = {}) => ({ localId: id, kind: 'image', fileName: 'private.png', mimeType: 'image/png', durationMs: 0, blob: new Blob(['private bytes']), ...extra });
const task = (taskId = 7) => ({ id: taskId, clientId: 'task-client', title: 'Private task', notes: '', status: 'open', priority: 3, createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z', attachmentCount: 0 });
function setup({ request, upload, browserUpload, extra } = {}) {
  const calls = [];
  const env = runtime(extra, {
    './sync-request': {
      request: async (path, init) => { calls.push(path); return request ? request(path, init) : { targetExists: true, files: [{ id, state: 'missing', todoId: null }] }; },
      retryableSyncError: (error) => !error.status || error.status >= 500,
      syncRetryDelay: () => 2,
    },
    './attachment-upload-client': {
      uploadTaskAttachmentMultipart: upload ?? (async () => ({ id })),
      uploadTaskAttachment: browserUpload ?? (async () => ({ id })),
    },
    './sync-diagnostics': { recordSyncDiagnostic() {} },
  });
  const db = env.load('app/offline-store.ts');
  return { env, db, calls, sync: env.load('app/attachment-sync.ts').syncQueuedAttachment };
}
const rows = (db) => db.listQueuedAttachments();
const seedRow = (db, row) => db.taskTransaction(['attachment-outbox'], (tx) => tx.objectStore('attachment-outbox').put({ todoId: 7, createdAt: '2026-09-26T00:00:00Z', attempts: 0, nextAttemptAt: 0, ...attachment(), ...row }));

test('upgrade from v9 preserves Infinity, draft IDs, all bytes and queued work; explicit retry wakes it', async () => {
  const env = runtime();
  const request = env.indexedDB.open('dawar-todo-offline', 9);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('attachment-outbox', { keyPath: 'localId' }).put({ ...attachment({ remoteAttachmentId: remoteId }), todoId: 7, draftToken: 'private-token', attempts: 4, nextAttemptAt: Infinity, error: 'Legacy error', createdAt: '2026-09-26T00:00:00Z' });
    request.result.createObjectStore('pending-actions', { keyPath: 'operationId' }).put({ operationId: 'keep-action', createdAt: '2026-09-26T00:00:00Z' });
  };
  const old = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  old.close();
  const db = env.load('app/offline-store.ts');
  assert.equal((await db.openDatabase()).version, 11);
  const [row] = await rows(db);
  assert.equal(await row.blob.text(), 'private bytes');
  assert.equal(row.remoteAttachmentId, remoteId);
  assert.equal(row.draftToken, 'private-token');
  assert.equal(row.nextAttemptAt, Infinity);
  assert.equal((await db.listOfflineTaskActions())[0].operationId, 'keep-action');
  assert.equal(env.load('app/attachment-queue.ts').attachmentQueueState(row), 'blocked');
  await db.retryQueuedAttachments();
  assert.equal((await rows(db))[0].nextAttemptAt, 0);
});

test('v8 cache and pending creates migrate without losing local attachments', async () => {
  const env = runtime(); const request = env.indexedDB.open('dawar-todo-offline', 8);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('cached-state', { keyPath: 'key' }).put({ key: 'server', todos: [task()], projects: [] });
    request.result.createObjectStore('pending-todos', { keyPath: 'clientId' }).put({ ...task(-7), localId: -7, attachments: [attachment()] });
  };
  const old = await new Promise((resolve) => { request.onsuccess = () => resolve(request.result); }); old.close();
  const db = env.load('app/offline-store.ts');
  assert.equal((await db.loadCachedServerState()).todos.length, 2);
  assert.equal(await (await db.listOfflineTodos())[0].attachments[0].blob.text(), 'private bytes');
});

test('lost multipart acknowledgement reconciles existing server ID without sending bytes twice', async () => {
  let committed = false, sends = 0;
  const { db, sync } = setup({
    request: async () => ({ targetExists: true, files: [{ id, state: committed ? 'ready' : 'missing', todoId: committed ? 7 : null }] }),
    upload: async (input) => { assert.equal(input.clientUploadId, id); sends++; committed = true; throw new TypeError('lost reply'); },
  });
  await db.queueTaskAttachments(7, [attachment()]);
  await sync(id);
  assert.equal(await (await rows(db))[0].blob.text(), 'private bytes');
  await db.retryQueuedAttachments(); await sync(id);
  assert.equal(sends, 1); assert.equal((await rows(db)).length, 0);
});

test('a committed draft claim with a lost reply is reconciled without duplicate upload', async () => {
  let claimed = false, claims = 0, sends = 0;
  const { db, sync } = setup({ request: async (path) => {
    if (path.endsWith('/claim')) { claims++; claimed = true; throw new TypeError('lost claim reply'); }
    return { targetExists: true, files: [{ id, state: 'missing', todoId: null }, { id: remoteId, state: claimed ? 'ready' : 'draft', todoId: claimed ? 7 : null }] };
  }, upload: async () => { sends++; } });
  await seedRow(db, { remoteAttachmentId: remoteId, draftToken: 'keep-token' });
  await sync(id); await db.retryQueuedAttachments(); await sync(id);
  assert.equal(claims, 1); assert.equal(sends, 0); assert.equal((await rows(db)).length, 0);
});

test('claim 400 keeps bytes and identity, rather than silently falling back', async () => {
  let sends = 0;
  const { db, sync } = setup({ request: async (path) => {
    if (path.endsWith('/claim')) throw Object.assign(new Error('capacity'), { status: 400 });
    return { targetExists: true, files: [{ id: remoteId, state: 'draft', todoId: null }] };
  }, upload: async () => { sends++; } });
  await seedRow(db, { remoteAttachmentId: remoteId, draftToken: 'keep-token' });
  await sync(id);
  const [row] = await rows(db);
  assert.equal(row.state, 'blocked'); assert.equal(row.lastStatus, 400); assert.equal(row.blob.size, 13);
  assert.equal(row.remoteAttachmentId, remoteId); assert.equal(sends, 0);
});

test('confirmed expired/missing draft falls back using the original local UUID', async () => {
  let sends = 0;
  const { db, sync } = setup({ upload: async (input) => { sends++; assert.equal(input.clientUploadId, id); return { id }; } });
  await seedRow(db, { remoteAttachmentId: remoteId, draftToken: 'expired' }); await sync(id);
  assert.equal(sends, 1); assert.equal((await rows(db)).length, 0);
});

test('404 from upload, missing target, and cache deletion all retain recoverable bytes', async () => {
  const { db, sync } = setup({ upload: async () => { throw Object.assign(new Error('not found'), { status: 404 }); } });
  await db.queueTaskAttachments(7, [attachment()]); await sync(id);
  assert.equal((await rows(db))[0].state, 'blocked');
  await db.commitRemoteTasks({ todos: [], deletedIds: [7] });
  const [row] = await rows(db); assert.equal(await row.blob.text(), 'private bytes'); assert.equal(row.reason, 'target-missing');
  const missing = setup({ request: async () => ({ targetExists: false, files: [{ id, state: 'missing', todoId: null }] }) });
  await missing.db.queueTaskAttachments(7, [attachment()]); await missing.sync(id);
  assert.equal((await rows(missing.db))[0].reason, 'target-missing');
});

test('missing bytes cannot be serialized as an empty or bogus file and can be restored explicitly', async () => {
  let sends = 0;
  const { db, sync } = setup({ upload: async () => { sends++; return { id }; } });
  await seedRow(db, { blob: undefined }); await sync(id);
  assert.equal((await rows(db))[0].reason, 'missing-bytes'); assert.equal(sends, 0);
  await assert.rejects(db.replaceQueuedAttachmentBytes(id, new File(['bytes'], 'other.png')), /original file/);
  await db.replaceQueuedAttachmentBytes(id, new File(['private bytes'], 'private.png', { type: 'image/png' }));
  await sync(id); assert.equal(sends, 1);
});

test('two tabs without Web Locks acquire one IDB lease, and stale acknowledgements cannot clear a new lease', async () => {
  const { env, db } = setup(); await db.queueTaskAttachments(7, [attachment()]);
  const second = runtime({ indexedDB: env.indexedDB }).load('app/offline-store.ts');
  const leases = await Promise.all([db.acquireQueuedAttachment(id, 1000), second.acquireQueuedAttachment(id, 1000)]);
  assert.equal(leases.filter(Boolean).length, 1);
  const old = leases.find(Boolean);
  const resumed = await second.acquireQueuedAttachment(id, 121001);
  assert.ok(resumed); assert.notEqual(old.leaseToken, resumed.leaseToken);
  assert.equal(await db.finishQueuedAttachment(id, old.leaseToken), false);
  assert.equal((await rows(db)).length, 1);
  assert.equal(await second.finishQueuedAttachment(id, resumed.leaseToken), true);
});

test('cancellation racing a success remains queued until confirmed removal', async () => {
  const { db } = setup(); await db.queueTaskAttachments(7, [attachment()]);
  const lease = await db.acquireQueuedAttachment(id);
  await db.cancelQueuedAttachment(id);
  assert.equal(await db.finishQueuedAttachment(id, lease.leaseToken), false);
  assert.equal((await rows(db))[0].cancelled, true);
});

test('merge moves queued targets atomically; repeated promotion never queues deletion', async () => {
  const { db } = setup(); await db.queueTaskAttachments(7, [attachment()]);
  await db.commitRemoteTasks({ todos: [task(8)], deletedIds: [7], attachmentTarget: { fromIds: [7], todoId: 8 } });
  assert.equal((await rows(db))[0].todoId, 8);
  assert.equal(await (await rows(db))[0].blob.text(), 'private bytes');
  const local = { ...task(-7), localId: -7, attachments: [] };
  await db.saveOfflineTodo(local); await db.promoteOfflineTodo(local, task()); await db.promoteOfflineTodo(local, task());
  assert.equal((await db.listOfflineTaskActions()).length, 0);
});

test('local task deletion during create retains attachments for recovery', async () => {
  const { db } = setup(); const local = { ...task(-7), localId: -7, attachments: [attachment()] };
  await db.saveOfflineTodo(local); await db.deleteOfflineTodo(local.clientId); await db.promoteOfflineTodo(local, task());
  const [row] = await rows(db); assert.equal(row.reason, 'target-missing'); assert.equal(row.blob.size, 13);
});

test('known missing IMAGES uses browser preparation with the SAME UUID and survives lost finalize', async () => {
  let committed = false, browser = 0, multipart = 0;
  const { db, sync } = setup({ request: async () => ({ imageProcessingAvailable: false, targetExists: true, files: [{ id, state: committed ? 'ready' : 'missing', todoId: committed ? 7 : null }] }),
    upload: async () => { multipart++; }, browserUpload: async (input) => { browser++; assert.equal(input.clientUploadId, id); committed = true; throw new TypeError('finalize reply lost'); } });
  await db.queueTaskAttachments(7, [attachment()]); await sync(id);
  assert.equal((await rows(db))[0].blob.size, 13);
  await db.retryQueuedAttachments(); await sync(id);
  assert.equal(browser, 1); assert.equal(multipart, 0); assert.equal((await rows(db)).length, 0);
});

test('diagnostics expose cause/phase/bytes/retry, never names, tokens, IDs or raw errors', () => {
  const env = runtime(); const { attachmentQueueDiagnostic } = env.load('app/attachment-queue.ts');
  const diagnostic = attachmentQueueDiagnostic({ ...attachment(), todoId: 7788, draftToken: 'secret-token', remoteAttachmentId: remoteId, error: 'https://signed.example?secret=PRIVATE', state: 'blocked', reason: 'server', serverPhase: 'image-binding', lastStatus: 503, attempts: 12, nextAttemptAt: Infinity, createdAt: new Date().toISOString() });
  const encoded = JSON.stringify(diagnostic);
  for (const forbidden of ['private.png', 'secret-token', remoteId, id, '7788', 'signed.example', 'PRIVATE']) assert.ok(!encoded.includes(forbidden));
  assert.equal(diagnostic.serverPhase, 'image-binding'); assert.equal(diagnostic.retryInMs, null); assert.equal(diagnostic.automaticRetry, false);
});

function serverRuntime(images, options = {}) {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE todos (id INTEGER PRIMARY KEY); INSERT INTO todos VALUES (7);
    CREATE TABLE todo_attachments (id TEXT PRIMARY KEY, todo_id INTEGER, draft_token TEXT, upload_state TEXT, expires_at TEXT, deleted_at TEXT, file_name TEXT, mime_type TEXT, byte_size INTEGER, kind TEXT DEFAULT 'image', original_key TEXT, display_key TEXT, thumbnail_key TEXT, width INTEGER, height INTEGER, duration_ms INTEGER, sort_order INTEGER, created_at TEXT, updated_at TEXT);`);
  const DB = { prepare(query) { return { bind(...args) { return { async first() { options.beforeQuery?.(query, args, sql); return sql.prepare(query).get(...args) ?? null; }, async all() { return { results: sql.prepare(query).all(...args) }; }, async run() { return sql.prepare(query).run(...args); } }; }, async first() { return sql.prepare(query).get() ?? null; } }; }, async batch(queries) { return Promise.all(queries.map((q) => q.run())); } };
  const logs = [];
  const env = runtime({ btoa, console: { info() {}, warn() {}, error(message, detail) { logs.push({ message, ...detail }); } }, fetch: options.fetch ?? (async () => { throw new TypeError('network'); }) }, {
    'cloudflare:workers': { env: { DB, IMAGES: images, S3_ACCESS_KEY: 'test-secret', S3_ACCESS_KEY_ID: 'test-key', S3_BUCKET: 'test', S3_ENDPOINT_URL: 'https://nyc3.digitaloceanspaces.com' }, waitUntil() {} },
  });
  return { sql, env, logs, server: env.load('db/attachments.ts') };
}

test('real direct API rejects missing IMAGES with typed phase before creating an attachment', async () => {
  const { server, sql, logs } = serverRuntime();
  await assert.rejects(server.uploadTodoAttachmentDirect(7, { clientUploadId: id, fileName: 'private.png', mimeType: 'image/png', kind: 'image', file: new File(['bytes'], 'private.png', { type: 'image/png' }) }), (e) => e.code === 'image-processing-unavailable' && e.attachmentPhase === 'image-binding');
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM todo_attachments').get().n, 0);
  assert.equal(logs.at(-1).imageBindingAvailable, false);
  assert.equal(logs.at(-1).errorMessage, 'Image processing is temporarily unavailable.');
  assert.ok(!JSON.stringify(logs).includes('private.png'));
  sql.close();
});

test('server recovery identifies ready, deleted, expired draft and missing independently of target', async () => {
  const { server, sql } = serverRuntime();
  const insert = sql.prepare('INSERT INTO todo_attachments (id, todo_id, draft_token, upload_state, expires_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(id, 7, null, 'ready', null, null);
  insert.run(remoteId, null, 'token', 'ready', '2000-01-01', null);
  let state = await server.inspectAttachmentRecovery(8, [id, remoteId], 'token');
  assert.equal(state.targetExists, false); assert.equal(state.files[0].state, 'ready'); assert.equal(state.files[1].state, 'missing');
  sql.prepare('UPDATE todo_attachments SET deleted_at = ? WHERE id = ?').run('2026-09-26', id);
  state = await server.inspectAttachmentRecovery(7, [id]); assert.equal(state.files[0].state, 'deleted'); sql.close();
});

test('server finalization transport failure preserves storage keys and uploading row', async () => {
  const { server, sql } = serverRuntime();
  sql.prepare('INSERT INTO todo_attachments (id, todo_id, upload_state, kind, mime_type, file_name, byte_size, original_key) VALUES (?, 7, ?, ?, ?, ?, 13, ?)').run(id, 'uploading', 'file', 'application/pdf', 'private.pdf', 'original');
  await assert.rejects(server.finalizeTodoMediaAttachmentUpload(id, { durationMs: 0 }, { todoId: 7 }));
  assert.equal(sql.prepare('SELECT upload_state FROM todo_attachments WHERE id = ?').get(id).upload_state, 'uploading');
  sql.close();
});

test('actual browser helper retries partial storage and lost finalize with one UUID and never discards it', async () => {
  let storageCalls = 0, discards = 0, mode = 'partial', bitmapCloses = 0;
  const preparedIds = [];
  const document = { createElement: () => ({ getContext: () => ({ drawImage() {}, fillRect() {} }), toBlob: (callback, mime) => callback(new Blob([mime === 'image/webp' ? 'RIFFxxxxWEBP' : new Uint8Array([255, 216, 255])], { type: mime })) }) };
  const env = runtime({ document, createImageBitmap: async () => ({ width: 2, height: 2, close() { bitmapCloses++; } }), fetch: async () => {
    storageCalls++; if (mode === 'partial' && storageCalls === 2) throw new TypeError('storage interruption');
    return { type: 'opaque' };
  } });
  const client = env.load('app/attachment-upload-client.ts');
  const input = { file: new File(['png'], 'private.png', { type: 'image/png' }), kind: 'image', clientUploadId: id, endpoint: '/api/todos/7/attachments', discard: async () => { discards++; },
    request: async (_path, init) => {
      const body = JSON.parse(init.body);
      if (init.method === 'POST') {
        preparedIds.push(body.clientUploadId);
        return { uploadId: id, uploads: Object.fromEntries(['original', 'display', 'thumbnail'].map((key) => [key, { url: 'https://storage.invalid', fields: {} }])) };
      }
      assert.equal(body.uploadId, id);
      if (mode === 'lost') throw new TypeError('lost finalize reply');
      return { attachment: { id, kind: 'image' } };
    } };
  await assert.rejects(client.uploadTaskAttachment(input));
  mode = 'lost'; await assert.rejects(client.uploadTaskAttachment(input));
  mode = 'success'; assert.equal((await client.uploadTaskAttachment(input)).id, id);
  assert.deepEqual(preparedIds, [id, id, id]); assert.equal(discards, 0); assert.equal(bitmapCloses, 3);
});

test('Safari PNG-for-WebP fallback declares JPEG that matches the bytes', async () => {
  const env = runtime({ document: { createElement: () => ({ getContext: () => ({ drawImage() {}, fillRect() {} }), toBlob: (callback, mime) => callback(new Blob([mime === 'image/webp' ? 'PNG' : new Uint8Array([255, 216, 255])], { type: mime === 'image/webp' ? 'image/png' : mime })) }) }, createImageBitmap: async () => ({ width: 2, height: 2, close() {} }), fetch: async () => ({ type: 'opaque' }) });
  await env.load('app/attachment-upload-client.ts').uploadTaskAttachment({ file: new File(['png'], 'private.png', { type: 'image/png' }), kind: 'image', clientUploadId: id, endpoint: '/api/todos/7/attachments', discard: async () => { assert.fail('must retain upload'); }, request: async (_path, init) => {
    if (init.method === 'PATCH') return { attachment: { id } };
    const body = JSON.parse(init.body);
    assert.equal(body.displayMimeType, 'image/jpeg'); assert.equal(body.thumbnailMimeType, 'image/jpeg');
    return { uploadId: id, uploads: Object.fromEntries(['original', 'display', 'thumbnail'].map((key) => [key, { url: 'https://storage.invalid', fields: {} }])) };
  } });
});

test('privacy-safe report retains attachment failures despite forty idle sync events', async () => {
  const map = new Map();
  const env = runtime({ navigator: { onLine: true, userAgent: 'test', language: 'en' }, fetch: async () => new Response('{}', { status: 200 }) });
  env.window.localStorage = { getItem: (key) => map.get(key), setItem: (key, value) => map.set(key, value) };
  env.window.location = { pathname: '/' };
  const db = env.load('app/offline-store.ts');
  await seedRow(db, { error: 'https://private.invalid?secret=do-not-export', state: 'blocked', reason: 'server', serverPhase: 'image-binding', nextAttemptAt: Infinity });
  const diagnostics = env.load('app/sync-diagnostics.ts');
  diagnostics.recordSyncDiagnostic('attachment-deferred', { reason: 'server', status: 503 });
  for (let i = 0; i < 50; i++) diagnostics.recordSyncDiagnostic('sync-finished', { remainingCreates: 0 });
  const report = await diagnostics.buildSyncDiagnosticsReport('settings');
  assert.ok(report.includes('attachment-deferred')); assert.ok(report.includes('image-binding'));
  for (const forbidden of ['private.png', 'do-not-export', 'private.invalid', id]) assert.ok(!report.includes(forbidden));
  const json = JSON.parse(report.split('\n\n')[1]);
  assert.equal(json.queue.counts.attachments, 1); assert.equal(json.recentSyncEvents.length, 41);
});

test('real prepare replay reserves one row and ready direct replay bypasses missing IMAGES', async () => {
  const { server, sql } = serverRuntime();
  const input = { clientUploadId: id, fileName: 'private.png', mimeType: 'image/png', byteSize: 13, displayMimeType: 'image/jpeg', thumbnailMimeType: 'image/jpeg' };
  const one = await server.prepareTodoAttachmentUpload(input, { todoId: 7 });
  const two = await server.prepareTodoAttachmentUpload(input, { todoId: 7 });
  assert.equal(one.uploadId, id); assert.equal(two.uploadId, id);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM todo_attachments').get().n, 1);
  sql.prepare("UPDATE todo_attachments SET upload_state = 'ready', kind = 'image' WHERE id = ?").run(id);
  const replay = await server.uploadTodoAttachmentDirect(7, { ...input, kind: 'image', file: new File(['private bytes'], 'private.png', { type: 'image/png' }) });
  assert.equal(replay.id, id); assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM todo_attachments').get().n, 1);
  sql.close();
});

test('real claim replay links one draft exactly once', async () => {
  const { server, sql } = serverRuntime();
  const token = '12345678-1234-4234-8234-123456789099';
  sql.prepare('INSERT INTO todo_attachments (id, draft_token, upload_state, expires_at, kind) VALUES (?, ?, ?, ?, ?)').run(remoteId, token, 'ready', '2099-01-01T00:00:00Z', 'image');
  assert.equal(await server.claimDraftAttachments(7, token, [remoteId]), 1);
  assert.equal(await server.claimDraftAttachments(7, token, [remoteId]), 1);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM todo_attachments WHERE todo_id = 7').get().n, 1);
  sql.close();
});

test('partial WebP prepare retries as JPEG using the persisted keys and keeps ready metadata immutable', async () => {
  let readyRace = false;
  const { server, sql } = serverRuntime(undefined, { beforeQuery(query, _args, db) {
    if (readyRace && query.includes('SET display_key')) {
      readyRace = false;
      db.prepare("UPDATE todo_attachments SET upload_state = 'ready' WHERE id = ?").run(id);
    }
  } });
  const input = { clientUploadId: id, fileName: 'private.png', mimeType: 'image/png', byteSize: 13 };
  const webp = await server.prepareTodoAttachmentUpload({ ...input, displayMimeType: 'image/webp', thumbnailMimeType: 'image/webp' }, { todoId: 7 });
  assert.ok(webp.uploads.display.fields.key.endsWith('.webp'));
  const jpeg = await server.prepareTodoAttachmentUpload({ ...input, displayMimeType: 'image/jpeg', thumbnailMimeType: 'image/jpeg' }, { todoId: 7 });
  const row = sql.prepare('SELECT * FROM todo_attachments WHERE id = ?').get(id);
  assert.equal(jpeg.uploads.display.fields.key, row.display_key);
  assert.equal(jpeg.uploads.thumbnail.fields.key, row.thumbnail_key);
  assert.ok(row.display_key.endsWith('.jpg'));
  readyRace = true;
  const ready = await server.prepareTodoAttachmentUpload({ ...input, displayMimeType: 'image/webp', thumbnailMimeType: 'image/webp' }, { todoId: 7 });
  assert.equal(ready.attachment.id, id); assert.equal(ready.uploads, undefined);
  assert.equal(sql.prepare('SELECT display_key FROM todo_attachments WHERE id = ?').get(id).display_key, row.display_key);
  assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM todo_attachments').get().n, 1);
  sql.close();
});

function imageProbe(url, init) {
  const original = String(url.url ?? url).includes('original');
  const bytes = new Uint8Array(30);
  if (original) { bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes[19] = 1; bytes[23] = 1; }
  else { bytes.set(new TextEncoder().encode('RIFFxxxxWEBPVP8X')); }
  return new Response((init?.method ?? url.method) === 'HEAD' ? null : bytes, { headers: { 'content-length': '30' } });
}

test('late finalizer cannot commit after derivative keys changed or cancellation won', async () => {
  let changeKeys = false, cancel = false;
  const { server, sql } = serverRuntime(undefined, { fetch: async (url, init) => imageProbe(url, init), beforeQuery(query, _args, db) {
    if (query.includes('SET width =')) {
      if (changeKeys) { changeKeys = false; db.prepare("UPDATE todo_attachments SET display_key = 'new/display.jpg', thumbnail_key = 'new/thumb.jpg' WHERE id = ?").run(id); }
      if (cancel) { cancel = false; db.prepare("UPDATE todo_attachments SET deleted_at = '2026-09-26' WHERE id = ?").run(id); }
    }
  } });
  const input = { clientUploadId: id, fileName: 'private.png', mimeType: 'image/png', byteSize: 30 };
  await server.prepareTodoAttachmentUpload(input, { todoId: 7 });
  changeKeys = true;
  await assert.rejects(server.finalizeTodoAttachmentUpload(id, { width: 1, height: 1 }, { todoId: 7 }), /preparation changed/);
  assert.equal(sql.prepare('SELECT upload_state FROM todo_attachments WHERE id = ?').get(id).upload_state, 'uploading');
  await server.prepareTodoAttachmentUpload(input, { todoId: 7 });
  cancel = true;
  await assert.rejects(server.finalizeTodoAttachmentUpload(id, { width: 1, height: 1 }, { todoId: 7 }), /preparation changed/);
  assert.equal(sql.prepare('SELECT upload_state FROM todo_attachments WHERE id = ?').get(id).upload_state, 'uploading');
  assert.ok(sql.prepare('SELECT deleted_at FROM todo_attachments WHERE id = ?').get(id).deleted_at);
  sql.close();
});

test('server cancellation reserves a missing stable ID against late prepare and keeps ready objects intact', async () => {
  const { server, sql } = serverRuntime(undefined, { fetch: async () => new Response(null, { status: 204 }) });
  assert.equal(await server.discardTodoAttachmentUpload(7, id), true);
  assert.ok(sql.prepare('SELECT deleted_at FROM todo_attachments WHERE id = ?').get(id).deleted_at);
  await assert.rejects(server.prepareTodoAttachmentUpload({ clientUploadId: id, fileName: 'private.png', mimeType: 'image/png', byteSize: 13 }, { todoId: 7 }), /already used|removed/);
  const input = { clientUploadId: remoteId, fileName: 'private.png', mimeType: 'image/png', byteSize: 13 };
  await server.prepareTodoAttachmentUpload(input, { todoId: 7 });
  sql.prepare("UPDATE todo_attachments SET upload_state = 'ready' WHERE id = ?").run(remoteId);
  assert.equal(await server.discardTodoAttachmentUpload(7, remoteId), false);
  assert.equal(sql.prepare('SELECT deleted_at FROM todo_attachments WHERE id = ?').get(remoteId).deleted_at, null);
  sql.close();
});

test('suspended upload callback cannot finalize after a new lease processes cancellation', async () => {
  let release, began, cancelled = false, patches = 0;
  const started = new Promise((resolve) => { began = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const { db, sync } = setup({ request: async (path, init) => {
    if (init.method === 'DELETE') { cancelled = true; return {}; }
    if (init.method === 'PATCH') { patches++; return {}; }
    return { targetExists: true, files: [{ id, state: cancelled ? 'deleted' : 'missing', todoId: cancelled ? 7 : null }] };
  }, upload: async (input) => { began(); await gate; await input.request('/api/todos/7/attachments', { method: 'PATCH' }); } });
  await db.queueTaskAttachments(7, [attachment()]);
  const late = sync(id); await started;
  const [row] = await rows(db);
  await db.updateQueuedAttachment(id, row.leaseToken, { leaseUntil: Date.now() - 1 });
  await db.cancelQueuedAttachment(id); await sync(id);
  assert.equal((await rows(db)).length, 0);
  release(); await late;
  assert.equal(patches, 0); assert.equal(cancelled, true);
});

test('merge undo restores original queued targets, including a response racing the undo intent', async () => {
  const { db } = setup(); await db.queueTaskAttachments(7, [attachment()]);
  await db.commitRemoteTasks({ todos: [task(8)], deletedIds: [7], attachmentTarget: { fromIds: [7], todoId: 8 } });
  assert.equal((await rows(db))[0].todoId, 8);
  await db.commitRemoteTasks({ todos: [task(7)], deletedIds: [8] });
  assert.equal((await rows(db))[0].todoId, 7);
  assert.equal((await rows(db))[0].nextAttemptAt, 0);
  await db.saveOfflineTaskAction({ operationId: 'merge', path: '/api/todos/bulk', method: 'POST', body: { action: 'merge', ids: [7, 9] }, taskIds: [7, 9], kind: 'bulk', createdAt: new Date().toISOString() });
  await db.markOfflineTaskActionUndo('merge');
  const acknowledged = await db.commitRemoteTasks({ todos: [task(8)], attachmentTarget: { fromIds: [7, 9], todoId: 8 }, acknowledgeAction: { operationId: 'merge', undoRequested: false } });
  assert.equal(acknowledged, false); assert.equal((await rows(db))[0].todoId, 7);
});

test('merge undo of an uploading snapshot never demotes a subsequently finalized attachment', async () => {
  const { server, sql } = serverRuntime();
  await server.prepareTodoAttachmentUpload({ clientUploadId: id, fileName: 'private.png', mimeType: 'image/png', byteSize: 13 }, { todoId: 7 });
  const original = sql.prepare('SELECT * FROM todo_attachments WHERE id = ?').get(id);
  sql.prepare("UPDATE todo_attachments SET todo_id = 8, upload_state = 'ready', duration_ms = 37, width = 22, expires_at = NULL WHERE id = ?").run(id);
  const binding = { prepare(query) { return { bind(...args) { return { async run() { return sql.prepare(query).run(...args); } }; } }; } };
  await server.restoreAttachmentStatements(binding, [original])[0].run();
  const restored = sql.prepare('SELECT * FROM todo_attachments WHERE id = ?').get(id);
  assert.equal(restored.todo_id, 7); assert.equal(restored.upload_state, 'ready'); assert.equal(restored.duration_ms, 37); assert.equal(restored.width, 22); assert.equal(restored.expires_at, null);
  sql.close();
});
