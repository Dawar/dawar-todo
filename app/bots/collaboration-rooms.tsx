"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Plus, Search, MessageCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect } from '@/components/ui/native-select';
import type { Bot } from '../../lib/bots-types';
import type { CollaborationRoom,CollaborationPost,CollaborationContext,CollaborationPostParams } from '../../lib/bot-collaboration';
import { botsClient as client } from './client';
import { BotAvatar } from './bot-avatar';
import { BotMessage } from './message';
import { LazyDetails } from './lazy-details';
import { useRunAction } from './run-action';
import { useCollaborationRead,roomPage } from './collaboration-read';
import { ConfigurationEvidence } from './configuration-evidence';
import { useRoomFeed } from './collaboration-room-feed';
import { CollaborationContextHistory } from './collaboration-context-history';
import { MessageTickRail } from './message-tick-rail';
import { roomHumanMessageTicks, type MessageTick } from './human-message-ticks';
import './collaboration.css';

const ignore=()=>{};
const body=(id:string,text:string)=>( {id,type:'agentMessage' as const,text,phase:'final_answer' as const,memoryCitation:null,delivery:null,questions:null} );
export function RoomAvatars({members,bots}:{members:string[];bots:Bot[]}) {
  return <span className="bots-room-avatars" aria-hidden="true">{members.slice(0,2).map(id=>{const bot=bots.find(b=>b.id===id);return bot?<BotAvatar key={id} bot={bot} small decorative working={false}/>:<span key={id}>?</span>;})}</span>;
}
export function roomName(room:CollaborationRoom,bots:Bot[]) {return room.type==='pair'?room.members.map(id=>bots.find(b=>b.id===id)?.name??'Unavailable bot').join(' + '):room.name;}
export function ActionNotice({action,online}:{action:ReturnType<typeof useRunAction>;online:boolean}) {
  return (action.intent||action.error)?<p className="bots-error" role="alert">{action.error||'Awaiting confirmation.'}{action.intent&&<Button variant="outline" type="button" disabled={!online||action.busy} onClick={()=>void action.retry().catch(ignore)}>Check delivery</Button>}</p>:null;
}
/** Mentions are exact named identities, outside Markdown code examples. Ambiguous
 * duplicate names require explicit recipient selection. */
