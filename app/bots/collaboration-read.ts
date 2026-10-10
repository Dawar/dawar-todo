"use client";
import { useEffect, useRef, useState } from 'react';
import type { BotOperations } from '../../lib/bots-operations';
import { botsClient as client } from './client';

type ReadMethod = 'conversations.list'|'conversations.read'|'conversations.contexts'|'conversations.history'|'conversations.detail'|'conversations.log'|'conversations.requests'|'collaboration.results'|'execution.config';
/** One bounded read per invalidation lane, no native loading or automatic mutations.
 * Never expose a previous owner/context response while a replacement read awaits. */
export function useCollaborationRead<M extends ReadMethod>(owner:string, botId:string, method:M, params:BotOperations[M]['params'], enabled:boolean, roomId?:string, contextId?:string) {
  const key = JSON.stringify([owner,botId,method,params,roomId??null,contextId??null]);
  const [state,setState] = useState<{key:string;value?:BotOperations[M]['result'];error:string;loading:boolean}>({key,error:'',loading:false});
  const [attempt,setAttempt] = useState(0), generation = useRef(0);
  useEffect(() => {
    const id=++generation.current;
    let disposed=false, running=false, dirty=false;
    const current=()=>!disposed && id===generation.current && client.owner===owner;
    const load=async()=> {
      if (!current() || !enabled || !client.online) return;
      if (running) {dirty=true;return;}
      running=true;
      setState(old=>({key,value:old.key===key?old.value:undefined,error:'',loading:true}));
      try {
        const value=await client.rpc<BotOperations[M]['result']>(method,botId,JSON.parse(key)[3],undefined,{owner});
        if (!current()) return;
        if (!value || typeof value!=='object' || new TextEncoder().encode(JSON.stringify(value)).length>160*1024) throw Error('The bounded response could not be verified. Retry this view.');
        setState({key,value,error:'',loading:false});
      } catch(e) {if(current())setState(old=>({key,value:old.key===key?old.value:undefined,error:e instanceof Error?e.message:'This view is unavailable.',loading:false}));}
      finally {running=false;if(dirty&&current()){dirty=false;void load();}}
    };
    let timer:ReturnType<typeof setTimeout>|undefined;
    const observed=new Map<string,string>();
    const invalidate=()=>{timer??=setTimeout(()=>{timer=undefined;void load();},250);};
    const event=(e:import('../../lib/bots-types').BotEvent)=> {
      if (!current()) return;
      if (e.type==='collaboration' || e.type==='collaboration.native' || e.type==='collaboration.request') {
        const data=e.data as {roomId?:string;contextId?:string;botId?:string;context?:unknown;type?:string;data?:{method?:string};operationId?:string;delivery?:unknown;resultIds?:string[]};
        if (roomId && data.roomId!==roomId || contextId && data.contextId && data.contextId!==contextId) return;
        if (!roomId && e.botId && e.botId!==botId && data.botId!==botId) return;
        if(e.type==='collaboration.native') {
          // Body deltas belong to opened native views, never a room/list scan.
          if(!contextId || !['turn/started','turn/completed','item/completed'].includes(data.data?.method??'') && data.type!=='history.refresh')return;
        } else if(data.context && !data.operationId && !data.delivery && !data.resultIds) {
          if(!contextId && method!=='conversations.contexts' && method!=='execution.config')return;
          const id=data.contextId??JSON.stringify((data.context as {id?:string}).id),text=JSON.stringify(data.context);
          if(observed.get(id)===text)return;observed.set(id,text);
        }
        invalidate();
      } else if(method==='execution.config' && (e.type==='bot' || e.type==='work') && e.botId===botId) invalidate();
    };
    client.events.add(event);void load();
    return()=>{disposed=true;if(timer)clearTimeout(timer);client.events.delete(event);};
  },[key,owner,botId,method,enabled,roomId,contextId,attempt]);
  return {...(state.key===key?state:{key,error:'',loading:false}),refresh:()=>setAttempt(n=>n+1),stale:!enabled||!client.online};
}

export function roomPage<T extends {id:string}>(value:unknown, predicate:(item:T)=>boolean):value is import('../../lib/bot-collaboration').CollaborationPage<T> {
  const p=value as import('../../lib/bot-collaboration').CollaborationPage<T>;
  return !!p && new TextEncoder().encode(JSON.stringify(p)).length<=96*1024 && Array.isArray(p.items) && p.items.length<=40 && typeof p.complete==='boolean' && (p.nextCursor===null||typeof p.nextCursor==='string') && new Set(p.items.map(v=>v.id)).size===p.items.length && p.items.every(v=>v&&typeof v.id==='string'&&predicate(v));
}
