// Bounded release review at 9a60cea. Run: node tests/bot-release-review-browser.mjs
// Native Chromium IDB/BroadcastChannel, real React composer and task recovery UI.
// All identities, files and backend responses are synthetic; no live services.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(fn, label) {
  for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
const bundle = await build({ entryPoints: ['tests/fixtures/bot-release-review.jsx'], bundle: true, write: false, outdir: 'outputs/release-review', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'synthetic-shell-routing', setup(builder) {
    builder.onLoad({ filter: /app\/app-shell\.tsx$/ }, () => ({ contents: 'export const useShellNavigation = () => () => false;', loader: 'tsx' }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'review-link', namespace: 'review' }));
    builder.onLoad({ filter: /.*/, namespace: 'review' }, () => ({ contents: 'import React from "react"; export default function Link({prefetch, ...props}) {return <a {...props}/>}', loader: 'jsx', resolveDir: process.cwd() }));
  } }], logLevel: 'silent' });
const js = bundle.outputFiles.find((f) => f.path.endsWith('.js')).text;
const globalCss = await postcss([tailwind()]).process(await readFile('app/globals.css', 'utf8'), { from: resolve('app/globals.css') });
const css = globalCss.css + '\n' + bundle.outputFiles.find((f) => f.path.endsWith('.css')).text;
let sessionStatus = 503, uploadError = false;
const requests = [], executions = new Map(), uploads = new Map(), heldResponses = [];
const sendResult = (res, value) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
const server = createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (path === '/review.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
    else if (path === '/review.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
    else if (path === '/api/bots/session') { res.statusCode = sessionStatus; sendResult(res, { error: 'Synthetic session unavailable' }); }
    else if (path === '/review-rpc') {
      let body = ''; for await (const chunk of req) body += chunk;
      const r = JSON.parse(body); requests.push(r);
      if (['turn.send', 'queue.add', 'queue.update'].includes(r.method)) {
        if (!executions.has(r.operationId)) executions.set(r.operationId, { result: { turn: { id: `synthetic-turn-${executions.size}` }, queuedSubmission: { id: 'synthetic-queue' } } });
        heldResponses.push({ res, r });
      } else if (r.method === 'attachments.begin') {
        if (uploadError) { sendResult(res, { error: 'Synthetic interrupted upload: saved bytes remain local.' }); return; }
        if (!uploads.has(r.operationId)) uploads.set(r.operationId, { id: r.operationId, botId: r.botId, ...r.params, ready: false, chunks: new Map() });
        sendResult(res, { result: { ...uploads.get(r.operationId), chunks: undefined } });
      } else if (r.method === 'attachments.chunk') {
        uploads.get(r.params.id).chunks.set(r.params.offset, r.params.data); sendResult(res, { result: {} });
      } else if (r.method === 'attachments.finish') {
        const f = uploads.get(r.params.id); f.ready = true; sendResult(res, { result: { ...f, chunks: undefined } });
      } else if (r.method === 'history') sendResult(res, { result: { thread: { turns: [] }, attachments: [], nextCursor: null } });
      else sendResult(res, { result: [] });
    } else if (path === '/away') res.end('<!doctype html><title>Synthetic navigation</title><p>Away from the bot workspace</p><a href="/review?bot=A">Back</a>');
    else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/review.css"><div id="root"></div><script src="/review.js"></script>');
  } catch (error) { res.statusCode = 500; sendResult(res, { error: String(error) }); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'bot-release-review-'));
