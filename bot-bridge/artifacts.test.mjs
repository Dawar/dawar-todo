import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, symlink, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter, once } from 'node:events';
import sharp from 'sharp';
import { syntheticArtifactPdf as pdf } from '../tests/fixtures/bot-artifact-files.mjs';
import { Store } from './store.mjs';
import { BotRuntime } from './runtime.mjs';
import { registerNativeItem, intendedOutputs, rememberInputProvenance } from './artifact-outputs.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'bot-artifact-contract-'));
  const store = new Store(join(root, 'state.sqlite'));
  const codex = new EventEmitter(); codex.calls = []; codex.turns = [];
  codex.call = async (method, params) => { codex.calls.push({ method, params }); assert.equal(method, 'thread/turns/list'); return { data: codex.turns, nextCursor: null }; };
  const runtime = new BotRuntime({ store, codex, root });
  const bots = [];
  for (const id of ['alpha', 'beta']) {
    const bot = { id, slug: id, name: id, threadId: `thread-${id}`, cwd: join(root, id), color: '#123456', archived: false, updatedAt: '2026-01-01T00:00:00.000Z' };
    await mkdir(bot.cwd); store.saveBot(bot); bots.push(bot);
  }
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const rpc = (method, bot, params = {}) => runtime.handle({ method, botId: bot?.id, params });
  return { root, store, codex, runtime, bots, rpc };
}
function metadata(store, bot, id, options = {}) {
  return store.put('attachment', { id, botId: bot.id, name: `${id}.pdf`, mimeType: 'application/pdf', size: 123,
    path: join(bot.cwd, 'missing-original'), ready: true, createdAt: '2026-09-01T00:00:00.000Z', ...options });
}
const image = () => sharp({ create: { width: 900, height: 450, channels: 3, background: '#ee3300' } }).png().toBuffer();

