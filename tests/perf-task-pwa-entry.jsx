import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SubscribedTaskRow, baselineFilter, baselineCounts } from '../app/page';
import { taskStore } from '../app/task-store';
const stats = (values) => {
  const v = [...values].sort((a, b) => a - b), round = (n) => Math.round(n * 1000) / 1000;
  return { n: v.length, medianMs: round(v[Math.floor(v.length / 2)]), p95Ms: round(v[Math.ceil(v.length * .95) - 1]), totalMs: round(v.reduce((a, b) => a + b, 0)) };
};
const timed = (fn) => { const start = performance.now(); fn(); return performance.now() - start; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};
const props = { selected: false, timeZone: 'UTC', showPin: true, reordering: false, reorderTarget: false,
  onSelect: noop, onAction: noop, onEdit: noop, onPin: noop, onAcknowledgeUrgent: noop, onTitleChange: noop,
  onTitleBlur: noop, onTitleFocus: noop, onTitleArrowNavigate: noop, onReorderStart: noop, onReorderMove: noop, onReorderEnd: noop };
window.runBaseline = async ({ fixtures, now }) => {
  const result = { userAgent: navigator.userAgent, tasks: [] };
  const mount = document.createElement('div'); document.body.append(mount);
  let root = createRoot(mount);
  for (const todos of fixtures) {
    const params = { todos, now, view: 'all', deferredQuery: '', project: '', priority: '', inlineEditingId: null };
    const filter = [], search = [], counts = [];
    for (let i = 0; i < 210; i++) {
      const f = timed(() => baselineFilter(params));
      const s = timed(() => baselineFilter({ ...params, deferredQuery: `task ${i % 10}` }));
      const c = timed(() => baselineCounts(params));
      if (i >= 10) { filter.push(f); search.push(s); counts.push(c); }
    }
    taskStore.setAll(todos);
    const draw = (at) => <ul>{todos.map((todo) => <SubscribedTaskRow key={todo.id} {...props} todo={todo} now={at} />)}</ul>;
    const samples = { mount: [], stableParent: [], changedClock: [], oneDraft: [], layout: [], mountThroughLayout: [] }, renders = {};
    for (let i = 0; i < (todos.length > 1000 ? 1 : 3); i++) {
      window.baselineRowRenders = 0;
      const mountStart = performance.now();
      samples.mount.push(timed(() => flushSync(() => root.render(draw(now))))); renders.mount = window.baselineRowRenders;
      await Promise.resolve(); // Include the real batched pre-paint title measurement.
      samples.layout.push(timed(() => { void mount.offsetHeight; }));
      samples.mountThroughLayout.push(performance.now() - mountStart);
      window.baselineRowRenders = 0;
      samples.stableParent.push(timed(() => flushSync(() => root.render(draw(now))))); renders.stableParent = window.baselineRowRenders;
      window.baselineRowRenders = 0;
      samples.changedClock.push(timed(() => flushSync(() => root.render(draw(now + 60_000))))); renders.changedClock = window.baselineRowRenders;
      window.baselineRowRenders = 0;
      samples.oneDraft.push(timed(() => flushSync(() => taskStore.setDraft('server:1', { title: `Synthetic typing ${i}` })))); renders.oneDraft = window.baselineRowRenders;
      flushSync(() => root.unmount()); root = createRoot(mount); await wait(50);
    }
    result.tasks.push({ count: todos.length, filter: stats(filter), search: stats(search), counts: stats(counts),
      render: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stats(v)])), rowRenders: renders });
  }
  flushSync(() => root.unmount()); mount.remove(); return result;
};

