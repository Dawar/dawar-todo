// Manual UI inspection only: temporary SQLite, synthetic native pages, isolated Chrome.

import { EventEmitter } from 'node:events';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
const nativeRoot=await mkdtemp(join(tmpdir(),'feed-native-preview-'));
const store=new Store(join(nativeRoot,'state.sqlite')), codex=new EventEmitter();
const user = (id,text,clientId=id) => ({ type:'userMessage',id,clientId,content:[{type:'text',text,text_elements:[]}] });
const answer = (id,text) => ({ type:'agentMessage',id,text,phase:'final_answer',memoryCitation:null,questions:null,delivery:null });
const turns=[], runs=[];
let clock=Date.parse('2026-09-24T08:00:00Z');
function routine(i, mixed=false, finding=false) {
  const id=`run-${i}`, turnId=`scheduled-${i}`, startedAt=Math.floor(clock/1000);clock+=3600000;
  const items=[user(`trigger-${i}`,'Review the studio schedule and note meaningful changes.',`schedule:${id}`),
    {type:'reasoning',id:`thought-${i}`,summary:['Check the upcoming dates before preparing the summary.'],content:['Synthetic private field; never displayed.']},
    {type:'commandExecution',id:`tool-${i}`,command:'Read the project calendar',status:'completed',aggregatedOutput:'Synthetic calendar details. '.repeat(1500)},
    answer(`routine-${i}`,'### Everything is on track\n\nNo changes to the studio schedule. The next review is tomorrow.')];
  if(mixed)items.push(user(`mixed-human-${i}`,'Could we leave Friday open?'),answer(`mixed-answer-${i}`,'Absolutely. **Friday stays open** for a little room to think.'));
  if(finding)items.push({type:'dynamicToolCall',id:`finding-${i}`,tool:'bots_report_result',status:'completed',success:true,arguments:{key:'design-review',summary:'### A date worth a look\n\nThe design review moved to **Thursday at 10**. Your Friday remains open.'},contentItems:[],durationMs:2});
  turns.push({id:turnId,status:'completed',startedAt,itemsView:'full',items});
  runs.push({id,botId:'night-studio',scheduleId:'studio-check',title:i%3===0?'Weekly planning check':'Studio calendar review',status:i===202?'failed':'completed',scheduledAt:new Date(startedAt*1000).toISOString(),startedAt:new Date(startedAt*1000).toISOString(),finishedAt:new Date((startedAt+12)*1000).toISOString(),error:i===202?'The calendar could not be reached. Your next scheduled check is still set.':null,turnId});
}
for(let i=0;i<60;i++) {
  const startedAt=Math.floor(clock/1000);clock+=3600000;
  turns.push({id:`human-${i}`,status:'completed',startedAt,itemsView:'full',items:[user(`user-${i}`,i===59?'Help me make room for the work that matters this week.':`Let’s refine the studio plan, part ${i+1}.`),
    {type:'reasoning',id:`reasoning-${i}`,summary:['Keep the plan focused, with space for unplanned work.'],content:['Synthetic private field.']},
    answer(`answer-${i}`,i===59?'### A lighter week, with a little more focus\n\nStart with one meaningful outcome: **finish the launch story**. Give it your best hour before the small things take over.\n\n- **Monday:** shape the idea.\n- **Tuesday:** write the first draft.\n- **Wednesday:** share it with someone whose taste you trust.\n\nLeave a little white space. A good plan should help you breathe.':`Part ${i+1} is ready. Keep one clear priority, then make space for the rest.`)]});
  routine(i*2,i===58);routine(i*2+1);
}
for(let i=200;i<255;i++)routine(i,false,i===253);
runs.at(-1).status='running';runs.at(-1).finishedAt=null;turns.at(-1).status='inProgress';
const bot={id:'night-studio',threadId:'night-studio',name:'Studio · Planning & ideas',purpose:'A little clarity for your next big thing.',cwd:nativeRoot,slug:'night-studio',archived:false,updatedAt:'2026-09-28T08:00:00Z',status:'working',activeTurnId:'scheduled-254',model:'gpt-6',effort:'high',mode:'default',color:'#3d8065'};
const snapshot={bots:[bot],pending:[],cursor:0,ready:true,models:[{id:'gpt-6',model:'gpt-6',displayName:'GPT-6',supportedReasoningEfforts:[{reasoningEffort:'high'}],serviceTiers:[{id:'fast'}]}],schedules:[{id:'studio-check',botId:bot.id,title:'Studio calendar review',enabled:true,nextRunAt:'2026-10-04T09:00:00Z'}],runs:runs.slice(-25).reverse(),defaults:{model:'gpt-6',effort:'high'}};
const nativeCalls=[];
codex.call=async(method,params)=>{nativeCalls.push({method,params});if(method==='thread/resume')return {};const start=Number(params.cursor||0);return {data:[...turns].reverse().slice(start,start+params.limit),nextCursor:start+params.limit<turns.length?String(start+params.limit):null};};
const runtime=new BotRuntime({store,codex,root:nativeRoot});
store.saveBot(bot);runtime.loaded.add(bot.threadId);for(const run of runs)store.put('run',run);
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
const bundle=await build({entryPoints:[process.argv.includes('--queue') ? 'diagnostics/night-queue-fixture.jsx' : 'diagnostics/night-conversation-fixture.jsx'],bundle:true,write:false,outdir:'outputs/browser-preview',format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},plugins:[{name:'preview-shell',setup(b){b.onLoad({filter:/app\/app-shell\.tsx$/},()=>({contents:'export const useShellNavigation = () => () => false;',loader:'tsx'}));b.onResolve({filter:/^next\/link$/},()=>({path:'link',namespace:'preview'}));b.onLoad({filter:/.*/,namespace:'preview'},()=>({contents:'import React from "react"; export default function Link({prefetch,...props}) {return <a {...props}/>}',loader:'jsx',resolveDir:process.cwd()}));}}],logLevel:'silent'});
js=bundle.outputFiles.find(f=>f.path.endsWith('.js')).text;css=(await postcss([tailwind()]).process(await readFile('app/globals.css','utf8'),{from:resolve('app/globals.css')})).css+'\n'+bundle.outputFiles.find(f=>f.path.endsWith('.css')).text;
}
await compile();
const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname;res.setHeader('Cache-Control','no-store');
  if(path==='/rpc') { let body='';for await(const chunk of req)body+=chunk;
    try {const request=JSON.parse(body);const allowed=['history.view','history.detail','runs.page'];
      const result=request.method==='snapshot'?snapshot:allowed.includes(request.method)?await runtime.handle(request):request.method==='usage.account'?{limits:[],ordinaryUsageAllowed:true}:[];
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({result}));
    }catch(error){res.end(JSON.stringify({error:error.message}));}
  } else if(path==='/fixture-image'){res.setHeader('Content-Type','image/png');res.end(await readFile('public/icons/icon-192.png'));}
  else if(path==='/fixture')res.end(JSON.stringify(snapshot));
  else if(path==='/native-info')res.end(JSON.stringify({nativeCalls,turns:turns.length,runs:runs.length}));
  else if(path==='/rebuild'){await compile();res.end('rebuilt');}
  else if(path==='/preview.js'){res.setHeader('Content-Type','application/javascript');res.end(js);}
  else if(path==='/preview.css'){res.setHeader('Content-Type','text/css');res.end(css);}
  else res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/preview.css"><div id="root"></div><script src="/preview.js"></script>');
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=await mkdtemp(join(tmpdir(),'bot-typing-preview-'));
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--disable-background-networking','--disable-sync','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let logs='';chrome.stderr.on('data',async data=>{logs+=data;const match=logs.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(!match)return;const targets=await(await fetch(`http://${new URL(match[1]).host}/json/list`)).json();await writeFile('outputs/bot-typing-recent/connection.json',JSON.stringify({origin:`http://127.0.0.1:${server.address().port}`,socket:targets.find(t=>t.type==='page').webSocketDebuggerUrl}));});
const shutdown=async()=>{chrome.kill('SIGTERM');server.close();store.close();await rm(nativeRoot,{recursive:true,force:true});await new Promise(r=>setTimeout(r,600));await rm(profile,{recursive:true,force:true,maxRetries:3});process.exit();};
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
console.log(`Disposable manual Conversation/Activity preview: http://127.0.0.1:${server.address().port}/preview?bot=night-studio\nNo scenarios or assertions are run. window.night exposes the disposable client. CDP connection: outputs/bot-typing-recent/connection.json`);
