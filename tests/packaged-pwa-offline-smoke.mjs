// Actual packaged Vinext + production service worker on an isolated loopback Worker.
// Required: PWA_SMOKE_BUILT_COMMIT=<artifact source commit>, not current Git HEAD.
// See PACKAGED_PWA_OFFLINE_REVIEW.md. No production source or bindings are changed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const sourceRoot = resolve(process.env.PWA_SMOKE_SOURCE_ROOT ?? '/home/dawar/ChatGPT/dawar-todo');
const artifactRoot = resolve(process.env.PWA_SMOKE_ARTIFACT_ROOT ?? join(sourceRoot, 'dist'));
const upstream = new URL(process.env.PWA_SMOKE_UPSTREAM ?? 'http://127.0.0.1:37931');
assert.equal(upstream.hostname, '127.0.0.1', 'Only the manager-owned loopback preview is allowed');
assert.equal(upstream.protocol, 'http:');
const declaredCommit = process.env.PWA_SMOKE_BUILT_COMMIT ?? '';
assert.match(declaredCommit, /^[a-f0-9]{7,40}$/, 'Set PWA_SMOKE_BUILT_COMMIT to the source commit of the actual dist artifact');
const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8' }).trim();
const builtCommit = git('rev-parse', `${declaredCommit}^{commit}`);
const requireCaptureFiles = process.env.PWA_SMOKE_REQUIRE_CAPTURE_FILES === '1';
const output = resolve(process.env.PWA_SMOKE_OUTPUT ?? 'outputs/packaged-pwa-offline');
const digest = (value) => createHash('sha256').update(value instanceof ArrayBuffer ? new Uint8Array(value) : value).digest('hex');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn, label, seconds = 20) {
  for (let i = 0; i < seconds * 20; i++) { const result = await fn(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
async function fingerprint() {
  const files = [];
  async function walk(path) { for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) await walk(full); else if (entry.isFile()) files.push(full);
  } }
  await walk(join(artifactRoot, 'client')); await walk(join(artifactRoot, 'server'));
  const hash = createHash('sha256');
  for (const file of files.sort()) hash.update(relative(artifactRoot, file)).update('\0').update(await readFile(file)).update('\0');
  return { sha256: hash.digest('hex'), files: files.length };
}
const helperSources = new Map();
const helper = (await build({ entryPoints: ['tests/fixtures/packaged-pwa-storage.mjs'], bundle: true, write: false, format: 'iife', logLevel: 'silent',
  plugins: [{ name: 'exact-packaged-storage-source', setup(builder) {
    builder.onResolve({ filter: /^@packaged\// }, ({ path }) => ({ path: join(sourceRoot, 'app', path === '@packaged/offline-store' ? 'offline-store.ts' : `bots/${path.slice('@packaged/'.length)}.ts`) }));
    builder.onLoad({ filter: /\.[jt]sx?$/ }, ({ path }) => {
      const name = relative(sourceRoot, path);
      if (name.startsWith('..') || name.includes('node_modules')) return;
      const contents = execFileSync('git', ['show', `${builtCommit}:${name}`], { cwd: sourceRoot, encoding: 'utf8' });
      helperSources.set(name, digest(contents));
      return { contents, loader: extname(path).slice(1), resolveDir: resolve(path, '..') };
    });
  } }] })).outputFiles[0].text;
await mkdir(output, { recursive: true });
await rm(join(output, 'result.json'), { force: true });
const artifactBefore = await fingerprint();
const swBody = await readFile(join(artifactRoot, 'client/sw.js'));
assert.equal(digest(await (await fetch(new URL('/sw.js', upstream))).arrayBuffer()), digest(swBody), 'Preview SW differs from declared dist directory');
let phase = 'warm', origin = '', chrome, browser, profile;
const proxyCounts = { upstream: 0, deniedApi: 0, deniedOffline: 0, terminatedStreams: 0 };
const activeRequests = new Map();
function severConnections(apiOnly = false) {
  for (const [request, { response, api }] of activeRequests) if (!apiOnly || api) {
    proxyCounts.terminatedStreams++; response.destroy(); request.destroy();
  }
}
const proxy = createServer((req, res) => {
  if (phase === 'offline') { proxyCounts.deniedOffline++; req.socket.destroy(); return; }
  if (phase === 'assets-only' && req.url.startsWith('/api/')) { proxyCounts.deniedApi++; req.socket.destroy(); return; }
  const target = new URL(req.url, upstream);
  if (target.origin !== upstream.origin) { res.writeHead(403); res.end(); return; }
  proxyCounts.upstream++;
  const headers = { ...req.headers, host: upstream.host };
  delete headers.authorization; delete headers.cookie;
  const request = httpRequest(target, { method: req.method, headers }, (response) => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  activeRequests.set(request, { response: res, api: target.pathname.startsWith('/api/') });
  request.on('close', () => activeRequests.delete(request));
  res.on('close', () => request.destroy());
  request.on('error', () => { if (!res.headersSent && !res.destroyed) res.writeHead(502); res.end(); });
  req.pipe(request);
});
await new Promise((done) => proxy.listen(0, '127.0.0.1', done));
origin = `http://pwa-review.localhost:${proxy.address().port}`;
const events = { documents: [], assets: [], failures: [], exceptions: [], blockedExternal: [], blockedLoopback: [], workerTargets: 0 };
const sessions = new Map();
const report = { declaredBuiltCommit: builtCommit, sourceHeadAtStart: git('rev-parse', 'HEAD'), testHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  artifactBefore, packagedSwSha256: digest(swBody), storageHelperSources: Object.fromEntries(helperSources), origin,
  automaticRegistration: false, cleanupApiPatches: false, requireCaptureFiles, checks: {}, limits: [], findings: [] };

async function startBrowser() {
  sessions.clear();
  chrome = spawn(process.env.BOT_TEST_CHROME ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--no-proxy-server',
    '--host-resolver-rules=MAP pwa-review.localhost 127.0.0.1, MAP * ~NOTFOUND', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', (data) => { stderr += data; }); chrome.on('error', (error) => { stderr += error.message; });
  const url = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'fresh Chromium');
  const socket = new WebSocket(url); await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  let seq = 0; const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  async function configure(sessionId, type) {
    await send('Runtime.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
    await send('Network.emulateNetworkConditions', { offline: phase === 'offline', latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
    if (type === 'page') {
      await send('Page.enable', {}, sessionId);
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
    }
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) { const p = pending.get(m.id); if (!p) return; clearTimeout(p.timer); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); return; }
    const p = m.params;
    if (m.method === 'Target.attachedToTarget') {
      const item = { id: p.sessionId, type: p.targetInfo.type, targetId: p.targetInfo.targetId };
      if (item.type === 'service_worker') events.workerTargets++;
      item.ready = configure(p.sessionId, item.type).catch((error) => { item.error = error.message; });
      sessions.set(item.id, item);
    } else if (m.method === 'Target.detachedFromTarget') sessions.delete(p.sessionId);
    else if (m.method === 'Fetch.requestPaused') {
      const url = new URL(p.request.url);
      const external = /^https?:$/.test(url.protocol) && url.origin !== origin;
      if (external) {
        const local = ['127.0.0.1', 'pwa-review.localhost', 'localhost', '[::1]'].includes(url.hostname);
        (local ? events.blockedLoopback : events.blockedExternal).push({ origin: url.origin, path: url.pathname, phase });
      }
      const block = external || phase === 'offline' || phase === 'assets-only' && url.pathname.startsWith('/api/');
      void send(block ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: p.requestId, ...(block ? { errorReason: 'InternetDisconnected' } : {}) }, m.sessionId).catch(() => {});
    } else if (m.method === 'Network.responseReceived') {
      const { response: r, type } = p;
      const entry = { phase, path: new URL(r.url).pathname, status: r.status, fromServiceWorker: Boolean(r.fromServiceWorker), fromDiskCache: Boolean(r.fromDiskCache) };
      if (type === 'Document') events.documents.push(entry);
      if (entry.path.startsWith('/assets/') && type === 'Script') events.assets.push(entry);
    } else if (m.method === 'Network.loadingFailed' && phase === 'offline') events.failures.push({ type: p.type, error: p.errorText });
    else if (m.method === 'Runtime.exceptionThrown') events.exceptions.push({ phase, message: (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).split('\n')[0].slice(0, 300) });
  });
  socket.addEventListener('close', () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Browser CDP connection closed')); }
    pending.clear();
  });
  browser = { socket, send };
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const item = await until(() => [...sessions.values()].find((s) => s.type === 'page'), 'page target');
  await item.ready; assert.equal(item.error, undefined, 'CDP page network policy setup');
  return pageApi(item.id);
}
function pageApi(id) {
  const send = (method, params = {}) => browser.send(method, params, id);
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).split('\n').slice(0, 3).join('\n'));
    return r.result.value;
  };
  return { send, evaluate };
}
async function stopBrowser() {
  if (!chrome || chrome.exitCode !== null) return;
  await browser.send('Browser.close').catch(() => {});
  await until(() => chrome.exitCode !== null, 'orderly browser shutdown');
  browser.socket.close();
}
async function navigate(page, path, selector) {
  const previous = await page.evaluate('performance.timeOrigin');
  await page.send('Page.navigate', { url: origin + path });
  await until(() => page.evaluate(`performance.timeOrigin !== ${previous} && !!document.querySelector(${JSON.stringify(selector)})`), `new packaged document ${path}`, 30);
}
async function inject(page) { await page.evaluate(helper); }
const taskSelector = 'textarea[aria-label="Add a task"]';
const botSelector = 'textarea[aria-label="Message Packaged PWA Smoke Bot"]';
const typeText = async (page, selector, text) => {
  await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.setSelectionRange(e.value.length, e.value.length); })()`);
  await page.send('Input.insertText', { text });
};
async function checkTask(page, expected) {
  await inject(page);
  await until(() => page.evaluate('document.body.textContent.includes(packagedSmoke.taskTitle) && document.querySelector(\'textarea[aria-label="Add a task"]\')?.value === packagedSmoke.quickText'), 'cached synthetic task and usable Quick Add');
  const saved = await page.evaluate('packagedSmoke.stored()');
  assert.equal(saved.taskFileHash, expected.taskFileHash); assert.equal(saved.botFileHash, expected.pngHash);
  assert.equal(saved.taskPresent, true); assert.equal(saved.operations, 0);
  const input = await page.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(taskSelector)}); const r = e.getBoundingClientRect(); return { disabled: e.disabled, height: r.height, width: r.width, bottom: r.bottom, visible: visualViewport.height }; })()`);
  assert.equal(input.disabled, false); assert.ok(input.height >= 38 && input.width > 100 && input.bottom <= input.visible + 1, 'Quick Add is visible and usable');
  return { taskPresent: saved.taskPresent, exactTaskBytes: true, exactBotBytes: true, quickAddRestored: true, input };
}
async function checkBot(page, expected, text) {
  await inject(page);
  await until(() => page.evaluate(`document.querySelector(${JSON.stringify(botSelector)})?.value === ${JSON.stringify(text)} && document.querySelector('.bots-messages')?.textContent.includes(packagedSmoke.historyText)`), 'cached bot history and composer');
  await until(() => page.evaluate('packagedSmoke.botImage().then((image) => image?.decoded)'), 'staged bot image decodes offline');
  const image = await page.evaluate('packagedSmoke.botImage()');
  assert.equal(image.local, true); assert.equal(image.hash, expected.pngHash);
  const saved = await page.evaluate('packagedSmoke.stored()');
  assert.equal(saved.botFileHash, expected.pngHash); assert.equal(saved.botText, text); assert.equal(saved.operations, 0);
  return { cachedSnapshot: true, cachedHistory: true, composerRestored: true, decodedLocalPreview: true, exactBotBytes: true, unsubmittedOperations: 0 };
}
try {
  profile = await mkdtemp(join(tmpdir(), 'packaged-pwa-profile-'));
  let page = await startBrowser();
  await navigate(page, '/', taskSelector);
  report.secureContext = await page.evaluate('({secure: isSecureContext, serviceWorker: "serviceWorker" in navigator, host: location.hostname})');
  assert.equal(report.secureContext.secure, true); assert.equal(report.secureContext.serviceWorker, true);
  report.browser = await page.evaluate('navigator.userAgent');
  await until(() => page.evaluate('!!navigator.serviceWorker.controller'), 'unchanged automatic production SW registration', 45);
  report.automaticRegistration = true;
  report.initialWorker = await page.evaluate('(async () => { const r = await navigator.serviceWorker.ready; return {scriptURL:r.active.scriptURL, state:r.active.state}; })()');
  report.cache = await page.evaluate('(async () => { const names = (await caches.keys()).filter((k) => k.startsWith("dawar-todo-shell-")); const rows = await Promise.all(names.map(async (name) => ({name, paths:(await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname)}))); return rows.map((r) => ({name:r.name, entries:r.paths.length, root:r.paths.includes("/"), bots:r.paths.includes("/bots"), js:r.paths.filter((p) => p.endsWith(".js")).length})); })()');
  assert.ok(report.cache.some((c) => c.root && c.bots && c.js > 5), 'SW installation completed document and JS caching');
  // Warm the real bot chunk before claiming repeat offline access.
  await navigate(page, '/bots', '.bots-screen'); await navigate(page, '/', taskSelector);
  phase = 'assets-only'; severConnections(true); // From here no API/mutation can reach the temporary D1.
  await inject(page); const expected = await page.evaluate('packagedSmoke.seed()'); report.originalByteHashes = expected;
  await typeText(page, taskSelector, await page.evaluate('packagedSmoke.quickText'));
  await until(() => page.evaluate('packagedSmoke.stored().then((s) => s.quickText === packagedSmoke.quickText && s.taskPresent)'), 'actual Quick Add input committed');
  const beforeGeneration = await page.evaluate('performance.timeOrigin');
  assert.equal(digest(await (await fetch(new URL('/sw.js?packaged-smoke-generation=2', upstream))).arrayBuffer()), digest(swBody), 'generation uses unchanged packaged SW bytes');
  await page.evaluate('navigator.serviceWorker.register("/sw.js?packaged-smoke-generation=2", {scope:"/"}).then(() => true)');
  await until(() => page.evaluate('navigator.serviceWorker.controller?.scriptURL.includes("packaged-smoke-generation=2")'), 'real second worker generation activates', 45);
  assert.equal(await page.evaluate('performance.timeOrigin'), beforeGeneration, 'SW activation must not force navigation');
  report.checks.generation = { samePackagedScriptBytes: true, activated: true, forcedNavigation: false, ...(await checkTask(page, expected)) };
  phase = 'offline'; severConnections(); proxy.closeAllConnections();
  const upstreamAtOffline = proxyCounts.upstream;
  await Promise.all([...sessions.values()].map(async (s) => {
    await s.ready;
    assert.equal(s.error, undefined, 'worker/page network policy setup');
    await browser.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, s.id);
  }));
  await page.send('Network.clearBrowserCache');
  report.httpCacheClearedBeforeOfflineDocuments = true;
  assert.equal(await page.evaluate('navigator.onLine'), false);
  assert.equal(await page.evaluate('fetch("/api/bootstrap?uncached-smoke-probe="+crypto.randomUUID()).then(() => false, () => true)'), true, 'uncached network is actually unavailable');
  await page.evaluate('packagedSmoke.stageCaptureImage()');
  await until(() => page.evaluate('packagedSmoke.captureImage().then((i) => i?.decoded)'), 'synthetic Quick Add file staged through UI');
  assert.equal((await page.evaluate('packagedSmoke.captureImage()')).hash, expected.pngHash);
  await page.evaluate('[...document.querySelectorAll(\'a[aria-label="Bots"]\')].find((e) => e.getClientRects().length).click()');
  await until(() => page.evaluate('!!document.querySelector(".bots-row-title")'), 'offline shell route to Bots');
  await page.evaluate('[...document.querySelectorAll(".bots-row")].find((e) => e.textContent.includes("Packaged PWA Smoke Bot")).click()');
  report.checks.shellNavigation = await checkBot(page, expected, await page.evaluate('packagedSmoke.botText'));
  await typeText(page, botSelector, ' — edited offline');
  const edited = await page.evaluate('packagedSmoke.botText + " — edited offline"');
  await until(() => page.evaluate(`packagedSmoke.stored().then((s) => s.botText === ${JSON.stringify(edited)})`), 'offline composer typing committed');
  await page.evaluate('[...document.querySelectorAll(\'a[aria-label="Tasks"]\')].find((e) => e.getClientRects().length).click()');
  await until(() => page.evaluate('location.pathname === "/" && !!document.querySelector(\'textarea[aria-label="Add a task"]\')?.getClientRects().length'), 'offline shell route back to Tasks');
  assert.equal((await page.evaluate('packagedSmoke.captureImage()')).hash, expected.pngHash);
  await navigate(page, '/bots?bot=packaged-pwa-smoke-bot', botSelector);
  report.checks.botNewDocument = await checkBot(page, expected, edited);
  await navigate(page, '/', taskSelector);
  report.checks.taskNewDocument = await checkTask(page, expected);
  const recoveredCapture = await page.evaluate('packagedSmoke.captureImage()');
  report.checks.captureFileAfterNewDocument = { recovered: recoveredCapture?.hash === expected.pngHash, required: requireCaptureFiles };
  if (!report.checks.captureFileAfterNewDocument.recovered) {
    report.limits.push('Quick Add unsent image did not survive a new document in this artifact; the original fixture bytes and staged bot/task copies remain intact. Capture attachment pass is not part of base 9a60cea.');
    if (requireCaptureFiles) report.findings.push('Quick Add unsent attachment missing after offline new document');
  }
  const form = await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(taskSelector)}).closest('form').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()`);
  await writeFile(join(output, 'quick-add-offline.png'), Buffer.from((await page.send('Page.captureScreenshot', { clip: form })).data, 'base64'));
  await stopBrowser();
  page = await startBrowser(); // Same fresh profile, all network already blocked.
  await navigate(page, '/', taskSelector);
  report.checks.taskBrowserRestart = await checkTask(page, expected);
  await typeText(page, taskSelector, ' — edited after restart');
  await until(() => page.evaluate('packagedSmoke.stored().then((s) => s.quickText === packagedSmoke.quickText + " — edited after restart")'), 'Quick Add remains editable after offline restart');
  report.checks.quickAddEditableAfterRestart = true;
  await navigate(page, '/bots?bot=packaged-pwa-smoke-bot', botSelector);
  report.checks.botBrowserRestart = await checkBot(page, expected, edited);
  await writeFile(join(output, 'bot-offline-restart.png'), Buffer.from((await page.send('Page.captureScreenshot')).data, 'base64'));
  assert.equal(proxyCounts.upstream, upstreamAtOffline, 'no upstream request succeeds during offline/restart phases');
  report.offlineDocuments = events.documents.filter((r) => r.phase === 'offline');
  assert.ok(report.offlineDocuments.length >= 4 && report.offlineDocuments.every((r) => r.status === 200 && r.fromServiceWorker), 'new offline documents must come from the production SW after HTTP cache clear');
  report.limits.push('Chromium can flag a Cache Storage response both fromServiceWorker and fromDiskCache. HTTP cache was explicitly cleared and disabled; SW attribution, failed uncached probes and zero upstream traffic establish the offline path.');
  report.offlineScriptsFromSW = events.assets.filter((r) => r.phase === 'offline' && r.fromServiceWorker).length;
  assert.ok(report.offlineScriptsFromSW > 5, 'built JavaScript executes from production SW cache');
  assert.deepEqual(events.blockedExternal, [], 'app attempted non-loopback network');
  assert.deepEqual(events.exceptions, [], 'uncaught packaged app/browser errors');
  report.checks.fullNetworkOffline = { uncachedProbeFailed: true, zeroUpstreamRequests: true, httpCacheDisabled: true, nativeWorkerTargets: events.workerTargets, failedNetworkRequests: events.failures.length };
  console.log('PASS packaged automatic SW, generation activation, offline routes/new documents, task/bot data and browser restart');
} catch (error) {
  report.findings.push(error.message);
} finally {
  try { await stopBrowser(); } catch { chrome?.kill('SIGKILL'); report.findings.push('Browser did not close cleanly'); }
  severConnections(); proxy.closeAllConnections(); await new Promise((done) => proxy.close(done));
  report.artifactAfter = await fingerprint(); report.sourceHeadAtEnd = git('rev-parse', 'HEAD');
  if (report.artifactAfter.sha256 !== artifactBefore.sha256) report.findings.push('Artifact changed during run: discard this result and rerun the same deterministic fixture against a stable declared build');
  report.proxyCounts = proxyCounts;
  report.browserExceptions = events.exceptions;
  report.blockedOtherLoopbackRequests = [...new Map(events.blockedLoopback.map((r) => [r.origin + r.path + r.phase, r])).values()];
  report.blockedPublicRequests = events.blockedExternal;
  if (report.blockedOtherLoopbackRequests.length) report.limits.push('Packaged HTML emits absolute manifest/icon URLs using the upstream Worker host, which this loopback proxy deliberately blocks. App/SW route caching still passed; installability metadata through this proxy is not verified.');
  report.limits.push('Linux Headless Chromium phone viewport is emulation; no iPhone/Safari, physical keyboard/OS kill, live auth/relay/upload service, or new application/SW cache-version deployment was tested. The generation exercise uses the identical packaged SW at a second script URL.');
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
console.log(JSON.stringify(report, null, 2));
assert.deepEqual(report.findings, [], 'Packaged PWA offline smoke failed; inspect the privacy-safe result report');
