// Real workspace + Chromium, synthetic transport only: a live response that
// arrives after load must stay reachable by ordinary scrolling (wheel input),
// including after scrolling up and back down. Usage:
//   node tests/bot-scroll-latest-browser.mjs        (desktop docked + phone)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await delay(30); } throw new Error(`Timed out: ${label}`); }
const bundle = await build({ entryPoints: ['tests/fixtures/bot-chapters-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'esm', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@': '.' },
  plugins: [{ name: 'synthetic-shell', setup(builder) {
    builder.onLoad({ filter: /app\/site-header\.tsx$/ }, () => ({ contents: 'export function SiteHeader(){return null}', loader: 'tsx' }));
    builder.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'asset-url' }));
    builder.onLoad({ filter: /.*/, namespace: 'asset-url' }, () => ({ contents: 'export default ""', loader: 'js' })); } }], logLevel: 'error' });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css'))?.text ?? '';
let appCss = '';
try { appCss = readdirSync('dist/server/assets').filter(name => /^index-.*\.css$/.test(name)).map(name => readFileSync(`dist/server/assets/${name}`, 'utf8')).join('\n'); } catch { /* Layout CSS from the bundle is sufficient. */ }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(`${appCss}\n${css}`); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><body style="margin:0"><div id="root"></div><script type="module" src="/harness.js"></script>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'bot-scroll-latest-'));
let chrome, socket;
const results = {};
try {
  chrome = spawn(process.env.BOT_TEST_CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', data => { stderr += data; });
  const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chromium');
  const targets = await (await fetch(`http://${new URL(debuggerUrl).host}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const item = pending.get(msg.id); pending.delete(msg.id); if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await send('Runtime.enable'); await send('Page.enable');
  const feed = `document.querySelector('.bots-messages')`;
  const probe = key => evaluate(`(() => { const f = ${feed}, n = [...f.querySelectorAll('[data-history-key]')].find(x => x.dataset.historyKey === ${JSON.stringify(key)});
    const fr = f.getBoundingClientRect(), r = n?.getBoundingClientRect();
    return { mounted: !!n, visible: !!r && r.bottom > fr.top && r.top < fr.bottom, distance: Math.round(f.scrollHeight - f.clientHeight - f.scrollTop), jump: !!document.querySelector('.bots-jump-latest') }; })()`);
  const wheel = async (deltaY, times) => {
    const point = await evaluate(`(() => { const r = ${feed}.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    for (let i = 0; i < times; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY }); await delay(60); }
    await delay(400);
  };
  const toBottom = async () => { for (let i = 0; i < 12; i++) { await wheel(1200, 3); const d = await evaluate(`(() => { const f = ${feed}; return f.scrollHeight - f.clientHeight - f.scrollTop; })()`); if (d <= 2) return; } };
  for (const [name, width, height, query] of [['desktop-docked', 1440, 900, 'long=40&dock&owner=desktop'], ['phone', 390, 844, 'long=40&owner=phone']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await send('Page.navigate', { url: `${origin}/harness?${query}` });
    await until(() => evaluate('document.body.dataset.ready === "1"'), `${name} ready`);
    await toBottom();
    // 1. Live response while following the bottom.
    await evaluate('harness.append(1)'); await delay(600);
    const following = await probe('live-1:live-answer-1');
    await toBottom();
    const followingReached = await probe('live-1:live-answer-1');
    if (process.env.DEBUG_SCROLL) console.log('STEP1', name, JSON.stringify(await evaluate(`(() => { const f = ${feed}, fr = f.getBoundingClientRect(); return { feed: [Math.round(fr.top), Math.round(fr.bottom), f.scrollHeight, f.clientHeight, f.scrollTop], keys: [...f.querySelectorAll('[data-history-key]')].filter(n => n.dataset.historyKey.startsWith('live')).map(n => { const r = n.getBoundingClientRect(); return [n.dataset.historyKey, n.className, n.parentElement.className, Math.round(r.top), Math.round(r.height)]; }), tail: [...f.firstElementChild.children].slice(-4).map(n => [n.tagName, n.className, Math.round(n.getBoundingClientRect().top), Math.round(n.getBoundingClientRect().height), n.textContent.slice(0, 50)]) }; })()`)));
    // 2. Scroll up then ordinary scroll down to the newest response.
    await wheel(-400, 4); await toBottom();
    const afterUpDown = await probe('live-1:live-answer-1');
    // 3. Live response while reading above, then ordinary scroll down.
    await wheel(-400, 4);
    await evaluate('harness.append(2)'); await delay(600);
    await toBottom();
    const readingThenDown = await probe('live-2:live-answer-2');
    await wheel(-400, 4); await toBottom();
    const secondUpDown = await probe('live-2:live-answer-2');
    if (process.env.DEBUG_SCROLL) console.log(name, JSON.stringify(await evaluate(`(() => { const f = ${feed}, fr = f.getBoundingClientRect(); return { feed: [Math.round(fr.top), Math.round(fr.bottom), f.scrollHeight, f.clientHeight, f.scrollTop], rows: [...f.querySelectorAll('[data-history-key]')].slice(-6).map(n => { const r = n.getBoundingClientRect(); return [n.dataset.historyKey, n.className, Math.round(r.top), Math.round(r.height), n.textContent.slice(0, 40)]; }), tail: [...f.firstElementChild.children].slice(-4).map(n => [n.tagName, n.className, Math.round(n.getBoundingClientRect().top), Math.round(n.getBoundingClientRect().height), n.textContent.slice(0, 50)]) }; })()`)));
    // 4. Streamed response: reading above while it streams, then scroll down.
    await evaluate('window.s3 = harness.stream(3); s3.start()'); await delay(200);
    for (let i = 0; i < 40; i++) { const more = await evaluate(`s3.delta(${i})`); if (i === 5) await wheel(-400, 2); if (!more) break; await delay(40); }
    await evaluate('s3.finish()'); await delay(600);
    await toBottom();
    const streamedThenDown = await probe('live-3:live-answer-3');
    if (process.env.DEBUG_SCROLL) console.log('STEP4', name, JSON.stringify(await evaluate(`(() => { const f = ${feed}; return { text: f.textContent.includes('Live answer 3'), q: f.textContent.includes('Live question 3'), keys: [...f.querySelectorAll('[data-history-key]')].slice(-5).map(n => [n.dataset.historyKey, Math.round(n.getBoundingClientRect().height), n.textContent.slice(0, 30)]), jump: document.querySelector('.bots-jump-latest')?.textContent, entries: harness.entries() }; })()`)));
    await wheel(-400, 4); await toBottom();
    const streamedUpDown = await probe('live-3:live-answer-3');
    // 5. Streamed while following the bottom.
    await evaluate('window.s4 = harness.stream(4); s4.start()'); await delay(200);
    for (let i = 0; i < 40; i++) { const more = await evaluate(`s4.delta(${i})`); if (!more) break; await delay(40); }
    await evaluate('s4.finish()'); await delay(600);
    const streamedFollowing = await probe('live-4:live-answer-4');
    await wheel(-400, 4); await toBottom();
    const streamedFollowingUpDown = await probe('live-4:live-answer-4');
    results[name] = { streamedThenDown, streamedUpDown, streamedFollowing, streamedFollowingUpDown, following, followingReached, afterUpDown, readingThenDown, secondUpDown };
  }
  console.log(JSON.stringify({ results, errors }, null, 2));
  assert.deepEqual(errors, []);
  for (const [name, value] of Object.entries(results))
    for (const step of ['followingReached', 'afterUpDown', 'readingThenDown', 'secondUpDown', 'streamedThenDown', 'streamedUpDown', 'streamedFollowing', 'streamedFollowingUpDown'])
      assert.ok(value[step].mounted && value[step].visible && value[step].distance <= 2, `${name} ${step}: newest response not reachable by scrolling ${JSON.stringify(value[step])}`);
} finally {
  socket?.close(); chrome?.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
