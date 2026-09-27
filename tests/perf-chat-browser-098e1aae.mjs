// Real React workspace + native Chromium IndexedDB, synthetic transport only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { readHistoryView, readHistoryDetail } from '../bot-bridge/history-view.mjs';
import { fixture } from './perf-chat-fixtures-098e1aae.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await delay(30); } throw new Error(`Timed out: ${label}`); }
const bundle = await build({ entryPoints: ['tests/perf-chat-entry-098e1aae.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'iife', minify: true, jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'synthetic-shell', setup(builder) { builder.onLoad({ filter: /app\/bots\/message\.tsx$/ }, async ({ path }) => ({ loader: 'tsx', contents: (await readFile(path, 'utf8')).replace('  function markdown(value: string) {', '  window.baselineMessageRenders = (window.baselineMessageRenders || 0) + 1; (window.messageIds ??= []).push(item.id); function markdown(value: string) {') })); builder.onLoad({ filter: /app\/site-header\.tsx$/ }, () => ({ contents: 'export function SiteHeader(){return null}', loader: 'tsx' })); } }], logLevel: 'silent' });
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '';
let options = {}, runtimes = new Map();
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end('body{margin:0}'+css); }
  else if (path === '/config' || path === '/rpc') {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (path === '/config') { options = body; runtimes = new Map(); res.end('{}'); return; }
    const { method, botId, params = {} } = body;
    let runtime = runtimes.get(botId);
    if (!runtime) {
      const data = fixture(botId, options);
      runtime = { epoch: 'synthetic', store: { cursor: () => 0, replay: () => [], list: () => data.attachments }, publicAttachment: (a) => a,
        historyPage: async (_, cursor) => { const end = cursor ? Number(cursor) : data.turns.length, start = Math.max(0, end - 20); return { data: data.turns.slice(start, end).reverse(), nextCursor: start ? String(start) : null }; } };
      runtimes.set(botId, runtime);
    }
    try {
      const bot = { id: botId, threadId: botId, updatedAt: 'stable' };
      const result = method === 'history.view' ? await readHistoryView(runtime, bot, params) : await readHistoryDetail(runtime, bot, params);
      const json = JSON.stringify(result); await delay((options.rtt ?? 0) + (options.bytesPerSecond ? Buffer.byteLength(json) / options.bytesPerSecond * 1000 : 0));
      res.setHeader('Content-Type', 'application/json'); res.end(json);
    } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String(e) })); }
  } else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'bot-chat-performance-098e1aae-'));
let chrome, socket;
try {
  let sequence = 0; const pending = new Map(), errors = [];
  async function connectBrowser() {
    chrome = spawn(process.env.BOT_TEST_CHROME ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; chrome.stderr.on('data', (data) => { stderr += data; }); chrome.on('error', (error) => { stderr += error.message; });
    const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'fresh Chromium');
    const targets = await (await fetch(`http://${new URL(debuggerUrl).host}/json/list`)).json();
    socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    socket.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.id) { const item = pending.get(msg.id); pending.delete(msg.id); msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result); }
      else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
    });
  }
  async function closeBrowser() {
    socket?.close(); chrome?.kill('SIGTERM');
    if (chrome && chrome.exitCode === null) await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), delay(2000)]);
    if (chrome && chrome.exitCode === null) { chrome.kill('SIGKILL'); await new Promise((resolve) => chrome.once('exit', resolve)); }
  }
  await connectBrowser();
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + '/harness' });
  await until(() => evaluate('!!window.performanceChat'), 'workspace bundle');
  const measured = await evaluate('performanceChat.run()');
  await writeFile('outputs/perf-chat-partial-098e1aae.json', JSON.stringify(measured, null, 2));
  // Restart Chromium itself with this synthetic profile, not merely React or the document.
  await closeBrowser(); await connectBrowser();
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: origin + '/harness?offline=1' });
  await until(() => evaluate('location.search.includes("offline") && !!window.performanceChat'), 'reloaded workspace');
  const offline = await evaluate('performanceChat.offlineReload()');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const mobile = await evaluate('performanceChat.mobileLayout()');
  await writeFile('outputs/perf-chat-keyboard-390.png', Buffer.from((await send('Page.captureScreenshot')).data, 'base64'));
  const dismissed = await evaluate('performanceChat.dismissKeyboard()');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: await evaluate('navigator.userAgent'), ...measured, offlineFreshBrowserProcess: offline, mobileKeyboard: mobile, keyboardDismissed: dismissed, browserErrors: errors }, null, 2));
} finally {
  socket?.close(); chrome?.kill('SIGTERM');
  if (chrome && chrome.exitCode === null) await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), delay(2000)]);
  if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