window.runTaskBehavior = async () => {
  const assert = (ok, message) => { if (!ok) throw new Error(message); };
  const host = document.createElement('div'); host.style.width = '340px'; document.body.append(host);
  const root = createRoot(host); const events = [];
  const todo = { id: 901, clientId: null, title: 'one\ntwo\nthree\nfour', notes: '', status: 'open', priority: 3, project: null, context: null, dueDate: null, snoozedUntil: null, recurrenceCron: null, attachmentCount: 0 };
  const second = { ...todo, id: 902, title: 'second' };
  taskStore.setAll([todo, second]);
  const handlers = { ...props, onSelect: t => events.push(['select', t.id]), onTitleFocus: t => events.push(['focus', t.id]),
    onTitleChange: (t, title) => { events.push(['change', t.id]); taskStore.setDraft(`server:${t.id}`, { title }); },
    onTitleBlur: (t, title) => events.push(['blur', t.id, title]),
    onTitleArrowNavigate: (t, direction) => { events.push(['arrow', t.id, direction]); host.querySelectorAll('textarea')[1].focus(); return true; },
    onReorderStart: t => events.push(['reorder-start', t.id]), onReorderMove: () => events.push(['reorder-move']), onReorderEnd: () => events.push(['reorder-end']),
  };
  const draw = () => <ul>{[todo, second].map(t => <SubscribedTaskRow key={t.id} {...handlers} todo={t} now={Date.now()} />)}</ul>;
  flushSync(() => root.render(draw())); await Promise.resolve();
  const textarea = host.querySelector('textarea');
  assert(textarea.clientHeight >= textarea.scrollHeight - 2, 'multiline title clipped at mount');
  textarea.focus(); await wait(20); textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  const larger = 'edited\n'.repeat(20);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, larger);
  textarea.dispatchEvent(new Event('input', { bubbles: true })); await wait(20);
  assert(events.some(e => e[0] === 'change'), 'title change handler missing');
  assert(textarea.clientHeight >= textarea.scrollHeight - 2, 'edited title clipped');
  assert(document.activeElement === textarea, 'typing lost focus');
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await wait(20);
  assert(document.activeElement === host.querySelectorAll('textarea')[1], 'arrow navigation lost full row access');
  assert(events.some(e => e[0] === 'blur' && e[2] === larger), 'blur lost last title: ' + JSON.stringify(events));
  host.querySelector('input[type=checkbox]').click();
  const drag = host.querySelector('[title="Drag to reorder"]');
  drag.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  drag.dispatchEvent(new PointerEvent('pointermove', { bubbles: true }));
  drag.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  assert(events.some(e => e[0] === 'select'), 'selection handler missing');
  assert(events.some(e => e[0] === 'reorder-start') && events.some(e => e[0] === 'reorder-end'), 'reorder handlers missing');
  const anchor = host.querySelector('[data-task-row-id="902"]');
  const oldNode = anchor; taskStore.setDraft('server:901', { title: larger + 'last' }); await wait(20);
  assert(host.querySelector('[data-task-row-id="902"]') === oldNode, 'unrelated row remounted');
  const result = { multilineMount: true, multilineEdit: true, focus: true, arrowNavigation: true, lastBlur: true, selection: true, reorderHandlers: true, rowIdentity: true, events: events.map(e => e[0]) };
  flushSync(() => root.unmount()); host.remove(); return result;
};