test('metadata-only global/per-bot paging has deterministic month ordering, filters and no native/file hydration', async (t) => {
  const { store, bots, rpc, codex } = await setup(t);
  for (let i = 0; i < 105; i++) metadata(store, bots[i % 2], `file-${String(i).padStart(3, '0')}`, { createdAt: `2026-${i < 70 ? '08' : '09'}-01T00:00:00.000Z`, artifact: i % 3 === 0 });
  const first = await rpc('artifacts.list', null, { limit: 11 });
  assert.equal(first.items.length, 11); assert.ok(first.nextCursor); assert.equal(first.items[0].id, 'file-104');
  assert.equal('path' in first.items[0], false); assert.equal('data' in first.items[0], false); assert.equal(first.items[0].botName, 'alpha');
  const seen = [...first.items]; let cursor = first.nextCursor;
  // A newly inserted backdated record must not alter an in-progress traversal.
  metadata(store, bots[0], 'late-insert', { createdAt: '2026-08-01T00:00:00.000Z' });
  store.remove('attachment', first.items.at(-1).id); // Removed cursor anchor remains usable.
  do { const page = await rpc('artifacts.list', null, { limit: 11, cursor }); seen.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(seen.length, 105); assert.equal(new Set(seen.map((a) => a.id)).size, 105); assert.equal(seen.some((a) => a.id === 'late-insert'), false);
  const filtered = await rpc('artifacts.list', bots[1], { search: 'FILE-10', direction: 'output', type: 'pdf', sort: 'oldest' });
  assert.deepEqual(filtered.items.map((a) => a.id), []); // No odd multiple of three in 100..104.
  const one = await rpc('artifacts.list', bots[0], { search: 'FILE-10', direction: 'output', type: 'pdf', sort: 'name' });
  assert.deepEqual(one.items.map((a) => a.id), ['file-102']);
  await assert.rejects(rpc('artifacts.list', bots[0], { cursor: first.nextCursor }), /cursor/);
  await assert.rejects(rpc('artifacts.list', null, { limit: 61 }), /Invalid/);
  await assert.rejects(rpc('artifacts.list', { id: 'not-authorized' }), /not found/);
  metadata(store, bots[0], 'unicode-name', { name: 'RÉSUMÉ.pdf' });
  assert.equal((await rpc('artifacts.list', bots[0], { search: 'résumé' })).items[0].id, 'unicode-name');
  assert.deepEqual(codex.calls, []);
});

test('explicit publication copies originals, deduplicates by bot/name/bytes and retries the same call safely', async (t) => {
  const { runtime, bots, rpc, store } = await setup(t); const bot = bots[0];
  await writeFile(join(bot.cwd, 'report.pdf'), pdf());
  const request = { tool: 'bots_publish_artifact', callId: 'publish-one', turnId: 'turn-one', arguments: { path: 'report.pdf' } };
  const first = await runtime.dynamicTool(bot, request), again = await runtime.dynamicTool(bot, request);
  assert.equal(first.attachmentId, again.attachmentId);
  const a = (await rpc('artifacts.list', bot)).items[0];
  assert.equal(a.mimeType, 'application/pdf'); assert.deepEqual(a.provenance, { threadId: bot.threadId, turnId: 'turn-one', itemId: 'publish-one' });
  await writeFile(join(bot.cwd, 'report.pdf'), 'changed source');
  assert.equal((await runtime.dynamicTool(bot, request)).attachmentId, first.attachmentId);
  assert.deepEqual(Buffer.from((await rpc('attachments.read', bot, { id: a.id })).data, 'base64'), pdf());
  const second = await runtime.dynamicTool(bot, { ...request, callId: 'publish-two' });
  assert.notEqual(second.attachmentId, first.attachmentId);
  assert.equal((await runtime.publishArtifact(bot, { path: 'report.pdf' })).attachmentId, second.attachmentId);
  assert.equal(store.list('attachment').length, 2);
  assert.equal((await rpc('history.attachments', bot)).attachments.length, 2);
  await assert.rejects(rpc('attachments.read', bots[1], { id: a.id }), /not found/);
});

test('cursor ceiling survives SQLite rowid reuse and excludes uploads completed after the first page', async (t) => {
  const { bots, store, rpc } = await setup(t); const bot = bots[0];
  for (const id of ['a', 'b', 'c']) metadata(store, bot, id);
  metadata(store, bot, 'pending', { ready: false });
  store.put('temporary-record', { id: 'latest-row' });
  const first = await rpc('artifacts.list', bot, { limit: 1 }); assert.equal(first.items[0].id, 'c');
  store.remove('temporary-record', 'latest-row');
  metadata(store, bot, 'backdated', { createdAt: '2020-01-01T00:00:00.000Z' }); // Reuses the old maximum records.rowid.
  store.put('attachment', { ...store.get('attachment', 'pending'), ready: true });
  const rest = await rpc('artifacts.list', bot, { cursor: first.nextCursor });
  assert.deepEqual(rest.items.map((a) => a.id), ['b', 'a']);
  assert.equal((await rpc('artifacts.list', bot)).items.length, 5);
});

test('library index migration rolls back on failure and leaves original attachment records retryable', async (t) => {
  const { bots, store, rpc } = await setup(t); const a = metadata(store, bots[0], 'existing-file');
  const transaction = store.transaction.bind(store);
  store.transaction = (fn) => transaction(() => { fn(); throw new Error('Synthetic migration failure'); });
  await assert.rejects(rpc('artifacts.list', bots[0]), /migration failure/);
  assert.deepEqual(store.get('attachment', a.id), a);
  assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name='artifact_library_sequence'").get(), undefined);
  store.transaction = transaction;
  assert.equal((await rpc('artifacts.list', bots[0])).items[0].id, a.id);
});

test('copy/DB failure is recoverable and never deletes or replaces source bytes', async (t) => {
  const { runtime, bots, store } = await setup(t); const bot = bots[0], source = join(bot.cwd, 'result.txt');
  await writeFile(source, 'recoverable bytes');
  const put = store.put.bind(store); store.put = (kind, record) => { if (kind === 'artifactPublication') throw new Error('Synthetic transaction failure'); return put(kind, record); };
  await assert.rejects(runtime.publishArtifact(bot, { path: source }, { key: 'same-publication' }), /transaction failure/);
  assert.equal(store.list('attachment').length, 0); assert.equal(await readFile(source, 'utf8'), 'recoverable bytes');
  store.put = put;
  const retry = await runtime.publishArtifact(bot, { path: source }, { key: 'same-publication' });
  assert.equal(await readFile(store.get('attachment', retry.attachmentId).path, 'utf8'), 'recoverable bytes');
});

test('an already-published legacy copy keeps its original ID/access when native history surfaces it', async (t) => {
  const { runtime, bots, store, rpc } = await setup(t); const bot = bots[0], path = join(bot.cwd, 'legacy.png');
  const bytes = await image(); await writeFile(path, bytes);
  metadata(store, bot, 'legacy-uuid', { path, name: 'legacy.png', mimeType: 'image/png', size: bytes.length, artifact: true });
  await registerNativeItem(runtime, bot, 'legacy-turn', { type: 'imageGeneration', id: 'legacy-image', status: 'completed', savedPath: path, result: '' });
  assert.equal(store.list('attachment').length, 1);
  assert.equal((await rpc('artifacts.list', bot)).items[0].id, 'legacy-uuid');
  assert.deepEqual(Buffer.from((await rpc('attachments.read', bot, { id: 'legacy-uuid' })).data, 'base64'), bytes);
});

test('received files gain known provenance without letting metadata failures affect send acknowledgement', async (t) => {
  const { runtime, bots, store, rpc } = await setup(t); const bot = bots[0];
  const a = metadata(store, bot, 'received-image', { mimeType: 'image/png', name: 'received.png' });
  store.saveOperation('client-id', 'fingerprint', 'done', { botId: bot.id, params: { attachments: [a.id] } });
  const item = { type: 'userMessage', id: 'native-item', clientId: 'client-id', content: [] };
  assert.equal(rememberInputProvenance(runtime, bot, 'received-turn', item), true);
  const result = (await rpc('artifacts.list', bot)).items[0];
  assert.equal(result.direction, 'input'); assert.equal(result.source, 'upload'); assert.equal(result.provenance.turnId, 'received-turn');
  const put = store.put.bind(store); store.put = () => { throw new Error('Synthetic metadata failure'); };
  assert.doesNotThrow(() => runtime.emitUserMessage(bot, 'received-turn', 'client-id', []));
  store.put = put; assert.equal(store.get('attachment', a.id).id, a.id);
});

test('automatic native storage ceiling reports recoverability without deleting files', async (t) => {
  const { runtime, bots, store } = await setup(t); const bot = bots[0];
  metadata(store, bot, 'prior-native-output', { artifact: true, source: 'native', size: 1024 * 1024 * 1024 });
  const bytes = await image();
  const result = await registerNativeItem(runtime, bot, 'new-turn', { type: 'imageGeneration', id: 'new-image', status: 'completed', result: bytes.toString('base64') });
  assert.equal(result.registered, 0); assert.match(result.failures[0].reason, /1 GB/); assert.equal(store.list('attachment').length, 1);
});

test('publishing rejects cross-bot files, credential names, symlinks and oversized files', async (t) => {
  const { runtime, bots } = await setup(t); const [bot, other] = bots;
  await writeFile(join(other.cwd, 'private.txt'), 'synthetic other-bot bytes');
  await assert.rejects(runtime.publishArtifact(bot, { path: join(other.cwd, 'private.txt') }), /outside/);
  await symlink(other.cwd, join(bot.cwd, 'escape'));
  await assert.rejects(runtime.publishArtifact(bot, { path: 'escape/private.txt' }), /outside/);
  await symlink(join(other.cwd, 'private.txt'), join(bot.cwd, 'linked'));
  await assert.rejects(runtime.publishArtifact(bot, { path: 'linked' }), /regular/);
  await writeFile(join(bot.cwd, '.env'), 'synthetic fixture');
  await assert.rejects(runtime.publishArtifact(bot, { path: '.env' }), /Credential/);
  await writeFile(join(bot.cwd, 'huge.bin'), ''); await truncate(join(bot.cwd, 'huge.bin'), 100 * 1024 * 1024 + 1);
  await assert.rejects(runtime.publishArtifact(bot, { path: 'huge.bin' }), /100 MB/);
});

test('real image and first-page PDF thumbnails are bounded WebP; originals remain exact and scoped', async (t) => {
  const { runtime, bots, rpc } = await setup(t); const bot = bots[0];
  for (const [name, bytes] of [['image.png', await image()], ['document.pdf', pdf()]]) {
    await writeFile(join(bot.cwd, name), bytes);
    const { attachmentId: id } = await runtime.publishArtifact(bot, { path: name });
    const entry = (await rpc('artifacts.list', bot, { search: name })).items[0];
    const [preview, concurrent] = await Promise.all([rpc('artifacts.preview', bot, { id, version: entry.preview.version }), rpc('artifacts.preview', bot, { id })]);
    assert.equal(preview, concurrent);
    assert.equal(preview.status, 'ready', `${name}: ${preview.reason}`); assert.equal(preview.mimeType, 'image/webp');
    assert.ok(preview.width <= 512 && preview.height <= 512); assert.ok(Buffer.from(preview.data, 'base64').length <= 128 * 1024);
    const stats = await sharp(Buffer.from(preview.data, 'base64')).stats();
    assert.ok(stats.channels[0].mean > 200 && stats.channels[2].mean < 30); // Red first PDF page, never blue second page.
    assert.deepEqual(await rpc('artifacts.preview', bot, { id }), preview);
    assert.deepEqual(Buffer.from((await rpc('attachments.read', bot, { id })).data, 'base64'), bytes);
    await assert.rejects(rpc('artifacts.preview', bots[1], { id }), /not found/);
    await assert.rejects(rpc('artifacts.preview', bot, { id, version: 'stale' }), /changed/);
  }
});

test('a stalled PDF decoder is killed within its wall bound and leaves the original recoverable', async (t) => {
  const { root, runtime, bots, rpc } = await setup(t); const bot = bots[0];
  const executable = join(root, 'slow-renderer');
  await writeFile(executable, '#!/bin/sh\nexec sleep 30\n', { mode: 0o700 });
  const previous = process.env.BOTS_PDFTOPPM_PATH; process.env.BOTS_PDFTOPPM_PATH = executable;
  t.after(() => { if (previous === undefined) delete process.env.BOTS_PDFTOPPM_PATH; else process.env.BOTS_PDFTOPPM_PATH = previous; });
  await writeFile(join(bot.cwd, 'timeout.pdf'), pdf());
  const { attachmentId: id } = await runtime.publishArtifact(bot, { path: 'timeout.pdf' });
  const start = performance.now(), preview = await rpc('artifacts.preview', bot, { id });
  assert.equal(preview.status, 'unavailable'); assert.ok(performance.now() - start < 9000);
  assert.deepEqual(Buffer.from((await rpc('attachments.read', bot, { id })).data, 'base64'), pdf());
});

test('missing/corrupt/unsupported/oversized previews fail per file without altering records', async (t) => {
  const { runtime, bots, rpc, store } = await setup(t); const bot = bots[0];
  for (const [name, bytes] of [['corrupt.pdf', Buffer.from('not a PDF')], ['unsafe.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://invalid.example/private"/></svg>')]]) {
    await writeFile(join(bot.cwd, name), bytes); const { attachmentId: id } = await runtime.publishArtifact(bot, { path: name });
    assert.equal((await rpc('artifacts.preview', bot, { id })).status, 'unavailable');
    assert.deepEqual(Buffer.from((await rpc('attachments.read', bot, { id })).data, 'base64'), bytes);
  }
  const missing = metadata(store, bot, 'missing', { name: 'missing.png', mimeType: 'image/png' });
  assert.equal((await rpc('artifacts.preview', bot, { id: missing.id })).status, 'unavailable');
  assert.deepEqual(store.get('attachment', missing.id), missing);
  metadata(store, bot, 'too-large', { size: 21 * 1024 * 1024, mimeType: 'image/png' });
  assert.match((await rpc('artifacts.preview', bot, { id: 'too-large' })).reason, /too large/);
});

