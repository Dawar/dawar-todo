import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SubscribedTaskRow, baselineFilter, baselineCounts } from '../app/page';
import { taskStore } from '../app/task-store';
import { BotsClient, botsClient } from '../app/bots/client';
import { BotsWorkspace } from '../app/bots/workspace';
import { reduceBotTurns } from '../app/bots/thread-state';

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
const fixtureHistory = (n) => Array.from({ length: n }, (_, i) => ({
  id: `turn-${i}`, status: i === n - 1 ? 'inProgress' : 'completed', itemsView: 'full', error: null,
  startedAt: 1, completedAt: null, durationMs: null,
  items: [{ id: `item-${i}`, type: 'agentMessage', text: 'Synthetic response. '.repeat(512), phase: 'final_answer' }],
}));

window.runBaseline = async ({ fixtures, now }) => {
  const result = { userAgent: navigator.userAgent, history: [], tasks: [] };
  const mount = document.createElement('div'); document.body.append(mount);
  let root = createRoot(mount);
  const client = new BotsClient(); client.owner = 'synthetic-owner-a';
  const nativeSet = Storage.prototype.setItem;
  let writes = [], failures = 0;
  Storage.prototype.setItem = function (key, value) {
    const start = performance.now();
    try { return nativeSet.call(this, key, value); }
    catch (e) { failures++; throw e; }
    finally { writes.push({ chars: value.length, ms: performance.now() - start }); }
  };
  try {
    for (const size of [4, 400]) {
      localStorage.clear(); let turns = fixtureHistory(size);
      client.save('history:synthetic', { turns, attachments: [] }); await wait(50);
      writes = []; failures = 0; const updateTimes = [], stringifyTimes = [];
      for (let i = 0; i < 120; i++) {
        turns = reduceBotTurns(turns, { method: 'item/agentMessage/delta', params: { turnId: `turn-${size - 1}`, itemId: `item-${size - 1}`, delta: 'x'.repeat(32) } });
        // Separate JSON microbenchmark; not included in update/effect measurements.
        stringifyTimes.push(timed(() => JSON.stringify({ turns, attachments: [] })));
        updateTimes.push(timed(() => client.save('history:synthetic', { turns, attachments: [] })));
        await wait(10); // Direct save-cost stress, separate from real workspace streaming below.
      }
      await wait(1100); // Include trailing persistence.
      const historyKey = client.cacheKey('history:synthetic');
      result.history.push({ turns: size, updates: 120, deltaChars: 3840, finalStoredChars: localStorage.getItem(historyKey)?.length ?? 0,
        writes: writes.length, failures, writtenChars: writes.reduce((a, w) => a + w.chars, 0),
        stringify: stats(stringifyTimes), clientSave: stats(updateTimes), setItem: writes.length ? stats(writes.map((w) => w.ms)) : null,
        persistedFinalDelta: client.cache('history:synthetic', null)?.turns?.at(-1)?.items[0]?.text.endsWith('x'.repeat(3840)) ?? false });
      flushSync(() => root.unmount()); root = createRoot(mount);
    }
    localStorage.clear(); writes = []; failures = 0;
    for (let i = 0; i < 3; i++) client.save(`history:quota-${i}`, { turns: fixtureHistory(400), attachments: [] });
    result.quota = { attemptedHistories: 3, storedHistories: localStorage.length, failures,
      attemptedChars: writes.reduce((a, w) => a + w.chars, 0) };
    localStorage.clear(); client.save('history:synthetic', { marker: 'owner-a' });
    client.owner = 'synthetic-owner-b';
    result.ownerScope = { ownerBCanReadA: client.cache('history:synthetic', null) !== null };
    client.save('history:synthetic', { marker: 'owner-b' });
    result.ownerScope.beforeClear = localStorage.length;
    client.clearOwnerCache(); result.ownerScope.afterClear = localStorage.length;
  } finally { Storage.prototype.setItem = nativeSet; localStorage.clear(); }

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
    const samples = { mount: [], stableParent: [], changedClock: [], oneDraft: [], layout: [] }, renders = {};
    for (let i = 0; i < (todos.length > 1000 ? 1 : 3); i++) {
      window.baselineRowRenders = 0;
      samples.mount.push(timed(() => flushSync(() => root.render(draw(now))))); renders.mount = window.baselineRowRenders;
      samples.layout.push(timed(() => { void mount.offsetHeight; }));
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

async function waitFor(predicate, label, timeout = 25_000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { if (predicate()) return; await wait(16); }
  throw new Error(`Chat scenario timed out: ${label}`);
}
const paint = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
function botFixture(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `synthetic-bot-${i}`, name: `Synthetic bot ${i}`, purpose: 'Synthetic purpose', slug: `synthetic-${i}`,
    cwd: '/synthetic', threadId: `thread-${i}`, color: '#276b58', status: 'idle', archived: false, model: null, effort: null, mode: 'default', preview: 'Synthetic preview',
    updatedAt: '2026-09-26T12:00:00Z', lastReadAt: '2026-09-26T12:00:00Z', activeTurnId: null }));
}
function chatTurns(botId, count, messages = 1, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: `chat-turn-${i + offset}`, status: 'completed', itemsView: 'full', error: null,
    startedAt: 1, completedAt: 2, durationMs: 1,
    items: Array.from({ length: messages }, (_, j) => ({ id: `chat-item-${i + offset}-${j}`, type: 'agentMessage', phase: 'final_answer',
      text: `**${botId} turn ${i + offset} message ${j}**\n\n` + 'Synthetic message text with **emphasis**, `code`, and [local example](#example). '.repeat(16)
        + (i === count - 1 && j === messages - 1 ? `\n\n${botId}:latest` : '') })) }));
}
const snapshotFor = (n) => ({ bots: botFixture(n), pending: [], cursor: 0, ready: true, account: { authenticated: true },
  defaults: { model: 'synthetic-model', effort: 'medium', serviceTier: 'default' }, models: [], schedules: [], runs: [] });
