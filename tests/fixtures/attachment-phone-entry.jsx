import React from 'react';
import { createRoot } from 'react-dom/client';
import * as db from '../../app/offline-store';
import { syncQueuedAttachment } from '../../app/attachment-sync';
import { attachmentQueueState } from '../../app/attachment-queue';
import { AttachmentQueuePanel } from '../../app/attachment-queue-panel';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let roots = [], originals = [];
window.seedPhoneRows = async () => {
  const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 32;
  canvas.getContext('2d').fillRect(0, 0, 64, 32);
  const png = new Uint8Array(await (await new Promise(done => canvas.toBlob(done, 'image/png'))).arrayBuffer());
  originals = [482869,375769,438790,308961,292932].map((size, index) => {
    const bytes = new Uint8Array(size); bytes.set(png);
    return { localId: `12345678-1234-4234-8234-12345678901${index}`, todoId: 7, createdAt: '2026-09-26', attempts: 4, nextAttemptAt: 0,
      kind: 'image', fileName: `synthetic-${index}.png`, mimeType: 'image/png', durationMs: 0, blob: new Blob([bytes], { type: 'image/png' }),
      phase: 'checking', leaseToken: `old-${index}`, leaseUntil: Date.now() - 1, draftToken: 'retained-draft', remoteAttachmentId: undefined };
  });
  await new Promise((resolve, reject) => {
    const r = indexedDB.open('dawar-todo-offline', 9);
    r.onupgradeneeded = () => { const store = r.result.createObjectStore('attachment-outbox', { keyPath: 'localId' }); originals.forEach(row => store.put(row)); };
    r.onsuccess = () => { r.result.close(); resolve(); }; r.onerror = () => reject(r.error);
  });
  const saved = await db.listQueuedAttachments();
  assert(saved.length === 5 && saved.every((row, i) => row.localId === originals[i].localId && row.blob.size === originals[i].blob.size), 'migration changed IDs/bytes');
  for (const row of saved) assert(await digest(row.blob) === await digest(originals.find(o => o.localId === row.localId).blob), 'migration changed original');
  return { rows: saved.length, bytes: saved.map(row => row.blob.size), database: (await db.openDatabase()).version };
};
async function digest(blob) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, '0')).join(''); }
window.uploadPhoneRows = async () => {
  for (const row of await db.listQueuedAttachments()) await syncQueuedAttachment(row.localId);
  const retained = await db.listQueuedAttachments();
  for (const row of retained) assert(await digest(row.blob) === await digest(originals.find(o => o.localId === row.localId).blob), 'retry lost original');
  return { remaining: retained.length, rows: retained.map(row => ({ state: attachmentQueueState(row), phase: row.phase ?? null, lease: !!row.leaseToken, transport: row.transport, bytes: row.blob.size })) };
};
window.retryPhoneRows = async () => { await db.retryQueuedAttachments(); return window.uploadPhoneRows(); };
window.testCommittedLease = async () => {
  const row = { ...originals[0], localId: crypto.randomUUID(), leaseToken: undefined, leaseUntil: undefined };
  await db.queueTaskAttachments(7, [row]); const acquired = await db.acquireQueuedAttachment(row.localId);
  const updated = await db.updateQueuedAttachment(row.localId, acquired.leaseToken, { phase: 'uploading' });
  assert(updated.phase === 'uploading', 'updater did not return committed phase');
  const released = await db.updateQueuedAttachment(row.localId, acquired.leaseToken, { phase: undefined, leaseToken: undefined, leaseUntil: undefined, state: 'retry', nextAttemptAt: Date.now() + 60000 });
  const saved = (await db.listQueuedAttachments()).find(r => r.localId === row.localId);
  assert(!released.leaseToken && !saved.leaseToken && attachmentQueueState(saved) === 'retry', 'released IDB lease still progressing');
  // Synthetic fixture row remains present for UI evidence, never automatically deleted.
  return { returnedPhase: updated.phase, persistedState: attachmentQueueState(saved), bytes: saved.blob.size };
};
window.testPanelExpiry = async () => {
  for (const r of roots) r.unmount(); roots = [];
  const row = { ...originals[0], localId: crypto.randomUUID(), leaseToken: 'suspended-tab', leaseUntil: Date.now() + 900 };
  await db.taskTransaction(['attachment-outbox'], tx => tx.objectStore('attachment-outbox').put(row));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); roots.push(root);
  // Deliberately stale parent snapshot: panel must age the committed rows itself.
  root.render(<AttachmentQueuePanel count={5} states={{ checking: 5 }} />);
  await wait(300);
  const before = host.querySelector('[role=status]').textContent;
  await wait(900);
  const afterClosed = host.querySelector('[role=status]').textContent;
  host.querySelector('[aria-expanded]').click(); await wait(150);
  const target = [...host.querySelectorAll('li')].find(li => li.textContent.includes(row.fileName) && li.textContent.includes('interrupted'));
  const retry = target && [...target.querySelectorAll('button')].find(b => b.textContent === 'Retry this attachment');
  if (window.expectFixed) assert(afterClosed.includes('0 in progress'), 'closed summary retained expired checking leases');
  if (!window.expectFixed) return { before, afterClosed, retryEnabled: Boolean(retry && !retry.disabled) };
  assert(retry && !retry.disabled, 'expired lease still blocks Retry');
  retry.click(); await wait(150);
  const saved = (await db.listQueuedAttachments()).find(r => r.localId === row.localId);
  assert(saved.localId === row.localId && saved.blob.size === row.blob.size && !saved.leaseToken, 'retry changed identity/bytes or retained lease');
  return { before, afterClosed, retryEnabled: !retry.disabled, width: document.documentElement.scrollWidth, viewport: innerWidth };
};
window.phoneReady = true;

window.stageStaleCapability = async () => {
  const row = { ...originals[0], localId: crypto.randomUUID(), leaseToken: undefined, leaseUntil: undefined, phase: undefined };
  originals.push(row); await db.queueTaskAttachments(7, [row]); await syncQueuedAttachment(row.localId);
  const saved = (await db.listQueuedAttachments()).find(item => item.localId === row.localId);
  return saved ? { retained: true, state: attachmentQueueState(saved), lease: !!saved.leaseToken, bytes: saved.blob.size, transport: saved.transport } : { retained: false };
};
