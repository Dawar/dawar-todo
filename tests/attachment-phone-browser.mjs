// Native Chrome IDB + real browser image encoding + real serialized route/SQLite contract.
// No production writes, credentials, account, or existing browser profile.
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { attachmentRouteRuntime } from './fixtures/attachment-route-runtime.mjs';
const baselineRef = process.env.PHONE_BASELINE_REF;
const serverRuntime = attachmentRouteRuntime();
const built = (await build({ entryPoints: ['tests/fixtures/attachment-phone-entry.jsx'], bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent', plugins: baselineRef ? [{ name: 'reviewed-source', setup(builder) { builder.onLoad({ filter: /\/app\/.*\.[jt]sx?$/ }, ({ path }) => ({ contents: execFileSync('git', ['show', `${baselineRef}:${relative(process.cwd(), path)}`], { encoding: 'utf8' }), loader: path.endsWith('tsx') ? 'tsx' : 'ts', resolveDir: dirname(path) })); } }] : [] })).outputFiles[0].text;
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><script>window.expectFixed=' + String(!baselineRef) + '</script><script src="/fixture.js"></script>'); return; }
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(built); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const request = new Request('https://synthetic.test' + req.url, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const response = await serverRuntime.fetch(request);
    // Redirect signed storage POSTS into this isolated object store. Signing and
    // server probes still run the real code; no external request is permitted.
    let body = await response.text();
    if (response.headers.get('content-type')?.includes('application/json')) {
      const payload = JSON.parse(body);
      if (payload.uploads) for (const target of Object.values(payload.uploads)) target.url = origin + '/storage';
      body = JSON.stringify(payload);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(body);
  } catch { res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'dawar-phone-regression-'));
let chrome, socket;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label) => { for (let i = 0; i < 400; i++) { const value = await fn(); if (value) return value; await delay(50); } throw new Error('Timed out: ' + label); };
try {
  chrome = spawn('/usr/bin/google-chrome', ['--headless=new','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio: ['ignore','ignore','pipe'] });
  let stderr = ''; chrome.stderr.on('data', d => stderr += d);
  const address = new URL(await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chrome'));
  const targets = await (await fetch(`http://${address.host}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map(); const exceptions = [];
  socket.addEventListener('message', ({ data }) => {
    const m = JSON.parse(data); if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params.exceptionDetails.text);
    else if (m.method === 'Fetch.requestPaused') { const external = new URL(m.params.request.url).origin !== origin; void send(external ? 'Fetch.failRequest' : 'Fetch.continueRequest', { requestId: m.params.requestId, ...(external ? { errorReason: 'BlockedByClient' } : {}) }); }
  });
  const send = (method, params = {}) => new Promise((resolve,reject) => { const id = ++sequence; pending.set(id,{resolve,reject}); socket.send(JSON.stringify({id,method,params})); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true}); if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text); return r.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: 'http*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.navigate', { url: origin }); await until(() => evaluate('window.phoneReady'), 'fixture');
  const result = { source: baselineRef ?? 'working tree', environment: 'fresh Linux Chrome, native IndexedDB/canvas; real routes + synthetic SQLite/object storage; no iPhone or deployed mutation' };
  result.migration = await evaluate('seedPhoneRows()');
  serverRuntime.faults.loseFinalize = true;
  result.lostFinalize = await evaluate('uploadPhoneRows()');
  assert.equal(result.lostFinalize.remaining, 1); assert.equal(result.lostFinalize.rows[0].state, 'retry'); assert.equal(result.lostFinalize.rows[0].lease, false);
  result.retry = await evaluate('retryPhoneRows()'); assert.equal(result.retry.remaining, 0);
  result.calls = Object.fromEntries(['recovery','multipart','prepare','storage','finalize'].map(type => [type,serverRuntime.calls.filter(c=>c.type===type).length]));
  assert.equal(result.calls.multipart,0); assert.equal(result.calls.prepare,5); assert.equal(result.calls.finalize,5);
  result.ready = serverRuntime.sql.prepare("SELECT COUNT(*) AS n FROM todo_attachments WHERE upload_state='ready'").get().n; assert.equal(result.ready,5);
  serverRuntime.faults.capability = 'stale-true';
  result.staleCapability = await evaluate('stageStaleCapability()');
  assert.equal(result.staleCapability.retained, Boolean(baselineRef));
  result.updater = await evaluate('testCommittedLease()'); result.panel = await evaluate('testPanelExpiry()');
  assert.deepEqual(exceptions, []);
  await mkdir('outputs/attachment-phone-regression', { recursive: true });
  await writeFile(`outputs/attachment-phone-regression/browser${baselineRef ? '-before' : ''}.json`, JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result,null,2));
} finally { socket?.close(); chrome?.kill('SIGTERM'); await new Promise(resolve => server.close(resolve)); serverRuntime.close(); await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}); }
