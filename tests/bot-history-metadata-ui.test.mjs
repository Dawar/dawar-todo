import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { runtime as browser } from './helpers/load-ts.mjs';

const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'bot-history-ui-')), store = new Store(join(root, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const item = { id: 'answer', type: 'agentMessage', text: '[Plan](bot-artifact:late-pdf)\n' + 'Complete synthetic answer. '.repeat(2000), phase: 'final_answer', delivery: null, memoryCitation: null, questions: null };
  const codex = new EventEmitter(); let reads = 0;
  codex.call = async () => { reads++; return { data: [{ id: 'turn', status: 'completed', startedAt: 1, items: [item] }], nextCursor: null }; };
  const native = new BotRuntime({ store, codex, root });
  store.saveBot({ id: 'bot', slug: 'bot', threadId: 'thread', cwd: root, name: 'Synthetic', updatedAt: 'stable', archived: false });
  native.loaded.add('thread');
  const env = browser({ IDBKeyRange }), { BotTimeline } = env.load('app/bots/timeline-controller.ts');
  const replies = [], transport = { owner: 'owner', online: true, rpc: async (method, botId, params) => {
    const result = JSON.parse(JSON.stringify(await native.handle({ method, botId, params })));
    replies.push({ method, result }); return result;
  } };
  const timeline = new BotTimeline('owner', 'bot', transport);
  t.after(() => timeline.dispose());
  const publish = (name = 'Considered plan.pdf') => {
    const attachment = store.put('attachment', { id: 'late-pdf', botId: 'bot', name, mimeType: 'application/pdf', size: 123, ready: true, artifact: true, createdAt: null, path: join(root, 'unused-original.pdf'), provenance: { threadId: 'thread', turnId: 'turn', itemId: 'answer' } });
    return native.emitEvent('attachment', native.publicAttachment(attachment), 'bot');
  };
  return { native, env, timeline, transport, replies, reads: () => reads, publish, item };
}

test('unchanged native detail merges fresh metadata and persists it offline without another native read/body write', async (t) => {
  const { env, timeline, transport, replies, reads, publish, item } = await setup(t);
  await timeline.refresh(); const entry = timeline.getSnapshot().entries[0];
  assert.equal(entry.complete, false);
  assert.equal((await timeline.detail(entry)).text, item.text);
  const cache = env.load('app/bots/timeline-detail-cache.ts');
  let saved;
  for (let i = 0; i < 100 && !(saved = await cache.readOpenedDetail('owner', 'bot', 'turn:answer')); i++) await pause();
  assert.ok(saved); assert.equal(saved.attachments.length, 0);
  publish(); const before = reads();
  const put = IDBObjectStore.prototype.put; let bodyWrites = 0;
  IDBObjectStore.prototype.put = function (...args) { if (this.name === 'bodies') bodyWrites++; return put.apply(this, args); };
  try {
    assert.equal((await timeline.detail(entry)).text, item.text);
    assert.equal(replies.at(-1).result.notModified, true); assert.equal(replies.at(-1).result.json, '');
    assert.equal(reads(), before); assert.equal(bodyWrites, 0);
    assert.equal(timeline.getSnapshot().attachments[0].name, 'Considered plan.pdf');
    assert.ok(timeline.getSnapshot().attachments[0].preview.version);
    const updated = await cache.readOpenedDetail('owner', 'bot', 'turn:answer');
    assert.equal(updated.item.text, item.text); assert.equal(updated.version, saved.version);
    assert.equal(updated.attachments[0].name, 'Considered plan.pdf');
    console.log(JSON.stringify({ scenario: 'late metadata with unchanged native detail', nativeTextCharacters: item.text.length,
      conditionalResponseBytes: Buffer.byteLength(JSON.stringify(replies.at(-1).result)), additionalNativeReads: reads() - before, bodyWrites }));
  } finally { IDBObjectStore.prototype.put = put; }
  await timeline.dispose(); transport.online = false;
  // Independent module/controller instance, shared durable IDB, no network.
  const cold = browser({ IDBKeyRange, indexedDB: env.indexedDB });
  const { BotTimeline } = cold.load('app/bots/timeline-controller.ts');
  const offline = { owner: 'owner', online: false, rpc: async () => { throw new Error('Offline controller attempted network'); } };
  const restored = new BotTimeline('owner', 'bot', offline);
  t.after(() => restored.dispose());
  assert.equal((await restored.detail(entry)).text, item.text);
  assert.equal(restored.getSnapshot().attachments[0].name, 'Considered plan.pdf');
  const foreign = new BotTimeline('other-owner', 'bot', { ...offline, owner: 'other-owner' });
  t.after(() => foreign.dispose());
  await assert.rejects(foreign.detail(entry), /not cached/);
});

test('late attachment replay and live metadata update the real timeline without native text hydration', async (t) => {
  const { timeline, reads, publish, replies } = await setup(t);
  await timeline.refresh(); const before = reads();
  publish(); await timeline.refresh();
  assert.equal(replies.at(-1).result.kind, 'events');
  assert.equal(timeline.getSnapshot().attachments[0].name, 'Considered plan.pdf');
  timeline.receive(publish('Revised plan.pdf'));
  assert.equal(timeline.getSnapshot().attachments[0].name, 'Revised plan.pdf');
  assert.equal(reads(), before);
  assert.ok(replies.every(({ method }) => method === 'history.view'));
});

test('an attachment event arriving during conditional detail is not overwritten by the older reply', async (t) => {
  const { timeline, env, transport, publish } = await setup(t);
  await timeline.refresh(); const entry = timeline.getSnapshot().entries[0];
  await timeline.detail(entry);
  const cache = env.load('app/bots/timeline-detail-cache.ts');
  for (let i = 0; i < 100 && !await cache.readOpenedDetail('owner', 'bot', 'turn:answer'); i++) await pause();
  publish('Earlier name.pdf');
  let delivered, release;
  const ready = new Promise((resolve) => { delivered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const rpc = transport.rpc;
  transport.rpc = async (...args) => { const result = await rpc(...args); assert.equal(result.notModified, true); delivered(); await gate; return result; };
  const reading = timeline.detail(entry); await ready;
  timeline.receive(publish('Latest name.pdf')); release(); await reading;
  assert.equal(timeline.getSnapshot().attachments[0].name, 'Latest name.pdf');
  assert.equal((await cache.readOpenedDetail('owner', 'bot', 'turn:answer')).attachments[0].name, 'Latest name.pdf');
});

test('metadata refresh cannot overwrite a concurrently newer detail body or its attachment version', async () => {
  const env = browser({ IDBKeyRange }), cache = env.load('app/bots/timeline-detail-cache.ts');
  const item = { id: 'answer', type: 'agentMessage', text: 'New authoritative answer' };
  const current = [{ id: 'file', botId: 'bot', name: 'Current file.pdf', ready: true, mimeType: 'application/pdf', size: 1 }];
  await cache.saveOpenedDetail('owner', 'bot', 'turn:answer', item, current, 'new');
  await cache.updateOpenedDetailAttachments('owner', 'bot', 'turn:answer', [{ ...current[0], name: 'Stale file.pdf' }], 'old');
  const loaded = await cache.readOpenedDetail('owner', 'bot', 'turn:answer');
  assert.equal(loaded.item.text, item.text); assert.equal(loaded.attachments[0].name, 'Current file.pdf');
});

test('pre-upgrade opened details remain readable and accept fresh metadata without a schema migration', async () => {
  const env = browser({ IDBKeyRange }), cache = env.load('app/bots/timeline-detail-cache.ts');
  const item = { id: 'answer', type: 'agentMessage', text: 'Preserved cached answer' };
  await cache.saveOpenedDetail('owner', 'bot', 'turn:answer', item, [], 'stable');
  const db = await new Promise((resolve, reject) => { const request = env.indexedDB.open('dawar-bot-opened-details-v1', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  const key = JSON.stringify(['owner', 'bot', 'turn:answer']);
  await new Promise((resolve, reject) => {
    const tx = db.transaction('metadata', 'readwrite'), store = tx.objectStore('metadata'), request = store.get(key);
    request.onsuccess = () => { const previous = request.result; delete previous.version; store.put(previous); };
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
  assert.equal((await cache.readOpenedDetail('owner', 'bot', 'turn:answer')).item.text, item.text);
  await cache.updateOpenedDetailAttachments('owner', 'bot', 'turn:answer', [{ id: 'late', name: 'Late metadata.pdf' }], 'stable');
  const loaded = await cache.readOpenedDetail('owner', 'bot', 'turn:answer');
  assert.equal(loaded.item.text, item.text); assert.equal(loaded.attachments[0].name, 'Late metadata.pdf'); db.close();
});
