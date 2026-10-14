import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const origin = 'https://synthetic.test';
const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function fixture() {
  const stored = new Map(), puts = [], fetched = []; let missing = false;
  const path = input => new URL(typeof input === 'string' ? input : input.url, origin).pathname;
  const cache = { match: async input => stored.get(path(input))?.clone(), put: async (input, response) => { puts.push(path(input)); stored.set(path(input), response.clone()); } };
  function worker() {
    const events = new Map();
    function RelativeRequest(input, init) { return new Request(new URL(typeof input === 'string' ? input : input.url, origin), init); }
    const context = { self: { location: { origin }, addEventListener: (event, fn) => events.set(event, fn), skipWaiting: async () => {} },
      caches: { open: async () => cache, match: cache.match }, Request: RelativeRequest, Response, URL, console: { info() {}, error() {}, warn() {} },
      fetch: async input => { const url = path(input); fetched.push(url);
        if (url === '/assets/a.js') return new Response(`import './b.js';`);
        if (url === '/assets/b.js') return new Response('leaf', { status: missing ? 503 : 200 });
        if (url === '/' || url === '/settings' || url === '/talk' || url === '/bots') return new Response('<script src="/assets/a.js"></script>');
        return new Response('static'); },
    };
    vm.createContext(context); vm.runInContext(source, context);
    return { walk: (strict) => { context.testCache = cache; return vm.runInContext(`cacheAssetGraph(testCache, ["/assets/a.js"], ${strict})`, context); }, install: () => { let work; events.get('install')({ waitUntil: p => work = p }); return work; },
      navigate: async () => { let response; const work = []; events.get('fetch')({ request: { url: origin + '/', method: 'GET', mode: 'navigate' }, respondWith: p => response = p, waitUntil: p => work.push(p) }); await response; await Promise.all(work); },
      version: () => { let result; events.get('message')({ data: { type: 'PWA_VERSION' }, ports: [{ postMessage: value => result = value }] }); return result; },
    };
  }
  return { worker, stored, puts, fetched, fail: value => missing = value };
}
test('completed immutable graph survives worker restart without re-putting/re-fetching descendants', async () => {
  const f = fixture(); await f.worker().install(); f.puts.length = f.fetched.length = 0;
  await f.worker().navigate();
  assert.equal(f.puts.filter(p => p.startsWith('/assets/')).length, 0);
  assert.equal(f.fetched.filter(p => p.startsWith('/assets/')).length, 0);
  assert.ok(f.stored.has('/assets/a.js') && f.stored.has('/assets/b.js'));
  assert.equal(f.worker().version().databaseVersion, 11);
});
test('failed partial graph is never marked complete; retry fetches missing child before caching document', async () => {
  const f = fixture(); f.fail(true);
  await assert.rejects(f.worker().install());
  assert.equal(f.stored.has('/.pwa-complete-asset-graph'), false);
  f.fail(false); f.fetched.length = 0;
  await f.worker().install();
  assert.ok(f.fetched.includes('/assets/b.js'));
  assert.ok(f.stored.has('/assets/b.js')); assert.ok(f.stored.has('/.pwa-complete-asset-graph'));
});

test('nonstrict warm partial walk leaves ancestors retryable across worker recreation and overlap', async () => {
  const f = fixture(); f.fail(true);
  await f.worker().walk(false);
  assert.equal(f.stored.has('/.pwa-complete-asset-graph'), false);
  f.fail(false); f.fetched.length = 0;
  const resumed = f.worker(); await Promise.all([resumed.walk(false), resumed.walk(true)]);
  assert.ok(f.fetched.includes('/assets/b.js'));
  const complete = await f.stored.get('/.pwa-complete-asset-graph').clone().json();
  assert.ok(complete.includes('/assets/a.js') && complete.includes('/assets/b.js'));
  f.fetched.length = 0; f.puts.length = 0; f.fail(true); // Descendants must now work from the offline graph.
  await f.worker().walk(true);
  assert.equal(f.fetched.length, 0); assert.equal(f.puts.length, 0);
});