const output = resolve('outputs/bot-release-review'); await mkdir(output, { recursive: true });
await rm(join(output, 'result.json'), { force: true });
const errors = [], pages = [];
let chrome;
async function connect(url) {
  const socket = new WebSocket(url); await new Promise((done) => socket.addEventListener('open', done, { once: true }));
  let sequence = 0; const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data);
    if (m.id) {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
    }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timed out: ${method}`)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { socket, send, evaluate };
}
const ack = (error = false) => {
  for (const { res, r } of heldResponses.splice(0)) sendResult(res, error ? { error: 'EPIPE after a synthetic native commit' } : executions.get(r.operationId));
};
try {
  chrome = spawn(process.env.BOT_TEST_CHROME ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', (data) => { stderr += data; }); chrome.on('error', (error) => { stderr += error.message; });
  const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'fresh Chromium');
  const debugHttp = `http://${new URL(debuggerUrl).host}`;
  async function page(path = '/review?bot=A') {
    const target = await (await fetch(`${debugHttp}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })).json();
    const p = await connect(target.webSocketDebuggerUrl); pages.push(p);
    await p.send('Runtime.enable'); await p.send('Page.enable');
    await p.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await p.send('Page.navigate', { url: origin + path });
    await until(() => p.evaluate('!!window.review'), 'fixture loaded');
    if (!path.includes('panel')) await until(() => p.evaluate('review.state().ready && review.state().value !== undefined'), 'offline cached owner/composer');
    return p;
  }
  const a = await page(), b = await page();
  const state = (p) => p.evaluate('review.state()');
  const reload = async (p) => {
    const instance = await p.evaluate('review.instance');
    await p.send('Page.reload');
    await until(() => p.evaluate(`!!window.review && review.instance !== ${JSON.stringify(instance)}`), 'new document after reload');
  };
  const ready = async (p) => until(async () => (await state(p)).saved, 'transaction committed');
  const normal = (s) => s.record.slots.normal;
  const convergence = async () => until(async () => {
    const [x, y] = await Promise.all([state(a), state(b)]);
    return x.saved && y.saved && x.record.revision === y.record.revision && [x, y];
  }, 'native BroadcastChannel convergence');
  await a.evaluate('review.hold()');
  await Promise.all([a.evaluate('review.type("concurrent text A"); review.add("tab-A.png", "", true)'), b.evaluate('review.type("concurrent text B"); review.add("tab-B.txt", "B file bytes")')]);
  assert.equal((await state(a)).dirty, true); assert.equal((await state(b)).dirty, true);
  await a.evaluate('review.release()');
  const concurrent = await convergence();
  for (const s of concurrent) {
    assert.deepEqual(new Set(Object.values(s.record.slots).map((d) => d.text).filter(Boolean)), new Set(['concurrent text A', 'concurrent text B']));
    assert.equal(normal(s).files.length, 2); assert.equal(s.storageError, '');
  }
  for (const p of [a, b]) {
    assert.equal((await p.evaluate('review.bytes()')).length, 2);
    await until(async () => (await state(p)).previews.some((i) => i.local && i.decoded), 'cross-tab local image decoded');
  }
  console.log('PASS real two-tab conflicting typing, file bytes, decoded local previews and broadcasts');

  // A different bot has independently held content throughout acknowledgement.
  await a.evaluate('review.select("B")');
  await until(() => a.evaluate('document.querySelector("textarea")?.getAttribute("aria-label") === "Message Bot B" && review.readyBot("B")'), 'selected B');
  await a.evaluate('review.type("other bot remains intact"); review.add("other-bot.txt", "other bot bytes")');
  await until(async () => (await a.evaluate('review.record("B")'))?.slots.normal.files.length === 1, 'other bot saved');
  await a.evaluate('review.select("A")');
  await until(() => a.evaluate('document.querySelector("textarea")?.getAttribute("aria-label") === "Message Bot A"'), 'return A');
  await a.evaluate('review.online(true)'); await b.evaluate('review.online(true)');
  await until(async () => (await state(a)).record.slots.normal.files.every((f) => f.remote?.ready), 'uploads acknowledged');
  await convergence();
  await a.evaluate('review.send()');
  await until(() => heldResponses.length === 1, 'first submitted operation');
  const operationId = heldResponses[0].r.operationId;
  await until(async () => !!(await state(b)).record.operations[operationId], 'operation broadcast to other tab');
  ack(true);
  await until(async () => (await state(a)).record.operations[operationId]?.state === 'uncertain', 'actual client classifies untyped EPIPE uncertain');
  await convergence();
  assert.ok(await a.evaluate('document.querySelector(".bots-draft-status").textContent.includes("acknowledgement is unconfirmed")'));
  await b.evaluate('review.send()');
  await until(() => heldResponses.length === 1, 'second tab reconciles');
  assert.equal(heldResponses[0].r.operationId, operationId);
  await a.evaluate('review.hold()');
  await a.evaluate('review.online(false)'); await b.evaluate('review.online(false)');
  await b.evaluate('review.type("new text during acknowledgement"); review.add("new-file.txt", "new bytes after send")');
  ack();
  await a.evaluate('review.release()');
  const settled = await convergence();
  for (const s of settled) {
    assert.equal(Object.keys(s.record.operations).length, 0);
    assert.equal(s.actionError, '', 'a confirmed send must not keep a stale unconfirmed warning in another tab');
    assert.equal(normal(s).text, 'new text during acknowledgement');
    assert.deepEqual(normal(s).files.map((f) => f.name), ['new-file.txt']);
    assert.equal(s.storageError, '');
  }
  for (const p of [a, b]) assert.equal(await p.evaluate('document.querySelector(".bots-draft-status").textContent.includes("acknowledgement is unconfirmed")'), false);
  assert.equal(executions.size, 1);
  assert.equal((await a.evaluate('review.record("B")')).slots.normal.text, 'other bot remains intact');
  assert.equal((await a.evaluate('review.bytes("B")'))[0].text, 'other bot bytes');
  console.log('PASS ambiguous actual client response, second-tab same-ID reconciliation and racing compare-and-clear');

  // Queue-edit lifecycle, actual background event, committed pagehide and navigation.
  await b.evaluate('review.queueEdit()'); await b.evaluate('review.type("edited queue survives navigation")');
  await ready(b);
  await a.send('Page.bringToFront');
  await until(() => b.evaluate('review.lifecycle.includes("visibility:hidden")'), 'native tab background event');
  await b.evaluate('review.type("queue final input before navigation")');
  await b.send('Page.navigate', { url: origin + '/away' });
  await until(() => b.evaluate('location.pathname === "/away"'), 'top-level navigation');
  const pagehide = await b.evaluate('JSON.parse(sessionStorage.getItem("review-lifecycle"))');
  assert.ok(pagehide.includes('pagehide'));
  await b.evaluate('history.back()');
  await until(() => b.evaluate('location.pathname === "/review" && !!window.review && review.state().ready'), 'native browser back');
  assert.equal((await state(b)).value, 'queue final input before navigation');
  await b.evaluate('review.normal()'); await ready(b);
  assert.equal((await state(b)).value, 'new text during acknowledgement');
  assert.equal((await b.evaluate('review.bytes()')).some((f) => f.text === 'new bytes after send'), true);
  await reload(b);
  await until(() => b.evaluate('!!window.review && review.state().ready && review.state().value === "new text during acknowledgement"'), 'offline reload');
  assert.equal((await state(b)).online, false);
  assert.equal((await b.evaluate('review.bytes()')).some((f) => f.text === 'new bytes after send'), true);
  console.log('PASS native visibility/pagehide, top-level navigation, browser back, offline reload and queue-edit restoration');

  // Real response handling of upload failure; reload retains both original bytes and retry identity.
  uploadError = true; await b.evaluate('review.online(true)');
  await until(async () => normal(await state(b)).files.some((f) => f.error), 'failed upload visible');
  const failed = normal(await state(b)).files[0];
  await reload(b);
  await until(() => b.evaluate('!!window.review && review.state().ready && review.state().value === "new text during acknowledgement"'), 'failed upload reload');
  assert.equal((await b.evaluate('review.bytes()')).some((f) => f.id === failed.id && f.text === 'new bytes after send'), true);
  uploadError = false; await b.evaluate('review.online(true)');
  await until(async () => normal(await state(b)).files.every((f) => f.remote?.ready && !f.error), 'same upload retry acknowledged');
  const uploadAttempts = requests.filter((r) => r.method === 'attachments.begin' && r.params.name === 'new-file.txt');
  assert.ok(uploadAttempts.length >= 2); assert.equal(new Set(uploadAttempts.map((r) => r.operationId)).size, 1);
  assert.equal(executions.size, 1, 'reconnect did not auto-send unsubmitted text');
  console.log('PASS interrupted upload reload/retry keeps bytes and upload identity; reconnect does not send draft');

  // Revoke while a queue mutation has executed but its response is still held.
  await b.evaluate('review.queueEdit(); review.send()');
  await until(() => heldResponses.length === 1, 'queue mutation dispatched before revocation');
  const revokedOperation = heldResponses[0].r.operationId;
  assert.equal(heldResponses[0].r.method, 'queue.update');
  // Real HTTP 403 goes through BotsClient.session and broadcasts revocation to both tabs.
  sessionStatus = 403; await b.evaluate('review.revoke()');
  await until(async () => (await state(a)).owner === '' && (await state(b)).owner === '', 'cross-tab owner revocation');
  for (const p of [a, b]) {
    assert.equal((await state(p)).value, undefined, 'revocation removes access to the prior composer');
    assert.ok(!(await p.evaluate('document.body.textContent')).includes('new text during acknowledgement'));
    assert.ok(!(await p.evaluate('document.body.textContent')).includes('new-file.txt'));
    assert.equal((await p.evaluate('review.bytes()')).some((f) => f.text === 'new bytes after send'), true);
  }
  assert.ok(await a.evaluate('review.broadcasts.some((b) => b.revoked)'));
  await until(async () => (await b.evaluate('review.record()')).operations[revokedOperation]?.state === 'uncertain', 'revocation preserves pending identity');
  ack(); await delay(30);
  assert.ok((await b.evaluate('review.record()')).operations[revokedOperation], 'late response after revocation cannot clear the owner-bound operation');
  sessionStatus = 503;
  await b.evaluate('review.seedOwner("release-review-other-owner")');
  await reload(b);
  await until(() => b.evaluate('!!window.review && review.state().owner === "release-review-other-owner" && !!document.querySelector("textarea")'), 'different owner cached identity');
  assert.equal(await b.evaluate('document.querySelector("textarea").value'), '');
  assert.equal(await b.evaluate('document.querySelectorAll(".bots-upload-list > span").length'), 0);
  await b.evaluate('review.seedOwner(review.owner)'); await reload(b);
  await until(() => b.evaluate('!!window.review && review.state().ready && review.state().owner === review.owner'), 'original owner restored offline');
  assert.ok((await b.evaluate('review.record()')).operations[revokedOperation]);
  await b.evaluate('review.normal()'); await ready(b);
  assert.equal((await state(b)).value, 'new text during acknowledgement');
  await b.evaluate('review.online(true)');
  await until(() => heldResponses.length === 1, 'original owner reconciles authorized queue operation');
  assert.equal(heldResponses[0].r.operationId, revokedOperation); ack();
  await until(async () => Object.keys((await b.evaluate('review.record()')).operations).length === 0, 'owner-bound operation confirmed');
  assert.equal(executions.size, 2, 'one send and one queue update, with stable identities across retries');
  await b.evaluate('review.online(false)');
  assert.equal((await b.evaluate('review.bytes()')).some((f) => f.text === 'new bytes after send'), true);
  console.log('PASS session 403 during pending queue update, late response, cross-tab revocation, owner isolation and same-ID recovery');

  // Narrow layouts use actual header, global Tailwind CSS and production components.
  await b.evaluate('review.longUploadErrors()'); await ready(b);
  const layouts = [], normalLayouts = [], findings = [];
  await b.send('Page.bringToFront');
  for (const [width, height, keyboard] of [[390, 844, 400], [320, 640, 330]]) {
    await b.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true });
    await b.evaluate('delete visualViewport.height; visualViewport.dispatchEvent(new Event("resize")); review.type("Multiline draft\\n".repeat(30))'); await ready(b);
    await until(() => b.evaluate('!review.layout().keyboardOpen'), 'full viewport layout');
    const normalLayout = await b.evaluate('review.layout()'); normalLayouts.push(normalLayout);
    if (normalLayout.input.bottom > height + 1) findings.push({ component: 'bot composer', width, height, inputBottom: normalLayout.input.bottom, problem: 'Composer clips even before keyboard resize.' });
    await b.evaluate(`review.keyboard(${keyboard})`);
    await until(() => b.evaluate('review.layout().keyboardOpen'), 'keyboard layout branch'); await delay(50);
    const layout = await b.evaluate('review.layout()'); layouts.push(layout);
    await writeFile(join(output, `composer-${width}.png`), Buffer.from((await b.send('Page.captureScreenshot')).data, 'base64'));
    assert.equal(layout.keyboardOpen, true);
    assert.ok(layout.pageScrollWidth <= width + 1, `composer page overflow: ${JSON.stringify(layout)}`);
    assert.ok(layout.input.scrollHeight > layout.input.clientHeight, 'multiline input scrolls internally');
    assert.ok(layout.input.height >= 38, `input too small: ${JSON.stringify(layout)}`);
    if (layout.input.bottom > keyboard + 1) findings.push({ component: 'bot composer', width, keyboard, inputBottom: layout.input.bottom, problem: 'Keyboard viewport clips the composer. Shared workspace/layout dependency.' });
    if (layout.status.scrollWidth > layout.status.clientWidth + 1) findings.push({ component: 'bot recovery status', width, problem: 'Unbroken error tokens require horizontal scrolling.' });
    assert.ok(layout.status.scrollHeight > layout.status.clientHeight && await b.evaluate('review.scrollStatus()') > 0, 'long recovery status scrolls internally');
    assert.ok(layout.files.scrollWidth > layout.files.clientWidth && await b.evaluate('review.scrollFiles()') > 0, 'long file strip scrolls internally');
  }
  const p = await page('/review?panel=1'); await p.send('Page.bringToFront'); await p.evaluate('review.seedPanel()');
  await until(() => p.evaluate(`document.querySelectorAll('[aria-label="Pending attachment recovery"] li').length === 3`), 'task recovery rows');
  const panelLayouts = [];
  for (const [width, height] of [[320, 640], [390, 640], [320, 330]]) {
    await p.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true }); await delay(50);
    const layout = await p.evaluate('review.layout()'); panelLayouts.push(layout);
    await writeFile(join(output, `task-recovery-${width}-${height}.png`), Buffer.from((await p.send('Page.captureScreenshot')).data, 'base64'));
    if (layout.pageScrollWidth > width + 1) findings.push({ component: 'task attachment recovery', width, height, pageScrollWidth: layout.pageScrollWidth, problem: 'Page-wide horizontal overflow. Task UI ownership dependency.' });
    assert.equal(await p.evaluate(`document.querySelectorAll('[aria-label="Pending attachment recovery"] input[type=file]').length`), 1);
    assert.equal(await p.evaluate(`document.querySelectorAll('[aria-label="Pending attachment recovery"] button').length`), 5);
    assert.ok(await p.evaluate('document.documentElement.scrollHeight > innerHeight'), 'recovery page scrolls vertically');
    await p.evaluate(`document.querySelector('[aria-label="Pending attachment recovery"] li:last-child').scrollIntoView({block: 'end'})`);
    await writeFile(join(output, `task-recovery-bottom-${width}-${height}.png`), Buffer.from((await p.send('Page.captureScreenshot')).data, 'base64'));
  }
  assert.deepEqual(errors, []);
  const result = { browser: await b.evaluate('navigator.userAgent'), reviewBaseline: '9a60cea', testedHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), backendUniqueOperations: executions.size, sendAttempts: requests.filter((r) => r.method === 'turn.send').length,
    broadcastMessages: await a.evaluate('review.broadcasts.length'), normalComposerLayouts: normalLayouts, composerLayouts: layouts, taskPanelLayouts: panelLayouts, findings, browserErrors: errors,
    limits: 'Headless Chromium emulation, synthetic backend; no iPhone/Safari, OS kill, real service reconnect or deployed service-worker test.' };
  await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  assert.deepEqual(findings, [], 'Release review has unresolved layout findings; see outputs/bot-release-review/result.json');
} finally {
  ack(); for (const p of pages) p.socket.close(); chrome?.kill('SIGTERM');
  if (chrome && chrome.exitCode === null) await Promise.race([new Promise((done) => chrome.once('exit', done)), delay(2000)]);
  if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
  server.closeAllConnections(); await new Promise((done) => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