test('native outputs register with stable provenance; ordinary links/viewed/working files never qualify', async (t) => {
  const { runtime, bots, rpc, store } = await setup(t); const bot = bots[0], bytes = await image();
  const item = { type: 'imageGeneration', id: 'native-image', status: 'completed', failure: null, result: bytes.toString('base64') };
  await registerNativeItem(runtime, bot, 'native-turn', item, '2026-07-01T00:00:00.000Z');
  await registerNativeItem(runtime, bot, 'native-turn', item);
  const a = (await rpc('artifacts.list', bot)).items[0]; assert.equal(a.source, 'native'); assert.equal(a.provenance.itemId, item.id);
  assert.equal(a.createdAt, '2026-07-01T00:00:00.000Z'); assert.equal(store.list('attachment').length, 1);
  const unsupported = await registerNativeItem(runtime, bot, 'native-turn', { ...item, id: 'unsupported-image', result: 'unsupported output representation' });
  assert.equal(unsupported.failures.length, 1); assert.match(unsupported.failures[0].reason, /explicitly/);
  assert.deepEqual(Buffer.from((await rpc('attachments.read', bot, { id: a.id })).data, 'base64'), bytes);
  for (const ignored of [{ type: 'imageView', path: '/tmp/file' }, { type: 'agentMessage', text: '[PDF](/tmp/report.pdf)' },
    { type: 'fileChange', changes: [{ path: '/tmp/result.pdf' }] }, { ...item, status: 'in_progress' },
    { type: 'mcpToolCall', status: 'completed', result: { content: [{ type: 'resource_link', uri: 'file:///tmp/report.pdf' }] } }]) assert.deepEqual(intendedOutputs(ignored), []);
});

