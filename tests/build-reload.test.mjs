import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './helpers/load-ts.mjs';

// Client build-change handling (app/build-reload.ts): a page on an old build
// reloads by itself at a safe moment, only through the draft-saving refresh
// guards, and at most once per target build per session.
const OLD = 'aaaaaaaaaaaa', NEW = 'bbbbbbbbbbbb';
const lifecycle = (patch = {}) => ({ build: OLD, expectedDatabaseVersion: 11, databaseVersion: 11, upgradedFrom: null, storage: 'ready', workerCache: null,
  workerDatabaseVersion: null, workerBuild: null, publishedBuild: null, publishedCheck: 'unknown', ...patch });
const tick = () => new Promise(r => setImmediate(r));

function harness({ state = lifecycle(), prepare, visibility = 'visible', session = new Map() } = {}) {
  const env = runtime();
  const { startBuildReload, staleBuild, isChunkLoadError, RELOAD_GUARD_MS } = env.load('app/build-reload.ts');
  let clock = 1_000_000, current = state;
  const timers = new Set(), listeners = new Set(), log = [];
  const h = {
    env, staleBuild, isChunkLoadError, RELOAD_GUARD_MS, log, reloads: 0, prepares: 0, inspects: 0, session,
    document: Object.assign(new EventTarget(), { visibilityState: visibility, activeElement: null }),
    window: new EventTarget(),
    set(patch) { current = { ...current, ...patch }; listeners.forEach(l => l()); },
    async advance(ms) {
      const until = clock + ms;
      for (;;) {
        const next = [...timers].filter(t => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        clock = next.at; timers.delete(next); next.fn(); await tick(); await tick();
      }
      clock = until; await tick(); await tick();
    },
    type() { h.window.dispatchEvent(new Event('keydown')); },
  };
  h.controller = startBuildReload({
    getLifecycle: () => current, subscribe: l => { listeners.add(l); return () => listeners.delete(l); },
    prepare: async () => { h.prepares++; await (prepare?.(h)); }, reload: () => { h.reloads++; },
    inspect: async () => { h.inspects++; }, window: h.window, document: h.document,
    session: { getItem: k => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    now: () => clock, setTimer: (fn, ms) => { const t = { at: clock + ms, fn }; timers.add(t); return t; }, clearTimer: t => timers.delete(t),
    idleMs: 60_000, retryMs: 30_000, pollMs: 300_000, log: (message, detail) => log.push({ message, ...detail }),
  });
  return h;
}

test('staleBuild: only a different, valid published or worker build on usable storage', () => {
  const { staleBuild } = harness();
  assert.equal(staleBuild(lifecycle()), null);
  assert.equal(staleBuild(lifecycle({ publishedBuild: OLD })), null);
  assert.equal(staleBuild(lifecycle({ publishedBuild: NEW })), NEW);
  assert.equal(staleBuild(lifecycle({ workerBuild: NEW })), NEW, 'the worker saw a newer build');
  assert.equal(staleBuild(lifecycle({ publishedBuild: OLD, workerBuild: NEW })), null, 'published wins over a stale worker');
  assert.equal(staleBuild(lifecycle({ build: 'development', publishedBuild: NEW })), null, 'development documents never auto-reload');
  assert.equal(staleBuild(lifecycle({ publishedBuild: NEW, storage: 'blocked' })), null, 'blocked storage keeps its own notice');
  assert.equal(staleBuild(lifecycle({ publishedBuild: NEW, storage: 'opening' })), NEW);
});

test('isChunkLoadError recognises the browsers\' missing-code errors only', () => {
  const { isChunkLoadError } = harness();
  assert.ok(isChunkLoadError(Object.assign(Error('Loading chunk 812 failed.'), { name: 'ChunkLoadError' })));
  assert.ok(isChunkLoadError(TypeError('Failed to fetch dynamically imported module: https://work.example/_next/static/chunks/a.js')));
  assert.ok(isChunkLoadError(TypeError('Importing a module script failed.')));
  assert.ok(isChunkLoadError(Error('Loading CSS chunk app-shell failed')));
  assert.ok(!isChunkLoadError(TypeError('Cannot read properties of undefined (reading \'id\')')));
  assert.ok(!isChunkLoadError(null));
});

test('a visible, active page waits until the person is idle, then reloads once through the refresh guards', async () => {
  const h = harness();
  await h.advance(30_000); h.type();
  h.set({ publishedBuild: NEW });
  await h.advance(59_000);
  assert.equal(h.reloads, 0, 'not while the person is active');
  await h.advance(2_000);
  assert.deepEqual([h.prepares, h.reloads], [1, 1]);
  assert.equal(JSON.parse(h.session.get('dawar-build-reload')).target, NEW);
  assert.deepEqual(h.log.at(-1), { message: 'reloading for a new build', from: OLD, to: NEW, urgent: false });
});

test('a hidden tab reloads as soon as the new build is known', async () => {
  const h = harness({ visibility: 'hidden' });
  h.type();
  h.set({ publishedBuild: NEW });
  await h.advance(0);
  assert.equal(h.reloads, 1);
});

test('switching away from the tab is a safe moment', async () => {
  const h = harness();
  h.type(); h.set({ publishedBuild: NEW });
  await h.advance(1_000);
  assert.equal(h.reloads, 0);
  h.document.visibilityState = 'hidden'; h.document.dispatchEvent(new Event('visibilitychange'));
  await h.advance(0);
  assert.equal(h.reloads, 1);
});

test('a focused editor keeps the old page even when idle', async () => {
  const h = harness();
  h.document.activeElement = { tagName: 'TEXTAREA' };
  h.set({ publishedBuild: NEW });
  await h.advance(10 * 60_000);
  assert.equal(h.reloads, 0);
  h.document.activeElement = { tagName: 'BUTTON' };
  await h.advance(60_000);
  assert.equal(h.reloads, 1);
});

test('an unsafe guard (unsaved draft, live call) defers and retries; nothing reloads meanwhile', async () => {
  let unsafe = true;
  const h = harness({ visibility: 'hidden', prepare: async () => { if (unsafe) throw Error('Composer draft is still saving.'); } });
  h.set({ publishedBuild: NEW });
  await h.advance(0);
  assert.deepEqual([h.prepares, h.reloads], [1, 0]);
  assert.match(h.log.at(-1).reason, /still saving/);
  await h.advance(29_000); assert.equal(h.prepares, 1);
  unsafe = false;
  await h.advance(1_000);
  assert.deepEqual([h.prepares, h.reloads], [2, 1]);
});

test('typing that resumes while the new build is fetched keeps the page', async () => {
  const h = harness({ prepare: async h => { h.type(); } });
  h.set({ publishedBuild: NEW });
  await h.advance(60_000);
  assert.deepEqual([h.prepares, h.reloads], [1, 0]);
});

test('at most one automatic reload per target build: a page still old after it keeps the banner path', async () => {
  const session = new Map([['dawar-build-reload', JSON.stringify({ target: NEW, at: 1_000_000 - 60_000 })]]);
  const h = harness({ visibility: 'hidden', session });
  h.set({ publishedBuild: NEW });
  await h.advance(5 * 60_000);
  assert.equal(h.reloads, 0, 'the server kept serving the old document; no reload loop');
  h.set({ publishedBuild: 'cccccccccccc' });
  await h.advance(0);
  assert.equal(h.reloads, 1, 'a different newer build may reload again');
});

test('a chunk-load failure reloads immediately, even while the person is active', async () => {
  const h = harness();
  h.type();
  const event = Object.assign(new Event('unhandledrejection'), { reason: TypeError('Failed to fetch dynamically imported module: /_next/static/chunks/x.js') });
  h.window.dispatchEvent(event);
  await h.advance(0);
  assert.ok(h.inspects >= 1, 're-reads the published build first');
  assert.deepEqual([h.prepares, h.reloads], [1, 1]);
  assert.equal(JSON.parse(h.session.get('dawar-build-reload')).target, `missing:${OLD}`);
  assert.equal(h.log.at(-1).urgent, true);
});

test('a screen crash reloads only when the build is stale', async () => {
  const h = harness();
  h.type();
  h.controller.failure(TypeError('x is undefined'));
  await h.advance(0);
  assert.equal(h.reloads, 0, 'a crash on the current build is a bug, not a version mismatch');
  h.set({ publishedBuild: NEW });
  h.type();
  h.controller.failure(TypeError('x is undefined'));
  await h.advance(0);
  assert.equal(h.reloads, 1);
});

test('a visible tab left open re-checks the published build periodically', async () => {
  const h = harness();
  const before = h.inspects;
  await h.advance(300_000);
  assert.equal(h.inspects, before + 1);
  h.document.visibilityState = 'hidden';
  await h.advance(300_000);
  assert.equal(h.inspects, before + 1, 'hidden tabs do not poll');
  h.controller.stop();
  h.set({ publishedBuild: NEW }); h.document.visibilityState = 'hidden';
  await h.advance(600_000);
  assert.equal(h.reloads, 0, 'stopped');
});

test('end to end with preparePwaRefresh: drafts are flushed before the reload, and a dirty draft blocks it', async () => {
  const env = runtime({ MessageChannel, location: { href: 'https://work.example/bots' } });
  const posted = [];
  env.navigator.serviceWorker = { controller: { postMessage(message, [port]) { posted.push(message.type); port.postMessage({ ok: true }); } } };
  const lifecycleModule = env.load('app/pwa-lifecycle.ts');
  const { preparePwaRefresh, registerPwaUpdateGuard } = env.load('app/pwa-update.ts');
  const { startBuildReload } = env.load('app/build-reload.ts');
  const events = [];
  let dirty = true;
  env.window.addEventListener('dawar-before-navigation', () => events.push('before-navigation'));
  registerPwaUpdateGuard('bot-drafts', async () => { events.push('flush'); if (dirty) throw Error('A draft could not be saved.'); });
  const document = Object.assign(new EventTarget(), { visibilityState: 'hidden', activeElement: null });
  let reloads = 0;
  const controller = startBuildReload({ getLifecycle: lifecycleModule.getPwaLifecycle, subscribe: lifecycleModule.subscribePwaLifecycle, prepare: preparePwaRefresh,
    reload: () => { events.push('reload'); reloads++; }, inspect: async () => {}, window: new EventTarget(), document, session: null, retryMs: 20, log: () => {} });
  lifecycleModule.updatePwaLifecycle({ build: OLD, storage: 'ready', publishedBuild: NEW });
  await new Promise(r => setTimeout(r, 10));
  assert.equal(reloads, 0, 'a draft that cannot be saved blocks the reload');
  dirty = false;
  await new Promise(r => setTimeout(r, 60));
  controller.stop();
  assert.equal(reloads, 1);
  const last = events.lastIndexOf('reload');
  assert.deepEqual(events.slice(last - 3, last + 1), ['before-navigation', 'flush', 'flush', 'reload'], 'flushed before and after the new document was cached');
  assert.ok(posted.includes('PWA_REFRESH_DOCUMENT'), 'the worker cached the new document before the reload');
});
