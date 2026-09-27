import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BotsWorkspace } from '../app/bots/workspace';
import { botsClient as client } from '../app/bots/client';
import { getBotTimeline } from '../app/bots/use-timeline';
import { botComposers } from '../app/bots/composer-service';
import { BotDraftStore } from '../app/bots/draft-store';
import { timelineCache } from '../app/bots/timeline-cache';
import { snapshotFor, chatTurns } from './perf-chat-fixtures-098e1aae.mjs';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const check = (value, label) => { if (!value) throw new Error(label); };
async function until(fn, label, timeout = 20000) { const start = performance.now(); while (performance.now() - start < timeout) { if (fn()) return; await wait(5); } throw new Error('Timed out: ' + label); }
const stats = (a) => { a = [...a].sort((x, y) => x - y); return { medianMs: a[Math.floor(a.length / 2)], maxMs: a.at(-1) }; };
const select = (id) => { history.pushState({}, '', id ? `/harness?bot=${id}` : '/harness'); window.dispatchEvent(new PopStateEvent('popstate')); };
const scrollState = () => { const e = document.querySelector('.bots-messages'); return { top: e.scrollTop, height: e.scrollHeight, viewport: e.clientHeight, bottomGap: e.scrollHeight - e.clientHeight - e.scrollTop }; };
const nodeKey = (e) => e?.dataset.historyKey;
let calls = [], downloads = 0, writes = [];
const originalPut = IDBObjectStore.prototype.put, originalSet = Storage.prototype.setItem;
IDBObjectStore.prototype.put = function (value, ...args) { writes.push({ store: this.name, value }); return originalPut.call(this, value, ...args); };
Storage.prototype.setItem = function (key, value) { writes.push({ store: 'localStorage', value, key }); return originalSet.call(this, key, value); };
client.start = () => {};
client.download = async () => { downloads++; await wait(180); return { blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="200" height="400"></svg>'], { type: 'image/svg+xml' }), name: 'synthetic.svg' }; };
client.rpc = async (method, botId, params) => {
  if (!method.startsWith('history.')) return [];
  const call = { method, botId, params, start: performance.now(), done: false }; calls.push(call);
  const result = await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method, botId, params }) });
  const text = await result.text(); call.bytes = new TextEncoder().encode(text).length; call.done = true;
  const body = JSON.parse(text); if (!result.ok) throw new Error(body.error); return body;
};
let root = createRoot(document.getElementById('root'));
async function reset(name, options, count = 20) {
  flushSync(() => root.unmount()); root = createRoot(document.getElementById('root'));
  client.owner = `synthetic-${name}`; client.online = true; client.snapshot = snapshotFor(count); client.notify();
  history.replaceState({}, '', '/harness'); await fetch('/config', { method: 'POST', body: JSON.stringify(options) });
  calls = []; downloads = 0; writes = []; window.baselineMessageRenders = 0; window.messageIds = [];
}
const storeStats = (items) => ({ writes: items.length, itemWrites: items.filter((i) => i.store === 'items').length,
  localStorageWrites: items.filter((i) => i.store === 'localStorage').length,
  byStore: Object.fromEntries([...new Set(items.map((i) => i.store))].map((key) => [key, items.filter((i) => i.store === key).length])),
  serializedCharsAfterMeasurement: items.reduce((n, i) => n + JSON.stringify(i.value).length, 0) });
