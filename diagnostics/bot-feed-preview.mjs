import { syntheticConversation } from './bot-feed-data.mjs';
import { EventEmitter } from 'node:events';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
const nativeRoot=await mkdtemp(join(tmpdir(),'feed-native-preview-'));
const store=new Store(join(nativeRoot,'state.sqlite')), codex=new EventEmitter();
const turns = syntheticConversation();
const nativeCalls=[];
codex.call=async(method,params)=>{nativeCalls.push({method,params});if(method==='thread/resume')return {};const start=Number(params.cursor||0);return {data:[...turns].reverse().slice(start,start+params.limit),nextCursor:start+params.limit<turns.length?String(start+params.limit):null};};
const runtime=new BotRuntime({store,codex,root:nativeRoot});
for(const id of ['design-a','design-b']){store.saveBot({id,threadId:id,name:'Synthetic',cwd:nativeRoot,slug:id,archived:false,updatedAt:'stable'});runtime.loaded.add(id);}
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { readFile, writeFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
await mkdir('outputs/bot-typing-recent', { recursive: true });
let js='',css='';
async function compile(){
const bundle=await build({entryPoints:['diagnostics/bot-feed-fixture.jsx'],bundle:true,write:false,outdir:'outputs/browser-preview',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'preview-shell',setup(b){b.onLoad({filter:/app\/app-shell\.tsx$/},()=>({contents:'export const useShellNavigation = () => () => false;',loader:'tsx'}));b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'preview'}));b.onLoad({filter:/.*/,namespace:'preview'},()=>({contents:'import React from "react"; export default function Link({prefetch,...props}) {return <a {...props}/>}',loader:'jsx',resolveDir:process.cwd()}));}}],logLevel:'silent'});
js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;css=(await postcss([tailwind()]).process(await readFile('app/globals.css','utf8'),{from:resolve('app/globals.css')})).css+'\n'+bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
}
await compile();
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('Cache-Control','no-store');if(path==='/history-rpc'){let body='';for await(const chunk of req)body+=chunk;try{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await runtime.handle(JSON.parse(body))));}catch(error){res.end(JSON.stringify({error:error.message}));}}else if(path==='/native-info'){res.end(JSON.stringify({nativeCalls,rawPageBytes:Buffer.byteLength(JSON.stringify(turns.slice(-25))),turns:turns.length}));}else if(path==='/rebuild'){await compile();res.end('rebuilt');}else if(path==='/preview.js'){res.setHeader('Content-Type','application/javascript');res.end(js);}else if(path==='/preview.css'){res.setHeader('Content-Type','text/css');res.end(css);}else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/preview.css"><div id="root"></div><script src="/preview.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=await mkdtemp(join(tmpdir(),'bot-typing-preview-'));
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let logs='';chrome.stderr.on('data',async data=>{logs+=data;const match=logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(!match)return;const targets=await(await fetch(`http://${new URL(match[1]).host}/json/list`)).json();await writeFile('outputs/bot-typing-recent/connection.json',JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,socket:targets.find(t=>t.type==='page').webSocketDebuggerUrl}));});
const shutdown=async()=>{chrome.kill('SIGTERM');server.close();store.close();await rm(nativeRoot,{recursive:true,force:true});await new Promise(r=>setTimeout(r,600));await rm(profile,{recursive:true,force:true,maxRetries:3});process.exit();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
console.log(`Disposable synthetic preview: http://127.0.0.1:${server.address().port}/preview?bot=design-a\nOpen the console and run await feed.open(). CDP connection: outputs/bot-typing-recent/connection.json`);
