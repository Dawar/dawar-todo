// Injected helper only seeds/inspects synthetic data through the built commit's
// actual storage modules. It never imports a page, client transport or app shell.
import * as offline from '@packaged/offline-store';
import { BotDraftStore } from '@packaged/draft-store';
import * as history from '@packaged/history-cache';
const owner = 'packaged-pwa-smoke-synthetic-owner';
const botId = 'packaged-pwa-smoke-bot';
const taskId = -731004991;
const taskTitle = 'PACKAGED PWA synthetic offline task';
const quickText = 'PACKAGED PWA unsent Quick Add';
const botText = 'PACKAGED PWA unsent bot composer';
const historyText = 'PACKAGED PWA cached bot history';
const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBf8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));
const documentBytes = new TextEncoder().encode('PACKAGED PWA exact synthetic attachment bytes\n');
const hash = async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('');
const store = new BotDraftStore(indexedDB, localStorage);
window.packagedSmoke = {
  owner, botId, taskId, taskTitle, quickText, botText, historyText,
  async seed() {
    const now = new Date().toISOString();
    await offline.saveOfflineTodo({ clientId: 'packaged-pwa-synthetic-task', localId: taskId, title: taskTitle, notes: '', project: null, createdAt: now, status: 'open', pinned: true, sortOrder: -1e15,
      attachments: [{ localId: 'packaged-pwa-task-file', kind: 'file', fileName: 'packaged-pwa-original.txt', mimeType: 'text/plain', durationMs: 0, blob: new Blob([documentBytes], { type: 'text/plain' }) }] });
    const bot = { id: botId, name: 'Packaged PWA Smoke Bot', purpose: '', slug: botId, cwd: '/synthetic', threadId: 'packaged-pwa-synthetic-thread', color: '#216e4e', status: 'idle', archived: false,
      model: null, effort: null, mode: 'default', preview: '', updatedAt: now, lastReadAt: now, activeTurnId: null };
    localStorage.setItem('dawar-bots:last-owner', owner);
    localStorage.setItem(`dawar-bots:${owner}:snapshot`, JSON.stringify({ bots: [bot], pending: [], cursor: 0, ready: true, models: [], schedules: [], runs: [], defaults: { model: 'synthetic', effort: 'medium' } }));
    const record = await store.load(owner, botId);
    await store.change(owner, botId, { kind: 'text', slot: 'normal', text: botText, version: 'packaged-pwa-synthetic-version', base: record.slots.normal.textVersion });
    await store.change(owner, botId, { kind: 'add', slot: 'normal', files: [{ id: 'packaged-pwa-bot-png', name: 'packaged-pwa-original.png', mimeType: 'image/png', size: png.length, hasBytes: true }] }, new Map([['packaged-pwa-bot-png', new Blob([png], { type: 'image/png' })]]));
    if (typeof history.saveBotHistory !== 'function') throw new Error('Built commit history module needs a storage-helper adapter: missing saveBotHistory.');
    await history.saveBotHistory(owner, botId, { turns: [{ id: 'packaged-pwa-cached-turn', status: 'completed', itemsView: 'full', items: [{ id: 'packaged-pwa-cached-item', type: 'agentMessage', text: historyText, phase: 'final_answer' }] }], attachments: [], truncated: false });
    return { pngHash: await hash(new Blob([png])), taskFileHash: await hash(new Blob([documentBytes])) };
  },
  async stored() {
    const task = await offline.getOfflineTodoByLocalId(taskId);
    const record = await store.get(owner, botId);
    const bytes = await store.file(owner, botId, 'packaged-pwa-bot-png');
    const draft = await offline.loadOfflineCaptureDraft();
    return { taskPresent: task?.title === taskTitle, taskFileHash: task?.attachments[0]?.blob && await hash(task.attachments[0].blob),
      botText: record?.slots.normal.text, botFileHash: bytes && await hash(bytes), operations: Object.keys(record?.operations ?? {}).length,
      quickText: draft?.text, captureKeys: draft ? Object.keys(draft) : [], localTaskCount: (await offline.listOfflineTodos()).length };
  },
  async captureImage() {
    const image = document.querySelector('[aria-label="Attachments to add"] img');
    return image ? { local: image.src.startsWith('blob:'), decoded: image.complete && image.naturalWidth > 0, hash: await hash(await (await fetch(image.src)).blob()) } : null;
  },
  stageCaptureImage() {
    const transfer = new DataTransfer(); transfer.items.add(new File([png], 'packaged-pwa-capture.png', { type: 'image/png' }));
    document.querySelector('textarea[aria-label="Add a task"]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  },
  async botImage() {
    const image = document.querySelector('.bots-upload-image img');
    return image ? { local: image.src.startsWith('blob:'), decoded: image.complete && image.naturalWidth > 0, hash: await hash(await (await fetch(image.src)).blob()) } : null;
  },
};
