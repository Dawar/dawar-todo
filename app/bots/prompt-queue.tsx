"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Combine, FolderInput, FolderOpen, GripVertical, Pencil, RefreshCw, Send, Trash2 } from 'lucide-react';
import type { Bot, BotQueueList, BotQueuedSubmission } from '../../lib/bots-types';
import { canMoveQueued, queueEditable, queueResumeBlocked, queueStatus } from './queue-state';
import { useQueueAction } from './use-queue-action';
import { botsClient as client } from './client';
import { UploadThumbnail } from './upload-thumbnail';
import './prompt-queue.css';
const textOf = (item:BotQueuedSubmission)=>item.input.flatMap(input=>input.type==='text'&&!input.text.startsWith('Attached file: ')?[input.text]:[]).join('\n')||'Attachments';
const selectionKey = (item:BotQueuedSubmission)=>`${item.id}:${item.revision}`;
function QueueText({text}:{text:string}) {
  const [open,setOpen]=useState(false);
  return <><p className={`bots-queue-text${open?' is-open':''}`}>{text}</p>{text.length>260&&<button className="bots-queue-text-toggle" type="button" onClick={()=>setOpen(!open)}>{open?'Show less':'Read message'}</button>}</>;
}
export function PromptQueue({ owner, bot, items, online, canEdit, onEdit, refresh, lists=[], supported=false, listId=null, title='Queued next', onOpenLists, embedded=false, relativeMoves=false }: {
  owner:string;bot:Bot;items:BotQueuedSubmission[];online:boolean;canEdit:boolean;
  onEdit:(item:BotQueuedSubmission)=>void;refresh:()=>Promise<void>;lists?:BotQueueList[];supported?:boolean;
  listId?:string|null;title?:string;onOpenLists?:()=>void;embedded?:boolean;relativeMoves?:boolean;
}) {
  const action=useQueueAction(owner,bot.id,refresh), [checked,setChecked]=useState<string[]>([]), [selecting,setSelecting]=useState(false);
  const [optimistic,setOptimistic]=useState<string[]|null>(null), [drop,setDrop]=useState<string|null|undefined>(undefined), [dragId,setDragId]=useState<string|null>(null);
  const dragging=useRef<{id:string;beforeId:string|null;pointerId:number}|null>(null), panel=useRef<HTMLElement>(null);
  const stopDrag=useRef<()=>void>(()=>{});
  useEffect(()=>()=>stopDrag.current(),[]);
  const locked=action.busy||action.blocked;
  const rows=optimistic ? [...items].sort((a,b)=>optimistic.indexOf(a.id)-optimistic.indexOf(b.id)) : items;
  const selectable=items.filter(item=>supported&&item.revision!==undefined&&queueEditable(item));
  const selected=selectable.filter(item=>checked.includes(selectionKey(item))), allSelected=selectable.length>0&&selected.length===selectable.length;
  const selection=selected.map(item=>({id:item.id,revision:item.revision!}));
  const reorder=async(id:string,beforeId:string|null)=>{
    if(locked||!online||id===beforeId)return;
    const item=items.find(item=>item.id===id);
    if(!item||!queueEditable(item))return;
    const ordered=items.filter(item=>item.id!==id), index=beforeId===null?ordered.length:ordered.findIndex(item=>item.id===beforeId);
    if(index<0)return; ordered.splice(index,0,item);
    const ids=ordered.map(item=>item.id);
    if(ids.every((id,index)=>id===items[index].id))return;
    setOptimistic(ids);
    try { await action.run('queue.reorder',{...(relativeMoves&&item.revision!==undefined?{id,beforeId,expectedRevision:item.revision}:{ids}),...(listId?{listId}:{})}); }
    finally {setOptimistic(null);}
  };
  const move=(index:number,direction:number)=>{
    if(!canMoveQueued(items,index,direction))return;
    void reorder(items[index].id,direction<0?items[index-1].id:items[index+2]?.id??null);
  };
  const moveTo=(item:BotQueuedSubmission|null,target:string)=>void action.run('queue.move',{items:item?[{id:item.id,revision:item.revision}]:selection,listId:target==='default'?null:target});
  const destinations=[...(!listId?[]:[{id:'default',name:'Queued next'}]),...lists.filter(list=>list.id!==listId)];
  if(!items.length&&!action.pending&&!action.error)return null;
  return <section ref={panel} className={`bots-prompt-queue bots-queue-panel${embedded?' is-embedded':''}`} aria-label="Queued messages" tabIndex={-1}>
    <header><strong>{title}<span>{items.length}</span></strong><div>
      {selectable.length>1&&<button type="button" className="bots-queue-select-toggle" onClick={()=>{setSelecting(!selecting);setChecked([]);}}>{selecting?'Done':'Select'}</button>}
      {onOpenLists&&<button type="button" aria-label="Open queue lists" title="Queue lists" onClick={onOpenLists}><FolderOpen size={17}/></button>}
      <button type="button" aria-label="Refresh queue status" title="Refresh" disabled={!online||action.busy} onClick={()=>void refresh()}><RefreshCw size={16}/></button>
    </div></header>
    {!online&&<p className="bots-queue-explanation">Reconnect to change this queue.</p>}
    {!listId&&bot.queuePaused&&items.length>0&&<div className="bots-queue-paused"><span>{queueResumeBlocked(items)?'Review messages before resuming.':'Queue paused'}</span><button type="button" disabled={!online||locked||queueResumeBlocked(items)} onClick={()=>void action.run('queue.resume')}>Resume</button></div>}
    {action.pending&&!action.busy&&<div className="bots-queue-action-note" role="alert"><p>{action.notSaved?'Could not save this change.':'Could not confirm this change.'}</p><button type="button" disabled={!online} onClick={action.retry}>Retry</button></div>}
    {action.error&&<div className="bots-queue-action-note is-error" role="alert"><p>{action.error}</p>{!action.pending&&action.blocked&&<button type="button" onClick={action.recover}>Retry</button>}</div>}
    {selecting&&<div className="bots-queue-selection"><label><input type="checkbox" aria-label="Select all queued messages" checked={allSelected} disabled={locked||!online} onChange={()=>setChecked(allSelected?[]:selectable.map(selectionKey))}/><span>{selected.length} selected</span></label>{selected.length>0&&<div><button type="button" disabled={locked||!online||selected.length<2} onClick={()=>void action.run('queue.merge',{items:selection})}><Combine size={16}/>Merge</button>{destinations.length>0&&<label className="bots-queue-move"><FolderInput size={16}/><select aria-label="Move selected messages to queue list" value="" disabled={locked||!online} onChange={e=>moveTo(null,e.target.value)}><option value="" disabled>Move to…</option>{destinations.map(list=><option value={list.id} key={list.id}>{list.name}</option>)}</select></label>}</div>}</div>}
    {rows.map((item,index)=>{
      const status=queueStatus(item,bot.queuePaused),mutable=queueEditable(item)&&!locked;
      const canDrag=online&&mutable&&items.every(queueEditable);
      return <article data-queue-id={item.id} className={`bots-prompt-queue-item${drop===item.id?' is-drop-target':''}${dragId===item.id?' is-dragging':''}`} key={item.id}>
        <div className="bots-queue-index">
          <button type="button" className="bots-queue-drag" aria-label={`Drag message ${index+1} to reorder`} title="Drag to reorder" disabled={!canDrag}
            onPointerDown={event=>{
              if(!canDrag||event.button!==0)return;
              event.preventDefault();stopDrag.current();
              const pointerId=event.pointerId;
              dragging.current={id:item.id,beforeId:item.id,pointerId};setDragId(item.id);
              const move=(event:PointerEvent)=>{
                const drag=dragging.current;if(!drag||drag.pointerId!==event.pointerId)return;
                const row=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-queue-id]');
                if(!row||!panel.current?.contains(row))return;
                const rowId=row.dataset.queueId!,at=items.findIndex(item=>item.id===rowId);
                drag.beforeId=event.clientY>row.getBoundingClientRect().top+row.offsetHeight/2?items[at+1]?.id??null:rowId;
                setDrop(drag.beforeId);
                const box=panel.current.getBoundingClientRect();if(event.clientY<box.top+40)panel.current.scrollTop-=12;else if(event.clientY>box.bottom-40)panel.current.scrollTop+=12;
              };
              const cleanup=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',finish);document.removeEventListener('pointercancel',cancel);window.removeEventListener('blur',cancel);dragging.current=null;setDragId(null);setDrop(undefined);};
              const finish=(event:PointerEvent)=>{
                const drag=dragging.current;if(!drag||drag.pointerId!==event.pointerId)return;
                const box=panel.current?.getBoundingClientRect();cleanup();
                if(box&&event.clientX>=box.left&&event.clientX<=box.right&&event.clientY>=box.top&&event.clientY<=box.bottom)void reorder(drag.id,drag.beforeId);
              };
              const cancel=()=>cleanup();stopDrag.current=cleanup;
              document.addEventListener('pointermove',move);document.addEventListener('pointerup',finish);document.addEventListener('pointercancel',cancel);window.addEventListener('blur',cancel);
            }}><GripVertical size={18}/></button>
          {selecting?<input type="checkbox" aria-label={`Select queued message ${index+1}`} checked={checked.includes(selectionKey(item))} disabled={!mutable||!online} onChange={e=>setChecked(values=>e.target.checked?[...values,selectionKey(item)]:values.filter(value=>value!==selectionKey(item)))}/>:<span>{index+1}</span>}
        </div>
        <div className="bots-queue-content"><QueueText text={textOf(item)}/>{status.attention&&<p className="bots-queue-status needs-attention"><strong>{status.label}</strong><span>{status.description}</span></p>}
          {item.configuration && <p className="bots-queue-status needs-attention"><strong>Requested settings · not dispatched</strong><span>{item.configuration.requested.model} · {item.configuration.requested.effort ?? "Unknown effort"} · {item.configuration.requested.mode} · {item.configuration.reason}</span></p>}
          {item.error&&<p className="bots-queue-item-error">{item.error}</p>}
          {item.attachments.length>0&&<div className="bots-queue-attachments">{item.attachments.map(file=><span key={file.id} title={file.name}>{file.mimeType.startsWith('image/')&&<UploadThumbnail botId={bot.id} attachmentId={file.id} online={online}/>}<span>{file.name}</span></span>)}</div>}
          <div className="bots-queue-actions">
            <button type="button" title={client.snapshot?.capabilities?.queueSendNow!==1?'Available after the bot service update':!queueEditable(item)||item.revision===undefined?'Delivery is already in progress; refresh to check it':'Send this message now; adds to the current turn if the bot is working'} disabled={!online||!mutable||bot.archived||client.snapshot?.capabilities?.queueSendNow!==1||item.revision===undefined||item.configuration?.confirmation==='pending-unsupported'} onClick={()=>void action.run('queue.send',{id:item.id,expectedRevision:item.revision})}><Send size={15}/>Send now</button>
            <button type="button" disabled={!online||!canEdit||!mutable} onClick={()=>onEdit(item)}><Pencil size={15}/>Edit</button>
            <button type="button" aria-label={`Move message ${index+1} up`} title="Move up" disabled={!online||locked||!canMoveQueued(items,index,-1)} onClick={()=>move(index,-1)}><ArrowUp size={16}/></button>
            <button type="button" aria-label={`Move message ${index+1} down`} title="Move down" disabled={!online||locked||!canMoveQueued(items,index,1)} onClick={()=>move(index,1)}><ArrowDown size={16}/></button>
            {supported&&item.revision!==undefined&&destinations.length>0&&<label className="bots-queue-move"><FolderInput size={15}/><select aria-label={`Move message ${index+1} to queue list`} value="" disabled={!online||!mutable} onChange={e=>moveTo(item,e.target.value)}><option value="" disabled>Move to…</option>{destinations.map(list=><option key={list.id} value={list.id}>{list.name}</option>)}</select></label>}
            <button type="button" className="is-destructive" disabled={!online||!mutable} onClick={()=>void action.run('queue.delete',{id:item.id,...(item.revision===undefined?{}:{expectedRevision:item.revision})})}><Trash2 size={15}/>Remove</button>
          </div>
        </div>
      </article>;
    })}
    {drop===null&&<div className="bots-queue-drop-end"/>}
  </section>;
}
