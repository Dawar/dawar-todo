"use client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {  FolderOpen, ListOrdered, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
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
export function QueueDestinationPicker({lists, disabled, onChoose, onClose, onManage, onSubmitNow, showDefault = true, description, error, returnFocus, submitting = false}: {
  lists: BotQueueList[]; disabled: boolean; onChoose: (id: string | null) => void; onClose: () => void; onManage?: () => void;
  onSubmitNow?: () => void; showDefault?: boolean; description?: string; error?: string; returnFocus?: HTMLElement | null; submitting?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const opener = returnFocus ?? document.activeElement, dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({preventScroll:true}); };
  }, [returnFocus]);
  return <dialog ref={ref} className="bots-queue-picker" aria-labelledby="queue-picker-title" onCancel={onClose} onClick={event => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
  }}>
    <header><div><span>Queue message</span><h2 id="queue-picker-title">Choose a list</h2></div><Button variant="outline" type="button" className="bots-icon-button" aria-label="Close queue picker" onClick={onClose}><X size={20}/></Button></header>
    {(description || submitting) && <p className="bots-queue-picker-note" role={submitting ? 'status' : undefined}>{submitting ? 'Queueing…' : description}</p>}
    {error && <p className="bots-lists-error" role="alert">{error}</p>}
    <div className="bots-queue-destinations">
      {showDefault && <Button variant="outline" type="button" disabled={disabled} onClick={() => onChoose(null)}><ListOrdered size={21}/><span><strong>Queued next</strong><small>Starts when this bot is free</small></span></Button>}
      {lists.map(list => <Button variant="outline" type="button" key={list.id} disabled={disabled} onClick={() => onChoose(list.id)}><FolderOpen size={21}/><span><strong>{list.name}</strong><small>{list.count} {list.count === 1 ? 'message' : 'messages'} · {list.cron ? list.enabled ? 'Scheduled' : 'Schedule paused' : 'Manual list'}</small></span></Button>)}
      {onSubmitNow && <Button variant="outline" type="button" disabled={disabled} onClick={onSubmitNow}><Send size={21}/><span><strong>Submit now</strong><small>Send this message directly</small></span></Button>}
    </div>
    {!lists.length && !showDefault && !onSubmitNow && <p className="bots-queue-picker-note">No named lists yet. Cancel keeps these messages paused.</p>}
    {onManage && <Button variant="outline" type="button" className="bots-queue-manage" onClick={onManage}><Plus size={17}/>{lists.length ? 'Manage queue lists' : 'Create a queue list'}</Button>}
    <Button variant="outline" type="button" className="bots-queue-manage" onClick={onClose}>{submitting ? 'Close' : 'Cancel'}</Button>
  </dialog>;
}
export function QueueLists({owner,bot,lists,defaultItems,online,refreshLists,refreshDefault,onEdit}: {
  owner:string;bot:Bot;lists:BotQueueList[];defaultItems:BotQueuedSubmission[];online:boolean;
  refreshLists:()=>Promise<void>;refreshDefault:()=>Promise<void>;onEdit:(item:BotQueuedSubmission)=>Promise<boolean>;
}) {
  const [selected,setSelected] = useState<string|null>('default'), [editor,setEditor] = useState<ReturnType<typeof blank> & {id?:string;revision?:number}|null>(null);
  const [loaded,setLoaded] = useState<{id:string|null;items:BotQueuedSubmission[]}>({id:null,items:[]}), [error,setError] = useState('');
  const [read,setRead] = useState<{id:string|null;loading:boolean;error:string}>({id:null,loading:false,error:''});
  const request=useRef(0), current=lists.find(l=>l.id===selected);
  const refresh = useCallback(async()=>{
    // Claim this refresh before any await: an older parent read must not become
    // the newest selected-list request after navigation or a later refresh.
    const n=++request.current;
    const currentRequest=()=>n===request.current && client.owner===owner;
    if (!online || !currentRequest()) return;
    setRead({id:selected,loading:true,error:''});
    try {
      await Promise.all([refreshLists(),refreshDefault()]);
      if (!currentRequest()) return;
      if (selected && selected!=='default') {
        const items=await client.rpc<BotQueuedSubmission[]>('queue.list',bot.id,{listId:selected});
        if (!currentRequest()) return;
        client.save(`queue:${bot.id}:${selected}`,items);
        setLoaded({id:selected,items});
      }
      setRead({id:selected,loading:false,error:''});
    } catch {
      if(currentRequest())setRead({id:selected,loading:false,error:'Could not refresh this queue. Try again.'});
    }
  },[refreshLists,refreshDefault,selected,online,bot.id,owner]);
  const action=useQueueAction(owner,bot.id,refresh);
  useEffect(()=>{
    let active=true;
    queueMicrotask(()=>{
      if(!active || client.owner!==owner)return;
      if(selected && selected!=='default')setLoaded({id:selected,items:client.cache<BotQueuedSubmission[]>(`queue:${bot.id}:${selected}`,[])});
      void refresh();
    });
    const listener=(event:{type:string;botId?:string})=>{if(event.type==='queue' && event.botId===bot.id)void refresh();};
    client.events.add(listener);
    return ()=>{active=false;
      // Invalidate this list read; this ref is a request counter, not a DOM node.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      request.current++;client.events.delete(listener);};
  },[selected,bot.id,owner,refresh]);
  const items=!selected||selected==='default'?defaultItems:loaded.id===selected?loaded.items:[];
  const loading=online && (read.id!==selected || read.loading), readError=read.id===selected?read.error:'';
  const locked=action.busy || action.blocked || !online;
  const validationId=useId(), cronError=editor?cronValidationError(editor.cron):null, hasSchedule=Boolean(editor?.cron.trim());
  let next:string|null=null, zoneError:string|null=null;
  if(editor && hasSchedule) {
    try { new Intl.DateTimeFormat(undefined,{timeZone:editor.timeZone}).format(); }
    catch { zoneError='Enter a valid timezone, such as America/Toronto.'; }
    if(!cronError && !zoneError) next=nextCronOccurrence(editor.cron,new Date(),editor.timeZone)?.toISOString()??null;
  }
  const scheduleError=cronError || zoneError || (hasSchedule && !next ? 'This schedule has no upcoming occurrence. Choose another schedule.' : null);
  return <div className="bots-queue-lists">
    <header className="bots-lists-heading"><div><h3>Queue lists</h3></div><Button variant="outline" type="button" title="New queue list" aria-label="New queue list" disabled={locked} onClick={()=>setEditor(blank())}><Plus size={19}/>New list</Button></header>
    {action.error && <p className="bots-lists-error" role="alert">{action.error}</p>}
    {action.pending && <div className={action.busy?'bots-lists-pending':'bots-lists-error'} role="status">{action.busy?'Saving…':'This change needs confirmation.'}{!action.busy&&<Button variant="outline" type="button" disabled={!online} onClick={action.retry}>Retry</Button>}</div>}
    {error && <p className="bots-lists-error" role="alert">{error}</p>}
    {editor && <form className="bots-list-editor" aria-busy={action.busy} onSubmit={async event=>{
      event.preventDefault(); if(locked || scheduleError || !editor.name.trim())return;
      const {revision,...params}=editor;
      if(await action.run('queueLists.save',{...params,cron:editor.cron.trim()||null,...(revision?{expectedRevision:revision}:{})}))setEditor(null);
    }}><header><strong>{editor.id?'List settings':'New queue list'}</strong><Button variant="outline" type="button" aria-label="Close list editor" onClick={()=>setEditor(null)}><X size={18}/></Button></header>
      <label>Name<Input autoFocus disabled={locked} value={editor.name} maxLength={80} required placeholder="Morning work" onChange={e=>setEditor({...editor,name:e.target.value})}/></label>
      <ListSchedule editor={editor} disabled={locked} cronError={cronError} zoneError={zoneError} errorId={validationId} onChange={value=>setEditor({...editor,...value})}/>
      {!cronError && !zoneError && (scheduleError?<small role="alert">{scheduleError}</small>:next&&editor.enabled?<small>Next: {when(next,editor.timeZone)}</small>:null)}
      <Button className="bots-primary" type="submit" disabled={locked||Boolean(scheduleError)||!editor.name.trim()}>{action.busy?'Saving…':'Save list'}</Button>
    </form>}
    <nav className="bots-list-tabs" aria-label="Queue lists">
      <Button variant="outline" type="button" aria-pressed={!selected||selected==='default'} onClick={()=>setSelected('default')}><ListOrdered size={16}/>Queued next <span>{defaultItems.length}</span></Button>
      {lists.map(list=><Button variant="outline" type="button" key={list.id} aria-pressed={selected===list.id} onClick={()=>setSelected(list.id)}><FolderOpen size={16}/>{list.name}<span>{list.count}</span></Button>)}
    </nav>
    <div className="bots-list-detail-heading"><div><h4>{current?.name ?? 'Queued next'}</h4><small>{current?.cron?current.enabled?`Next ${when(current.nextRunAt,current.timeZone)} · ${current.timeZone}`:'Schedule paused':current?'Manual list':'Starts when this bot is free'}</small></div>{current&&<div>
      <Button variant="outline" disabled={locked||!items.length} onClick={()=>void action.run('queueLists.flush',{id:current.id,expectedRevision:current.revision})}><Send size={17}/>Queue now</Button>
      <Button variant="outline" disabled={locked} onClick={()=>setEditor({id:current.id,revision:current.revision,name:current.name,cron:current.cron??'',timeZone:current.timeZone,enabled:current.enabled})}><Pencil size={17}/>Settings</Button>
      <Button variant="outline" title="Only empty lists can be removed" disabled={locked||items.length>0||current.count>0} onClick={async()=>{if(await action.run('queueLists.delete',{id:current.id,expectedRevision:current.revision}))setSelected('default');}}><Trash2 size={17}/>Delete list</Button>
    </div>}</div>
      {readError && online && <div className="bots-lists-error bots-lists-read-error" role="alert"><span>{readError}</span><Button variant="outline" type="button" onClick={()=>void refresh()}>Retry</Button></div>}
      <PromptQueue owner={owner} bot={bot} items={selected==='default'?defaultItems:items} online={online} canEdit listId={selected==='default'?null:selected} title={current?.name??'Queued next'} lists={lists} supported relativeMoves={client.snapshot?.capabilities?.queueRelativeMoves===1} onEdit={async item=>{setError('');try{if(!await onEdit(item))setError('Could not confirm removal. Retry in the composer.');}catch{setError('Queue removal could not be confirmed. Check delivery before trying again.');}}} refresh={refresh} embedded />
      {!items.length && (loading?<p className="bots-lists-empty-note" role="status">Loading messages…</p>:!online?<p className="bots-lists-empty-note">Connect to refresh this queue.</p>:!readError?<p className="bots-lists-empty-note">No queued messages.</p>:null)}
  </div>;
}

function ListSchedule({editor,onChange,disabled,cronError,zoneError,errorId}:{editor:ReturnType<typeof blank>;onChange:(value:Partial<ReturnType<typeof blank>>)=>void;disabled:boolean;cronError:string|null;zoneError:string|null;errorId:string}) {
  const parts=editor.cron.split(' '), timed=/^\d{1,2} \d{1,2} \* \* (\*|1-5)$/.test(editor.cron);
  const mode=!editor.cron?'manual':timed?parts[4]==='*'?'daily':'weekdays':editor.cron==='0 * * * *'?'hourly':'custom';
  const time=timed?`${parts[1].padStart(2,'0')}:${parts[0].padStart(2,'0')}`:'09:00';
  return <><label>Schedule<NativeSelect disabled={disabled} value={mode} onChange={e=>onChange({cron:e.target.value==='manual'?'':e.target.value==='hourly'?'0 * * * *':e.target.value==='custom'?'0 9 * * 1':`0 9 * * ${e.target.value==='daily'?'*':'1-5'}`})}>
    <option value="manual">Manual only</option><option value="daily">Every day</option><option value="weekdays">Weekdays</option><option value="hourly">Every hour</option><option value="custom">Custom schedule</option>
  </NativeSelect></label>
  {(mode==='daily'||mode==='weekdays')&&<label>Time<Input type="time" aria-invalid={Boolean(cronError)||undefined} aria-describedby={cronError?`${errorId}-cron`:undefined} disabled={disabled} required value={time} onChange={e=>{const [hour,minute]=e.target.value.split(':');if(hour&&minute)onChange({cron:`${Number(minute)} ${Number(hour)} * * ${mode==='daily'?'*':'1-5'}`});}}/>{cronError&&<small id={`${errorId}-cron`} role="alert">{cronError}</small>}</label>}
  {mode==='custom'&&<label>Cron expression<Input disabled={disabled} aria-invalid={Boolean(cronError)||undefined} aria-describedby={cronError?`${errorId}-cron`:undefined} value={editor.cron} onChange={e=>onChange({cron:e.target.value})} spellCheck={false}/>{cronError&&<small id={`${errorId}-cron`} role="alert">{cronError}</small>}</label>}
  {editor.cron&&<><label>Timezone<Input disabled={disabled} aria-invalid={Boolean(zoneError)||undefined} aria-describedby={zoneError?`${errorId}-zone`:undefined} value={editor.timeZone} onChange={e=>onChange({timeZone:e.target.value})} required placeholder="America/Toronto"/>{zoneError&&<small id={`${errorId}-zone`} role="alert">{zoneError}</small>}</label><label className="bots-list-checkbox"><input type="checkbox" disabled={disabled} checked={editor.enabled} onChange={e=>onChange({enabled:e.target.checked})}/>Schedule enabled</label></>}
  </>;
}
