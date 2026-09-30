"use client";
import { useState } from 'react';
import { ArrowDown, ArrowUp, Combine, FolderInput, FolderOpen, MoreHorizontal, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import type { Bot, BotQueueList, BotQueuedSubmission } from '../../lib/bots-types';
import { canMoveQueued, queueEditable, queueResumeBlocked, queueStatus } from './queue-state';
import { useQueueAction } from './use-queue-action';
import { UploadThumbnail } from './upload-thumbnail';
import './prompt-queue.css';
const textOf = (item:BotQueuedSubmission)=>item.input.flatMap(input=>input.type==='text'&&!input.text.startsWith('Attached file: ')?[input.text]:[]).join('\n')||'Attachments';
const selectionKey = (item:BotQueuedSubmission)=>`${item.id}:${item.revision}`;
function QueueText({text}:{text:string}) {
  const [open,setOpen]=useState(false);
  return <><p className={`bots-queue-text${open?' is-open':''}`}>{text}</p>{text.length>260&&<button className="bots-queue-text-toggle" type="button" onClick={()=>setOpen(!open)}>{open?'Show less':'Read message'}</button>}</>;
}
export function PromptQueue({ owner, bot, items, online, canEdit, onEdit, refresh, lists=[], supported=false, listId=null, title='Queued next', onOpenLists, embedded=false }: {
  owner:string;bot:Bot;items:BotQueuedSubmission[];online:boolean;canEdit:boolean;
  onEdit:(item:BotQueuedSubmission)=>void;refresh:()=>Promise<void>;lists?:BotQueueList[];supported?:boolean;
  listId?:string|null;title?:string;onOpenLists?:()=>void;embedded?:boolean;
}) {
  const action=useQueueAction(owner,bot.id,refresh), [checked,setChecked]=useState<string[]>([]);
  const locked=action.busy||action.blocked;
  const selectable=items.filter(item=>supported&&item.revision!==undefined&&queueEditable(item));
  const selected=selectable.filter(item=>checked.includes(selectionKey(item))), allSelected=selectable.length>0&&selected.length===selectable.length;
  if(!items.length&&!action.pending&&!action.error)return null;
  const selection=selected.map(item=>({id:item.id,revision:item.revision!}));
  const move=(index:number,direction:number)=>{
    if(!canMoveQueued(items,index,direction))return;
    const ids=items.map(item=>item.id),other=index+direction;[ids[index],ids[other]]=[ids[other],ids[index]];
    void action.run('queue.reorder',{ids,...(listId?{listId}:{})});
  };
  const moveTo=(item:BotQueuedSubmission|null,target:string)=>{
    void action.run('queue.move',{items:item?[{id:item.id,revision:item.revision}]:selection,listId:target==='default'?null:target});
  };
  const destinations=[...(!listId?[]:[{id:'default',name:'Queued next'}]),...lists.filter(list=>list.id!==listId)];
  return <section className={`bots-prompt-queue bots-queue-panel${embedded?' is-embedded':''}`} aria-label="Queued messages" tabIndex={-1}>
    <header><strong>{title}<span>{items.length}</span></strong><div>{onOpenLists&&<button type="button" aria-label="Open queue lists" title="Queue lists" onClick={onOpenLists}><FolderOpen size={17}/></button>}<button type="button" aria-label="Refresh queue status" title="Refresh" disabled={!online||action.busy} onClick={()=>void refresh()}><RefreshCw size={16}/></button></div></header>
    {!online&&<p className="bots-queue-explanation">Saved queue · reconnect to make changes.</p>}
    {!listId&&bot.queuePaused&&items.length>0&&<div className="bots-queue-paused"><span>{queueResumeBlocked(items)?'Review messages before resuming.':'Queue paused'}</span><button type="button" disabled={!online||locked||queueResumeBlocked(items)} onClick={()=>void action.run('queue.resume')}>Resume</button></div>}
    {action.pending&&<div className="bots-queue-action-note" role="status"><p>{action.busy?'Confirming your change…':action.notSaved?'This change needs to be saved on your device.':'This change still needs confirmation.'}</p><button type="button" disabled={!online||action.busy} onClick={action.retry}>Check same action</button></div>}
    {action.error&&<div className="bots-queue-action-note is-error" role="alert"><p>{action.error}</p>{!action.pending&&action.blocked&&<button type="button" onClick={action.recover}>Read saved action</button>}</div>}
    {selectable.length>0&&<div className="bots-queue-selection"><label><input type="checkbox" aria-label="Select all queued messages" checked={allSelected} disabled={locked||!online} onChange={()=>setChecked(allSelected?[]:selectable.map(selectionKey))}/><span>{selected.length?`${selected.length} selected`:'Select messages'}</span></label>{selected.length>0&&<div><button type="button" title="Merge selected messages in queue order" aria-label="Merge selected messages" disabled={locked||!online||selected.length<2} onClick={()=>void action.run('queue.merge',{items:selection})}><Combine size={16}/><span>Merge</span></button>{destinations.length>0&&<label className="bots-queue-move"><FolderInput size={16}/><select aria-label="Move selected messages to queue list" value="" disabled={locked||!online} onChange={e=>moveTo(null,e.target.value)}><option value="" disabled>Move to…</option>{destinations.map(list=><option value={list.id} key={list.id}>{list.name}</option>)}</select></label>}</div>}</div>}
    {items.map((item,index)=>{
      const status=queueStatus(item,bot.queuePaused),mutable=queueEditable(item)&&!locked;
      return <article className="bots-prompt-queue-item" key={item.id}>
        <label className="bots-queue-index">{supported&&item.revision!==undefined?<input type="checkbox" aria-label={`Select queued message ${index+1}`} checked={checked.includes(selectionKey(item))} disabled={!mutable||!online} onChange={e=>setChecked(values=>e.target.checked?[...values,selectionKey(item)]:values.filter(value=>value!==selectionKey(item)))}/>:<span>{index+1}</span>}</label>
        <div className="bots-queue-content"><QueueText text={textOf(item)}/>{status.attention?<p className="bots-queue-status needs-attention"><strong>{status.label}</strong><span>{status.description}</span></p>:<p className="bots-queue-status">{listId?'Saved in this list':status.label}</p>}
          {item.error&&<p className="bots-queue-item-error">{item.error}</p>}
          {item.attachments.length>0&&<div className="bots-queue-attachments">{item.attachments.map(file=><span key={file.id} title={file.name}>{file.mimeType.startsWith('image/')&&<UploadThumbnail botId={bot.id} attachmentId={file.id} online={online}/>}<span>{file.name}</span></span>)}</div>}
        </div>
        <details className="bots-queue-item-menu"><summary aria-label={`Actions for queued message ${index+1}`} title="Message actions"><MoreHorizontal size={19}/></summary><div className="bots-queue-actions">
          <button type="button" disabled={!canEdit||!mutable} onClick={()=>onEdit(item)}><Pencil size={16}/>Edit message</button>
          <div className="bots-queue-order-actions"><button type="button" aria-label={`Move queued message ${index+1} up`} title="Move up" disabled={!online||locked||!canMoveQueued(items,index,-1)} onClick={()=>move(index,-1)}><ArrowUp size={16}/></button><button type="button" aria-label={`Move queued message ${index+1} down`} title="Move down" disabled={!online||locked||!canMoveQueued(items,index,1)} onClick={()=>move(index,1)}><ArrowDown size={16}/></button><span>Reorder</span></div>
          {supported&&item.revision!==undefined&&destinations.length>0&&<label className="bots-queue-move"><FolderInput size={16}/><select aria-label={`Move queued message ${index+1} to queue list`} value="" disabled={!online||!mutable} onChange={e=>moveTo(item,e.target.value)}><option value="" disabled>Move to…</option>{destinations.map(list=><option key={list.id} value={list.id}>{list.name}</option>)}</select></label>}
          <button type="button" className="is-destructive" disabled={!online||!mutable} onClick={()=>void action.run('queue.delete',{id:item.id,...(item.revision===undefined?{}:{expectedRevision:item.revision})})}><Trash2 size={16}/>Remove</button>
        </div></details>
      </article>;
    })}
  </section>;
}
