"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, Plus, Search, MessageCircle } from 'lucide-react';
import type { Bot } from '../../lib/bots-types';
import type { CollaborationRoom,CollaborationPost,CollaborationContext,CollaborationResult,CollaborationPostParams } from '../../lib/bot-collaboration';
import { botsClient as client } from './client';
import { BotAvatar } from './bot-avatar';
import { BotMessage } from './message';
import { LazyDetails } from './lazy-details';
import { useRunAction } from './run-action';
import { useCollaborationRead,roomPage } from './collaboration-read';
import { ConfigurationEvidence } from './configuration-evidence';
import { useRoomFeed } from './collaboration-room-feed';
import { CollaborationContextHistory } from './collaboration-context-history';
import './collaboration.css';

const ignore=()=>{};
const body=(id:string,text:string)=>( {id,type:'agentMessage' as const,text,phase:'final_answer' as const,memoryCitation:null,delivery:null,questions:null} );
export function RoomAvatars({members,bots}:{members:string[];bots:Bot[]}) {
  return <span className="bots-room-avatars" aria-hidden="true">{members.slice(0,2).map(id=>{const bot=bots.find(b=>b.id===id);return bot?<BotAvatar key={id} bot={bot} small decorative working={false}/>:<span key={id}>?</span>;})}</span>;
}
export function roomName(room:CollaborationRoom,bots:Bot[]) {return room.type==='pair'?room.members.map(id=>bots.find(b=>b.id===id)?.name??'Unavailable bot').join(' + '):room.name;}
export function ActionNotice({action,online}:{action:ReturnType<typeof useRunAction>;online:boolean}) {
  return (action.intent||action.error)?<p className="bots-error" role="alert">{action.error||'Original action is awaiting confirmation.'}{action.intent&&<button type="button" disabled={!online||action.busy} onClick={()=>void action.retry().catch(ignore)}>Check same action</button>}</p>:null;
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
    <h2>Create or reuse a conversation</h2><label>Room type<select autoFocus value={type} onChange={e=>setType(e.target.value as typeof type)}><option value="pair">Pair</option><option value="group">Named group</option></select></label>
    {type==='group'&&<label>Name<input autoFocus maxLength={120} value={name} onChange={e=>setName(e.target.value)}/></label>}
    <Members bots={bots} value={members} onChange={setMembers} disabled={action.busy||!!action.intent}/>
    <p>Only addressed messages wake a bot. Membership supplies no additional authority.</p>
    <button type="submit" disabled={!online||!action.ready||action.busy||!!action.intent||!members.includes(botId)||members.length<2||type==='pair'&&members.length!==2||type==='group'&&!name.trim()}>Create / reuse</button><button type="button" onClick={onClose}>Cancel</button>
    <ActionNotice action={action} online={online}/>{action.accepted&&<button type="button" onClick={()=>{const r=(action.confirmation as {result?:CollaborationRoom})?.result;if(r)onCreated(r);}}>Open confirmed room</button>}
  </form>;
}
export function DiscussionsNavigator({owner,bots,online,botId,onBot,onOpen,selected}:{owner:string;bots:Bot[];online:boolean;botId:string;onBot:(id:string)=>void;onOpen:(room:CollaborationRoom)=>void;selected:string|null}) {
  const [search,setSearch]=useState(''),[create,setCreate]=useState(false),[cursors,setCursors]=useState<(string|null)[]>([null]),[attention,setAttention]=useState<string[]>([]);
  const createButton=useRef<HTMLButtonElement>(null);
  const read=useCollaborationRead(owner,botId,'conversations.list',{limit:40,...(cursors.at(-1)?{cursor:cursors.at(-1)!}:{})},!!botId&&online&&client.snapshot?.capabilities?.collaborationRooms===1);
  const valid=roomPage<CollaborationRoom>(read.value,r=>r.members.includes(botId)&&r.members.length<=12&&typeof r.name==='string');
  const rooms=valid?read.value!.items:[];
  useEffect(()=>{
    let seq=-1;
    const known=new Set(read.value?.items.map(r=>r.id)??[]);
    const receive=(event:import('../../lib/bots-types').BotEvent)=>{
      const d=event.data as {roomId?:string;operationId?:string;resultIds?:string[]};
      if(client.owner!==owner||event.type!=='collaboration'||event.seq<=seq||!d.roomId||!known.has(d.roomId)||d.roomId===selected||!d.operationId&&!d.resultIds?.length)return;
      seq=event.seq;setAttention(old=>old.includes(d.roomId!)?old:[...old,d.roomId!]);
    };client.events.add(receive);return()=>{client.events.delete(receive);};
  },[owner,read.value,selected]);
  return <div className="bots-room-navigation"><label>Conversations involving<select aria-label="Conversation member" value={botId} onChange={e=>onBot(e.target.value)}>{bots.filter(b=>!b.archived).map(b=><option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
    <label className="bots-room-search"><Search size={16}/><input aria-label="Search loaded conversations" placeholder="Search conversations" value={search} onChange={e=>setSearch(e.target.value)}/></label>
    <button ref={createButton} disabled={!botId||!online||client.snapshot?.capabilities?.collaborationRooms!==1} onClick={()=>setCreate(v=>!v)}><Plus size={16}/>New conversation</button>
    {create&&<CreateRoom key={`${owner}:${botId}`} owner={owner} botId={botId} bots={bots} online={online} onClose={()=>{setCreate(false);createButton.current?.focus();}} onCreated={r=>{setCreate(false);read.refresh();onOpen(r);}}/>}
    {client.snapshot?.capabilities?.collaborationRooms!==1?<p>The connected service does not yet support rooms. Existing bot discussions remain available in bot details.</p>:<>
      {rooms.filter(r=>roomName(r,bots).toLowerCase().includes(search.trim().toLowerCase())).map(room=><button className={`bots-room-row ${selected===room.id?'selected':''}`} key={room.id} onClick={()=>{setAttention(old=>old.filter(id=>id!==room.id));onOpen(room);}}><RoomAvatars members={room.members} bots={bots}/><span>{roomName(room,bots)}{room.held&&<small>Room held</small>}{attention.includes(room.id)&&<small title="Observed new activity in this view; no device-wide unread count is inferred">New activity</small>}</span></button>)}
      {read.loading&&<p role="status">Loading conversations…</p>}{read.error&&<p role="alert">{read.error}</p>}{!read.loading&&valid&&!rooms.length&&<p>No conversations on this page.</p>}
      {!read.loading&&read.value&&!valid&&<p role="alert">This room page could not be verified.</p>}
      <nav aria-label="Conversation pages"><button disabled={cursors.length<2||read.loading} onClick={()=>setCursors(v=>v.slice(0,-1))}>Previous</button><button disabled={!valid||!read.value?.nextCursor||read.loading} onClick={()=>setCursors(v=>[...v,read.value!.nextCursor])}>More conversations</button><button disabled={!online||read.loading} onClick={read.refresh}>Refresh</button></nav><small>Search covers the loaded page; more rooms remain available through pages.</small>
    </>}
  </div>;
}

type RoomDraft={text:string;version:string};
function useRoomDraft(owner:string,roomId:string) {
  const key=`dawar-room-draft:v1:${JSON.stringify([owner,roomId])}`;
  const [value,setValue]=useState<RoomDraft>({text:'',version:''}),[error,setError]=useState(''),[ready,setReady]=useState(false);
  const read=useCallback(()=>{try{const raw=localStorage.getItem(key),r=raw?JSON.parse(raw):{text:'',version:crypto.randomUUID()};if(typeof r.text!=='string'||typeof r.version!=='string')throw Error('Saved room draft is unavailable.');setValue(r);setError('');setReady(true);}catch(e){setReady(false);setError(String(e));}},[key]);
  useEffect(()=>{let live=true;queueMicrotask(()=>{if(live)read();});const changed=(e:StorageEvent)=>{if(e.key===key&&client.owner===owner)read();};window.addEventListener('storage',changed);return()=>{live=false;window.removeEventListener('storage',changed);};},[read,key,owner]);
  const save=useCallback((next:RoomDraft)=>{if(client.owner!==owner)return;try{localStorage.setItem(key,JSON.stringify(next));setValue(next);setError('');}catch(e){setError(`Draft could not be saved: ${String(e)}`);setReady(false);}},[owner,key]);
  const clear=useCallback((version:string|undefined)=>{if(!version||client.owner!==owner)return;try{const raw=localStorage.getItem(key);if(raw&&JSON.parse(raw).version===version)save({text:'',version:crypto.randomUUID()});}catch(e){setError(String(e));}},[owner,key,save]);
  return {value,ready,error,read,edit:(text:string)=>save({text,version:crypto.randomUUID()}),clear};
}
function RoomControls({owner,botId,room,bots,online,onUpdated}:{owner:string;botId:string;room:CollaborationRoom;bots:Bot[];online:boolean;onUpdated:()=>void}) {
  const membership=useRunAction(owner,botId,`room:${room.id}:membership`),hold=useRunAction(owner,botId,`room:${room.id}:hold`);
  const [members,setMembers]=useState(room.members);
  return <details className="bots-room-controls"><summary>Room details and controls</summary><p>Room hold stops new room admission; it does not stop committed turns or the bot&apos;s foreground work.</p><button disabled={!online||!hold.ready||hold.busy||!!hold.intent} onClick={()=>void hold.perform('conversations.hold',{roomId:room.id,expectedRevision:room.revision,held:!room.held}).then(onUpdated).catch(ignore)}>{room.held?'Release room hold':'Hold room'}</button><ActionNotice action={hold} online={online}/>
    <Members bots={bots} value={members} onChange={setMembers} disabled={membership.busy||!!membership.intent}/><button disabled={!online||!membership.ready||membership.busy||!!membership.intent||!members.includes(botId)||members.length<2||room.type==='pair'} onClick={()=>void membership.perform('conversations.membership',{roomId:room.id,expectedRevision:room.revision,members}).then(onUpdated).catch(ignore)}>Save membership</button><ActionNotice action={membership} online={online}/><small>Original room {room.id} · revision {room.revision}</small>
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
  return <form className="bots-room-composer" onSubmit={e=>{e.preventDefault();void send().catch(ignore);}}><fieldset><legend>Addressed bots</legend>{room.members.map(id=><label key={id}><input type="checkbox" checked={recipients.includes(id)} disabled={action.busy||!!action.intent} onChange={e=>setRecipients(e.target.checked?[...recipients,id]:recipients.filter(v=>v!==id))}/>{bots.find(b=>b.id===id)?.name??'Unavailable bot'}</label>)}</fieldset>
    <label>Message kind<select disabled={action.busy||!!action.intent} value={effectiveKind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="info" disabled={addressed.length>0}>Information · no reply needed</option><option value="question">Question · useful result requested</option><option value="task">Task · useful result requested</option></select></label>
    <textarea aria-label={`Message ${roomName(room,bots)}`} value={draft.value.text} maxLength={200000} onChange={e=>draft.edit(e.target.value)} disabled={!draft.ready} placeholder="Write to this room…" rows={3}/>
    <p>{addressed.length?`${addressed.length} addressed bot${addressed.length===1?'':'s'}. Active room turns receive your guidance; foreground turns keep running separately.`:'No addressed bots: this post is stored quietly.'}</p>
    <button type="submit" disabled={!online||!draft.ready||!!draft.error||!action.ready||action.busy||!!action.intent||!draft.value.text.trim()||tooLarge||!eligible||stopped||room.held&&addressed.length>0}>Send to room</button>
    {tooLarge&&<p role="alert">This draft is {bodyBytes.toLocaleString()} bytes; room posts support 16 KiB. The complete draft is retained. Shorten it explicitly or reference a published artifact.</p>}{stopped&&<p>A selected bot is stopped; no automatic Resume is performed.</p>}{draft.error&&<p role="alert">{draft.error}<button type="button" onClick={draft.read}>Retry draft storage</button></p>}
    {(action.error||action.intent)&&<p role="alert">{action.error||'Post delivery is unconfirmed; the original text and recipients are retained.'}{action.intent&&<button type="button" disabled={!online||action.busy} onClick={()=>void retry().catch(ignore)}>Check same post</button>}</p>}
    {action.intent&&<details><summary>Read original unconfirmed post</summary><p>Saved recipients: {(action.intent.params.recipients as string[]??[]).map(id=>bots.find(b=>b.id===id)?.name??id).join(', ')||'none'}</p><BotMessage item={body(action.intent.id,String(action.intent.params.text??''))} botId={botId} attachments={[]} download={ignore}/></details>}{action.accepted&&<small>Original post accepted; per-bot delivery and completion are shown separately.</small>}
  </form>;
}
function ResultPromotion({owner,botId,result,online,refresh}:{owner:string;botId:string;result:CollaborationResult;online:boolean;refresh:()=>void}) {
  const action=useRunAction(owner,botId,`result:${result.id}:promote`),[confirm,setConfirm]=useState(false);
  return <div>{result.promotion?<p>Promoted at a related boundary · {result.promotion.state}. Consumption is separate.</p>:result.workId?<><button disabled={!online||action.busy||!!action.intent} onClick={()=>setConfirm(true)}>Bring to related foreground work</button>{confirm&&<div><p>Queue this result once at the next safe foreground boundary for work {result.workId}? It will not interrupt the active turn.</p><button disabled={!action.ready||action.busy||!!action.intent} onClick={()=>void action.perform('collaboration.promote',{resultId:result.id,boundary:'human',relatedWorkId:result.workId!}).then(()=>{setConfirm(false);refresh();}).catch(ignore)}>Confirm promotion</button><button onClick={()=>setConfirm(false)}>Cancel</button></div>}</>:<p>No related work identity; promotion is unavailable.</p>}<ActionNotice action={action} online={online}/></div>;
}
export function CollaborationInbox({owner,botId,online,bots,onOpen}:{owner:string;botId:string;online:boolean;bots:Bot[];onOpen:(roomId:string)=>void}) {
  const [cursors,setCursors]=useState<(string|null)[]>([null]);
  const read=useCollaborationRead(owner,botId,'collaboration.results',{limit:20,view:cursors.at(-1)?'older':'latest',...(cursors.at(-1)?{cursor:cursors.at(-1)!}:{})},online&&client.snapshot?.capabilities?.collaborationRooms===1);
  const valid=roomPage<CollaborationResult>(read.value,r=>r.botId===botId&&typeof r.text==='string');
  return <details className="bots-result-inbox"><summary>Result inbox {valid&&`· ${read.value!.items.filter(r=>!r.promotion).length} ready on this page`}</summary>{valid&&read.value!.items.map(r=><article key={r.id}><strong>{bots.find(b=>b.id===r.sourceBotId)?.name??'Named bot'} · {r.outcome}</strong><BotMessage item={body(r.id,r.text)} botId={r.sourceBotId} attachments={[]} download={ignore}/><button onClick={()=>onOpen(r.roomId)}>Open original room</button><details><summary>Source and references</summary><p>Result {r.id} · turn {r.turnId} · original operation {r.operationId}</p>{r.references.map((ref,i)=><p key={i}>{ref}</p>)}</details><ResultPromotion owner={owner} botId={botId} result={r} online={online} refresh={read.refresh}/></article>)}{read.error&&<p role="alert">{read.error}</p>}<button disabled={!online||read.loading} onClick={read.refresh}>Refresh results</button><button disabled={cursors.length<2||read.loading} onClick={()=>setCursors(v=>v.slice(0,-1))}>Previous results</button><button disabled={!valid||!read.value!.nextCursor||read.loading} onClick={()=>setCursors(v=>[...v,read.value!.nextCursor])}>More results</button></details>;
}
export function RoomConversation({owner,botId,roomId,bots,online,onBack}:{owner:string;botId:string;roomId:string;bots:Bot[];online:boolean;onBack:()=>void}) {
  const supported=client.snapshot?.capabilities?.collaborationRooms===1;
  const read=useRoomFeed(owner,botId,roomId,online,supported);
  const contextRead=useCollaborationRead(owner,botId,'conversations.contexts',{roomId,limit:40},online&&client.snapshot?.capabilities?.collaborationRooms===1,roomId);
  const valid=!!read.value&&read.value.room.id===roomId;
  const room=valid?read.value!.room:null;
  const contexts=roomPage<CollaborationContext>(contextRead.value,c=>c.roomId===roomId)?contextRead.value!.items:[];
  const feed=useRef<HTMLDivElement>(null),draft=useRoomDraft(owner,roomId);
  const [quoteError,setQuoteError]=useState('');
  const quote=(post:CollaborationPost)=>{if(client.owner!==owner||!draft.ready)return;const text=`${draft.value.text}${draft.value.text?'\n\n':''}> Source: room ${roomId} · post ${post.id}\n${post.text.split('\n').map(line=>'> '+line).join('\n')}\n\n`;if(text.length>200000){setQuoteError('This source exceeds the room draft limit. Copy the original or use a smaller explicit excerpt.');return;}setQuoteError('');draft.edit(text);feed.current?.parentElement?.querySelector<HTMLTextAreaElement>('.bots-room-composer textarea')?.focus();};
  useLayoutEffect(()=>{
    const e=feed.current;if(!e)return;
    if(read.following)e.scrollTop=e.scrollHeight;
    else if(read.anchor){const node=[...e.querySelectorAll<HTMLElement>('[data-post-id]')].find(n=>n.dataset.postId===read.anchor!.id);if(node)e.scrollTop+=node.getBoundingClientRect().top-e.getBoundingClientRect().top-read.anchor.offset;}
  },[read.value,read]);
  return <section className="bots-conversation bots-room-conversation"><header className="bots-conversation-heading"><button className="bots-icon-button" aria-label="Back to conversations" onClick={onBack}><ArrowLeft size={20}/></button>{room&&<RoomAvatars members={room.members} bots={bots}/>}<strong>{room?roomName(room,bots):'Conversation'}</strong></header>
    {!supported&&<p role="status">The connected service does not support rooms. Cached source remains readable; use legacy bot discussions.</p>}{!online&&<p role="status">Offline · cached room data; delivery controls are disabled.</p>}{read.error&&<p role="alert">{read.error}<button disabled={!online} onClick={read.refresh}>Retry room</button></p>}
    {room&&<RoomControls key={`${room.id}:${room.revision}`} owner={owner} botId={botId} room={room} bots={bots} online={online&&supported} onUpdated={read.refresh}/>}
    <div className="bots-room-feed" ref={feed} onScroll={()=>{const e=feed.current;if(!e)return;const following=e.scrollHeight-e.scrollTop-e.clientHeight<80;const node=[...e.querySelectorAll<HTMLElement>('[data-post-id]')].find(n=>n.getBoundingClientRect().bottom>e.getBoundingClientRect().top);read.remember(following,node?{id:node.dataset.postId!,offset:node.getBoundingClientRect().top-e.getBoundingClientRect().top}:null);}}>
      <nav aria-label="Room message pages"><button disabled={!read.value?.olderCursor||read.loading||!online} onClick={()=>void read.browseOlder()}>Earlier messages</button><button disabled={!online||read.loading} onClick={()=>void read.latest()}>Latest messages</button>{read.newerAvailable&&<span role="status">Room updates available · <button disabled={!online||read.loading} onClick={()=>void (read.canCatchUp?read.newer():read.latest())}>{read.canCatchUp?'Load newer messages':'Go to latest messages'}</button></span>}</nav>
      {read.loading&&<p role="status">Loading room page…</p>}{valid&&read.value!.items.map(post=><article key={post.id} className={`bots-room-post ${post.author.kind==='owner'?'is-owner':''}`} data-post-id={post.id}>
        <header>{post.author.kind==='bot'&&bots.find(b=>b.id===(post.author as {botId:string}).botId)&&<BotAvatar bot={bots.find(b=>b.id===(post.author as {botId:string}).botId)!} small decorative working={false}/>}<strong>{post.author.kind==='owner'?'You':bots.find(b=>b.id===(post.author as {botId:string}).botId)?.name??'Named bot'}</strong><time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleString()}</time></header>
        <BotMessage item={body(post.id,post.text)} botId={post.author.kind==='bot'?post.author.botId:botId} attachments={[]} download={ignore}/>
        {read.value!.deliveries.filter(d=>d.postId===post.id).map(d=><p className="bots-room-delivery" key={d.id}>{bots.find(b=>b.id===d.botId)?.name??'Named bot'} · {d.state}{d.terminalStatus&&` · ${d.terminalStatus}`}{d.waitReason&&` · ${d.waitReason}`}{d.error&&` · ${d.error}`} · result {d.resultState}</p>)}
        <details><summary>Original source / copy</summary><p>Post {post.id} · operation {post.operationId}</p>{post.workId&&<p>Work {post.workId}</p>}{post.rootId&&<p>Discussion root {post.rootId}</p>}{post.requestId&&<p>Request {post.requestId}</p>}<button onClick={()=>void navigator.clipboard.writeText(post.text).catch(ignore)}>Copy original text</button><button disabled={!draft.ready} onClick={()=>quote(post)}>Quote in room</button></details>
      </article>)}
      {contexts.map(context=><LazyDetails key={context.id} className="bots-room-context" summary={<><MessageCircle size={14}/>{bots.find(b=>b.id===context.botId)?.name??'Named bot'} · room work {context.status}{context.provisioning!=='bound'&&` · ${context.provisioning}`}</>}>{()=> <><ConfigurationEvidence value={context.config}/><p>Goal: {context.goal.status} · room context, separate from foreground</p><CollaborationContextHistory owner={owner} botId={context.botId} context={context} online={online}/></>}</LazyDetails>)}
      {contextRead.error&&<p role="alert">{contextRead.error}<button disabled={!online} onClick={contextRead.refresh}>Retry contexts</button></p>}
    </div>
    {quoteError&&<p role="alert">{quoteError}</p>}{room&&<RoomComposer draft={draft} key={`${owner}:${roomId}:${botId}`} owner={owner} botId={botId} room={room} bots={bots} contexts={contexts} online={online&&supported} onSent={()=>{if(read.following)void read.newer();}}/>}
  </section>;
}