test('intended MCP PDF resource registers; cross-bot resource returns a recoverable issue', async (t) => {
  const { runtime, bots, rpc } = await setup(t); const [bot, other] = bots;
  const item = { type: 'mcpToolCall', id: 'resource-item', status: 'completed', result: { content: [{ type: 'resource', annotations: { audience: ['user'] }, resource: { uri: 'artifact:///report.pdf', mimeType: 'application/pdf', blob: pdf().toString('base64') } }] } };
  assert.equal((await registerNativeItem(runtime, bot, 'turn-resource', item)).registered, 1);
  assert.equal((await rpc('artifacts.list', bot)).items[0].kind, 'pdf');
  await writeFile(join(other.cwd, 'private.pdf'), pdf());
  const rejected = await registerNativeItem(runtime, bot, 'turn-resource', { ...item, id: 'bad-resource', result: { content: [{ type: 'resource_link', name: 'private.pdf', uri: `file://${join(other.cwd, 'private.pdf')}`, annotations: { audience: ['user'] } }] } });
  assert.equal(rejected.failures.length, 1); assert.equal(rejected.registered, 0); assert.equal(JSON.stringify(rejected).includes(other.cwd), false);
});

test('native history indexing is bounded/resumable/idempotent and new completion emits registered attachment', async (t) => {
  const { runtime, bots, rpc, codex, store } = await setup(t); const bot = bots[0], bytes = await image();
  const item = { type: 'imageGeneration', id: 'last-image', status: 'completed', result: bytes.toString('base64') };
  codex.turns = [{ id: 'old-turn', startedAt: 1751328000, items: [...Array.from({ length: 41 }, (_, i) => ({ type: 'agentMessage', id: `text-${i}`, text: 'synthetic' })), item] }];
  const first = await rpc('artifacts.index', bot); assert.equal(first.registered, 0); assert.ok(first.nextCursor);
  const second = await rpc('artifacts.index', bot, { cursor: first.nextCursor }); assert.equal(second.registered, 1); assert.equal(second.nextCursor, null);
  await rpc('artifacts.index', bot, { cursor: first.nextCursor }); assert.equal(store.list('attachment').length, 1);
  await assert.rejects(rpc('artifacts.index', bots[1], { cursor: first.nextCursor }), /Invalid/);
  const event = once(runtime, 'event');
  runtime.onNotification({ method: 'item/completed', params: { threadId: bot.threadId, turnId: 'new-turn', item: { ...item, id: 'live-image' } } });
  await event;
  // Await the registration lock, not a timing-based guess about file copying.
  while (runtime.pendingArtifactItems) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.list('attachment').length, 1); // Same name/content de-duplicates live and historical output.
  assert.equal(store.replay(0).some((e) => e.type === 'attachment'), true);
});