const scrollState = () => { const el = document.querySelector('.bots-messages'); return el ? {
  top: el.scrollTop, height: el.scrollHeight, viewport: el.clientHeight, bottomGap: el.scrollHeight - el.clientHeight - el.scrollTop,
} : null; };
window.runChatBaseline = async () => {
  const client = botsClient;
  // Synthetic boundary: all actual workspace hooks, reducers, markdown and cache calls run.
  client.start = noop; client.owner = 'synthetic-chat-owner'; client.timeZone = 'UTC';
  let downloads = 0;
  client.download = async () => { downloads++; return { blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>'], { type: 'image/svg+xml' }), name: 'synthetic.svg', mimeType: 'image/svg+xml' }; };
  const container = document.createElement('div'); document.body.append(container);
  let root = createRoot(container); const result = { navigation: [], botList: [] };
  const nativeSet = Storage.prototype.setItem; let storageWrites = [];
  Storage.prototype.setItem = function (key, value) { storageWrites.push({ key, chars: value.length }); return nativeSet.call(this, key, value); };
  const storageSince = (start) => ({ writes: storageWrites.length - start, chars: storageWrites.slice(start).reduce((n, w) => n + w.chars, 0) });
  const reset = () => { flushSync(() => root.unmount()); root = createRoot(container); history.replaceState({}, '', '/harness'); localStorage.clear(); };
  const select = (id) => { history.pushState({}, '', id ? `/harness?bot=${id}` : '/harness'); window.dispatchEvent(new PopStateEvent('popstate')); };
  try {
    for (const botCount of [20, 200, 1000]) {
      reset(); client.online = false; client.snapshot = snapshotFor(botCount); window.baselineMessageRenders = 0;
      const start = performance.now(); flushSync(() => root.render(<BotsWorkspace />)); await paint();
      const mountMs = performance.now() - start;
      const redrawMs = timed(() => flushSync(() => client.notify()));
      result.botList.push({ bots: botCount, renderedRows: document.querySelectorAll('.bots-row').length, mountToPaintMs: mountMs, unrelatedRedrawMs: redrawMs });
    }
    for (const [name, options] of [
      ['small-20-turns', { messages: 1, cachedTurns: 0, rtt: 195, bytesPerSecond: Infinity }],
      ['dense-20-turns-weak-link', { messages: 20, cachedTurns: 0, rtt: 600, bytesPerSecond: 128 * 1024 }],
      ['accumulated-400-turn-cache', { messages: 1, cachedTurns: 400, rtt: 600, bytesPerSecond: 128 * 1024 }],
      ['one-turn-80-tools', { messages: 1, tools: 80, cachedTurns: 0, rtt: 195, bytesPerSecond: Infinity }],
    ]) {
      reset(); client.online = true; client.snapshot = snapshotFor(20);
      const a = client.snapshot.bots[0].id, b = client.snapshot.bots[1].id;
      if (options.cachedTurns) client.save(`history:${a}`, { turns: chatTurns(a, options.cachedTurns), attachments: [] });
      const calls = []; let pending = 0, maxPending = 0;
      client.rpc = async (method, botId) => {
        const body = method === 'history' ? { thread: { id: 'synthetic-thread', turns: chatTurns(botId, 20, options.messages) }, attachments: [], pending: [], nextCursor: 'synthetic-older-page' }
          : method === 'history.page' ? { data: chatTurns(botId, 20, 1, -20).reverse(), nextCursor: null } : [];
        if (method === 'history' && options.tools) {
          const turn = body.thread.turns.at(-1);
          const tools = Array.from({ length: options.tools }, (_, i) => ({ type: 'commandExecution', id: `tool-${i}`, command: 'synthetic command', cwd: '/synthetic', status: 'completed',
            commandActions: [], aggregatedOutput: 'Synthetic tool output.\n'.repeat(1490), exitCode: 0, durationMs: 10 }));
          turn.items.unshift(...tools);
          const scheduled = body.thread.turns[0];
          scheduled.items.unshift({ type: 'userMessage', id: 'scheduled-input', clientId: 'schedule:synthetic', content: [{ type: 'text', text: 'Synthetic scheduled run' }] });
          for (let i = 0; i < 3; i++) {
            body.attachments.push({ id: `synthetic-image-${i}`, botId, name: 'synthetic.svg', mimeType: 'image/svg+xml', size: 80, ready: true, path: `/synthetic/image-${i}.svg` });
            scheduled.items[0].content.push({ type: 'localImage', path: `/synthetic/image-${i}.svg` });
          }
        }
        const serialized = JSON.stringify(body), bytes = new TextEncoder().encode(serialized).length;
        const record = { method, botId, bytes, requestedAt: performance.now(), resolvedAt: null }; calls.push(record);
        pending++; maxPending = Math.max(maxPending, pending);
        await wait(options.rtt + (Number.isFinite(options.bytesPerSecond) ? bytes / options.bytesPerSecond * 1000 : 0));
        pending--; record.resolvedAt = performance.now(); return JSON.parse(serialized);
      };
      flushSync(() => root.render(<BotsWorkspace />)); await paint();
      const open = async (id, offline = false) => {
        const before = calls.length, downloadsBefore = downloads, storageStart = storageWrites.length, start = performance.now(); window.baselineMessageRenders = 0;
        select(id);
        await waitFor(() => document.querySelector('.bots-messages')?.textContent.includes(`${id}:latest`), 'latest message available');
        await paint(); const firstMs = performance.now() - start, firstRows = document.querySelectorAll('.bots-turn').length;
        const firstScroll = scrollState();
        if (!offline) await waitFor(() => calls.slice(before).some((c) => c.method === 'history' && c.resolvedAt), 'history RPC completion');
        await waitFor(() => !document.querySelector('.bots-messages')?.textContent.includes('Loading conversation…'), 'loading finish');
        await paint();
        return { firstLatestPaintMs: firstMs, settledMs: performance.now() - start, firstRows, settledRows: document.querySelectorAll('.bots-turn').length,
          messageRenders: window.baselineMessageRenders, firstScroll, settledScroll: scrollState(),
          historyRequests: calls.slice(before).filter((c) => c.method === 'history').length,
          storage: storageSince(storageStart),
          closedToolPreNodes: document.querySelectorAll('details.bots-activity:not([open]) pre').length,
          closedScheduledMessages: document.querySelectorAll('details.is-scheduled:not([open]) .bots-message').length,
          attachmentDownloads: downloads - downloadsBefore,
          historyBytes: calls.slice(before).filter((c) => c.method === 'history').reduce((n, c) => n + c.bytes, 0) };
      };
      const first = await open(a); const other = await open(b); const repeat = await open(a);
      const scroll = document.querySelector('.bots-messages'); scroll.scrollTop = Math.floor(scroll.scrollHeight / 3); scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      const beforeStream = scrollState(), streamStorage = storageWrites.length; window.baselineMessageRenders = 0;
      const stream = [];
      for (let i = 0; i < 10; i++) {
        const event = { seq: i + 1, type: 'codex', botId: a, data: { method: 'item/agentMessage/delta',
          params: { turnId: 'chat-turn-19', itemId: `chat-item-19-${options.messages - 1}`, delta: ` synthetic-delta-${i}` } } };
        stream.push(timed(() => flushSync(() => client.receive({ type: 'event', event }))));
        await wait(50);
      }
      await wait(1100);
      const streaming = { events: 10, cost: stats(stream), storage: storageSince(streamStorage), messageRenders: window.baselineMessageRenders, before: beforeStream, after: scrollState(),
        latestDeltaVisible: document.querySelector('.bots-messages').textContent.includes('synthetic-delta-9') };
      const anchor = document.querySelectorAll('.bots-turn')[5]; const anchorBefore = anchor.getBoundingClientRect().top;
      const oldCount = document.querySelectorAll('.bots-turn').length;
      document.querySelector('.bots-older').click();
      await waitFor(() => document.querySelectorAll('.bots-turn').length > oldCount, 'older page'); await paint();
      const pagination = { rowsBefore: oldCount, rowsAfter: document.querySelectorAll('.bots-turn').length,
        anchorShiftPx: anchor.getBoundingClientRect().top - anchorBefore, scroll: scrollState() };
      // An older-history scroll position is followed by navigation away/back.
      scroll.scrollTop = Math.floor(scroll.scrollHeight / 3); scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
      const beforeAway = scrollState(); await open(b);
      const returnToA = await open(a);
      client.online = false; client.notify(); await paint(); select(b); await paint();
      const offline = await open(a, true);
      const beforeReconnect = calls.filter((c) => c.method === 'history').length;
      client.online = true; client.notify(); await waitFor(() => calls.filter((c) => c.method === 'history').length > beforeReconnect, 'reconnect history');
      await waitFor(() => pending === 0, 'all requests settled'); await paint();
      result.navigation.push({ name, configured: { ...options, bytesPerSecond: Number.isFinite(options.bytesPerSecond) ? options.bytesPerSecond : null },
        first, other, repeat, streaming, pagination, positionRestoration: { beforeAway, afterReturn: returnToA.settledScroll }, offline,
        reconnectHistoryRequests: calls.filter((c) => c.method === 'history').length - beforeReconnect, maxPendingRPCs: maxPending,
        historyRequestsTotal: calls.filter((c) => c.method === 'history').length,
        historyBytesTotal: calls.filter((c) => c.method === 'history').reduce((n, c) => n + c.bytes, 0) });
    }
    reset(); client.online = true; client.snapshot = snapshotFor(3);
    const waiting = [];
    client.rpc = (method, botId) => method === 'history' ? new Promise((resolve) => waiting.push({ botId, resolve })) : Promise.resolve([]);
    flushSync(() => root.render(<BotsWorkspace />)); await paint();
    select('synthetic-bot-0'); await wait(100); select('synthetic-bot-1'); await wait(100); select('synthetic-bot-0'); await wait(100);
    const aRequests = waiting.filter((w) => w.botId === 'synthetic-bot-0');
    const reply = (label) => ({ thread: { id: 'synthetic-thread', turns: [{ ...chatTurns('synthetic-bot-0', 1)[0], items: [{ id: 'race-item', type: 'agentMessage', text: label, phase: 'final_answer' }] }] }, attachments: [], pending: [], nextCursor: null });
    aRequests.at(-1).resolve(reply('NEWER-RESPONSE')); await waitFor(() => container.textContent.includes('NEWER-RESPONSE'), 'newer race response');
    if (aRequests.length > 1) { aRequests[0].resolve(reply('OLDER-RESPONSE')); await wait(100); await paint(); }
    result.requestRace = { selectionSequence: 'A/B/A before responses', historyRequests: waiting.length, simultaneousARequests: aRequests.length,
      staleAOverwroteNewer: container.textContent.includes('OLDER-RESPONSE') };
    for (const w of waiting) w.resolve(reply('CLEANUP')); await wait(50);
  } finally { Storage.prototype.setItem = nativeSet; flushSync(() => root.unmount()); container.remove(); localStorage.clear(); history.replaceState({}, '', '/harness'); }
  return result;
};
