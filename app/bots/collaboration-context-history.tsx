"use client";
import { useEffect, useMemo, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import type { CollaborationContext } from '../../lib/bot-collaboration';
import type { HistoryEntry, HistoryPage } from '../../lib/bot-history-view';
import type { ThreadItem } from '../../lib/codex-protocol/v2/ThreadItem';
import type { BotAttachment, BotRequest } from '../../lib/bots-types';
import { historyKey } from '../../lib/bot-history-view';
import { botsClient as client } from './client';
import { useCollaborationRead,roomPage } from './collaboration-read';
import { TimelineEntry } from './timeline';
import { LazyDetails } from './lazy-details';
import { ConfigurationEvidence } from './configuration-evidence';
import { RequestCard } from './request-card';
import { useRunAction } from './run-action';
import { ActionNotice } from './collaboration-rooms';
import { updateRunPage } from './run-page-events';
import { reduceItemEvent, type NativeEvent } from './thread-state';
import type { BotOperations } from '../../lib/bots-operations';

/** Room-only opened bodies, no foreground reader/cache/stream namespace. */
class RoomDetailReader {
  private dead=false;
  private version=0;
  snapshot=()=>this.version;
  private listeners=new Set<()=>void>();
  private items=new Map<string,ThreadItem>();
  private pending=new Map<string,Promise<ThreadItem>>();
  private readers=new Map<string,number>();
  private errors=new Map<string,string>();
  private sequences=new Map<string,number>();
  receive=(event:import("../../lib/bots-types").BotEvent)=>{
    const d=event.data as {roomId?:string;contextId?:string;threadId?:string;turnId?:string;type?:string;data?:NativeEvent};
    if(this.dead||client.owner!==this.owner||event.botId!==this.botId||event.type!=="collaboration.native"||d.roomId!==this.context.roomId||d.contextId!==this.context.id||d.threadId!==this.context.threadId)return;
    for(const key of new Set([...this.items.keys(),...this.pending.keys()])){
      const [turnId,itemId]=JSON.parse(key) as string[];
      const nativeId=d.data?.params?.itemId??d.data?.params?.item?.id??(d.data as unknown as {itemId?:string})?.itemId;
      if(nativeId&&nativeId!==itemId)continue;
      if(turnId!==d.turnId||event.seq<=(this.sequences.get(key)??-1))continue;
      this.sequences.set(key,event.seq);
      const item=this.items.get(key);
      if(d.type==="codex"&&item&&d.data?.params){const completed=d.data.method==='item/completed'&&d.data.params.item?.id===itemId?d.data.params.item:null;const next=completed??reduceItemEvent(item,d.data);this.items.set(key,next.type==="reasoning"?{...next,content:[]}:next);}
      else if(d.type==="history.refresh"){this.items.delete(key);this.errors.set(key,"Opened detail changed; refresh its original source.");}
    }this.notify();
  };
  private active=0;
  private waiting:(()=>void)[]=[];
  attachments:BotAttachment[]=[];
  constructor(readonly owner:string,readonly botId:string,readonly context:Pick<CollaborationContext,"id"|"roomId"|"threadId">){}
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  subscribeDetail=(entry:Pick<HistoryEntry,'turnId'|'id'>,fn:()=>void)=>{const key=JSON.stringify([entry.turnId,entry.id]);this.readers.set(key,(this.readers.get(key)??0)+1);const off=this.subscribe(fn);return()=>{off();const n=(this.readers.get(key)??1)-1;if(n)this.readers.set(key,n);else{this.readers.delete(key);this.items.delete(key);}};};
  detailItem=(e:HistoryEntry)=>this.items.get(JSON.stringify([e.turnId,e.id]))??null;
  detailPending=(e:HistoryEntry)=>this.pending.has(JSON.stringify([e.turnId,e.id]));
  detailError=(e:HistoryEntry)=>this.errors.get(JSON.stringify([e.turnId,e.id]))??'';
  private notify(){this.version++;this.listeners.forEach(fn=>fn());}
  private current(key:string){if(this.dead||client.owner!==this.owner||!this.readers.has(key))throw Error('This room detail closed or changed. Reopen its original context.');}
  detail=(entry:HistoryEntry):Promise<ThreadItem>=>{
    const key=JSON.stringify([entry.turnId,entry.id]),existing=this.pending.get(key);if(existing)return existing;
    if(this.readers.size>8)return Promise.reject(Error('Close a work detail before opening another.'));
    const work=(async()=>{
      if(this.active>=2)await new Promise<void>(resolve=>this.waiting.push(resolve));
      this.active++;
      try {
        this.current(key);const observed=this.sequences.get(key);if(!client.online)throw Error('Reconnect to read this room detail.');
        let json='',offset=0,version:string|undefined;
        do {
          const p=await client.rpc<BotOperations['conversations.detail']['result']>('conversations.detail',this.botId,{contextId:this.context.id,turnId:entry.turnId,itemId:entry.id,offset,...(version?{version}:{})},undefined,{owner:this.owner});
          this.current(key);
          if(this.sequences.get(key)!==observed)throw Error("Native detail changed while reading. Refresh the original item.");
          if(p.context.id!==this.context.id||p.context.roomId!==this.context.roomId||p.context.botId!==this.botId||p.context.threadId!==this.context.threadId||typeof p.json!=='string'||version&&p.version!==version)throw Error('Room detail scope/version changed. Refresh this item.');
          // The existing service chunks large items. Never show partial raw JSON or hidden reasoning.
          version=p.version;json+=p.json;
          if(json.length>8*1024*1024)throw Error('This detail exceeds the bounded display body. Its source is retained; ask for a smaller published artifact.');
          this.attachments=[...new Map([...this.attachments,...(p.attachments??[])].map(a=>[a.id,a])).values()];
          if(p.nextOffset===null)break;
          if(!Number.isSafeInteger(p.nextOffset)||p.nextOffset<=offset||p.nextOffset!==json.length)throw Error('Room detail paging did not advance.');
          offset=p.nextOffset;
        }while(true);
        const item=JSON.parse(json) as ThreadItem;if(item.id!==entry.id||item.type!==entry.type)throw Error('The original native item identity changed.');
        const visible=item.type==='reasoning'?{...item,content:[]}:item;this.items.set(key,visible);this.errors.delete(key);return visible;
      }finally{this.active--;this.waiting.shift()?.();}
    })().catch(e=>{if(!this.dead&&client.owner===this.owner)this.errors.set(key,String(e));throw e;}).finally(()=>{this.pending.delete(key);this.notify();});
    this.pending.set(key,work);this.notify();return work;
  };
  dispose(){this.dead=true;this.items.clear();this.readers.clear();this.listeners.clear();}
}
function ContextQuestion({owner,botId,value,online}:{owner:string;botId:string;value:BotOperations['conversations.requests']['result']['items'][number];online:boolean}) {
  const action=useRunAction(owner,botId,`room-question:${value.contextId}:${value.key}`);
  const pending:BotRequest={key:value.key,botId,threadId:value.threadId,request:value.request,createdAt:''};
  const secret=value.request.method==='item/tool/requestUserInput'&&value.request.params.questions.some(q=>q.isSecret);
  if(secret)return <p>Private answers require the foreground encrypted form; this room cannot request or store them.</p>;
  return <div><RequestCard pending={pending} memoryKey={JSON.stringify([owner,botId,value.roomId,value.contextId,value.key])} disabled={!online||value.unavailable||action.busy||!!action.intent||action.accepted} respond={result=>action.perform('requests.respond',{key:value.key,result})}/>{value.unavailable&&<p>The original synchronous question is unavailable after reconnect. It was not answered or recreated.</p>}<ActionNotice action={action} online={online}/></div>;
}
function ContextLog({owner,botId,context,entry,online,reader,download}:{owner:string;botId:string;context:CollaborationContext;entry:HistoryEntry;online:boolean;reader:RoomDetailReader;download:(id:string)=>void}) {
  const [cursor,setCursor]=useState<string|null>(null);
  const read=useCollaborationRead(owner,botId,'conversations.log',{contextId:context.id,turnId:entry.turnId,...(cursor?{cursor}:{})},online,context.roomId,context.id);
  const valid=read.value?.context.id===context.id&&read.value.context.threadId===context.threadId&&read.value.entries.every(e=>e.turnId===entry.turnId);
  return <div>{valid&&read.value!.entries.map(e=><TimelineEntry key={historyKey(e.turnId,e.id)} entry={{...e,deferredTurn:false}} timeline={reader} attachments={read.value!.attachments} download={download}/>)}{read.error&&<p role="alert">{read.error}</p>}<button disabled={!online||read.loading} onClick={read.refresh}>Refresh work page</button><button disabled={!valid||!read.value!.olderCursor||read.loading} onClick={()=>setCursor(read.value!.olderCursor)}>Earlier work items</button></div>;
}
export function CollaborationContextHistory({owner,botId,context,online,turnId}:{owner:string;botId:string;context:CollaborationContext;online:boolean;turnId?:string}) {
  const [cursors,setCursors]=useState<(string|null)[]>([null]),[live,setLive]=useState<{base:unknown;page:HistoryPage;error:string}|null>(null),[requestCursors,setRequestCursors]=useState<(string|null)[]>([null]);
  const enabled=online&&context.provisioning==='bound'&&!!context.threadId;
  const read=useCollaborationRead(owner,botId,'conversations.history',{contextId:context.id,...(turnId?{turnId}:{}),...(cursors.at(-1)?{cursor:cursors.at(-1)!}:{})},enabled,context.roomId,context.id);
  const requests=useCollaborationRead(owner,botId,'conversations.requests',{contextId:context.id,limit:40,...(requestCursors.at(-1)?{cursor:requestCursors.at(-1)!}:{})},enabled,context.roomId,context.id);
  const reader=useMemo(()=>new RoomDetailReader(owner,botId,{id:context.id,roomId:context.roomId,threadId:context.threadId}),[owner,botId,context.id,context.roomId,context.threadId]);
  useSyncExternalStore(reader.subscribe,reader.snapshot,reader.snapshot);
  useEffect(()=>{client.events.add(reader.receive);return()=>{client.events.delete(reader.receive);reader.dispose();};},[reader]);
  const alive=useRef(true),downloadGeneration=useRef(0);
  useEffect(()=>{alive.current=true;const generation=downloadGeneration.current+1;downloadGeneration.current=generation;return()=>{alive.current=false;downloadGeneration.current=generation+1;};},[owner,botId,context.id,context.threadId]);
  const [downloadError,setDownloadError]=useState('');
  const download=useCallback((id:string)=>{setDownloadError('');const captured=downloadGeneration.current;void client.download(botId,id,owner).then(({blob,name})=>{if(!alive.current||client.owner!==owner||captured!==downloadGeneration.current)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60_000);}).catch(e=>{if(alive.current&&client.owner===owner)setDownloadError(String(e));});},[botId,owner]);
  const valid=read.value?.context.id===context.id&&read.value.context.botId===botId&&read.value.context.threadId===context.threadId&&Array.isArray(read.value.entries);
  useEffect(()=>{
    const raw=read.value as unknown as Partial<HistoryPage>;
    if(!valid||!Number.isSafeInteger(raw?.eventCursor))return;
    let page:HistoryPage={...raw,entries:read.value!.entries,contextEntries:read.value!.contextEntries,attachments:read.value!.attachments,olderCursor:read.value!.olderCursor,complete:read.value!.complete,eventCursor:raw.eventCursor!,revision:raw.revision??'',context:{runId:null,laneId:context.id,threadId:context.threadId!}};
    let frame=0,queued:import('../../lib/bots-types').BotEvent[]=[],closed=false;
    const receive=(event:import('../../lib/bots-types').BotEvent)=>{
      const d=event.data as {contextId?:string;roomId?:string;threadId?:string;turnId?:string;type?:string;data?:unknown};
      if(closed||client.owner!==owner||event.type!=='collaboration.native'||event.botId!==botId||d.contextId!==context.id||d.roomId!==context.roomId||d.threadId!==context.threadId||!d.turnId||turnId&&d.turnId!==turnId||!page.entries.some(e=>e.turnId===d.turnId))return;
      if(queued.length>=64)return; // Refresh invalidation also reconciles overflow; never a transcript scan.
      queued.push({...event,type:d.type==='history.refresh'?'run.state':'run.codex',data:{runId:null,laneId:context.id,threadId:context.threadId,...(d.type==='history.refresh'?{historyRefresh:d.data}:{message:d.data})}});
      frame ||= requestAnimationFrame(()=>{frame=0;const updates=queued;queued=[];try{for(const update of updates){const value=update.data as {message?:NativeEvent;historyRefresh?:{turnId?:string}};const id=value.message?.params.turnId??value.message?.params.turn?.id??value.historyRefresh?.turnId;page=updateRunPage(page,[update],id,cursors.length===1);}setLive({base:read.value,page,error:''});}catch(e){setLive({base:read.value,page,error:String(e)});}});
    };client.events.add(receive);return()=>{closed=true;client.events.delete(receive);if(frame)cancelAnimationFrame(frame);};
  },[read.value,valid,owner,botId,context.id,context.roomId,context.threadId,turnId,cursors.length]);
  const projected=live&&live.base===read.value?live.page:read.value;
  const entries=valid?[...new Map([...(projected?.entries??[]),...(projected?.contextEntries??[])].map(e=>[historyKey(e.turnId,e.id),e])).values()]:[];
  return <div className="bots-room-native-history">{!context.threadId&&<p>Context prepared; no native thread is bound yet.</p>}{read.loading&&<p role="status">Loading bounded native history…</p>}{read.error&&<p role="alert">{read.error}</p>}
    {live?.base===read.value&&live?.error&&<p role="alert">{live.error}<button onClick={read.refresh}>Refresh bounded history</button></p>}
    <nav><button disabled={cursors.length<2||read.loading} onClick={()=>setCursors(v=>v.slice(0,-1))}>Return to newer history</button><button disabled={!valid||!read.value!.olderCursor||read.loading} onClick={()=>setCursors(v=>[...v,read.value!.olderCursor])}>Earlier native history</button><button disabled={!enabled||read.loading} onClick={read.refresh}>Refresh history</button></nav>
    {entries.map(entry=><div key={historyKey(entry.turnId,entry.id)}>{entry.deferredTurn?<LazyDetails summary={`Activity · ${entry.label}`} className="bots-activity">{()=> <ContextLog owner={owner} botId={botId} context={context} entry={entry} online={online} reader={reader} download={download}/>}</LazyDetails>:<TimelineEntry entry={entry} timeline={reader} attachments={[...read.value!.attachments,...reader.attachments]} download={download}/>}{entry.item?.type==='agentMessage'&&entry.item.phase==='final_answer'&&<ConfigurationEvidence value={read.value!.turnConfigurations.find(c=>c.threadId===context.threadId&&c.turnId===entry.turnId)} label="Recorded turn settings"/>}</div>)}
    {roomPage<BotOperations['conversations.requests']['result']['items'][number]>(requests.value,q=>q.botId===botId&&q.contextId===context.id&&q.roomId===context.roomId&&q.threadId===context.threadId)&&requests.value!.items.map(q=><ContextQuestion key={q.id} owner={owner} botId={botId} value={q} online={online}/>)}{requests.error&&<p role="alert">{requests.error}</p>}<nav aria-label="Room questions"><button disabled={requestCursors.length<2||requests.loading} onClick={()=>setRequestCursors(v=>v.slice(0,-1))}>Previous questions</button><button disabled={!requests.value?.nextCursor||requests.loading} onClick={()=>setRequestCursors(v=>[...v,requests.value!.nextCursor])}>More questions</button></nav>
    {downloadError&&<p role="alert">{downloadError}</p>}<small>Original context {context.id} · thread {context.threadId??'not bound'}. Quoting or copying uses the original source; room history never merges into foreground.</small>
  </div>;
}
