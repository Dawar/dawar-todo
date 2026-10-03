// Release-review fixture: production components/stores, fresh synthetic identities.
// Only the backend transport and shell routing are substituted by the runner.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { BotsWorkspace } from '../../app/bots/workspace';
import { botsClient as client } from '../../app/bots/client';
import { botComposers } from '../../app/bots/composer-service';
import { BotDraftStore } from '../../app/bots/draft-store';
import { AttachmentQueuePanel } from '../../app/attachment-queue-panel';
import { queueTaskAttachments, acquireQueuedAttachment, updateQueuedAttachment, listQueuedAttachments } from '../../app/offline-store';

const owner = 'release-review-owner';
const bots = ['A', 'B'].map((id) => ({ id, name: `Bot ${id}`, purpose: '', slug: id, cwd: '/synthetic', threadId: `thread-${id}`, color: '#216e4e', status: 'idle', archived: false,
  model: null, effort: null, mode: 'default', preview: '', updatedAt: '2026-09-26T00:00:00Z', lastReadAt: '2026-09-26T00:00:00Z', activeTurnId: null }));
const snapshot = { bots, pending: [], cursor: 0, ready: true, models: [], schedules: [], runs: [], defaults: { model: 'synthetic', effort: 'medium' } };
const seedOwner = (id) => {
  localStorage.setItem('dawar-bots:last-owner', id);
  localStorage.setItem(`dawar-bots:${id}:snapshot`, JSON.stringify(snapshot));
};
if (!localStorage.getItem('release-review-initialized')) {
  seedOwner(owner); localStorage.setItem('release-review-initialized', '1');
}
client.scheduleReconnect = () => {}; // No live VM; the runner explicitly reconnects.
const input = () => document.querySelector('textarea[aria-label^="Message "]');
const composer = (bot = 'A', id = owner) => botComposers.peek(id, bot);
const store = new BotDraftStore(indexedDB, localStorage);
const lifecycle = [];
for (const event of ['pagehide', 'pageshow', 'popstate']) window.addEventListener(event, () => { lifecycle.push(event); sessionStorage.setItem('review-lifecycle', JSON.stringify(lifecycle)); });
document.addEventListener('visibilitychange', () => lifecycle.push(`visibility:${document.visibilityState}`));
const broadcasts = [];
new BroadcastChannel('dawar-bot-drafts').onmessage = (event) => broadcasts.push(event.data);
new BroadcastChannel('dawar-bots-auth').onmessage = () => broadcasts.push({ revoked: true });
const root = createRoot(document.getElementById('root'));
if (location.search.includes('panel')) root.render(<AttachmentQueuePanel count={3} states={{ blocked: 2, 'missing-bytes': 1 }} />);
else root.render(<BotsWorkspace />);

