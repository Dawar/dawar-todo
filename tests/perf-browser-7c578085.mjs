import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import ts from 'typescript';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(50); }
  throw new Error(`Timed out: ${label}`);
}
function nodes(source, predicate) {
  const out = []; const visit = (n) => { if (predicate(n)) out.push(n); ts.forEachChild(n, visit); }; visit(source); return out;
}
async function bundle() {
  return build({ entryPoints: ['tests/perf-browser-entry-7c578085.jsx'], bundle: true, write: false,
    outdir: 'outputs/perf-browser', format: 'iife', minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'baseline-read-only-instrumentation', setup(build) {
      build.onLoad({ filter: /app\/site-header\.tsx$/ }, () => ({ contents: 'export function SiteHeader(){return null}', loader: 'tsx' }));
      build.onLoad({ filter: /app\/page\.tsx$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const callbacks = ['filtered', 'counts'].map((name) => {
          const declarations = nodes(ast, (n) => ts.isVariableDeclaration(n) && n.name.getText(ast) === name && ts.isCallExpression(n.initializer) && n.initializer.expression.getText(ast) === 'useMemo');
          assert.equal(declarations.length, 1, `Task adapter needs review: ${name}`);
          return declarations[0].initializer.arguments[0].getText(ast);
        });
        const row = nodes(ast, (n) => ts.isFunctionExpression(n) && n.name?.text === 'TaskRow')[0];
        assert.ok(row, 'TaskRow instrumentation needs review');
        const at = row.body.getStart(ast) + 1;
        source = source.slice(0, at) + 'window.baselineRowRenders++;' + source.slice(at);
        source += `\nexport { TaskRow, SubscribedTaskRow };\n`;
        for (const [i, name] of ['baselineFilter', 'baselineCounts'].entries())
          source += `export function ${name}({todos,now,view,deferredQuery,project,priority,inlineEditingId}) { return (${callbacks[i]})(); }\n`;
        return { contents: source, loader: 'tsx', resolveDir: dirname(path) };
      });
      build.onLoad({ filter: /app\/bots\/message\.tsx$/ }, async ({ path }) => {
        let source = await readFile(path, 'utf8');
        const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const fn = nodes(ast, (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'BotMessage')[0];
        assert.ok(fn, 'BotMessage instrumentation needs review');
        const at = fn.body.getStart(ast) + 1;
        source = source.slice(0, at) + 'window.baselineMessageRenders = (window.baselineMessageRenders || 0) + 1;' + source.slice(at);
        return { contents: source, loader: 'tsx', resolveDir: dirname(path) };
      });
    } }], logLevel: 'silent' });
}

// Counters wrap native browser APIs; production SW handler/graph algorithm is unchanged.
const swCounters = `
self.__baseline = {puts:0,matches:0,textReads:0,textChars:0};
const baselineOpen=caches.open.bind(caches), baselineMatch=caches.match.bind(caches), baselineText=Response.prototype.text;
const wrappedCaches=new WeakSet();
caches.match=(...args)=>{self.__baseline.matches++;return baselineMatch(...args)};
caches.open=async (...args)=>{const c=await baselineOpen(...args);if(!wrappedCaches.has(c)){wrappedCaches.add(c);const p=c.put.bind(c);c.put=(...args)=>{self.__baseline.puts++;return p(...args)}}return c};
Response.prototype.text=async function(){const t=await baselineText.call(this);self.__baseline.textReads++;self.__baseline.textChars+=t.length;return t};
self.addEventListener('message',e=>{if(e.data==='baseline'){e.ports[0].postMessage({...self.__baseline,generation:self.__baselineGeneration})}if(e.data==='baseline-reset'){for(const k in self.__baseline)self.__baseline[k]=0;e.ports[0].postMessage(true)}});
`;

