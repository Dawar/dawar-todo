// Real workspace + Chromium, synthetic transport only (tests/fixtures/
// bot-chapters-browser.jsx with ?elements): every AI Elements pattern renders
// from native item shapes, follow-up Suggestions only fill the composer, and
// expanding/collapsing activity creates no sends. Screenshots for review.
// Usage: node tests/ai-elements-browser.mjs [output-dir]   (needs a prior build for app CSS)
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

const out = resolve(process.argv[2] ?? 'outputs/ai-elements-browser');
await mkdir(out, { recursive: true });
const delay = ms => new Promise(done => setTimeout(done, ms));
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
try { appCss = readdirSync('dist/server/assets').filter(name => /^index-.*\.css$/.test(name)).map(name => readFileSync(`dist/server/assets/${name}`, 'utf8')).join('\n'); } catch { /* Bundle CSS still renders the components. */ }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(`${appCss}\n${css}`); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"><body style="margin:0;font-family:system-ui,sans-serif"><div id="root"></div><script type="module" src="/harness.js"></script>');
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'ai-elements-'));
let chrome, socket;
const results = {};
try {
  chrome = spawn(process.env.BOT_TEST_CHROME ?? 'google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', data => { stderr += data; });
  const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chromium');
  const targets = await (await fetch(`http://${new URL(debuggerUrl).host}/json/list`)).json();
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
  await new Promise(done => socket.addEventListener('open', done, { once: true }));
  let sequence = 0; const pending = new Map(), errors = [];
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const item = pending.get(msg.id); pending.delete(msg.id); if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result); }
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((done, fail) => { const id = ++sequence; pending.set(id, { resolve: done, reject: fail }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const shot = async name => { const { data } = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(out, `${name}.png`), Buffer.from(data, 'base64')); };
  await send('Runtime.enable'); await send('Page.enable');
  for (const [name, width, height, query] of [['desktop-1440', 1440, 1000, 'elements&dock&expand&owner=elements-desktop'], ['mobile-390', 390, 844, 'elements&expand&owner=elements-phone'], ['mobile-320', 320, 640, 'elements&expand&owner=elements-small']]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
    await send('Page.navigate', { url: `${origin}/harness?${query}` });
    await until(() => evaluate('document.body.dataset.ready === "1"'), `${name} ready`);
    // Expanded rows load their native detail through the normal detail path.
    await until(() => evaluate(`!!document.querySelector('.ai-stack-trace') && !!document.querySelector('.ai-tool') && !!document.querySelector('.ai-subagent')`), `${name} activity details`);
    const found = await evaluate(`(() => {
      const q = s => document.querySelectorAll(s), text = s => document.querySelector(s)?.textContent ?? '';
      const terminal = document.querySelector('.ai-code-block[data-variant=terminal] .ai-code-body')?.textContent ?? '';
      return {
        terminal: q('.ai-code-block[data-variant=terminal]').length, ansiHidden: !terminal.includes('\\u001b'), exitFooters: [...q('.ai-terminal-meta')].map(n => n.textContent),
        stackFrames: q('.ai-stack-trace > .ai-stack-frames > .ai-stack-frame').length, foldedFrames: q('.ai-stack-internal .ai-stack-frame').length, stackMessage: text('.ai-stack-message'),
        toolSections: [...q('.ai-tool-section-title')].map(n => n.textContent), subagent: text('.ai-subagent'), subagentLabel: [...q('.bots-native-work-title')].map(n => n.textContent).includes('Subagent'),
        marker: text('.ai-marker'), reasoning: !!document.querySelector('.bots-native-work .ai-trace-icon'),
        citation: document.querySelector('.ai-inline-citation')?.getAttribute('aria-label'), sources: text('.ai-sources > summary'), suggestions: q('.ai-suggestion').length,
        question: document.querySelector('.bots-request')?.dataset.pattern, questionCount: text('.ai-request-heading small'),
        context: document.querySelector('.ai-context')?.getAttribute('aria-label'),
        pageOverflow: document.scrollingElement.scrollWidth - innerWidth, feedOverflow: (f => f.scrollWidth - f.clientWidth)(document.querySelector('.bots-messages')),
      }; })()`);
    // Expanding/collapsing activity is display only.
    await evaluate(`(async () => { for (const s of document.querySelectorAll('.bots-native-work > summary')) { s.click(); await new Promise(r => setTimeout(r, 30)); s.click(); } })()`);
    await delay(200);
    const sendsAfterToggle = await evaluate('harness.sends.length');
    // Ordinary wheel scrolling up to the activity rows (the feed keeps its own anchors).
    const point = await evaluate(`(() => { const r = document.querySelector('.bots-messages').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    for (const selector of ['.ai-stack-trace', '.ai-tool']) {
      for (let i = 0; i < 60; i++) {
        const top = await evaluate(`(() => { const f = document.querySelector('.bots-messages').getBoundingClientRect(), n = document.querySelector('${selector}')?.getBoundingClientRect(); return n ? n.top - f.top : 0; })()`);
        if (top >= 40) break;
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: -200 }); await delay(50);
      }
      await delay(300);
      await shot(`elements-${name}-${selector === '.ai-tool' ? 'tool' : 'activity'}`);
    }
    // A Suggestion fills the composer for review; it never submits.
    await evaluate(`document.querySelector('.bots-messages').scrollTop = 1e9`); await delay(250);
    await shot(`elements-${name}-answer`);
    // While a genuine question is pending, follow-ups stay unavailable.
    const suggestionBlockedByQuestion = await evaluate(`document.querySelector('.ai-suggestion').disabled`);
    await evaluate('harness.clearPending()');
    await until(() => evaluate(`!document.querySelector('.ai-suggestion')?.disabled && !document.querySelector('.bots-composer textarea')?.disabled`), `${name} composer ready`);
    await evaluate(`document.querySelector('.ai-suggestion').click()`);
    const draft = await until(() => evaluate(`document.querySelector('.bots-composer textarea')?.value || ''`), `${name} prefilled draft`);
    await delay(300);
    await shot(`elements-${name}-suggestion-draft`);
    const sendsAfterSuggestion = await evaluate('harness.sends.length');
    results[name] = { ...found, sendsAfterToggle, suggestionBlockedByQuestion, draft, sendsAfterSuggestion };
  }
  console.log(JSON.stringify({ results, errors, out }, null, 2));
  assert.deepEqual(errors, []);
  for (const [name, r] of Object.entries(results)) {
    assert.ok(r.terminal >= 1 && r.ansiHidden, `${name}: terminal output without escape codes`);
    assert.ok(r.exitFooters.some(t => /^Exit code 1/.test(t)) && r.exitFooters.some(t => /^Exit code 0/.test(t)) && r.exitFooters.some(t => /^Running/.test(t)), `${name}: exit codes from the native items`);
    assert.equal(r.stackFrames, 2, `${name}: own frames listed`);
    assert.equal(r.foldedFrames, 1, `${name}: library frame folded`);
    assert.match(r.stackMessage, /^TypeError/);
    assert.deepEqual(r.toolSections, ['Parameters', 'Result'], `${name}: tool sections`);
    assert.ok(r.subagentLabel && /reviewer/.test(r.subagent), `${name}: subagent provenance`);
    assert.match(r.marker, /Context compacted/);
    assert.ok(r.reasoning);
    assert.equal(r.citation, 'Source 1: ui.shadcn.com');
    assert.equal(r.sources, 'Used 2 sources');
    assert.equal(r.suggestions, 2);
    assert.equal(r.question, 'questionnaire');
    assert.equal(r.questionCount, '2 questions');
    assert.match(r.context ?? '', /^Context 76% used: 151k of 200k tokens/);
    assert.ok(r.pageOverflow <= 0 && r.feedOverflow <= 1, `${name}: no horizontal overflow ${r.pageOverflow}/${r.feedOverflow}`);
    assert.equal(r.sendsAfterToggle, 0, `${name}: expanding activity sent nothing`);
    assert.equal(r.suggestionBlockedByQuestion, true, `${name}: follow-ups wait for the pending question`);
    assert.equal(r.draft, 'Add a guard for the unloaded chapter row.', `${name}: suggestion prefilled the draft`);
    assert.equal(r.sendsAfterSuggestion, 0, `${name}: suggestion did not submit`);
  }
} finally {
  socket?.close(); chrome?.kill('SIGTERM');
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