let held;
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBf8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
const rect = (element) => {
  if (!element) return null;
  const r = element.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflowY: getComputedStyle(element).overflowY };
};
window.review = {
  instance: crypto.randomUUID(), owner, snapshot, lifecycle, broadcasts,
  readyBot: (bot) => composer(bot)?.ready,
  state() { const c = composer(); return { owner: client.owner, online: client.online, ready: c?.ready, saved: c?.saved, dirty: c?.dirty, record: c?.record, storageError: c?.storageError, actionError: c?.actionError, value: input()?.value, previews: [...document.querySelectorAll('.bots-upload-image img')].map((img) => ({ local: img.src.startsWith('blob:'), decoded: img.complete && img.naturalWidth > 0 })) }; },
  type(value) {
    const field = input();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  },
  add(name, contents = 'synthetic bytes', image = false) {
    const transfer = new DataTransfer(); transfer.items.add(new File([image ? png : contents], name, { type: image ? 'image/png' : 'text/plain' }));
    const field = document.querySelector('input[type="file"]'); field.files = transfer.files; field.dispatchEvent(new Event('change', { bubbles: true }));
  },
  select(bot) { history.pushState({}, '', `/review?bot=${bot}`); window.dispatchEvent(new PopStateEvent('popstate')); },
  flush: () => composer().flush(),
  async bytes(bot = 'A', id = owner) {
    const record = await store.get(id, bot);
    const files = [...new Map(Object.values(record?.slots ?? {}).flatMap((d) => d.files).map((f) => [f.id, f])).values()];
    return Promise.all(files.map(async (f) => { const bytes = await store.file(id, bot, f.id); return { id: f.id, name: f.name, size: bytes?.size, text: f.mimeType.startsWith('image/') ? undefined : await bytes?.text() }; }));
  },
  record: (bot = 'A', id = owner) => store.get(id, bot),
  // A real IDB readwrite lock guarantees concurrent edits start at the same base.
  // No production persistence/broadcast method is stubbed.
  async hold() {
    const db = await new Promise((resolve, reject) => { const q = indexedDB.open('dawar-bot-drafts', 1); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error); });
    held = { release: false };
    const tx = db.transaction(['drafts', 'files'], 'readwrite');
    held.done = new Promise((resolve, reject) => { tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error); });
    await new Promise((resolve) => { const loop = () => { const q = tx.objectStore('drafts').get([owner, 'A']); q.onsuccess = () => { resolve(); if (!held.release) loop(); }; }; loop(); });
  },
  async release() { held.release = true; await held.done; },
  online(value) {
    client.online = value;
    if (value) client.socket = { readyState: WebSocket.OPEN, close() {}, send(raw) {
      const request = JSON.parse(raw);
      void fetch('/review-rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
        .then((response) => response.json()).then((response) => client.receive({ type: 'response', id: request.id, ...response }));
    } };
    client.notify();
  },
  send() { void composer().send(); },
  // Exercise actual session status classification/auth-channel revocation.
  revoke: () => client.connect(),
  seedOwner,
  async queueEdit() {
    composer().edit({ id: 'synthetic-queue', botId: 'A', input: [{ type: 'text', text: 'queued text' }], attachments: [] });
    await composer().flush();
  },
  normal() { composer().select('normal'); },
  async longUploadErrors() {
    const longName = 'long_filename_'.repeat(18) + '.txt';
    this.add(longName, 'retained long-name bytes');
    for (let i = 0; i < 6; i++) this.add(`image-${i}.png`, '', true);
    await composer().flush();
    for (const f of composer().draft.files) await store.change(owner, 'A', { kind: 'fileError', id: f.id, error: ('A recoverable transfer error with detailed retry guidance. ').repeat(15) + 'ERROR_TOKEN_'.repeat(35) });
    await composer().refresh();
    return longName;
  },
  keyboard(height) {
    input()?.focus();
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => height });
    window.visualViewport.dispatchEvent(new Event('resize'));
  },
  layout() {
    return { width: innerWidth, height: innerHeight, visualHeight: visualViewport.height, rootWidth: document.documentElement.clientWidth,
      pageScrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      screen: rect(document.querySelector('.bots-screen')), input: rect(input()), composer: rect(document.querySelector('.bots-composer')),
      status: rect(document.querySelector('.bots-draft-status')), files: rect(document.querySelector('.bots-upload-list')), panel: rect(document.querySelector('[aria-label="Pending attachment recovery"]')),
      overflowControls: [...document.querySelectorAll('input, label, button')].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map((e) => ({ tag: e.tagName, type: e.getAttribute('type'), className: e.className, ...rect(e) })),
      keyboardOpen: document.querySelector('.bots-screen')?.classList.contains('bots-keyboard-open') };
  },
  scrollStatus() { const node = document.querySelector('.bots-draft-status'); node.scrollTop = node.scrollHeight; return node.scrollTop; },
  scrollFiles() { const node = document.querySelector('.bots-upload-list'); node.scrollLeft = node.scrollWidth; return node.scrollLeft; },
  async seedPanel() {
    const files = ['very_long_file_name_'.repeat(18) + '.txt', 'missing_original.png', 'interrupted.pdf'];
    await queueTaskAttachments(-77, files.map((fileName, i) => ({ localId: `review-task-${i}`, kind: 'file', fileName, mimeType: 'text/plain', durationMs: 0, blob: new Blob([i === 1 ? '' : `task staged bytes ${i}`]) })));
    for (let i = 0; i < 3; i++) {
      const row = await acquireQueuedAttachment(`review-task-${i}`);
      await updateQueuedAttachment(row.localId, row.leaseToken, { state: 'blocked', reason: i === 1 ? 'missing-bytes' : 'server', nextAttemptAt: Infinity, leaseUntil: 0,
        error: i === 0 ? 'A long upload error explains that the bytes are still saved. '.repeat(15) + 'UNBROKEN_ERROR_'.repeat(40) : 'Choose the original file to recover the missing bytes.' });
    }
    document.querySelector('button[aria-expanded]').click();
  },
  panelRows: () => listQueuedAttachments(),
};