async function open(id, offline = false) {
  const start = performance.now(), before = calls.length, dl = downloads; window.baselineMessageRenders = 0;
  select(id); await until(() => document.querySelector('.bots-messages')?.textContent.includes(`${id}:latest`), 'latest paint'); await paint();
  const paintMs = performance.now() - start, paintRenders = window.baselineMessageRenders;
  if (!offline) await until(() => calls.slice(before).some((c) => c.method === 'history.view' && c.done), 'refresh settled');
  await paint();
  return { firstLatestPaintMs: paintMs, settledMs: performance.now() - start, messageRendersToPaint: paintRenders,
    loadedEntries: getBotTimeline(client.owner, id).getSnapshot().entries.length, mountedEntries: document.querySelectorAll('[data-history-key]').length,
    closedToolPreNodes: document.querySelectorAll('details.bots-activity:not([open]) pre').length,
    closedScheduledMessages: document.querySelectorAll('details.is-scheduled:not([open]) .bots-message').length,
    attachmentDownloads: downloads - dl, historyRequests: calls.slice(before).filter((c) => c.method === 'history.view').length,
    historyBytes: calls.slice(before).filter((c) => c.method === 'history.view').reduce((n, c) => n + c.bytes, 0), scroll: scrollState() };
}
window.performanceChat = {
  async run() {
    const result = { navigation: [], botList: [] };
    for (const n of [20, 200, 1000]) {
      await reset(`list-${n}`, {}, n); client.online = false;
      const start = performance.now(); flushSync(() => root.render(<BotsWorkspace />)); await paint();
      const mountToPaintMs = performance.now() - start, before = performance.now(); flushSync(() => client.notify());
      result.botList.push({ bots: n, renderedRows: document.querySelectorAll('.bots-row').length, mountToPaintMs, unrelatedRedrawMs: performance.now() - before });
      const field = document.querySelector('[aria-label="Search bots"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, `bot ${n - 1}`); field.dispatchEvent(new Event('input', { bubbles: true })); await paint();
      check(document.querySelector('.bots-row-title').textContent === `Synthetic bot ${n - 1}`, 'search reaches last virtualized bot');
    }
    for (const [name, options] of [
      ['small-20-turns', { messages: 1, rtt: 195 }],
      ['dense-20-turns-weak-link', { messages: 20, rtt: 600, bytesPerSecond: 128 * 1024 }],
      ['accumulated-400-turn-cache', { messages: 1, cachedTurns: 400, rtt: 600, bytesPerSecond: 128 * 1024 }],
      ['one-turn-80-tools', { messages: 1, tools: 80, rtt: 195 }],
    ]) {
      await reset(name, options); const a = 'synthetic-bot-0', b = 'synthetic-bot-1';
      if (options.cachedTurns) client.save(`history:${a}`, { turns: chatTurns(a, 400), attachments: [] });
      flushSync(() => root.render(<BotsWorkspace />)); await paint();
      const first = await open(a), other = await open(b), repeat = await open(a);
      const scroller = document.querySelector('.bots-messages'); scroller.scrollTop = scroller.scrollHeight / 3; scroller.dispatchEvent(new Event('scroll')); await paint();
      const before = scrollState(); writes = []; window.baselineMessageRenders = 0; window.messageIds = [];
      const dispatch = [], toPaint = [];
      for (let i = 0; i < 10; i++) {
        const event = { seq: i + 1, type: 'codex', botId: a, data: { method: 'item/agentMessage/delta', params: { turnId: 'chat-turn-19', itemId: `chat-item-19-${options.messages - 1}`, delta: ` synthetic-delta-${i}` } } };
        const start = performance.now(); flushSync(() => client.receive({ type: 'event', event })); dispatch.push(performance.now() - start);
        await paint(); toPaint.push(performance.now() - start); await wait(20);
      }
      await getBotTimeline(client.owner, a).flush(); await wait(20);
      const streaming = { events: 10, synchronousDispatch: stats(dispatch), eventToTwoFrames: stats(toPaint), messageRenders: window.baselineMessageRenders,
        unchangedMessageRenders: window.messageIds.filter((id) => id !== `chat-item-19-${options.messages - 1}`).length, storage: storeStats(writes), before, after: scrollState() };
      const container = document.querySelector('.bots-messages'); container.scrollTop = 0; container.dispatchEvent(new Event('scroll')); await paint();
      const anchor = document.querySelector('[data-history-key]'), key = nodeKey(anchor), anchorBefore = anchor.getBoundingClientRect().top;
      document.querySelector('.bots-older').click(); await wait(options.rtt + 1000); await paint();
      const same = [...document.querySelectorAll('[data-history-key]')].find((el) => nodeKey(el) === key);
      const pagination = { anchorStillMounted: Boolean(same), anchorShiftPx: same ? same.getBoundingClientRect().top - anchorBefore : null,
        mountedEntries: document.querySelectorAll('[data-history-key]').length, loadedEntries: getBotTimeline(client.owner, a).getSnapshot().entries.length };
      const position = getBotTimeline(client.owner, a).getSnapshot().position;
      select(b); await paint(); select(a); await paint(); await wait(20);
      const returned = [...document.querySelectorAll('[data-history-key]')].find((el) => nodeKey(el) === position.anchor);
      const restoration = { anchorFound: Boolean(returned), offsetErrorPx: returned ? returned.getBoundingClientRect().top - document.querySelector('.bots-messages').getBoundingClientRect().top - position.offset : null };
      document.querySelector('.bots-jump-latest').click(); await paint();
      client.online = false; client.notify(); select(b); await paint(); const offline = await open(a, true);
      client.online = true; client.notify(); await until(() => calls.every((c) => c.done), 'reconnect'); await wait(options.rtt + 50);
      result.navigation.push({ name, first, other, repeat, streaming, pagination, restoration, offline });
      check(first.closedToolPreNodes === 0 && first.closedScheduledMessages === 0, 'closed bodies mounted');
      check(streaming.unchangedMessageRenders === 0, 'unchanged body rerendered');
    }
    await reset('race', {}); const originalRpc = client.rpc, waiting = [];
    client.rpc = (method, botId) => method === 'history.view' ? new Promise((resolve) => waiting.push({ botId, resolve })) : Promise.resolve([]);
    flushSync(() => root.render(<BotsWorkspace />)); await paint(); select('synthetic-bot-0'); await wait(50); select('synthetic-bot-1'); await wait(50); select('synthetic-bot-0'); await wait(50);
    const a = waiting.filter((r) => r.botId === 'synthetic-bot-0'); check(a.length === 1, 'duplicate same bot request');
    const empty = { kind: 'page', entries: [], olderCursor: null, revision: 'r1', eventCursor: 0, attachments: [], complete: true };
    for (const call of waiting) call.resolve(empty); await paint(); client.rpc = originalRpc;
    result.race = { requests: waiting.length, simultaneousARequests: a.length, staleOverwrite: false };
    await reset('huge-answer', { hugeAnswer: true, rtt: 0 }); flushSync(() => root.render(<BotsWorkspace />)); await paint();
    await open('synthetic-bot-0');
    const continueButton = [...document.querySelectorAll('.bots-detail-status button')].find((button) => button.textContent.includes('Continue'));
    check(continueButton, 'oversized answer must advertise continuation'); continueButton.click();
    await until(() => document.querySelector('.bots-text-pages button')?.textContent === 'Previous part', 'full answer pages');
    [...document.querySelectorAll('.bots-text-pages button')].find((button) => button.textContent === 'Last part').click(); await paint();
    check(document.querySelector('.bots-messages').textContent.includes('COMPLETE-END'), 'complete answer tail unreachable');
    result.hugeAnswer = { sourceChars: 340012, completeTailReachable: true, detailRequests: calls.filter((c) => c.method === 'history.detail').length, mountedTextChars: document.querySelector('.bots-messages').textContent.length };
    await reset('delayed-image', { lateImages: true, rtt: 0 }); flushSync(() => root.render(<BotsWorkspace />)); await paint();
    const imageOpen = await open('synthetic-bot-0'); await wait(300); await paint();
    result.delayedImage = { initialBottomGap: imageOpen.scroll.bottomGap, finalBottomGap: scrollState().bottomGap, decoded: document.querySelector('.bots-attached-image')?.complete };
    check(result.delayedImage.finalBottomGap <= 1, 'late image broke following latest');
    // Seed nine histories, then reload the document with the transport offline.
    await reset('offline-process', { tools: 80, rtt: 0 }); flushSync(() => root.render(<BotsWorkspace />)); await paint();
    for (let i = 0; i < 9; i++) { const controller = getBotTimeline(client.owner, `synthetic-bot-${i}`); await controller.refresh(); await controller.flush(); }
    const controller = getBotTimeline(client.owner, 'synthetic-bot-0');
    await controller.detail(controller.getSnapshot().entries.find((e) => e.type === 'commandExecution')); await wait(100); await controller.flush();
    // Persist a non-bottom reading anchor separately from latest-follow state.
    const anchorController = getBotTimeline(client.owner, 'synthetic-bot-8');
    const anchor = anchorController.getSnapshot().entries.at(-1);
    anchorController.position({ anchor: `${anchor.turnId}:${anchor.id}`, offset: 10, following: false }); await anchorController.flush();
    await timelineCache.close();
    return result;
  },
  async offlineReload() {
    client.owner = 'synthetic-offline-process'; client.online = false; client.snapshot = snapshotFor(20); calls = []; downloads = 0;
    flushSync(() => root.render(<BotsWorkspace />)); await paint();
    const first = await open('synthetic-bot-0', true); check(calls.length === 0, 'offline network request');
    const controller = getBotTimeline(client.owner, 'synthetic-bot-0'), tool = controller.getSnapshot().entries.find((e) => e.type === 'commandExecution');
    const full = await controller.detail(tool); check(full.aggregatedOutput.length > 30000, 'opened tool detail missing offline');
    select('synthetic-bot-8'); await until(() => getBotTimeline(client.owner, 'synthetic-bot-8').getSnapshot().cached, 'cold restored anchor'); await paint();
    const saved = getBotTimeline(client.owner, 'synthetic-bot-8').getSnapshot().position;
    check(!saved.following, 'cold follow/anchor metadata lost');
    return { first, openedDetailOfflineChars: full.aggregatedOutput.length, afterNineHistories: true, coldAnchorRetained: Boolean(saved.anchor), requests: calls.length, downloads };
  },
  async mobileLayout() {
    select('synthetic-bot-0'); await until(() => botComposers.peek(client.owner, 'synthetic-bot-0')?.ready, 'mobile composer');
    const composer = botComposers.peek(client.owner, 'synthetic-bot-0');
    composer.addFiles(Array.from({ length: 6 }, (_, i) => new File(['<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'], `image-${i}.svg`, { type: 'image/svg+xml' })));
    await composer.flush(); const store = new BotDraftStore(indexedDB, localStorage);
    for (const f of composer.draft.files) await store.change(client.owner, 'synthetic-bot-0', { kind: 'fileError', id: f.id, error: 'Recoverable upload error '.repeat(100) + 'UNBROKEN_ERROR_TOKEN'.repeat(100) });
    await composer.refresh(); await paint();
    const input = document.querySelector('textarea[aria-label^="Message"]'); input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Multiline draft\n'.repeat(20)); input.dispatchEvent(new Event('input', { bubbles: true }));
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 400 }); window.visualViewport.dispatchEvent(new Event('resize')); await wait(300); await paint();
    const status = document.querySelector('.bots-recovery-details'); status.open = true; await paint();
    const r = input.getBoundingClientRect(), box = document.querySelector('.bots-composer').getBoundingClientRect();
    check(r.bottom <= 401 && r.height >= 38, 'keyboard clips editor');
    check(box.bottom <= 401, 'keyboard clips send/attachment controls');
    const output = { inputBottom: r.bottom, inputHeight: r.height, composerBottom: box.bottom, statusWidth: document.querySelector('.bots-draft-status').scrollWidth, viewportWidth: innerWidth };
    window.__keyboardResult = output;
    return output;
  },
  async dismissKeyboard() {
    document.activeElement.blur(); Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => innerHeight }); window.visualViewport.dispatchEvent(new Event('resize')); await wait(300);
    check(!document.querySelector('.bots-screen').classList.contains('bots-keyboard-open'), 'keyboard mode retained after dismissal');
    return { screenHeight: document.querySelector('.bots-screen').getBoundingClientRect().height, viewportHeight: innerHeight };
  },
};
