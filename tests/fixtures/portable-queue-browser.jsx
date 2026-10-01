import React from 'react';import {createRoot} from 'react-dom/client';
import {BotsWorkspace} from '../../app/bots/workspace';import {botsClient as client} from '../../app/bots/client';import {botComposers} from '../../app/bots/composer-service';
const owner='synthetic-portable-owner';const bots=['A','B'].map((id,i)=>({id,name:`Bot ${id}`,extension:i?12:2,purpose:'Test',slug:id,cwd:'/synthetic',threadId:`thread-${id}`,color:'#216e4e',status:'idle',archived:false,model:null,effort:null,mode:'default',preview:'',updatedAt:'2026-09-26T00:00:00Z',lastReadAt:'2026-09-26T00:00:00Z',activeTurnId:null,queuePaused:true}));
const queue=['First','Second','Third'].map((text,i)=>({id:`q${i+1}`,botId:'A',revision:1,state:'queued',input:[{type:'text',text}],attachments:[]}));const calls=[];
client.start=()=>{};client.owner=owner;client.online=true;client.snapshot={bots,teams:[],pending:[],cursor:0,ready:true,models:[],schedules:[],runs:[],capabilities:{queueLists:1,queueRelativeMoves:1},defaults:{model:'synthetic',effort:'medium'}};
const findings=['First paragraph.\n\nSecond paragraph with **bold**.\n\n- One\n- Two','Another finding\n\nWith a second paragraph.'].map((text,i)=>({id:`f${i}`,turnId:'scheduled-turn',type:'agentMessage',label:'Scheduled finding',item:{type:'agentMessage',id:`f${i}`,text,phase:'final_answer'},complete:true,scheduled:true,status:'completed',startedAt:1700000000,messageAt:1700000000+i,audience:'finding',runId:'one-run'}));
client.rpc=async(method,botId,params={},id)=>{
 calls.push({method,botId,params,id});
 if(method==='history.view')return{kind:'page',entries:findings,attachments:[],olderCursor:null,revision:'r',eventCursor:0,complete:true};
 if(method==='queue.list')return botId==='A'&&!params.listId?[...queue]:[];
 if(method==='queueLists.list')return[{id:'nightly',botId,name:'Nightly Improvements',count:0,revision:1,cron:'0 21 * * *',timeZone:'America/Toronto',enabled:true,nextRunAt:'2026-10-02T01:00:00Z'}];
 if(method==='queue.reorder'){const at=queue.findIndex(q=>q.id===params.id),item=queue.splice(at,1)[0];queue.splice(params.beforeId===null?queue.length:queue.findIndex(q=>q.id===params.beforeId),0,item);return{};}
 if(method==='queue.delete'){queue.splice(queue.findIndex(q=>q.id===params.id),1);return{deleted:true};}
 if(method==='queue.add'){queue.push({id,botId,revision:1,state:'queued',input:[{type:'text',text:params.text}],attachments:[]});return{queuedSubmission:queue.at(-1)};}
 return{};
};
const root=createRoot(document.getElementById('root'));root.render(<BotsWorkspace/>);
window.portable={calls,queue,composer:()=>botComposers.peek(owner,new URL(location.href).searchParams.get('bot')||'A'),type(text){const field=document.querySelector('.bots-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,text);field.dispatchEvent(new Event('input',{bubbles:true}));}};
