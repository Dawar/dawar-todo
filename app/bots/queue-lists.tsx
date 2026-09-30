"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CalendarClock, Clock3, FolderOpen, ListOrdered, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import type { Bot, BotQueueList, BotQueuedSubmission } from '../../lib/bots-types';
import { botsClient as client } from './client';
import { useQueueAction } from './use-queue-action';
import { PromptQueue } from './prompt-queue';
import { cronValidationError, nextCronOccurrence } from '../../lib/cron';
import './queue-lists.css';

export function useQueueLists(owner: string, botId: string | null, online: boolean, supported: boolean) {
  const [value,setValue] = useState<{scope:string;lists:BotQueueList[]}>({scope:'',lists:[]});
  const scope = JSON.stringify([owner,botId]), generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!botId || !online || !supported) return;
    const lists = await client.rpc<BotQueueList[]>('queueLists.list',botId,{});
    if (request===generation.current && client.owner===owner) {
      client.save(`queue-lists:${botId}`,lists); setValue({scope:JSON.stringify([owner,botId]),lists});
    }
  },[owner,botId,online,supported]);
  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{if(active && botId) {setValue({scope,lists:client.cache<BotQueueList[]>(`queue-lists:${botId}`,[])});void refresh().catch(()=>{});}});
    const listener = (event:{type:string;botId?:string})=>{if(event.type==='queue' && event.botId===botId) void refresh().catch(()=>{});};
    client.events.add(listener);
    return ()=>{active=false;
      // Invalidate asynchronous reads when the owning scope is hidden or removed.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;client.events.delete(listener);};
  },[scope,botId,refresh]);
  return {lists:value.scope===scope?value.lists:[],refresh};
}
const when = (date:string|null,zone:string) => date ? new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:zone}).format(new Date(date)) : null;
const blank = () => ({name:'',cron:'0 9 * * 1-5',timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',enabled:true});
/** The composer journals the destination with the original text and attachments. */
export function QueueDestinationPicker({lists, disabled, onChoose, onClose, onManage}: {
  lists: BotQueueList[]; disabled: boolean; onChoose: (id: string | null) => void; onClose: () => void; onManage: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); }; }, []);
  return <dialog ref={ref} className="bots-queue-picker" aria-labelledby="queue-picker-title" onCancel={onClose} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <header><div><span>Queue message</span><h2 id="queue-picker-title">Choose a list</h2></div><button type="button" className="bots-icon-button" aria-label="Close queue picker" onClick={onClose}><X size={20}/></button></header>
    <div className="bots-queue-destinations">
      <button type="button" disabled={disabled} onClick={() => onChoose(null)}><ListOrdered size={21}/><span><strong>Queued next</strong><small>Starts when this bot is free</small></span></button>
      {lists.map(list => <button type="button" key={list.id} disabled={disabled} onClick={() => onChoose(list.id)}><FolderOpen size={21}/><span><strong>{list.name}</strong><small>{list.count} {list.count === 1 ? 'message' : 'messages'} · {list.cron ? list.enabled ? 'Scheduled' : 'Schedule paused' : 'Manual list'}</small></span></button>)}
    </div>
    <button type="button" className="bots-queue-manage" onClick={onManage}><Plus size={17}/>{lists.length ? 'Manage queue lists' : 'Create a queue list'}</button>
  </dialog>;
}
export function QueueLists({owner,bot,lists,defaultItems,online,refreshLists,refreshDefault,onEdit}: {
  owner:string;bot:Bot;lists:BotQueueList[];defaultItems:BotQueuedSubmission[];online:boolean;
  refreshLists:()=>Promise<void>;refreshDefault:()=>Promise<void>;onEdit:(item:BotQueuedSubmission)=>Promise<boolean>;
}) {
  const [selected,setSelected] = useState<string|null>(null), [editor,setEditor] = useState<ReturnType<typeof blank> & {id?:string;revision?:number}|null>(null);
  const [loaded,setLoaded] = useState<{id:string|null;items:BotQueuedSubmission[]}>({id:null,items:[]}), [error,setError] = useState('');
  const request=useRef(0), current=lists.find(l=>l.id===selected);
  const refresh = useCallback(async()=>{
    await refreshLists(); await refreshDefault();
    if (!selected || selected==='default' || !online) return;
    const n=++request.current;
    try {const items=await client.rpc<BotQueuedSubmission[]>('queue.list',bot.id,{listId:selected});if(n===request.current && client.owner===owner){setLoaded({id:selected,items});client.save(`queue:${bot.id}:${selected}`,items);setError('');}}
    catch(e){if(n===request.current)setError(e instanceof Error?e.message:'This list could not load.');}
  },[refreshLists,refreshDefault,selected,online,bot.id,owner]);
  const action=useQueueAction(owner,bot.id,refresh);
  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{if(active && selected && selected!=='default'){setLoaded({id:selected,items:client.cache<BotQueuedSubmission[]>(`queue:${bot.id}:${selected}`,[])});void refresh().catch(e => setError(e instanceof Error ? e.message : "Queue lists could not refresh."));}});
    const listener=(event:{type:string;botId?:string})=>{if(event.type==='queue' && event.botId===bot.id)void refresh().catch(e => setError(e instanceof Error ? e.message : "Queue lists could not refresh."));};
    client.events.add(listener);
    return ()=>{active=false;
      // Invalidate this list read; this ref is a request counter, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;client.events.delete(listener);};
  },[selected,bot.id,refresh]);
  const items=!selected||selected==='default'?defaultItems:loaded.id===selected?loaded.items:[];
  const locked=action.busy || action.blocked || !online;
  const cronError=editor?cronValidationError(editor.cron):null;
  let next:string|null=null;
  if(editor?.cron && !cronError) {try{next=nextCronOccurrence(editor.cron,new Date(),editor.timeZone)?.toISOString()??null;}catch{}}
  return <div className="bots-queue-lists">
    <header className="bots-lists-heading"><div><h3>Queue lists</h3><p>Collect work now. Send it when it suits you.</p></div><button type="button" title="New queue list" aria-label="New queue list" disabled={locked} onClick={()=>setEditor(blank())}><Plus size={19}/></button></header>
    {action.error && <p className="bots-lists-error" role="alert">{action.error}</p>}
    {action.pending && <div className="bots-lists-error" role="status">{action.busy?'Confirming your change…':'This change needs confirmation.'}<button type="button" disabled={!online||action.busy} onClick={action.retry}>Check same action</button></div>}
    {error && <p className="bots-lists-error" role="alert">{error}</p>}
    {editor && <form className="bots-list-editor" onSubmit={async event=>{
      event.preventDefault(); if(cronError)return;
      const {revision,...params}=editor;
      if(await action.run('queueLists.save',{...params,cron:editor.cron.trim()||null,...(revision?{expectedRevision:revision}:{})}))setEditor(null);
    }}><header><strong>{editor.id?'List settings':'New queue list'}</strong><button type="button" aria-label="Close list editor" onClick={()=>setEditor(null)}><X size={18}/></button></header>
      <label>Name<input autoFocus value={editor.name} maxLength={80} required placeholder="Morning work" onChange={e=>setEditor({...editor,name:e.target.value})}/></label>
      <label>Schedule<select value={['0 9 * * 1-5','0 9 * * *','0 * * * *','*/30 * * * *',''].includes(editor.cron)?editor.cron:'custom'} onChange={e=>setEditor({...editor,cron:e.target.value==='custom'?'0 9 * * 1':e.target.value})}><option value="">Manual only</option><option value="0 9 * * 1-5">Weekdays at 9 AM</option><option value="0 9 * * *">Every day at 9 AM</option><option value="0 * * * *">Every hour</option><option value="*/30 * * * *">Every 30 minutes</option><option value="custom">Custom cron</option></select></label>
      {editor.cron && <><label>Cron<input value={editor.cron} onChange={e=>setEditor({...editor,cron:e.target.value})} spellCheck={false}/></label><label>Timezone<input value={editor.timeZone} onChange={e=>setEditor({...editor,timeZone:e.target.value})} required placeholder="America/New_York"/></label><label className="bots-list-checkbox"><input type="checkbox" checked={editor.enabled} onChange={e=>setEditor({...editor,enabled:e.target.checked})}/>Schedule enabled</label></>}
      {cronError?<small role="alert">{cronError}</small>:next&&editor.enabled?<small>Next: {when(next,editor.timeZone)}</small>:null}
      <button className="bots-primary" type="submit" disabled={locked||Boolean(cronError)||Boolean(editor.cron&&!next)}>Save list</button>
    </form>}
    {!selected ? <div className="bots-lists-grid">
      <button type="button" className="bots-list-card is-default" onClick={()=>setSelected('default')}><ListOrdered size={22}/><strong>Queued next</strong><span>{defaultItems.length} {defaultItems.length===1?'message':'messages'}</span><small>Starts when this bot is free</small></button>
      {lists.map(list=><button type="button" className="bots-list-card" key={list.id} onClick={()=>setSelected(list.id)}><FolderOpen size={22}/><strong>{list.name}</strong><span>{list.count} {list.count===1?'message':'messages'}</span><small><Clock3 size={13}/>{list.cron?list.enabled?`Next ${when(list.nextRunAt,list.timeZone)}`:'Schedule paused':'Manual only'}</small></button>)}
      {!lists.length && <div className="bots-lists-empty"><CalendarClock size={30} strokeWidth={1.3}/><h4>A place for work that can wait</h4><p>Create a list, move messages into it, and choose when they join your bot’s queue.</p></div>}
    </div> : <>
      <div className="bots-list-detail-heading"><button type="button" aria-label="Back to queue lists" onClick={()=>{setSelected(null);}}><ArrowLeft size={18}/></button><div><h4>{current?.name ?? 'Queued next'}</h4>{current?.cron&&<small>{current.enabled?`Next ${when(current.nextRunAt,current.timeZone)}`:'Schedule paused'} · {current.timeZone}</small>}</div>{current&&<div><button title="Send list to queued next" aria-label="Send list to queued next" disabled={locked||!items.length} onClick={()=>void action.run('queueLists.flush',{id:current.id,expectedRevision:current.revision})}><Send size={17}/></button><button title="List settings" aria-label="List settings" disabled={locked} onClick={()=>setEditor({id:current.id,revision:current.revision,name:current.name,cron:current.cron??'',timeZone:current.timeZone,enabled:current.enabled})}><Pencil size={17}/></button><button title="Remove empty list" aria-label="Remove empty list" disabled={locked||items.length>0} onClick={async()=>{if(await action.run('queueLists.delete',{id:current.id,expectedRevision:current.revision}))setSelected(null);}}><Trash2 size={17}/></button></div>}</div>
      <PromptQueue owner={owner} bot={bot} items={selected==='default'?defaultItems:items} online={online} canEdit listId={selected==='default'?null:selected} title={current?.name??'Queued next'} lists={lists} supported onEdit={async item=>{setError('');try{if(!await onEdit(item))setError('This message could not be taken out for editing. Check draft recovery in the conversation, then refresh this list.');}catch(reason){setError(reason instanceof Error?reason.message:'Queue removal could not be confirmed.');}}} refresh={refresh} embedded />
      {!items.length&&<p className="bots-lists-empty-note">Nothing here yet. Queue a message in the conversation, then move it into this list.</p>}
    </>}
  </div>;
}
