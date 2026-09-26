// Run from repository root: node tests/perf-baseline-7c578085.mjs [--no-browser]
// Synthetic data only. No application server, credentials, or user profile required.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { runtime } from './helpers/load-ts.mjs';

export const epoch = Date.parse('2026-09-26T12:00:00Z');
export const tasks = (count) => Array.from({ length: count }, (_, i) => ({
  id: i + 1, clientId: null, title: `Synthetic task ${i + 1}`, notes: 'Synthetic notes. '.repeat(16),
  status: i % 5 === 0 ? 'completed' : 'open', priority: i % 3 + 1,
  dueDate: null, project: i % 11 === 0 ? null : `Project ${i % 10}`, context: 'Synthetic',
  sourceKind: 'site', sourceId: null, completedAt: null,
  snoozedUntil: i % 17 === 0 ? '2026-10-01T00:00:00Z' : null,
  recurrenceCron: null, recurrenceLastFiredAt: null, pinned: i < 3,
  sortOrder: ((i * 7919) % count) * 1024, createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z', attachmentCount: 0,
}));
export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (n) => Math.round(n * 1000) / 1000;
  return { n: values.length, medianMs: round(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * .95) - 1)]),
    totalMs: round(values.reduce((a, b) => a + b, 0)) };
}

class Clock {
  now = 0; next = 0; queue = new Map(); fired = []; maxAppTimers = 0;
  set = (fn, delay = 0, fixture = false) => {
    const id = ++this.next;
    this.queue.set(id, { fn, at: this.now + delay, delay, fixture });
    this.maxAppTimers = Math.max(this.maxAppTimers, this.appTimers());
    return id;
  };
  clear = (id) => this.queue.delete(id);
  appTimers = () => [...this.queue.values()].filter((x) => !x.fixture).length;
  async drain() { for (let i = 0; i < 160; i++) await Promise.resolve(); }
  async to(end) {
    await this.drain();
    for (;;) {
      const next = [...this.queue].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      const [id, t] = next; this.now = t.at; this.queue.delete(id);
      if (!t.fixture) this.fired.push({ at: this.now, delay: t.delay });
      t.fn(); await this.drain();
      assert.ok(this.fired.length < 20_000, 'runaway timer');
    }
    this.now = end; await this.drain();
  }
}

