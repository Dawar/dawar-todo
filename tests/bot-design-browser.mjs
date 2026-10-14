// Real React workspace + native Chromium IndexedDB, synthetic transport only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { designArtifacts } from './fixtures/bot-design-artifacts.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await delay(30); } throw new Error(`Timed out: ${label}`); }
const bundle = await build({ entryPoints: ['tests/fixtures/bot-design-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'synthetic-shell-routing', setup(builder) {
    if (process.env.BOT_DESIGN_BASE) builder.onLoad({ filter: /app\/bots\/.*\.(tsx?|css)$/ }, ({ path }) => ({ contents: execFileSync('git', ['show', `${process.env.BOT_DESIGN_BASE}:${path.slice(process.cwd().length + 1)}`], { encoding: 'utf8' }), loader: path.endsWith('.css') ? 'css' : path.endsWith('.tsx') ? 'tsx' : 'ts' }));
    builder.onLoad({ filter: /app\/app-shell\.tsx$/ }, () => ({ contents: 'export const useShellNavigation = () => () => false;', loader: 'tsx' }));
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: 'preview-link', namespace: 'preview' }));
    builder.onLoad({ filter: /.*/, namespace: 'preview' }, () => ({ contents: 'import React from "react"; export default function Link({prefetch, ...props}) {return <a {...props}/>}', loader: 'jsx', resolveDir: process.cwd() }));
  } }], logLevel: 'silent' });
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
const globalCss = await postcss([tailwind()]).process(await readFile('app/globals.css', 'utf8'), { from: resolve('app/globals.css') });
const css = globalCss.css + '\n' + bundle.outputFiles.find((file) => file.path.endsWith('.css')).text;
const output = process.env.BOT_DESIGN_BASE ? 'outputs/bot-design-before' : process.env.BOT_DESIGN_FOLLOWUP ? 'outputs/bot-design-followup' : 'outputs/bot-design'; await mkdir(output, { recursive: true });
const artifacts = await designArtifacts();
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/artifact-rpc') {
    try { const parts = []; for await (const part of req) parts.push(part); const request = JSON.parse(Buffer.concat(parts).toString()); const result = await artifacts.handle(request); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ result })); } catch (error) { res.end(JSON.stringify({ error: error.message })); }
  }
  else if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script src="/harness.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'bot-durability-browser-'));
let chrome, socket;
try {
  chrome = spawn(process.env.BOT_TEST_CHROME ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', (data) => { stderr += data; }); chrome.on('error', (error) => { stderr += error.message; });
  const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'fresh Chromium');
  const targets = await (await fetch(`http://${new URL(debuggerUrl).host}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const item = pending.get(msg.id); pending.delete(msg.id); msg.error ? item.reject(new Error(JSON.stringify(msg.error))) : item.resolve(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  const results = [];
  const capture = async (name) => { await delay(100); await writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot')).data, 'base64')); };
  for (const [width, height] of [[390,844], [320,740], [1440,1000]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 700 });
    await send('Page.navigate', { url: origin + '/preview?bot=design-a' });
    await until(() => evaluate('!!window.design'), 'workspace bundle');
    if (process.env.BOT_DESIGN_FOLLOWUP) {
      // Fresh owner/browser context: verify history before ever opening a gallery.
      const outputs = process.env.BOT_DESIGN_FOLLOWUP === 'counts' ? undefined : await evaluate('design.outputCards()');
      if (outputs) await capture(`message-outputs-${width}`);
      const paging = await evaluate('design.galleryCountChecks()'); await capture(`gallery-last-page-${width}`);
      const singular = await evaluate('design.galleryCountChecks(true)'); await capture(`gallery-single-file-${width}`);
      results.push({ width, paging, singular, outputs }); continue;
    }
    await evaluate('design.scenario("populated")'); await capture(`chat-${width}`);
    const reproduction = await evaluate('design.emptyHeightReproduction()'); await capture(`empty-height-reproduction-${width}`);
    if (process.env.BOT_DESIGN_BASE) { results.push({ width, reproduction }); break; }
    assert.ok(reproduction.emptyHeight <= 42, 'exact supplied empty-tall reproduction');
    const geometry = await evaluate('design.tallRegression()');
    const jump = await evaluate('design.jumpCheck()');
    await capture(`empty-composer-${width}`);
    if (width < 700) {
      await evaluate('design.type("A few thoughts for the week…\\nAnd a little room to think.")');
      await evaluate(`design.keyboard(${width === 390 ? 400 : 330})`);
      const layout = await evaluate('design.layout()'); assert.ok(layout.inputBottom <= layout.visualHeight + 1); assert.ok(layout.inputHeight >= 38);
      await capture(`keyboard-${width}`); await evaluate('design.dismissKeyboard()');
    }
    const states = {};
    for (const name of ['empty', 'loading', 'offline', 'error', 'recovery']) {
      states[name] = await evaluate(`design.scenario(${JSON.stringify(name)})`); await capture(`${name}-${width}`);
      assert.ok(states[name].bodyWidth <= width + 1, `${name} overflow at ${width}`);
    }
    const gallery = {};
    for (const name of ['populated', 'empty', 'loading', 'offline', 'error']) {
      gallery[name] = await evaluate(`design.gallery(${JSON.stringify(name)})`); await capture(`gallery-${name}-${width}`);
    }
    await evaluate('design.gallery("populated")');
    gallery.interactions = await evaluate('design.galleryChecks()');
    await evaluate('delete window.design'); await send('Page.reload'); await until(() => evaluate('!!window.design'), 'fresh page');
    gallery.offlineRestart = await evaluate('design.offlineReload()'); await capture(`gallery-offline-preview-${width}`); await evaluate('design.galleryAction("close")'); await capture(`gallery-offline-cached-${width}`);
    await evaluate('design.gallery("populated", "bot")'); await capture(`attachments-${width}`);
    gallery.image = await evaluate('design.galleryAction("image")'); await capture(`viewer-image-${width}`); await evaluate('design.galleryAction("close")');
    gallery.pdf = await evaluate('design.galleryAction("pdf")'); await capture(`viewer-pdf-${width}`); await evaluate('design.galleryAction("close")');
    await evaluate('design.galleryAction("quota")'); await capture(`settings-quota-${width}`);
    gallery.discovery = await evaluate('design.discoveryChecks()');
    gallery.outputs = await evaluate('design.outputCards()'); await capture(`message-outputs-${width}`);
    results.push({ width, reproduction, geometry, jump, states, gallery });
  }
  assert.deepEqual(errors, []);
  const result = { artifactRuntime: artifacts.calls, nativeCalls: artifacts.nativeCalls, browser: await evaluate('navigator.userAgent'), results, browserErrors: errors, limits: 'Chromium emulation, real BotRuntime/SQLite/files and Sharp/Poppler with synthetic Codex transport. No actual Safari/iPhone verification.' };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));

} finally {
  socket?.close(); chrome?.kill('SIGTERM');
  if (chrome && chrome.exitCode === null) await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), delay(2000)]);
  if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  await artifacts.close();
}
