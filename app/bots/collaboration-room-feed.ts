"use client";
import { useEffect,useMemo,useSyncExternalStore } from 'react';
import type { BotEvent } from '../../lib/bots-types';
import type { BotOperations } from '../../lib/bots-operations';
import type { CollaborationRecentParams } from '../../lib/bot-collaboration';
import { botsClient as client } from './client';
import { roomPage } from './collaboration-read';
type Page=BotOperations['conversations.read']['result'];
/** Bounded chronological room window. Older/catch-up cursors have independent
 * meanings; no partial response proves deletion. All writes remain elsewhere. */
class RoomFeed {
  value?:Page; loading=false;error='';newerAvailable=false;following=true;
  anchor:{id:string;offset:number}|null=null;
  get canCatchUp(){return this.latestWindow;}
  reconnect(){if(!this.value)return this.latest();this.newerAvailable=true;this.notify();if(this.following&&this.latestWindow)return this.newer();return Promise.resolve();}
  private pageParams:CollaborationRecentParams={view:'latest'};
  private dead=false;private generation=0;private revision=0;private latestWindow=true;private newerCursor:string|undefined;private pending=false;private seq=-1;
  private listeners=new Set<()=>void>();private timer:ReturnType<typeof setTimeout>|undefined;
  constructor(readonly owner:string,readonly botId:string,readonly roomId:string){}
  remember(following:boolean,anchor:{id:string;offset:number}|null){this.following=following;this.anchor=anchor;}
  browseOlder(){this.following=false;this.anchor=null;return this.older();}
  snapshot=()=>this.revision;
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  private notify(){this.revision++;this.listeners.forEach(fn=>fn());}
  private current(){return !this.dead&&client.owner===this.owner;}
  activate(){this.dead=false;}
  receive=(event:BotEvent)=>{
    const d=event.data as {roomId?:string;operationId?:string;delivery?:Page['deliveries'][number]};
    if(!this.current()||event.type!=='collaboration'||d.roomId!==this.roomId||event.seq<=this.seq)return;this.seq=event.seq;
    if(d.delivery&&this.value?.items.some(p=>p.id===d.delivery!.postId)&&d.delivery.roomId===this.roomId&&this.value.room.members.includes(d.delivery.botId)){
      this.value={...this.value,deliveries:[...this.value.deliveries.filter(v=>v.id!==d.delivery!.id),d.delivery]};this.notify();
    }
    if(!d.operationId)return; // Repeated context status isn't a room-body read.
    this.invalidate();
  };
  invalidate=()=>{if(!this.current())return;this.newerAvailable=true;this.notify();if(this.following&&this.latestWindow&&!this.timer)this.timer=setTimeout(()=>{this.timer=undefined;void this.newer();},250);};
  private async load(params:CollaborationRecentParams,append=false){
    if(this.loading){this.pending=true;return;}
    if(!this.current()||!client.online)return;
    const generation=++this.generation;this.loading=true;this.error='';this.notify();
    try {
      const value=await client.rpc<BotOperations['conversations.read']['result']>('conversations.read',this.botId,{roomId:this.roomId,limit:40,...params},undefined,{owner:this.owner});
      if(!this.current()||generation!==this.generation)return;
      if(!roomPage<import('../../lib/bot-collaboration').CollaborationPost>(value,p=>p.roomId===this.roomId&&typeof p.text==='string')||value.room?.id!==this.roomId||!value.room.members.includes(this.botId)||value.view!==params.view||typeof value.newerCursor!=='string'||!Array.isArray(value.deliveries)||value.deliveries.some(d=>d.roomId!==this.roomId||!value.items.some(p=>p.id===d.postId)))throw Error('This recent room page could not be verified. Refresh its original scope.');
      if(append&&this.value){
        const items=[...new Map([...this.value.items,...value.items].map(p=>[p.id,p])).values()];
        const deliveries=[...new Map([...this.value.deliveries,...value.deliveries].map(d=>[d.id,d])).values()];
        if(items.length>80||new TextEncoder().encode(JSON.stringify({items,deliveries})).length>256*1024){this.newerAvailable=true;throw Error('New messages exceed this mounted window. Your reading page is retained; Latest messages opens the bounded newest page.');}
        this.value={...this.value,room:value.room,items,deliveries};
      }else{this.pageParams=params;this.value=value;this.latestWindow=params.view==='latest';}
      // Only the complete frozen traversal advances to the next watermark.
      this.newerCursor=value.complete||params.view!=='newer'?value.newerCursor:value.nextCursor??value.newerCursor;
      this.newerAvailable=params.view==='newer'&&!value.complete;
    }catch(e){if(this.current()&&generation===this.generation)this.error=e instanceof Error?e.message:'Room page unavailable.';}
    finally{if(generation===this.generation){this.loading=false;this.notify();}if(this.pending&&this.current()){this.pending=false;this.newerAvailable=true;this.notify();}}
  }
  latest=()=>{this.anchor=null;this.following=true;return this.load({view:'latest'});};
  older=()=>this.value?.olderCursor?this.load({view:'older',cursor:this.value.olderCursor}):Promise.resolve();
  newer=()=>this.latestWindow&&this.newerCursor?this.load({view:'newer',cursor:this.newerCursor},true):Promise.resolve();
  refresh=()=>this.load(this.pageParams);
  dispose(){this.dead=true;this.generation++;this.loading=false;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
}
const feeds=new Map<string,RoomFeed>();
export function useRoomFeed(owner:string,botId:string,roomId:string,online:boolean,supported:boolean){
  const feed=useMemo(()=>{const key=JSON.stringify([owner,botId,roomId]);let value=feeds.get(key);if(!value){value=new RoomFeed(owner,botId,roomId);feeds.set(key,value);}return value;},[owner,botId,roomId]);
  useSyncExternalStore(feed.subscribe,feed.snapshot,feed.snapshot);
  useEffect(()=>{
    feed.activate();client.events.add(feed.receive);if(online&&supported)void feed.reconnect();
    return()=>{client.events.delete(feed.receive);feed.dispose();};
  },[feed,online,supported]);
  useEffect(()=>{for(const[key,value]of feeds)if(value.owner!==owner){value.dispose();feeds.delete(key);}while(feeds.size>6){const victim=[...feeds].find(([,value])=>value!==feed);if(!victim)break;victim[1].dispose();feeds.delete(victim[0]);}},[feed,owner]);
  return feed;
}