export async function browserBaseline({ tasks, epoch }) {
  const built = await bundle(), workerSource = await readFile('public/sw.js', 'utf8');
  const js = built.outputFiles.find((f) => f.path.endsWith('.js')).text;
  const css = built.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  let generation = 1, documentDelay = 0, unavailable = false;
  const network = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    network.push(path);
    if (unavailable) { req.socket.destroy(); return; }
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/harness') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><link rel="stylesheet" href="/harness.css"><script src="/harness.js"></script>'); }
    else if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
    else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{margin:0} ' + css); }
    else if (path === '/sw.js') {
      res.setHeader('Content-Type', 'application/javascript');
      // Synthetic deployment increments only the shell generation; identical production algorithm.
      const source = generation === 1 ? workerSource : workerSource.replace(/(const CACHE_NAME = `\$\{CACHE_PREFIX\}v)(\d+)/, (_, a, n) => a + (Number(n) + 1));
      res.end(swCounters + `self.__baselineGeneration=${generation};\n` + source);
    } else if (path.startsWith('/assets/')) {
      res.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : 'application/javascript');
      if (path.includes('entry')) res.end(`import './chunk-0-v${generation}.js'; import './style.css';`);
      else if (path.includes('style')) res.end('body{color:black}');
      else { const index = Number(path.match(/chunk-(\d+)/)?.[1]); res.end((index < 29 ? `import './chunk-${index + 1}.js';\n` : '') + '// synthetic asset\n'.repeat(256)); }
    } else if (['/', '/settings', '/talk', '/bots'].includes(path)) {
      await sleep(documentDelay); res.setHeader('Content-Type', 'text/html');
      // Discoverable graph, intentionally not executed by the document: isolates SW work.
      res.end(`<!doctype html><body>synthetic shell ${generation}<script type="application/json">{"entry":"/assets/entry-v${generation}.js"}</script></body>`);
    } else { res.end('synthetic static asset'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'dawar-perf-7c578085-'));
  let chrome, socket; const errors = [];
  try {
    chrome = spawn(process.env.PERF_CHROME ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; chrome.stderr.on('data', (d) => { stderr += d; }); chrome.on('error', (e) => { stderr += e.message; });
    const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'fresh Chrome startup');
    const address = new URL(debuggerUrl);
    const targets = await (await fetch(`http://${address.host}/json/list`)).json();
    const target = targets.find((t) => t.type === 'page');
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => socket.addEventListener('open', r, { once: true }));
    let seq = 0; const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); if (msg.error) p.reject(new Error(JSON.stringify(msg.error))); else p.resolve(msg.result); }
      else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text + ': ' + (msg.params.exceptionDetails.exception?.description ?? ''));
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: origin + '/harness' });
    await until(() => evaluate('typeof window.runBaseline === "function"'), 'bundle load');
    const result = await evaluate(`runBaseline(${JSON.stringify({ fixtures: [tasks(289), tasks(2890)], now: epoch })})`);
    console.error('Browser storage/task measurements complete; measuring workspace navigation.');
    await send('HeapProfiler.collectGarbage');
    result.chat = await evaluate('runChatBaseline()');
    console.error('Workspace measurements complete; measuring service worker.');
    await writeFile('outputs/perf-browser-measured-7c578085.json', JSON.stringify(result, null, 2));
    assert.ok(result.history.every((h) => h.persistedFinalDelta), 'latest stream delta must persist');
    assert.equal(result.ownerScope.ownerBCanReadA, false);
    const message = (command) => evaluate(`new Promise(resolve=>{const c=new MessageChannel();c.port1.onmessage=e=>resolve(e.data);navigator.serviceWorker.controller.postMessage(${JSON.stringify(command)},[c.port2])})`);
    const settle = async () => { let last = -1, stable = 0; await until(async () => { await sleep(50); const count = (await message('baseline')).puts; stable = count === last ? stable + 1 : 0; last = count; return stable >= 5; }, 'SW background settle'); };
    const summary = (paths) => ({ requests: paths.length, documents: paths.filter((p) => ['/', '/settings', '/talk', '/bots'].includes(p)).length,
      graphAssets: paths.filter((p) => p.startsWith('/assets/')).length, other: paths.filter((p) => !['/', '/settings', '/talk', '/bots'].includes(p) && !p.startsWith('/assets/')).length });
    let start = network.length;
    const installStart = performance.now();
    await evaluate('navigator.serviceWorker.register("/sw.js").then(()=>navigator.serviceWorker.ready).then(()=>true)');
    await until(() => evaluate('!!navigator.serviceWorker.controller'), 'SW claim'); await settle();
    result.serviceWorker = { graph: '32 immutable assets, 9 shell resources; synthetic update changes 2 assets',
      coldInstall: { ...summary(network.slice(start)), elapsedMs: Math.round(performance.now() - installStart), counters: await message('baseline') } };
    documentDelay = 195;
    for (const label of ['cachedNavigation', 'repeatNavigation']) {
      await message('baseline-reset'); start = network.length;
      await send('Page.navigate', { url: origin + '/' });
      await until(() => evaluate('document.readyState === "complete" && location.pathname === "/"'), 'cached navigation');
      const nav = await evaluate('(()=>{const n=performance.getEntriesByType("navigation")[0];return {responseStartMs:n.responseStart,domContentLoadedMs:n.domContentLoadedEventEnd}})()');
      await settle();
      result.serviceWorker[label] = { ...summary(network.slice(start)), ...nav, counters: await message('baseline') };
    }
    generation = 2; await message('baseline-reset'); start = network.length;
    await evaluate('navigator.serviceWorker.getRegistration().then(r=>r.update()).then(()=>true)');
    await until(async () => (await message('baseline')).generation === 2, 'updated controller'); await settle();
    result.serviceWorker.update = { ...summary(network.slice(start)), counters: await message('baseline'), cacheNames: await evaluate('caches.keys()') };
    start = network.length; unavailable = true;
    await send('Network.enable'); await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await send('Page.navigate', { url: origin + '/' });
    await until(() => evaluate('document.readyState === "complete" && document.body.textContent.includes("synthetic shell")'), 'offline cached shell');
    result.serviceWorker.offline = { serverAttempts: network.length - start, serverResponses: 0, shell: await evaluate('document.body.firstChild.textContent'),
      responseStartMs: await evaluate('performance.getEntriesByType("navigation")[0].responseStart') };
    assert.match(result.serviceWorker.offline.shell, /synthetic shell 2/);
    assert.equal(result.serviceWorker.update.cacheNames.filter((n) => n.startsWith('dawar-todo-shell-')).length, 2);
    assert.deepEqual(errors, [], 'unexpected browser exceptions');
    return result;
  } finally {
    socket?.close(); chrome?.kill('SIGTERM');
    if (chrome && chrome.exitCode === null) await Promise.race([new Promise((r) => chrome.once('exit', r)), sleep(3000)]);
    if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
    await new Promise((r) => server.close(r)); await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}