// Actual Home + native IndexedDB, with only network disabled on the synthetic origin.
let captureRoot;
async function mountCaptureHome() {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  const host = document.createElement('div'); document.body.append(host); captureRoot = createRoot(host);
  const { default: Home } = await import('../app/page');
  const { taskSync } = await import('../app/task-sync'); taskSync.start();
  flushSync(() => captureRoot.render(<Home />));
  for (let i = 0; i < 300; i++) { const field = host.querySelector('textarea[aria-label="Add a task"]'); if (field && !field.disabled) return { host, field }; await wait(10); }
  throw new Error('Capture did not restore');
}
window.stageCapture = async () => {
  const { host, field } = await mountCaptureHome(); field.focus(); await wait(20);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Synthetic unsubmitted capture');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  const input = host.querySelector('input[type=file]'); if (!input) throw new Error('Capture file picker missing');
  const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array([0, 255, 8, 9])], 'synthetic-original.txt', { type: 'application/octet-stream' }));
  input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  for (let i = 0; i < 300; i++) {
    if (host.querySelector('a[download="synthetic-original.txt"]') && host.textContent.includes('Draft saved on this device')) {
      const { listOfflineTodos } = await import('../app/offline-store');
      if ((await listOfflineTodos()).length) throw new Error('Unsubmitted draft became a task');
      return true;
    }
    await wait(10);
  }
  throw new Error('Capture files were not committed');
};
window.recoverCapture = async () => {
  const { host, field } = await mountCaptureHome();
  if (field.value !== 'Synthetic unsubmitted capture') throw new Error('Reload lost capture text');
  const link = host.querySelector('a[download="synthetic-original.txt"]'); if (!link) throw new Error('Reload lost file');
  const bytes = [...new Uint8Array(await (await fetch(link.href)).arrayBuffer())];
  if (JSON.stringify(bytes) !== '[0,255,8,9]') throw new Error('Reload changed original bytes');
  const { listOfflineTodos } = await import('../app/offline-store'); if ((await listOfflineTodos()).length) throw new Error('Reload auto-submitted draft');
  captureRoot.unmount();
  const { taskSync } = await import('../app/task-sync'); taskSync.stop();
  return { nativeIndexedDBReload: true, text: true, originalBytes: true, noAutomaticSubmit: true };
};

window.testCaptureAddRace = async () => {
  const { host, field } = await mountCaptureHome();
  const { TaskCaptureSession } = await import('../app/task-capture');
  const { listOfflineTodos } = await import('../app/offline-store');
  const until = async (fn) => { for (let i = 0; i < 400; i++) { if (await fn()) return; await wait(10); } throw new Error('Capture race did not settle'); };
  const select = name => {
    const input = host.querySelector('input[type=file]'); const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array([0, 255, 8, 9])], name, { type: 'application/octet-stream' }));
    input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  let finishPrepare;
  window.capturePreparationGate = () => new Promise(resolve => finishPrepare = resolve);
  select('delayed.txt'); await until(() => finishPrepare);
  const add = host.querySelector('button[type=submit]');
  if (!add.disabled) throw new Error('Add remained enabled during file preparation');
  host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  if ((await listOfflineTodos()).length) throw new Error('Add consumed a draft before file selection finished');
  delete window.capturePreparationGate; finishPrepare();
  await until(() => host.textContent.includes('Draft saved on this device') && !add.disabled);
  const native = TaskCaptureSession.prototype.consume; let finishConsume;
  TaskCaptureSession.prototype.consume = async function (record) { await new Promise(resolve => finishConsume = resolve); return native.call(this, record); };
  add.click(); await until(() => finishConsume);
  if (!field.disabled || !host.querySelector('[aria-label="Add attachment or assign project"]').disabled) throw new Error('Capture controls remained active during Add');
  select('synthetic-original.txt'); // Native picker result arriving after Add started belongs to the next draft.
  finishConsume();
  await until(async () => (await listOfflineTodos()).length === 1 && !field.disabled && host.querySelector('a[download="synthetic-original.txt"]'));
  TaskCaptureSession.prototype.consume = native;
  field.focus(); await wait(20);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'Synthetic unsubmitted capture');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => host.textContent.includes('Draft saved on this device'));
  const queued = (await listOfflineTodos())[0]; const session = new TaskCaptureSession(); const draft = await session.load();
  if (queued.attachments.length !== 2 || draft.attachments.length !== 1) throw new Error('Add lost early or late files');
  if (queued.attachments.some(item => item.localId === draft.attachments[0].localId)) throw new Error('Late file was claimed by the earlier task');
  captureRoot.unmount(); const { taskSync } = await import('../app/task-sync'); taskSync.stop();
  return { pendingPreparationBlocksAdd: true, pendingConsumeGuardsControls: true, earlyFilesTransferred: 2, lateFilePreservedInNextDraft: true };
};

