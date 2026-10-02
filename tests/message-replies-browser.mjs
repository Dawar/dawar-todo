// Real React workspace + native Chromium IndexedDB, synthetic transport only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import postcss from 'postcss';import tailwind from '@tailwindcss/postcss';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await delay(30); } throw new Error(`Timed out: ${label}`); }
const bundle = await build({ entryPoints: ['tests/fixtures/message-replies-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'synthetic-shell', setup(builder) { builder.onLoad({ filter: /app\/site-header\.tsx$/ }, () => ({ contents: 'export function SiteHeader(){return null}', loader: 'tsx' })); } }], logLevel: 'silent' });
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
const globalCss=(await postcss([tailwind()]).process(await readFile('app/globals.css','utf8'),{from:'app/globals.css'})).css;
const css = globalCss + (bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '');
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'message-replies-browser-'));
let chrome, socket;
try {
  chrome = spawn(process.env.BOT_TEST_CHROME ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', (data) => { stderr += data; }); chrome.on('error', (error) => { stderr += error.message; });
  const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'fresh Chromium');
  const targets = await (await fetch(`http://${new URL(debuggerUrl).host}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let loaded; let sequence = 0; const pending = new Map(), errors = [], dialogs=[];
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const item = pending.get(msg.id); pending.delete(msg.id); if(msg.error)item.reject(new Error(JSON.stringify(msg.error)));else item.resolve(msg.result); }
    else if(msg.method==='Page.loadEventFired')loaded?.();
    else if(msg.method==='Page.javascriptDialogOpening')dialogs.push(msg.params);
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  const navigate = async (method, params) => { const done = new Promise(resolve => { loaded = resolve; }); await send(method,params); await done; loaded = null; };
  await navigate('Page.navigate',{url:origin+'/review?bot=A'});
  await until(()=>evaluate('window.replies?.composer()?.ready && !!document.querySelector(`button[aria-label="Reply to message"]`)'),'reply workspace');
  await evaluate('replies.type("Typed message stays"); replies.attach()');
  await until(()=>evaluate('replies.composer().draft.files[0]?.remote?.ready'),'uploaded explicit file');
  await evaluate('document.querySelector(`[data-history-key="turn-answer:answer"] button[aria-label="Reply to message"]`).click()');
  await until(()=>evaluate('!!document.querySelector(`button[aria-label="Cancel reply"]`)'),'quoted preview');
  assert.equal(await evaluate('document.querySelector("textarea").value'),'Typed message stays');
  assert.equal(await evaluate('replies.composer().draft.files.length'),1);
  assert.equal(await evaluate('replies.composer().draft.reply.itemId'),'answer');
  await evaluate('replies.composer().flush()');
  await navigate('Page.reload',{});
  await until(()=>evaluate('window.replies?.composer()?.ready && !!document.querySelector(`button[aria-label="Cancel reply"]`)'),'reload persisted quote');
  assert.equal(await evaluate('replies.composer().draft.reply.itemId'),'answer');
  await evaluate('replies.select("B")');await until(()=>evaluate('replies.draft("B")?.ready'),'other bot');
  await evaluate('replies.type("Independent B"); replies.draft("B").flush()');
  await evaluate('replies.select("A")');await until(()=>evaluate('document.querySelector("textarea")?.value==="Typed message stays"'),'original bot draft');
  assert.equal(await evaluate('replies.composer().draft.reply.itemId'),'answer');
  await evaluate('document.querySelector(`button[aria-label="Cancel reply"]`).click(); replies.composer().flush()');
  assert.equal(await evaluate('document.querySelector("textarea").value'),'Typed message stays');assert.equal(await evaluate('replies.composer().draft.files.length'),1);
  await evaluate('document.querySelector(`[data-history-key="turn-user:user"] button[aria-label="Reply to message"]`).click()');
  await until(()=>evaluate('replies.composer().draft.reply?.itemId==="user"'),'user reply');
  await evaluate('replies.composer().flush(); document.querySelector(`button[aria-label="Queue next message"]`)?.click()');
  // Exercise the actual controller path if the queue button label changes.
  if(!await evaluate('replies.queue.length'))await evaluate('replies.composer().send(true)');
  await until(()=>evaluate('replies.queue.length===1 && replies.composer().draft.text===""'),'queue reply');
  assert.equal(await evaluate('replies.queue[0].reply.itemId'),'user');
  await evaluate('replies.composer().checkout(replies.queue[0])');
  assert.equal(await evaluate('replies.queue.length'),0);assert.equal(await evaluate('replies.composer().draft.reply.itemId'),'user');assert.equal(await evaluate('replies.composer().draft.files.length'),1);
  await evaluate('document.querySelector(`[data-burst-message="member-two"] button[aria-label="Reply to message"]`).click()');
  await until(()=>evaluate('replies.composer().draft.reply?.partId==="member-two"'),'individual burst reply');
  assert.equal(await evaluate('replies.composer().draft.reply.text'),'member two');
  await evaluate('replies.composer().setReply(replies.ref()); replies.composer().flush()');
  await mkdir('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/message-replies',{recursive:true});
  await writeFile('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/message-replies/desktop.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('replies.composer().send()');await until(()=>evaluate('replies.composer().draft.text===""'),'direct reply committed');
  const sendCall=await evaluate('replies.calls.find(c=>c.method==="turn.send")');assert.equal(sendCall.params.reply.itemId,'answer');assert.equal(sendCall.params.text,'Typed message stays');
  await evaluate('replies.timeline().refresh()');
  await until(()=>evaluate('document.querySelectorAll(`button[aria-label="Open quoted message"]`).length>=2'),'sent quote');
  await evaluate('document.querySelector(`[data-history-key="turn-sent:sent"] button[aria-label="Open quoted message"]`).click()');
  await evaluate('document.querySelector(".bots-messages").dispatchEvent(new WheelEvent("wheel",{deltaY:-30,bubbles:true}))');
  await until(()=>evaluate('replies.timeline().getSnapshot().entries.some(e=>e.id==="older")'),'paged source located');
  await delay(150);assert.notEqual(await evaluate('replies.timeline().getSnapshot().position.anchor'),'turn-older:older');
  await evaluate('document.querySelector(`[data-history-key="turn-sent:sent"] button[aria-label="Open quoted message"]`).click()');
  await until(()=>evaluate('replies.timeline().getSnapshot().position.anchor==="turn-older:older"'),'loaded quote jump');
  const node=await evaluate('(()=>{const el=document.querySelector(`[data-history-key="turn-older:older"]`),feed=document.querySelector(".bots-messages");return {top:el?.getBoundingClientRect().top-feed.getBoundingClientRect().top,gaps:replies.timeline().getSnapshot().gaps.length};})()');
  assert.ok(node.top>=0 && node.top<=80,JSON.stringify(node));assert.ok(node.gaps>=1);
  await evaluate('document.querySelector(".bots-jump-latest")?.click()');
  await evaluate('replies.type("Keep missing-source draft"); document.querySelector(`[data-history-key="turn-missing-sent:missing-sent"] button[aria-label="Open quoted message"]`).click()');
  await until(()=>evaluate('document.querySelector(`[data-history-key="turn-missing-sent:missing-sent"]`).textContent.includes("Original message unavailable")'),'unavailable source');
  assert.equal(await evaluate('document.querySelector("textarea").value'),'Keep missing-source draft');
  assert.ok(await evaluate('document.querySelector(`[data-history-key="turn-missing-sent:missing-sent"]`).textContent.includes("Readable saved snapshot")'));
  await evaluate('document.querySelector(`[data-history-key="turn-part-sent:part-sent"] button[aria-label="Open quoted message"]`).click()');
  await until(()=>evaluate('replies.timeline().getSnapshot().position.anchor==="turn-burst:burst"'),'burst member quote jump');
  await delay(100);
  const member=await evaluate('(()=>{const el=document.querySelector(`[data-burst-message="member-two"]`),feed=document.querySelector(".bots-messages");return {top:el.getBoundingClientRect().top-feed.getBoundingClientRect().top,bottom:feed.scrollHeight-feed.clientHeight-feed.scrollTop};})()');assert.ok(member.top>=0&&(member.top<=80||member.bottom<=1),JSON.stringify(member));
  await evaluate('document.querySelector(".bots-jump-latest")?.click()');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate('replies.type("Mobile reply draft"); replies.composer().setReply(replies.ref()); replies.composer().flush()');await delay(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth'),390);
  await writeFile('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/message-replies/mobile.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  assert.deepEqual(errors,[]);console.log('PASS actual React workspace + native Chromium IndexedDB: user/assistant reply; cancel; reload; per-bot drafts; files; queue checkout; direct send; paged source lookup preserves reading gestures, then jumps to visible source; unavailable snapshot/draft retained; burst member reply; 390px no overflow; no runtime errors. Transport synthetic; no live owner mutations.');
} finally {socket?.close();if(chrome?.exitCode===null){const exited=new Promise(resolve=>chrome.once('exit',resolve));chrome.kill('SIGTERM');await exited;}server.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
