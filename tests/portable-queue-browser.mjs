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
const bundle = await build({ entryPoints: ['tests/fixtures/portable-queue-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
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
const profile = await mkdtemp(join(tmpdir(), 'bot-durability-browser-'));
let chrome, socket;
try {
  chrome = spawn(process.env.BOT_TEST_CHROME ?? '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking', '--disable-sync', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; chrome.stderr.on('data', (data) => { stderr += data; }); chrome.on('error', (error) => { stderr += error.message; });
  const debuggerUrl = await until(() => stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'fresh Chromium');
  const targets = await (await fetch(`http://${new URL(debuggerUrl).host}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let sequence = 0; const pending = new Map(), errors = [], dialogs=[];
  socket.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const item = pending.get(msg.id); pending.delete(msg.id); if(msg.error)item.reject(new Error(JSON.stringify(msg.error)));else item.resolve(msg.result); }
    else if(msg.method==='Page.javascriptDialogOpening')dialogs.push(msg.params);
    else if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  await send('Runtime.enable'); await send('Page.enable'); await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate', { url: origin + '/harness?bot=A' });
  await until(() => evaluate('!!window.portable'), 'workspace bundle');
  await until(()=>evaluate('!!portable.composer()?.ready'),'composer ready');
  await evaluate('portable.type("Travel with me")');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Alt',code:'AltLeft',modifiers:1});
  for (const digit of ['1','2']) await send('Input.dispatchKeyEvent',{type:'keyDown',key:digit,code:`Digit${digit}`,modifiers:1});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Alt',code:'AltLeft',modifiers:0});
  await until(()=>evaluate('location.search.includes("bot=B") && document.querySelector("textarea")?.value==="" && document.querySelector("textarea")?.getAttribute("aria-label")==="Message Bot B"'),'ordinary multi-digit per-bot switch');
  await evaluate('history.pushState({},"","/harness?bot=A");window.dispatchEvent(new PopStateEvent("popstate"))');
  await until(()=>evaluate('document.querySelector("textarea")?.value==="Travel with me"'),'A draft preserved');
  await evaluate('portable.attach()');
  await until(()=>evaluate('portable.draft("A").draft.files[0]?.uploadMode && !portable.draft("A").dirty'),'inflight file saved');
  await send('Browser.grantPermissions',{origin,permissions:['clipboardReadWrite','clipboardSanitizedWrite']});
  await evaluate('navigator.clipboard.writeText("plain clipboard text")');
  await evaluate('document.querySelector(`button[aria-label="Copy composer"]`).click()');
  await until(()=>evaluate('!!portable.clipboard()'),'special composer copied');
  assert.equal(await evaluate('navigator.clipboard.readText()'),'plain clipboard text');
  await evaluate('history.pushState({},"","/harness?bot=B");window.dispatchEvent(new PopStateEvent("popstate"))');
  await until(()=>evaluate('portable.composer()?.botId==="B" && document.querySelector("textarea")?.value===""'),'B independent');
  await evaluate('portable.type("Beta")');
  await evaluate('document.querySelector(`button[aria-label="Paste composer"]`).click()');
  await until(()=>dialogs.length===1,'paste overwrite warning');assert.match(dialogs[0].message,/Replace Bot B/);
  await send('Page.handleJavaScriptDialog',{accept:false});
  assert.equal(await evaluate('document.querySelector("textarea").value'),'Beta');
  await until(()=>evaluate('!document.querySelector(`button[aria-label="Paste composer"]`).disabled'),'paste unlocked after cancel');
  await evaluate('document.querySelector(`button[aria-label="Paste composer"]`).click()');
  await until(()=>dialogs.length===2,'paste warning again');await send('Page.handleJavaScriptDialog',{accept:true});
  await until(()=>evaluate('document.querySelector("textarea").value==="Travel with me" && portable.draft("B").draft.files.length===1'),'explicit paste text and unfinished image');
  assert.equal(await evaluate('portable.draft("A").draft.text'),'Travel with me');
  // Standard text paste remains the native textarea action, never a composer transfer.
  await evaluate('(()=>{const field=document.querySelector("textarea");field.focus();field.setSelectionRange(0,field.value.length);})()');
  await evaluate('document.addEventListener("paste",event=>{portable.textPaste={text:event.clipboardData.getData("text/plain"),prevented:event.defaultPrevented};},true)');
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:2});
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Control',code:'ControlLeft',windowsVirtualKeyCode:17,modifiers:0});
  await until(()=>evaluate('document.querySelector("textarea").value==="plain clipboard text"'),'ordinary text paste').catch(async error=>{console.log(await evaluate('(async()=>JSON.stringify({paste:portable.textPaste,active:document.activeElement?.outerHTML,fields:[...document.querySelectorAll("textarea")].map(f=>({value:f.value,range:[f.selectionStart,f.selectionEnd],visible:!!f.getClientRects().length})),clipboard:await navigator.clipboard.readText()}))()'));throw error;});
  assert.equal(await evaluate('portable.draft("B").draft.files.length'),1);
  await evaluate('portable.type("Moved contents")');
  const moveShortcut=async()=>{await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Alt',code:'AltLeft',modifiers:9});await send('Input.dispatchKeyEvent',{type:'keyDown',key:'@',code:'Digit2',modifiers:9});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Alt',code:'AltLeft',modifiers:0});};
  await moveShortcut();await until(()=>dialogs.length===3,'move overwrite warning');await send('Page.handleJavaScriptDialog',{accept:false});
  assert.equal(await evaluate('location.search.includes("bot=B")'),true);assert.equal(await evaluate('portable.draft("A").draft.text'),'Travel with me');
  await until(()=>evaluate('!document.querySelector(`button[aria-label="Copy composer"]`).disabled'),'move unlocked after cancel');
  await moveShortcut();await until(()=>dialogs.length===4,'move warning again');await send('Page.handleJavaScriptDialog',{accept:true});
  await until(()=>evaluate('location.search.includes("bot=A") && document.querySelector("textarea")?.value==="Moved contents"'),'explicit Shift move selects destination');
  assert.equal(await evaluate('portable.draft("B").draft.text'),'');assert.equal(await evaluate('portable.draft("B").draft.files.length'),0);assert.equal(await evaluate('portable.draft("A").draft.files[0].uploadBotId'),'A');
  await until(()=>evaluate('document.querySelectorAll(".bots-composer-support [data-queue-id]").length===3 && document.querySelector("textarea")?.getAttribute("aria-label")==="Message Bot A" && !document.querySelector(`.bots-composer-support button[aria-label="Move message 3 up"]`).disabled'),'queue rows').catch(async error=>{console.log(await evaluate('JSON.stringify({path:location.search,rows:document.querySelectorAll(".bots-composer-support [data-queue-id]").length,calls:portable.calls,text:document.body.innerText.slice(-1500)})'));console.log(errors);throw error;});
  await evaluate('document.querySelector(`.bots-composer-support button[aria-label="Move message 3 up"]`).click()');
  await until(()=>evaluate('portable.queue.map(q=>q.id).join(",")==="q1,q3,q2" && [...document.querySelectorAll(".bots-composer-support [data-queue-id]")].map(row=>row.dataset.queueId).join(",")==="q1,q3,q2" && !document.querySelector(`.bots-composer-support [data-queue-id="q3"] .bots-queue-drag`).disabled'),'arrow reorder').catch(async error=>{console.log(await evaluate('JSON.stringify({calls:portable.calls.slice(-10),queue:portable.queue.map(q=>q.id),rows:[...document.querySelectorAll(".bots-composer-support [data-queue-id]")].map(row=>({id:row.dataset.queueId,disabled:row.querySelector("button").disabled})),text:document.body.innerText.slice(-1200)})'));console.log(errors);throw error;});
  const point=async(selector)=>evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+Math.min(18,r.height/2)}})()`);
  await evaluate('document.querySelector(".bots-prompt-queue").scrollTop=0');
  await evaluate('document.querySelector(".bots-composer textarea").blur()');await delay(50);
  const from=await point('.bots-composer-support [data-queue-id="q3"] .bots-queue-drag'),to=await point('.bots-composer-support [data-queue-id="q1"]');
  await evaluate('portable.pointerlog=[];for(const type of ["pointerdown","pointermove","pointerup","pointercancel","lostpointercapture"])document.addEventListener(type,event=>portable.pointerlog.push({type,id:event.target.closest?.("[data-queue-id]")?.dataset.queueId,x:event.clientX,y:event.clientY,button:event.button,target:event.target.tagName,cls:String(event.target.className)}),true)');

  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...from});await send('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',...to,buttons:1});await send('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
  await until(()=>evaluate('portable.queue[0].id==="q3"'),'drag reorder').catch(async error=>{console.log(await evaluate('JSON.stringify({pointerlog:portable.pointerlog,queue:portable.queue.map(q=>q.id),calls:portable.calls.slice(-6),points:[...document.querySelectorAll(".bots-composer-support [data-queue-id]")].map(row=>({id:row.dataset.queueId,rect:row.getBoundingClientRect().toJSON()})),panel:document.querySelector(".bots-prompt-queue").getBoundingClientRect().toJSON()})'));throw error;});
  await evaluate('document.querySelector(`.bots-composer-support [data-queue-id="q3"] .bots-queue-actions button`).click()');
  await until(()=>evaluate('document.querySelector("textarea").value==="Third" && portable.queue.length===2'),'checkout normal draft');
  assert.equal(await evaluate('!!document.querySelector(".bots-draft-status")'),false);
  assert.equal(await evaluate('document.querySelectorAll(".bots-scheduled-findings").length'),1);
  assert.equal(await evaluate('document.querySelectorAll(".bots-scheduled-findings .bots-scheduled-message-mark").length'),1);
  assert.equal(await evaluate('document.querySelectorAll(".bots-scheduled-findings .bots-message-markdown p").length'),4);
  assert.equal(await evaluate('document.querySelectorAll(".bots-scheduled-findings li").length'),2);
  await evaluate('document.querySelector(`.bots-composer-support button[aria-label="Open queue lists"]`).click()');
  await until(()=>evaluate('document.querySelector(".bots-details-panel.is-queues")?.getClientRects().length'),'queue lists drawer');
  await evaluate('[...document.querySelectorAll(".bots-details-panel.is-queues .bots-list-tabs button")].find(button=>button.textContent.includes("Nightly Improvements")).click()');
  await until(()=>evaluate('document.querySelector(".bots-details-panel.is-queues .bots-list-detail-heading h4")?.textContent==="Nightly Improvements"'),'direct list tab');
  await evaluate('[...document.querySelectorAll(".bots-details-panel.is-queues .bots-list-detail-heading button")].find(button=>button.textContent.includes("Settings")).click()');
  await until(()=>evaluate('document.querySelector(".bots-list-editor input[type=time]")?.value==="21:00"'),'friendly schedule time');
  assert.equal(await evaluate('[...document.querySelectorAll(".bots-list-editor input")].some(input=>input.value==="America/Toronto")'),true);
  await evaluate('document.querySelector(`button[aria-label="Close bot details"]`).click()');
  await mkdir('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/composer-transfer',{recursive:true});
  const desktopShot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/composer-transfer/desktop.png',Buffer.from(desktopShot.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await delay(100);
  assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true);
  const mobileShot=await send('Page.captureScreenshot',{format:'png'});await writeFile('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/composer-transfer/mobile.png',Buffer.from(mobileShot.data,'base64'));
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({perBotDraftSwitch:true,specialCopyPaste:true,ordinaryTextClipboardUntouched:true,overwriteCancelAndConfirm:true,shiftMoveWithInflightFiles:true,visibleArrowReorder:true,pointerDragReorder:true,checkoutNormalDraft:true,quietComposer:true,directListTabs:true,friendlyScheduleTime:"21:00 America/Toronto",scheduledGroup:1,paragraphs:4,markdownListItems:2,mobileWidth:390,browserErrors:errors},null,2));
} finally {
  socket?.close(); chrome?.kill('SIGTERM');
  if (chrome && chrome.exitCode === null) await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), delay(2000)]);
  if (chrome && chrome.exitCode === null) chrome.kill('SIGKILL');
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 3 });
}