window.openOfflineCapture = async () => {
  const { host, field } = await mountCaptureHome();
  if (field.value !== 'Synthetic unsubmitted capture') throw new Error('Cold offline navigation lost draft text');
  const link = host.querySelector('a[download="synthetic-original.txt"]');
  if (!link) throw new Error('Cold offline navigation lost selected file');
  const bytes = [...new Uint8Array(await (await fetch(link.href)).arrayBuffer())];
  if (JSON.stringify(bytes) !== '[0,255,8,9]') throw new Error('Cold offline navigation changed original bytes');
  const { listOfflineTodos } = await import('../app/offline-store'); const queued = await listOfflineTodos();
  if (queued.length !== 1 || queued[0].attachments.length !== 2) throw new Error('Cold offline navigation lost queued task/files');
  if (!host.querySelector('[data-task-row-id]')) throw new Error('Offline task list is unusable');
  field.focus(); await wait(20);
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, field.value + ' offline edit');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  for (let i = 0; i < 300 && !host.textContent.includes('Draft saved on this device'); i++) await wait(10);
  const { TaskCaptureSession } = await import('../app/task-capture'); const stored = await new TaskCaptureSession().load();
  if (!stored.draft.text.endsWith(' offline edit')) throw new Error('Offline capture editing did not persist');
  return { freshDocument: true, realAppModulesExecuted: true, nativeIndexedDB: true, queuedTasks: queued.length, queuedFiles: queued[0].attachments.length,
    preAddTextAndFile: true, originalBytes: bytes.length, offlineEditPersisted: true, noAutomaticSubmit: (await listOfflineTodos()).length === 1 };
};

let recoveryRoot, recoveryHost;
window.seedRecoveryPanel = async () => {
  const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/panel.css';
  document.head.append(style); await new Promise(resolve => style.onload = resolve);
  const { taskTransaction } = await import('../app/offline-store');
  await taskTransaction(['attachment-outbox'], tx => {
    for (const [localId, blob] of [['panel-local', new Blob(['original'])], ['panel-missing', undefined]]) tx.objectStore('attachment-outbox').put({
      localId, todoId: 1, kind: 'file', fileName: 'very-long-original-filename_'.repeat(16) + '.txt', mimeType: 'text/plain', blob,
      createdAt: new Date().toISOString(), attempts: 1, nextAttemptAt: Infinity, state: 'blocked', reason: blob ? 'server' : 'missing-bytes',
      error: 'UNBROKEN_ERROR_'.repeat(80), durationMs: 0,
    });
  });
  const { AttachmentQueuePanel } = await import('../app/attachment-queue-panel');
  recoveryHost = document.createElement('div'); document.body.append(recoveryHost); recoveryRoot = createRoot(recoveryHost);
  flushSync(() => recoveryRoot.render(<AttachmentQueuePanel count={2} states={{ blocked: 2 }} />));
  [...recoveryHost.querySelectorAll('button')].find(b => b.textContent === 'Review attachments').click();
  for (let i = 0; i < 300 && recoveryHost.querySelectorAll('li').length !== 2; i++) await wait(10);
};
window.checkRecoveryPanel = async () => {
  await wait(30); const panel = recoveryHost.querySelector('ul'); if (!panel) throw new Error('Recovery panel did not open');
  const width = document.documentElement.clientWidth;
  const file = panel.querySelector('input[type=file]');
  const controlWidth = file.getBoundingClientRect().width;
  if (document.documentElement.scrollWidth > width) throw new Error('Recovery panel overflows viewport: ' + document.documentElement.scrollWidth + '/' + width);
  for (const control of panel.querySelectorAll('button,input')) {
    control.scrollIntoView({ block: 'center' }); await wait(5); const rect = control.getBoundingClientRect();
    if (rect.left < 0 || rect.right > width + 1 || rect.top < -1 || rect.bottom > innerHeight + 1) throw new Error('Recovery control unreachable');
  }
  if (!panel.textContent.includes('Choose original file') || !panel.textContent.includes('Save local file') || !panel.textContent.includes('Retry this attachment')) throw new Error('Recovery actions hidden');
  return { width, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, fileControlWidth: controlWidth, allRecoveryControlsReachable: true };
};
window.closeRecoveryPanel = () => { recoveryRoot.unmount(); recoveryHost.remove(); };
