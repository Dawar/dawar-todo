// Manual synthetic UI only. No scenarios, assertions, user account or native mutation.
import React, { Activity, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BotsWorkspace } from '../app/bots/workspace';
import { botsClient as client, BotRpcError } from '../app/bots/client';
import { botComposers } from '../app/bots/composer-service';
import { getBotTimeline } from '../app/bots/use-timeline';
const owner=sessionStorage.getItem('night-queue-owner') || `queue-preview-${crypto.randomUUID()}`;
sessionStorage.setItem('night-queue-owner',owner);
client.start=()=>{}; client.owner=owner;client.online=true;
const file={id:'fixture-file',botId:'night-studio',name:'Studio reference.png',mimeType:'image/png',size:1024,ready:true,path:'/synthetic/studio-reference.png',createdAt:'2026-09-28T08:00:00Z'};
const input=text=>[{type:'text',text,text_elements:[]}];
const items=[
  {id:'legacy-1',clientUserMessageId:'legacy-input',input:input('Finish the earlier outline.'),attachments:[]},
  {id:'staged-1',clientUserMessageId:'staged-1',input:input('Review the launch story when this conversation is free.'),attachments:[],state:'queued',revision:1,operationId:null,waitReason:'main-turn-running'},
  {id:'staged-2',clientUserMessageId:'queue-start:failed-fixture',input:[...input('Use this reference for the next draft.'),{type:'localImage',path:file.path}],attachments:[file],state:'failed',revision:1,operationId:'queue-start:failed-fixture',waitReason:'rejected',error:'The model was unavailable before this message could start.'},
  {id:'staged-3',clientUserMessageId:'queue-start:uncertain-fixture',input:input('Check the final wording once more.'),attachments:[],state:'uncertain',revision:1,operationId:'queue-start:uncertain-fixture',waitReason:'delivery-unconfirmed'},
];
let queue=structuredClone(items), failure='none', hold=false;const held=[], calls=[], receipts=new Map();
function Preview(){const [mode,setMode]=useState('visible');useEffect(()=>{window.queuePreview.view=setMode;},[]);return mode==='unmounted'?null:<Activity mode={mode}><BotsWorkspace/></Activity>;}
client.rpc=async(method,botId,params={},id,options)=>{
  calls.push({method,botId,params:structuredClone(params),id,owner:options?.owner});
  if(!client.online)throw new BotRpcError('Synthetic connection is offline.','not-sent');
  if(method==='queue.list')return structuredClone(queue);
  if(['queue.delete','queue.reorder','queue.resume','queue.update','queue.add','runs.acknowledge'].includes(method)&&hold)await new Promise(resolve=>held.push(resolve));
  if(method==='runs.acknowledge'){if(failure!=='none')throw new BotRpcError('Synthetic review response '+failure,failure);return {};}
  if(['queue.delete','queue.reorder','queue.resume','queue.update','queue.add'].includes(method)){
    if(receipts.has(id))return receipts.get(id);
    if(failure==='uncertain')throw new BotRpcError('Synthetic acknowledgement was lost.','uncertain');
    if(failure==='rejected')throw new BotRpcError('Synthetic action was definitely rejected.','rejected');
    let result={};
    if(method==='queue.delete'){queue=queue.filter(x=>x.id!==params.id);result={deleted:true};}
    if(method==='queue.update'){queue=queue.map(x=>x.id===params.id?{...x,state:'queued',revision:x.revision+1,operationId:null,waitReason:'paused',error:null,input:input(params.text)}:x);result={queuedSubmission:queue.find(x=>x.id===params.id)};}
    if(method==='queue.resume')client.snapshot={...client.snapshot,bots:client.snapshot.bots.map(b=>({...b,queuePaused:false}))};
    if(method==='queue.reorder')queue=params.ids.map(id=>queue.find(x=>x.id===id));
    receipts.set(id,result);client.notify();return result;
  }
  const response=await fetch('/rpc',{method:'POST',body:JSON.stringify({method,botId,params})}).then(r=>r.json());
  if(response.error)throw Error(response.error);return response.result;
};
client.download=async()=>({blob:await fetch('/fixture-image').then(r=>r.blob()),name:file.name});
fetch('/fixture').then(r=>r.json()).then(snapshot=>{client.snapshot={...snapshot,bots:snapshot.bots.map(b=>({...b,queuePaused:true}))};history.replaceState({},'','/preview?bot=night-studio');createRoot(document.getElementById('root')).render(<Preview/>);});
window.queuePreview={client,calls,composer:()=>botComposers.peek(owner,'night-studio'),timeline:()=>getBotTimeline(owner,'night-studio'),
  failure(value){failure=value;},
  hold(value=true){hold=value;}, release(outcome='none'){failure=outcome;hold=false;held.splice(0).forEach(resolve=>resolve());},
  owner,

  rows(value){queue=structuredClone(value);for(const listener of client.events)listener({type:'queue',botId:'night-studio',data:{},seq:1});},
  items,
  async echo(id='staged-image',revision=1){const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`night-studio:${id}:${revision}`))),b=>b.toString(16).padStart(2,'0')).join('');const clientId=`queue-start:${hash}`,timeline=getBotTimeline(owner,'night-studio');let sequence=Math.max(100,timeline.getSnapshot().eventCursor);
    timeline.receive({type:'attachment',botId:'night-studio',seq:++sequence,data:file});
    timeline.receive({type:'codex',botId:'night-studio',seq:++sequence,data:{method:'item/completed',params:{turnId:`queued-turn-${id}-${revision}`,item:{type:'userMessage',id:`client:${clientId}`,clientId,content:[{type:'localImage',path:file.path}]}}}});
    timeline.receive({type:'codex',botId:'night-studio',seq:++sequence,data:{method:'item/completed',params:{turnId:`queued-turn-${id}-${revision}`,item:{type:'userMessage',id:`native-user-${id}-${revision}`,clientId,content:[{type:'localImage',path:file.path}]}}}});
  },
};
