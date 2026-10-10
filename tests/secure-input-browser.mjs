// Real React workspace + native Chromium IndexedDB, synthetic transport only.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {Store} from '../bot-bridge/store.mjs';import {SecureInputs} from '../bot-bridge/secure-input.mjs';import {secureBrowserFrame} from '../lib/secure-relay.ts';
import { build } from 'esbuild';
import postcss from 'postcss';import tailwind from '@tailwindcss/postcss';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) { for (let i = 0; i < 300; i++) { const value = await fn(); if (value) return value; await delay(30); } throw new Error(`Timed out: ${label}`); }
const bundle = await build({ entryPoints: ['tests/fixtures/secure-input-browser.jsx'], bundle: true, write: false, outdir: 'outputs/browser-test', format: 'esm', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [{ name: 'synthetic-shell', setup(builder) { builder.onLoad({ filter: /app\/site-header\.tsx$/ }, () => ({ contents: 'export function SiteHeader(){return null}', loader: 'tsx' })); } }], logLevel: 'silent' });
const js = bundle.outputFiles.find((file) => file.path.endsWith('.js')).text;
const globalCss=(await postcss([tailwind()]).process(await readFile('app/globals.css','utf8'),{from:'app/globals.css'})).css;
const css = globalCss + (bundle.outputFiles.find((file) => file.path.endsWith('.css'))?.text ?? '');
const stateRoot=await mkdtemp(join(tmpdir(),'secure-browser-state-'));const store=new Store(join(stateRoot,'state.sqlite'));
for(const id of ['A','B'])store.saveBot({id,threadId:`thread-${id}`,cwd:stateRoot,slug:id});
const secure=new SecureInputs({store,relayOnline:true,emitEvent:(type,data,botId)=>store.event({type,data,botId})});
const marker='SYNTHETIC_BROWSER_PRIVATE_1e92237_第二行',owner='synthetic-reply-owner';let failAck=true, encryptedFrames=0;
async function request(op){return secure.request(store.bot('A'),{operationId:op,title:'Private API sign-in',purpose:'Sign in to the synthetic API without placing credentials in chat.',destination:{kind:'https',label:'Synthetic HTTPS API',origin:'https://api.example.test'},fields:[{name:'token',label:'API secret'}],images:[{name:'image',label:'Sensitive image',required:false}]});}
const initial=await request('browser-one');
const server = createServer(async(req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if(path==='/secure-list'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(secure.list(store.bot(new URL(req.url,'http://localhost').searchParams.get('bot')))));return;}
  if(path==='/secure-channel'){try{let text='';for await(const chunk of req){text+=chunk;if(text.length>420000)throw Error('too large');}assert.ok(!text.includes(marker));const frame=secureBrowserFrame({...JSON.parse(text),id:'synthetic-frame'},owner,'synthetic-client');if(frame.action==='chunk')encryptedFrames++;const result=await secure.channel(frame);if(result.received&&failAck){failAck=false;res.statusCode=503;res.end('{}');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}catch{res.statusCode=400;res.end('{}');}return;}
  if (path === '/harness.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); }
  else if (path === '/harness.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
  else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/harness.css"><div id="root"></div><script type="module" src="/harness.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'secure-input-browser-'));
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
  await until(()=>evaluate('window.replies?.composer()?.ready && !!document.querySelector(".bots-secure-card")'),'secure workspace');
  await evaluate('replies.type("Ordinary independent draft"); replies.attach()');await until(()=>evaluate('replies.composer().draft.files[0]?.remote?.ready'),'ordinary file');await evaluate('replies.composer().flush()');
  const open=()=>evaluate('Array.from(document.querySelectorAll(".bots-secure-card button")).find(b=>b.textContent==="Open secure form").click()');
  await open();assert.equal(await evaluate('document.querySelector("input[name=token]").type'),'password');assert.equal(await evaluate('document.querySelector("input[name=allow-model]").checked'),false);
  await evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(marker)}`);
  await evaluate('document.querySelector("input[type=file]").files=(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhkAAAAASUVORK5CYII="),c=>c.charCodeAt(0))],"private-image.png",{type:"image/png"}));return d.files;})();document.querySelector("input[type=file]").dispatchEvent(new Event("change",{bubbles:true}))');
  let storage=await evaluate('secureQA.storage()');assert.ok(!JSON.stringify(storage).includes(marker));assert.ok(!JSON.stringify(storage).includes('private-image.png'));
  await evaluate(`document.querySelector('[aria-label="Close sensitive form"]').click()`);await open();assert.equal(await evaluate('document.querySelector("input[name=token]").value'),'');
  await evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(marker)}`);await navigate('Page.reload',{});
  await until(()=>evaluate('window.replies?.composer()?.ready && !!document.querySelector(".bots-secure-card")'),'reload');await open();assert.equal(await evaluate('document.querySelector("input[name=token]").value'),'');
  assert.equal(await evaluate('replies.composer().draft.text'),'Ordinary independent draft');assert.equal(await evaluate('replies.composer().draft.files.length'),1);
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(marker)}`);await evaluate('document.querySelector(".bots-secure-card").scrollIntoView({block:"start"})');await delay(100);assert.equal(await evaluate('document.documentElement.scrollWidth'),390);
  await mkdir('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/secure-input',{recursive:true});
  await writeFile('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/secure-input/mobile.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('document.querySelector(".bots-secure-form").requestSubmit()');await until(()=>evaluate('document.querySelector(".bots-secure-form [role=alert]")?.textContent.includes("unconfirmed")'),'lost ACK');
  assert.equal(await evaluate('document.querySelector("input[name=token]").value'),marker);assert.equal(await evaluate('document.querySelector("input[name=token]").matches(":disabled")'),true);
  await evaluate('document.querySelector(".bots-secure-form").requestSubmit()');await until(()=>evaluate('!document.querySelector(".bots-secure-form") && document.querySelector(".bots-secure-receipt")?.textContent.includes("Delivered")'),'positive receipt').catch(async error=>{console.log(JSON.stringify({encryptedFrames,states:secure.list(store.bot('A')).map(r=>r.state),ui:await evaluate('Array.from(document.querySelectorAll(".bots-secure-card button,.bots-secure-card [role=alert]")).map(el=>({text:el.textContent,disabled:el.disabled}))')}));throw error;});
  assert.equal(secure.live.get(initial.handle).payload.fields.token,marker);assert.equal(secure.live.get(initial.handle).payload.modelRead,false);assert.equal(encryptedFrames,2);
  assert.equal(await evaluate('replies.composer().draft.text'),'Ordinary independent draft');assert.equal(await evaluate('replies.composer().draft.files.length'),1);assert.equal(await evaluate('replies.calls.filter(c=>c.method==="turn.send"||c.method==="queue.add").length'),0);
  storage=await evaluate('secureQA.storage()');assert.ok(!JSON.stringify(storage).includes(marker));assert.ok(!JSON.stringify(await evaluate('replies.calls')).includes(marker));assert.equal(store.list('attachment').length,0);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});await delay(100);
  await writeFile('/home/dawar/bots/dwight-lead-developer-dawartodo-copy/outputs/secure-input/desktop.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate('Array.from(document.querySelectorAll(".bots-secure-card button")).find(b=>b.textContent.includes("Delete Now")).click()');await until(()=>evaluate('document.querySelector(".bots-secure-receipt")?.textContent.includes("Deleted")'),'human delete');assert.equal(secure.live.has(initial.handle),false);
  const second=await request('browser-two');await navigate('Page.reload',{});await until(()=>evaluate('!!Array.from(document.querySelectorAll(".bots-secure-card button")).find(b=>b.textContent==="Open secure form")'),'fresh request');await open();
  await evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(marker)};replies.select('B')`);await until(()=>evaluate('replies.draft("B")?.ready && !document.querySelector(".bots-secure-form")'),'switch discards sensitive form');
  await evaluate("replies.select('A')");await until(()=>evaluate('!!Array.from(document.querySelectorAll(".bots-secure-card button")).find(b=>b.textContent==="Open secure form")'),'return to secure request');await open();assert.equal(await evaluate('document.querySelector("input[name=token]").value'),'');
  await evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(marker)};document.querySelector('input[name=allow-model]').click()`);await evaluate('document.querySelector("input[type=file]").files=(()=>{const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhkAAAAASUVORK5CYII="),c=>c.charCodeAt(0))],"private-image.png",{type:"image/png"}));return d.files;})();document.querySelector("input[type=file]").dispatchEvent(new Event("change",{bubbles:true}))');await evaluate('document.querySelector(".bots-secure-form").requestSubmit()');await until(()=>evaluate('!document.querySelector(".bots-secure-form")'),'opt in receipt');assert.equal(secure.live.get(second.handle).payload.modelRead,true);assert.equal(secure.live.get(second.handle).payload.images[0].bytes.toString('base64'),'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhkAAAAASUVORK5CYII=');assert.ok(!JSON.stringify(await evaluate('secureQA.storage()')).includes('private-image.png'));
  assert.ok(await evaluate('document.querySelectorAll(".bots-secure-card")[1].textContent.includes("copies survive deletion")'));
  assert.deepEqual(errors,[]);for(const name of await (await import('node:fs/promises')).readdir(stateRoot))assert.ok(!(await readFile(join(stateRoot,name))).includes(Buffer.from(marker)),name);
  console.log('PASS actual React workspace/native Chromium WebCrypto + real volatile bridge: masked/unchecked form, close/reload discard, normal draft/file retained, encrypted lost-ACK retry same receipt, safe receipt/delete, explicit model-read choice, native IDB/local/session/cache/SQLite scans, 390px layout. No live owner mutations or S3 writes.');
} finally {socket?.close();if(chrome?.exitCode===null){const exited=new Promise(resolve=>chrome.once('exit',resolve));chrome.kill('SIGTERM');await exited;}server.close();secure.close();store.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});await rm(stateRoot,{recursive:true,force:true});}