export function mentionedMembers(text:string,members:string[],bots:Bot[]) {
  let fence='';
  const visible=text.split('\n').map(line=>{
    const marker=line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence='';return '';}
    return fence||/^\s{0,3}>/.test(line)?'':line.replace(/(`+)[\s\S]*?\1/g,'');
  }).join('\n');
  return members.filter(id=>{
    const name=bots.find(b=>b.id===id)?.name;if(!name||bots.filter(b=>b.name.toLowerCase()===name.toLowerCase()).length!==1)return false;
    const escaped=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return new RegExp(`(?:^|[\\s(])@${escaped}(?=$|[\\s.,!?:;)])`,'iu').test(visible);
  });
}
function Members({bots,value,onChange,disabled=false}:{bots:Bot[];value:string[];onChange:(ids:string[])=>void;disabled?:boolean}) {
  return <fieldset className="bots-room-members"><legend>Named members</legend>{bots.filter(b=>!b.archived||value.includes(b.id)).map(bot=><label key={bot.id}><input type="checkbox" checked={value.includes(bot.id)} disabled={disabled||!value.includes(bot.id)&&value.length>=12} onChange={e=>onChange(e.target.checked?[...value,bot.id]:value.filter(id=>id!==bot.id))}/>{bot.name}</label>)}{value.some(id=>!bots.some(b=>b.id===id))&&<p>Some saved members are unavailable. Their identities are retained.</p>}</fieldset>;
}
function CreateRoom({owner,botId,bots,online,onCreated,onClose}:{owner:string;botId:string;bots:Bot[];online:boolean;onCreated:(room:CollaborationRoom)=>void;onClose:()=>void}) {
  const [type,setType]=useState<'pair'|'group'>('pair'),[members,setMembers]=useState([botId]),[name,setName]=useState('');
  const action=useRunAction(owner,botId,'rooms:create');
  const submit=async()=>{const r=await action.performResult('conversations.create',{type,members,...(type==='group'?{name:name.trim()}:{})});if(client.owner===owner)onCreated(r as CollaborationRoom);};
  return <form className="bots-room-editor" onSubmit={e=>{e.preventDefault();void submit().catch(ignore);}} onKeyDown={e=>{if(e.key==='Escape')onClose();}}>
    <h2>New conversation</h2><label>Room type<NativeSelect autoFocus value={type} onChange={e=>setType(e.target.value as typeof type)}><option value="pair">Pair</option><option value="group">Named group</option></NativeSelect></label>
    {type==='group'&&<label>Name<Input autoFocus maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>}
    <Members bots={bots} value={members} onChange={setMembers} disabled={action.busy||!!action.intent}/>
    <p>Choose who joins. Bots respond only when addressed.</p>
    <Button variant="outline" type="submit" disabled={!online||!action.ready||action.busy||!!action.intent||!members.includes(botId)||members.length<2||type==='pair'&&members.length!==2||type==='group'&&!name.trim()}>Open conversation</Button><Button variant="outline" type="button" onClick={onClose}>Cancel</Button>
    <ActionNotice action={action} online={online}/>{action.accepted&&<Button variant="outline" type="button" onClick={()=>{const r=(action.confirmation as {result?:CollaborationRoom})?.result;if(r)onCreated(r);}}>Open confirmed room</Button>}
  </form>;
}
export function DiscussionsNavigator({owner,bots,online,botId,onBot,onOpen,selected}:{owner:string;bots:Bot[];online:boolean;botId:string;onBot:(id:string)=>void;onOpen:(room:CollaborationRoom)=>void;selected:string|null}) {
  const [search,setSearch]=useState(''),[create,setCreate]=useState(false),[cursors,setCursors]=useState<(string|null)[]>([null]),[attention,setAttention]=useState<string[]>([]);
  const createButton=useRef<HTMLButtonElement>(null);
  const read=useCollaborationRead(owner,botId,'conversations.list',{limit:40,...(cursors.at(-1)?{cursor:cursors.at(-1)!}:{})},!!botId&&online&&client.snapshot?.capabilities?.collaborationRooms===1);
  const valid=roomPage<CollaborationRoom>(read.value,r=>r.members.includes(botId)&&r.members.length<=12&&typeof r.name==='string');
  const rooms=valid?read.value!.items:[];
  const matchingRooms=rooms.filter(room=>roomName(room,bots).toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(()=>{
    let seq=-1;
    const known=new Set(read.value?.items.map(r=>r.id)??[]);
    const receive=(event:import('../../lib/bots-types').BotEvent)=>{
      const d=event.data as {roomId?:string;operationId?:string;resultIds?:string[]};
      if(client.owner!==owner||event.type!=='collaboration'||event.seq<=seq||!d.roomId||!known.has(d.roomId)||d.roomId===selected||!d.operationId&&!d.resultIds?.length)return;
      seq=event.seq;setAttention(old=>old.includes(d.roomId!)?old:[...old,d.roomId!]);
    };client.events.add(receive);return()=>{client.events.delete(receive);};
  },[owner,read.value,selected]);
  return <div className="bots-room-navigation"><label>Conversations involving<NativeSelect aria-label="Conversation member" value={botId} onChange={e=>onBot(e.target.value)}>{bots.filter(b=>!b.archived).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</NativeSelect></label>
    <label className="bots-room-search"><Search size={16}/><Input aria-label="Search loaded conversations" placeholder="Search conversations" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <Button variant="outline" ref={createButton} disabled={!botId||!online||client.snapshot?.capabilities?.collaborationRooms!==1} onClick={()=>setCreate(v=>!v)}><Plus size={16}/>New conversation</Button>
    {create&&<CreateRoom key={`${owner}:${botId}`} owner={owner} botId={botId} bots={bots} online={online} onClose={()=>{setCreate(false);createButton.current?.focus();}} onCreated={r=>{setCreate(false);read.refresh();onOpen(r);}}/>}
    {client.snapshot?.capabilities?.collaborationRooms!==1?<p>The connected service does not yet support rooms. Existing bot discussions remain available in bot details.</p>:<>
      {matchingRooms.map(room=><Button variant="ghost" aria-current={selected===room.id?'page':undefined} className={`bots-room-row ${selected===room.id?'selected':''}`} key={room.id} onClick={()=>{setAttention(old=>old.filter(id=>id!==room.id));onOpen(room);}}><RoomAvatars members={room.members} bots={bots}/><span>{roomName(room,bots)}{room.held&&<small>Room held</small>}{attention.includes(room.id)&&<small title="Observed new activity in this view; no device-wide unread count is inferred">New activity</small>}</span></Button>)}
      {!read.loading&&valid&&rooms.length>0&&!matchingRooms.length&&<p role="status">No matching conversations on this page.</p>}
      {read.loading&&<p role="status">Loading conversations…</p>}{read.error&&<p role="alert">{read.error}</p>}{!read.loading&&valid&&!rooms.length&&<p>No conversations on this page.</p>}
      {!read.loading&&read.value&&!valid&&<p role="alert">This room page could not be verified.</p>}
      <nav aria-label="Conversation pages"><Button variant="outline" disabled={cursors.length<2||read.loading} onClick={()=>setCursors(v=>v.slice(0,-1))}>Previous</Button><Button variant="outline" disabled={!valid||!read.value?.nextCursor||read.loading} onClick={()=>setCursors(v=>[...v,read.value!.nextCursor])}>More conversations</Button><Button variant="outline" disabled={!online||read.loading} onClick={read.refresh}>Refresh</Button></nav><small>Search covers this page.</small>
    </>}
  </div>;
}

type RoomDraft={text:string;version:string};
function useRoomDraft(owner:string,roomId:string) {
  const key=`dawar-room-draft:v1:${JSON.stringify([owner,roomId])}`;
  const [value,setValue]=useState<RoomDraft>({text:'',version:''}),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const read=useCallback(()=>{try{const raw=localStorage.getItem(key),r=raw?JSON.parse(raw):{text:'',version:crypto.randomUUID()};if(typeof r.text!=='string'||typeof r.version!=='string')throw Error('Saved room draft is unavailable.');setValue(r);setError('');setReady(true);}catch{setReady(false);setError('Could not read your saved draft. Retry without clearing site storage.');}},[key]);
  useEffect(()=>{let live=true;queueMicrotask(()=>{if(live)read();});const changed=(e:StorageEvent)=>{if(e.key===key&&client.owner===owner)read();};window.addEventListener('storage',changed);return()=>{live=false;window.removeEventListener('storage',changed);};},[read,key,owner]);
  const save=useCallback((next:RoomDraft)=>{if(client.owner!==owner)return;try{localStorage.setItem(key,JSON.stringify(next));setValue(next);setError('');}catch{setError('Could not save this draft. Keep this page open and retry.');setReady(false);}},[owner,key]);
  const clear=useCallback((version:string|undefined)=>{if(!version||client.owner!==owner)return;try{const raw=localStorage.getItem(key);if(raw&&JSON.parse(raw).version===version)save({text:'',version:crypto.randomUUID()});}catch{setError('Could not update your saved draft. Retry without clearing site storage.');}},[owner,key,save]);
  return {value,ready,error,read,edit:(text:string)=>save({text,version:crypto.randomUUID()}),clear};
}
function RoomControls({owner,botId,room,bots,online,onUpdated}:{owner:string;botId:string;room:CollaborationRoom;bots:Bot[];online:boolean;onUpdated:()=>void}) {
  const membership=useRunAction(owner,botId,`room:${room.id}:membership`),hold=useRunAction(owner,botId,`room:${room.id}:hold`);
  const [members,setMembers]=useState(room.members);
  return <details className="bots-room-controls"><summary>Room details and controls</summary><p>Hold prevents new room work. Work already started continues.</p><Button variant="outline" disabled={!online||!hold.ready||hold.busy||!!hold.intent} onClick={()=>void hold.perform('conversations.hold',{roomId:room.id,expectedRevision:room.revision,held:!room.held}).then(onUpdated).catch(ignore)}>{room.held?'Release room hold':'Hold room'}</Button><ActionNotice action={hold} online={online}/>
    <Members bots={bots} value={members} onChange={setMembers} disabled={membership.busy||!!membership.intent}/><Button variant="outline" disabled={!online||!membership.ready||membership.busy||!!membership.intent||!members.includes(botId)||members.length<2||room.type==='pair'} onClick={()=>void membership.perform('conversations.membership',{roomId:room.id,expectedRevision:room.revision,members}).then(onUpdated).catch(ignore)}>Save membership</Button><ActionNotice action={membership} online={online}/><details><summary>Room reference</summary><small>{room.id} · revision {room.revision}</small></details>
  </details>;
}
function RoomComposer({owner,botId,room,bots,contexts,online,onSent,draft}:{owner:string;botId:string;room:CollaborationRoom;bots:Bot[];contexts:CollaborationContext[];online:boolean;onSent:()=>void;draft:ReturnType<typeof useRoomDraft>}) {
  const action=useRunAction(owner,botId,`room:${room.id}:post`);
  const [recipients,setRecipients]=useState<string[]>([]),[kind,setKind]=useState<'info'|'question'|'task'>('info');
  const addressed=[...new Set([...recipients,...mentionedMembers(draft.value.text,room.members,bots)])];
  const confirmedVersion=action.accepted?action.confirmation?.capture?.draftVersion:undefined;
  const {ready:draftReady,clear:clearDraft}=draft;
  useEffect(()=>{if(draftReady&&confirmedVersion)clearDraft(confirmedVersion);},[draftReady,clearDraft,confirmedVersion]);
  const effectiveKind=addressed.length?(kind==='info'?'task':kind):'info';
  const bodyBytes=new TextEncoder().encode(draft.value.text).length,tooLarge=bodyBytes>16*1024;
  const eligible=addressed.every(id=>bots.some(b=>b.id===id&&!b.archived));
  const stopped=addressed.some(id=>bots.find(b=>b.id===id)?.queuePaused);
  const send=async()=>{const version=draft.value.version;const steer=Object.fromEntries(contexts.filter(c=>addressed.includes(c.botId)&&c.status==='running'&&c.activeTurnId&&c.threadId).map(c=>[c.botId,c.activeTurnId!]));
    const params:CollaborationPostParams={roomId:room.id,kind:effectiveKind,text:draft.value.text,recipients:addressed,expectation:effectiveKind==='info'?'none':'result',...(Object.keys(steer).length?{steer}:{})};
    await action.performResult('conversations.post',params,{draftVersion:version});draft.clear(action.confirmation?.capture?.draftVersion);if(client.owner===owner)onSent();};
  const retry=async()=>{const version=action.intent?.capture?.draftVersion;await action.retry();draft.clear(version);if(client.owner===owner)onSent();};
  return <form className="bots-room-composer" onSubmit={e=>{e.preventDefault();void send().catch(ignore);}}><details className="bots-room-addressing"><summary>{addressed.length?`Recipients · ${addressed.length}`:'Recipients · no reply requested'}</summary><fieldset><legend>Addressed bots</legend>{room.members.map(id=><label key={id}><input type="checkbox" checked={recipients.includes(id)} disabled={action.busy||!!action.intent} onChange={e=>setRecipients(e.target.checked?[...recipients,id]:recipients.filter(v=>v!==id))}/>{bots.find(b=>b.id===id)?.name??'Unavailable bot'}</label>)}</fieldset>
    <label>Message kind<NativeSelect disabled={action.busy||!!action.intent} value={effectiveKind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="info" disabled={addressed.length>0}>Information · no reply needed</option><option value="question">Question · useful result requested</option><option value="task">Task · useful result requested</option></NativeSelect></label></details>
    <Textarea aria-label={`Message ${roomName(room,bots)}`} value={draft.value.text} maxLength={200000} onChange={e=>draft.edit(e.target.value)} disabled={!draft.ready} placeholder="Write to this room…" rows={2}/>
    <div className="bots-room-send-row"><p className="bots-room-send-hint">{addressed.length?`${addressed.length} bot${addressed.length===1?'':'s'} will receive this message.`:'Only saved to this conversation.'}</p>
    <Button variant="outline" type="submit" disabled={!online||!draft.ready||!!draft.error||!action.ready||action.busy||!!action.intent||!draft.value.text.trim()||tooLarge||!eligible||stopped||room.held&&addressed.length>0}>Send</Button></div>
    {tooLarge&&<p role="alert">This draft is {bodyBytes.toLocaleString()} bytes; room posts support 16 KiB. The complete draft is retained. Shorten it explicitly or reference a published artifact.</p>}{stopped&&<p>A selected bot is stopped; no automatic Resume is performed.</p>}{draft.error&&<p role="alert">{draft.error}<Button variant="outline" type="button" onClick={draft.read}>Retry draft storage</Button></p>}
    {(action.error||action.intent)&&<p role="alert">{action.error||'Post delivery is unconfirmed; the original text and recipients are retained.'}{action.intent&&<Button variant="outline" type="button" disabled={!online||action.busy} onClick={()=>void retry().catch(ignore)}>Check same post</Button>}</p>}
    {action.intent&&<details><summary>Read original unconfirmed post</summary><p>Saved recipients: {(action.intent.params.recipients as string[]??[]).map(id=>bots.find(b=>b.id===id)?.name??id).join(', ')||'none'}</p><BotMessage item={body(action.intent.id,String(action.intent.params.text??''))} botId={botId} attachments={[]} download={ignore}/></details>}{action.accepted&&<small>Original post accepted; per-bot delivery and completion are shown separately.</small>}
  </form>;
}
export function RoomConversation({owner,botId,roomId,bots,online,onBack}:{owner:string;botId:string;roomId:string;bots:Bot[];online:boolean;onBack:()=>void}) {
  const supported=client.snapshot?.capabilities?.collaborationRooms===1;
  const read=useRoomFeed(owner,botId,roomId,online,supported);
  const contextRead=useCollaborationRead(owner,botId,'conversations.contexts',{roomId,limit:40},online&&client.snapshot?.capabilities?.collaborationRooms===1,roomId);
  const valid=!!read.value&&read.value.room.id===roomId;
  const room=valid?read.value!.room:null;
  const contexts=roomPage<CollaborationContext>(contextRead.value,c=>c.roomId===roomId)?contextRead.value!.items:[];
  const feed=useRef<HTMLDivElement>(null),content=useRef<HTMLDivElement>(null),draft=useRoomDraft(owner,roomId);
  const tickAnchor=useRef<string|null>(null);
  const ticks=useMemo(()=>roomHumanMessageTicks(read.value?.items??[],roomId),[read.value?.items,roomId]);
  const showTicks=ticks.ticks.length>0||!!read.value?.olderCursor;
  const selectTick=(tick:MessageTick)=>{
    if(client.owner!==owner||read.value?.room.id!==roomId||!feed.current)return;
    const post=read.value.items.find(post=>post.author.kind==='owner'&&JSON.stringify([roomId,post.id])===tick.id);
    const node=[...feed.current.querySelectorAll<HTMLElement>('[data-post-id]')].find(node=>node.dataset.postId===post?.id);
    if(!post||!node)return;
    tickAnchor.current=post.id;
    read.remember(false,{id:post.id,offset:24});
    feed.current.scrollTop+=node.getBoundingClientRect().top-feed.current.getBoundingClientRect().top-24;
  };
  useLayoutEffect(()=>{
    tickAnchor.current=null;
    const element=feed.current,body=content.current;if(!element||!body)return;
    let frame=0;
    const restore=()=>{
      frame=0;if(!tickAnchor.current||client.owner!==owner)return;
      const node=[...element.querySelectorAll<HTMLElement>('[data-post-id]')].find(node=>node.dataset.postId===tickAnchor.current);
      if(!node){tickAnchor.current=null;return;}
      element.scrollTop+=node.getBoundingClientRect().top-element.getBoundingClientRect().top-24;
    };
    const resize=new ResizeObserver(()=>{if(!frame)frame=requestAnimationFrame(restore);});resize.observe(element);resize.observe(body);
    return()=>{resize.disconnect();cancelAnimationFrame(frame);};
  },[read,owner,roomId]);
  const [quoteError,setQuoteError]=useState('');
  const quote=(post:CollaborationPost)=>{if(client.owner!==owner||!draft.ready)return;const text=`${draft.value.text}${draft.value.text?'\n\n':''}> Source: room ${roomId} · post ${post.id}\n${post.text.split('\n').map(line=>'> '+line).join('\n')}\n\n`;if(text.length>200000){setQuoteError('This source exceeds the room draft limit. Copy the original or use a smaller explicit excerpt.');return;}setQuoteError('');draft.edit(text);feed.current?.closest('.bots-room-conversation')?.querySelector<HTMLTextAreaElement>('.bots-room-composer textarea')?.focus();};
  useLayoutEffect(()=>{
    const e=feed.current;if(!e)return;
    if(read.following)e.scrollTop=e.scrollHeight;
    else if(read.anchor){const node=[...e.querySelectorAll<HTMLElement>('[data-post-id]')].find(n=>n.dataset.postId===read.anchor!.id);if(node)e.scrollTop+=node.getBoundingClientRect().top-e.getBoundingClientRect().top-read.anchor.offset;}
  },[read.value,read]);
  return <section className="bots-conversation bots-room-conversation"><header className="bots-conversation-heading"><Button variant="ghost" size="icon" className="bots-icon-button" aria-label="Back to conversations" onClick={onBack}><ArrowLeft size={20}/></Button>{room&&<RoomAvatars members={room.members} bots={bots}/>}<strong>{room?roomName(room,bots):'Conversation'}</strong></header>
    {!supported&&<p role="status">The connected service does not support rooms. Cached source remains readable; use legacy bot discussions.</p>}{!online&&<p role="status">Offline · cached room data; delivery controls are disabled.</p>}{read.error&&<p role="alert">{read.error}<Button variant="outline" disabled={!online} onClick={read.refresh}>Retry room</Button></p>}
    {room&&<RoomControls key={`${room.id}:${room.revision}`} owner={owner} botId={botId} room={room} bots={bots} online={online&&supported} onUpdated={read.refresh}/>}
    <div className={`bots-room-tick-timeline${showTicks?' has-message-ticks':''}`}><div className="bots-room-feed" ref={feed} onWheel={()=>{tickAnchor.current=null;}} onTouchStart={()=>{tickAnchor.current=null;}} onKeyDownCapture={()=>{tickAnchor.current=null;}} onPointerDownCapture={()=>{tickAnchor.current=null;}} onScroll={()=>{
      const e=feed.current;if(!e)return;
      if(tickAnchor.current){read.remember(false,{id:tickAnchor.current,offset:24});return;}
      const following=e.scrollHeight-e.scrollTop-e.clientHeight<80,top=e.getBoundingClientRect().top;
      const visible=[...e.querySelectorAll<HTMLElement>('[data-post-id]')].filter(node=>node.getBoundingClientRect().bottom>top&&node.getBoundingClientRect().top<top+e.clientHeight);
      const node=visible.find(node=>node.dataset.postId===read.anchor?.id)??visible[0];
      read.remember(following,node?{id:node.dataset.postId!,offset:node.getBoundingClientRect().top-top}:null);
    }}><div ref={content} className="bots-room-feed-content">
      <nav aria-label="Room message pages"><Button variant="outline" disabled={!read.value?.olderCursor||read.loading||!online} onClick={()=>void read.browseOlder()} aria-label="Earlier room messages">Earlier</Button><Button variant="outline" disabled={!online||read.loading} onClick={()=>void read.latest()} aria-label="Latest room messages">Latest</Button>{read.newerAvailable&&<span role="status">Room updates available · <Button variant="outline" disabled={!online||read.loading} onClick={()=>void (read.canCatchUp?read.newer():read.latest())}>{read.canCatchUp?'Load newer messages':'Go to latest messages'}</Button></span>}</nav>
      {read.loading&&<p role="status">Loading room page…</p>}{valid&&!read.loading&&!read.value!.items.length&&<div className="bots-room-empty"><MessageCircle size={24} aria-hidden="true"/><strong>No messages yet</strong><p>Start the conversation below.</p></div>}{valid&&read.value!.items.map(post=><article key={post.id} className={`bots-room-post ${post.author.kind==='owner'?'is-owner':''}`} data-post-id={post.id} data-history-key={JSON.stringify([roomId,post.id])}>
        <header>{post.author.kind==='bot'&&bots.find(b=>b.id===(post.author as {botId:string}).botId)&&<BotAvatar bot={bots.find(b=>b.id===(post.author as {botId:string}).botId)!} small decorative working={false}/>}<strong>{post.author.kind==='owner'?'You':bots.find(b=>b.id===(post.author as {botId:string}).botId)?.name??'Named bot'}</strong><time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString()}</time></header>
        <BotMessage item={body(post.id,post.text)} botId={post.author.kind==='bot'?post.author.botId:botId} attachments={[]} download={ignore}/>
        {read.value!.deliveries.filter(d=>d.postId===post.id).map(d=><p className="bots-room-delivery" key={d.id}>{bots.find(b=>b.id===d.botId)?.name??'Named bot'} · {d.state}{d.terminalStatus&&` · ${d.terminalStatus}`}{d.waitReason&&` · ${d.waitReason}`}{d.error&&` · ${d.error}`} · result {d.resultState}</p>)}
        <details><summary>Original source / copy</summary><p>Post {post.id} · operation {post.operationId}</p>{post.workId&&<p>Work {post.workId}</p>}{post.rootId&&<p>Discussion root {post.rootId}</p>}{post.requestId&&<p>Request {post.requestId}</p>}<Button variant="outline" onClick={()=>void navigator.clipboard.writeText(post.text).catch(ignore)}>Copy original text</Button><Button variant="outline" disabled={!draft.ready} onClick={()=>quote(post)}>Quote in room</Button></details>
      </article>)}
      {contexts.map(context=><LazyDetails key={context.id} className="bots-room-context" summary={<><MessageCircle size={14}/>{bots.find(b=>b.id===context.botId)?.name??'Named bot'} · room work {context.status}{context.provisioning!=='bound'&&` · ${context.provisioning}`}</>}>{()=> <><ConfigurationEvidence value={context.config}/><p>Goal: {context.goal.status} · room context, separate from foreground</p><CollaborationContextHistory owner={owner} botId={context.botId} context={context} online={online}/></>}</LazyDetails>)}
      {contextRead.error&&<p role="alert">{contextRead.error}<Button variant="outline" disabled={!online} onClick={contextRead.refresh}>Retry contexts</Button></p>}
    </div></div>{showTicks&&<MessageTickRail key={JSON.stringify([owner,botId,roomId])} {...ticks} scroll={feed} content={content} earlier={!!read.value?.olderCursor} incomplete={!!read.value?.olderCursor||!!read.newerAvailable} loading={read.loading} online={online&&supported} error={read.error} onEarlier={()=>{tickAnchor.current=null;return read.browseOlder();}} onSelect={selectTick}/>}</div>
    {quoteError&&<p role="alert">{quoteError}</p>}{room&&<RoomComposer draft={draft} key={`${owner}:${roomId}:${botId}`} owner={owner} botId={botId} room={room} bots={bots} contexts={contexts} online={online&&supported} onSent={read.invalidate}/>}
  </section>;
}