async function syncScenario(name, { healthy = true, active = false, blocked = false, lifecycle = false, loss = false, burst = false, restart = false } = {}) {
  const clock = new Clock();
  class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [epoch + clock.now])); } static now() { return epoch + clock.now; } }
  const window = Object.assign(new EventTarget(), { setTimeout: clock.set, clearTimeout: clock.clear });
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const navigator = { onLine: true };
  const counts = {}; const requests = []; const finished = []; const streams = []; const lifecycleSamples = [];
  let signalHealthy = healthy, subscription, revision = 1, concurrent = 0, maxConcurrent = 0, uploads = 0, revisionReads = 0;
  const cache = { todos: tasks(289), projects: Array.from({ length: 10 }, (_, i) => `Project ${i}`), revision };
  const counted = (key, value) => async () => { counts[key] = (counts[key] ?? 0) + 1; return typeof value === 'function' ? value() : value; };
  const db = {
    loadCachedServerState: counted('cacheLoads', cache),
    listOfflineTodos: counted('createScans', []), listOfflineTodoMutations: counted('editScans', []),
    listOfflineTaskActions: counted('actionScans', []),
    listQueuedAttachments: counted('uploadScans', blocked ? [{ todoId: 1, localId: 'synthetic-upload', nextAttemptAt: Infinity, attempts: 1 }] : []),
    commitRemoteTasks: counted('commits', () => { cache.revision = revision; }),
  };
  const worker = runtime({ Date: TestDate, setTimeout: (fn, ms) => clock.set(fn, ms, true), clearTimeout: clock.clear }).load('worker/sync-events.ts');
  class Stream extends EventTarget {
    constructor() { super(); this.closed = false; streams.push(this); this.handshake = clock.set(() => void this.open(), 195, true); }
    async open() {
      if (this.closed) return;
      if (!signalHealthy) { this.onerror?.(); return; }
      this.reader = worker.revisionEventStream({ after: cache.revision, signal: new AbortController().signal,
        readRevision: async () => { revisionReads++; return revision; } }).getReader();
      while (!this.closed) {
        const { value, done } = await this.reader.read(); if (done || this.closed) return;
        const text = new TextDecoder().decode(value);
        const event = new Event(text.match(/event: (\w+)/)[1]); event.data = text.match(/data: (.+)/)[1];
        this.dispatchEvent(event);
      }
    }
    close() { this.closed = true; clock.clear(this.handshake); void this.reader?.cancel(); }
  }
  const request = async (path, options) => {
    requests.push({ at: clock.now, path, hidden: document.visibilityState === 'hidden', offline: !navigator.onLine });
    concurrent++; maxConcurrent = Math.max(concurrent, maxConcurrent);
    try {
      await new Promise((resolve, reject) => {
        const id = clock.set(resolve, 195, true);
        options.signal?.addEventListener('abort', () => { clock.clear(id); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
      if (active) revision++;
      return path === '/api/bootstrap'
        ? { ...cache, revision, captureDraft: null, settings: {} }
        : { reset: false, todos: active ? [{ ...cache.todos[0], title: `Synthetic update ${revision}` }] : [], deletedIds: [], revision };
    } finally { concurrent--; }
  };
  const env = runtime({ window, document, navigator, Date: TestDate, setTimeout: clock.set, clearTimeout: clock.clear,
    ...(healthy || loss ? { EventSource: Stream } : {}) }, {
    './offline-store': db,
    './offline-events': { subscribeOfflineChanges: (fn) => { subscription = fn; return () => { subscription = undefined; }; } },
    './sync-request': { request, retryableSyncError: () => true, syncRetryDelay: () => 3000 },
    './attachment-upload-client': { uploadTaskAttachmentMultipart: async () => { uploads++; } },
    './sync-diagnostics': { recordSyncDiagnostic: (event, data) => { if (event === 'sync-finished') finished.push({ at: clock.now, ...data }); } },
  });
  const engine = env.load('app/task-sync.ts').createTaskSyncEngine();
  engine.start(); engine.start(); // Duplicate start must be idempotent.
  if (active && healthy) for (let at = 5000; at < 300_000; at += 5000) clock.set(() => {
    const stream = streams.findLast((x) => !x.closed);
    if (stream) { const event = new Event('revision'); event.data = String(revision + 1); stream.dispatchEvent(event); }
  }, at, true);
  if (loss) clock.set(() => { signalHealthy = false; streams.findLast((x) => !x.closed)?.onerror?.(); }, 60_000, true);
  const storm = () => { for (let i = 0; i < 20; i++) {
    window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  } };
  if (burst) { clock.set(storm, 60_000, true); clock.set(storm, 60_100, true); }
  if (lifecycle) {
    clock.set(() => { document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }, 60_000, true);
    clock.set(() => { navigator.onLine = false; window.dispatchEvent(new Event('offline')); }, 120_000, true);
    clock.set(() => { navigator.onLine = true; window.dispatchEvent(new Event('online')); }, 180_000, true);
    clock.set(() => { lifecycleSamples.push({ at: clock.now, appTimers: clock.appTimers() }); document.visibilityState = 'visible'; storm(); }, 240_000, true);
  }
  if (restart) { clock.set(() => engine.stop(), 60_000, true); clock.set(() => engine.start(), 120_000, true); }
  await clock.to(300_000);
  const beforeStop = clock.appTimers(); engine.stop(); await clock.to(301_000);
  const result = { name, durationSeconds: 300, requests: requests.length, bootstrap: requests.filter((x) => x.path === '/api/bootstrap').length,
    syncFinished: finished.length, streamsOpened: streams.length, syntheticWorkerRevisionReads: revisionReads, maxConcurrentRequests: maxConcurrent,
    appTimersFired: clock.fired.length, twoSecondTimers: clock.fired.filter((x) => x.delay === 2000).length,
    maxAppTimers: clock.maxAppTimers, timersBeforeStop: beforeStop, timersAfterStop: clock.appTimers(),
    hiddenRequests: requests.filter((x) => x.hidden).length, offlineRequests: requests.filter((x) => x.offline).length,
    burstWindowRequests: requests.filter((x) => x.at >= 60_000 && x.at < 61_000).length,
    resumeWindowRequests: requests.filter((x) => x.at >= 240_000 && x.at < 241_000).length,
    uploads, ...counts, lifecycleSamples, requestTimesMs: requests.map((x) => x.at) };
  assert.equal(result.hiddenRequests, 0); assert.equal(result.offlineRequests, 0);
  assert.equal(result.maxConcurrentRequests, 1); assert.equal(result.timersAfterStop, 0);
  assert.equal(subscription, undefined); assert.equal(result.uploads, 0);
  return result;
}

async function cacheCosts() {
  const results = [];
  for (const count of [289, 2890]) {
    let stringifies = 0, chars = 0;
    const instrumentedJSON = { ...JSON, stringify: (...args) => { const result = JSON.stringify(...args); stringifies++; chars += result?.length ?? 0; return result; }, parse: JSON.parse };
    const env = runtime({ JSON: instrumentedJSON });
    const db = env.load('app/offline-store.ts');
    await db.saveCachedServerState(tasks(count), [], 1);
    const database = await db.openDatabase();
    const transaction = database.transaction.bind(database); const idb = {};
    database.transaction = (...args) => {
      const tx = transaction(...args), objectStore = tx.objectStore.bind(tx), wrapped = new WeakSet();
      tx.objectStore = (name) => {
        const store = objectStore(name);
        if (wrapped.has(store)) return store;
        wrapped.add(store);
        for (const method of ['getAll', 'put']) {
          const original = store[method].bind(store);
          store[method] = (...args) => { const key = `${name}.${method}`; idb[key] = (idb[key] ?? 0) + 1; return original(...args); };
        }
        return store;
      };
      return tx;
    };
    for (let i = 0; i < 5; i++) await db.commitRemoteTasks({ todos: [], deletedIds: [], revision: 1 });
    stringifies = 0; chars = 0; for (const key of Object.keys(idb)) delete idb[key];
    const times = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); await db.commitRemoteTasks({ todos: [], deletedIds: [], revision: 1 }); times.push(performance.now() - start); }
    const store = env.load('app/task-store.ts').createTaskStore(); const fixture = tasks(count); store.setAll(fixture);
    let lists = 0, rows = 0; store.subscribe(() => lists++);
    for (const todo of fixture) store.subscribeRow(`server:${todo.id}`, () => rows++);
    const setAllTimes = [];
    for (let i = 0; i < 30; i++) { const start = performance.now(); store.setAll(fixture.map((t) => ({ ...t }))); setAllTimes.push(performance.now() - start); }
    const unchangedNotifications = { lists, rows };
    for (let i = 0; i < 50; i++) store.setDraft('server:1', { title: `Synthetic typing ${i}` });
    assert.deepEqual(unchangedNotifications, { lists: 0, rows: 0 });
    assert.deepEqual({ lists, rows }, { lists: 0, rows: 50 });
    results.push({ tasks: count, emptyDeltaCommit: stats(times), stringifyCallsPerCommit: stringifies / 30,
      stringifyCharsPerCommit: chars / 30, idbPer30Commits: idb,
      unchangedSetAll: stats(setAllTimes), unchangedNotifications, draft50Notifications: { lists, rows } });
    database.close();
  }
  return results;
}

if (process.argv[1]?.endsWith('perf-baseline-7c578085.mjs')) {
  const report = { base: '24bf96976393d37b3ffea6c5be94fb43ce797af3', testedCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    environment: { node: process.version, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model }, sync: [] };
  for (const [name, options] of [
    ['healthy-idle', {}], ['healthy-revisions-every-5s', { active: true }],
    ['no-realtime-idle', { healthy: false }], ['no-realtime-active-deltas', { healthy: false, active: true }],
    ['realtime-lost-at-60s', { loss: true }], ['lifecycle-storm', { burst: true }],
    ['hidden-offline-resume', { lifecycle: true }], ['blocked-upload', { blocked: true }],
    ['blocked-upload-hidden', { blocked: true, lifecycle: true }], ['stop-restart', { restart: true }],
  ]) report.sync.push(await syncScenario(name, options));
  report.cache = await cacheCosts();
  if (!process.argv.includes('--no-browser')) {
    const { browserBaseline } = await import('./perf-browser-7c578085.mjs');
    report.browser = await browserBaseline({ tasks, epoch });
  }
  console.log(JSON.stringify(report, null, 2));
}
