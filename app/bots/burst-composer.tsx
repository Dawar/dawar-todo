"use client";
import { Button } from "@/components/ui/button";
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowUp, Copy, Paperclip, Pencil, Trash2 } from 'lucide-react';
import { ReplyQuote, ReplyAction } from "./message-reply";
import type { BotReplyReference } from "../../lib/bot-replies";
import type { BotAttachment } from '../../lib/bots-types';
import type { HistoryEntry } from '../../lib/bot-history-view';
import type { Burst, BurstMessage } from './single-thread-contract';
import { MessageTime } from "./message-time";
import { AttachmentImage } from './message';
import { TextPages, ItemPages } from './lazy-details';
import { botsClient as client } from './client';
import type { BotEvent } from '../../lib/bots-types';
import type { BurstState } from './single-thread-contract';
import { useRunAction } from './run-action';
import { acknowledgedBurst, pendingMessageCount, retainedBatches, savedBurstState, validBurstState, type SavedBurstState } from './burst-state';
import './single-thread.css';
import { blastText } from '../../lib/burst-edit';
/** Receipt-owned staging shares the conversation feed, never native history. */
export function useBurstConversation({ owner, botId, threadId, online, draft, enabled, quietSeconds }: { owner: string; botId: string; threadId?: string | null; online: boolean; draft: string; enabled: boolean; quietSeconds: number }) {
  const cacheKey = `burst-summary:v1:${botId}`;
  const [value, setValue] = useState<SavedBurstState | null>(() => { const saved = client.owner === owner ? client.cache<SavedBurstState | null>(cacheKey, null) : null; return saved && validBurstState(saved, botId) && (!saved.threadId || saved.threadId === threadId) ? saved : null; }), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (value && client.owner === owner) client.save(cacheKey, savedBurstState(value));
  }, [owner, cacheKey, value]);
  const discardAction = useRunAction(owner, botId, 'burst:discard');
  const queueAction = useRunAction(owner, botId, 'burst:queue');
  const [queuePreparing,setQueuePreparing] = useState(false);
  const discard = (messageIds: string[], pendingOnly = false) => discardAction.perform('bursts.discard', { messageIds, ...(pendingOnly ? { pendingOnly: true as const } : {}) }).then(() => setRefresh(value => value + 1));
  const action = useRunAction(owner, botId, 'burst:control'), sequence = useRef(0), generation = useRef(0), typing = useRef({ id: crypto.randomUUID(), last: 0, value: draft, inputAt: 0, active: false });
  const [typingUntil, setTypingUntil] = useState(0);
  useEffect(() => {
    const listener = (event: BotEvent) => {
      if (!enabled || client.owner !== owner || event.botId !== botId || !['burst','burst.edit'].includes(event.type) || event.seq <= sequence.current) return;
      if(event.type==='burst.edit') {
        if((event.data as {threadId?:string})?.threadId!==threadId)return;
        sequence.current=event.seq;generation.current++;setRefresh(value=>value+1);return;
      }
      sequence.current = event.seq;
      const next = event.data as BurstState;
      if (validBurstState(next, botId) && (!next.threadId || next.threadId === threadId)) { generation.current++; setValue(next); setError(''); }
    };
    client.events.add(listener); return () => { client.events.delete(listener); };
  }, [owner, botId, threadId, enabled]);
  useEffect(() => {
    let live = true; const before = generation.current;
    if (enabled && online) void client.rpc<BurstState>('bursts.read', botId, {}, undefined, { owner }).then(next => {
      if (live && client.owner === owner && before === generation.current) {
        if (!validBurstState(next, botId) || next.threadId && next.threadId !== threadId) throw Error('Pending delivery could not be verified. Refresh to try again.');
        setValue(next); setError('');
      }
    }).catch(() => {
      // A newer receipt/event wins over both success and failure of this read.
      // Otherwise an old timeout can recreate a warning after delivery settled.
      if (live && client.owner === owner && before === generation.current)
        setError('Delivery status unavailable. Try again.');
    });
    return () => { live = false; };
  }, [owner, botId, threadId, online, refresh, enabled]);
  useEffect(() => {
    const confirmed: Parameters<typeof client.confirmedInputs.add>[0] = (target, confirmation) => {
      if (!enabled || client.owner !== owner || target !== botId || confirmation?.method !== 'bursts.submit'
        || !threadId || confirmation.threadId !== threadId) return;
      // Display the exact accepted source even if its socket event was lost.
      generation.current++;
      setValue(prior => acknowledgedBurst(prior, confirmation.result, botId, threadId));
      setRefresh(prior => prior + 1);
    };
    client.confirmedInputs.add(confirmed);
    return () => { client.confirmedInputs.delete(confirmed); };
  }, [owner, botId, threadId, enabled]);
  const batches = retainedBatches(value).filter(batch => batch.state !== 'sent');
  const hasPending = batches.some(batch => batch.state === 'pending' || batch.state === 'preparing');
  useEffect(() => {
    const state = typing.current;
    if (state.value !== draft) { state.value = draft; state.inputAt = Date.now(); }
    if (!enabled || !online || !hasPending) return;
    const idleAt = state.inputAt + quietSeconds * 1000, remaining = idleAt - Date.now();
    const stopTyping = () => {
      if (state.active && client.owner === owner && client.online) void client.rpc('bursts.typing', botId, { clientId: state.id, typing: false }, undefined, { owner }).catch(() => {});
      state.active = false;
      setTypingUntil(0);
    };
    if (!draft || remaining <= 0) { queueMicrotask(stopTyping); return; }
    queueMicrotask(() => setTypingUntil(idleAt));
    // A short renewable lease holds all pending batches. Only actual edits
    // renew it; a saved nonempty draft must never keep the backlog waiting.
    if (!state.active || Date.now() - state.last >= 750) {
      state.last = Date.now();
      state.active = true;
      void client.rpc('bursts.typing', botId, { clientId: state.id, typing: true }, undefined, { owner }).catch(() => {});
    }
    const timer = setTimeout(stopTyping, remaining);
    return () => clearTimeout(timer);
  }, [draft, owner, botId, online, hasPending, enabled, quietSeconds]);
  const messages = value?.messages.filter(message => message.state !== 'sent') ?? [], count = pendingMessageCount(value);
  // Start is bot-wide. A later uncertain split blocks retry of an earlier
  // definite failure too; neither text nor a missing native echo proves failure.
  const states = [...batches.map(batch => batch.state), ...messages.map(message => message.state)];
  const uncertain = states.includes('uncertain'), dispatching = states.includes('dispatching'), failed = states.includes('failed');
  const paused = value?.paused === true || states.includes('paused'), blocked = uncertain || dispatching;
  const canStart = !blocked && (failed || paused || batches.some(batch => batch.state === 'pending'));
  const pauseRequested = action.intent?.method === 'bursts.stop';
  const refreshDelivery = () => setRefresh(value => value + 1);
  return { owner, botId, value: enabled ? value : null, batches, messages, count, action, error, hasPending, uncertain, dispatching, failed, paused, blocked, canStart, refreshDelivery, typingUntil, discard, discardAction, pauseRequested, queueAction, queuePreparing, setQueuePreparing };
}
export type BurstConversation = ReturnType<typeof useBurstConversation>;

/** A canonical client ID, never text matching, replaces its retained bubbles. */
export function canonicalBurst(entry: HistoryEntry, value: SavedBurstState | null) {
  if (entry.item?.type !== 'userMessage' || !entry.item.clientId) return null;
  const clientId = entry.item.clientId;
  const batch = retainedBatches(value).find(batch => batch.operationId === clientId);
  if (!batch || batch.state !== 'sent' || batch.turnId !== entry.turnId) return null;
  const members = batch.messageIds.map(id => value?.messages.find(message => message.id === id));
  if (members.some(message => !message || value?.preview?.truncatedTextIds.includes(message.id))) return null;
  return { batch, messages: members as BurstMessage[] };
}

function BurstFill({ dueAt, quietSeconds, animate }: { dueAt: string | null; quietSeconds: number; animate: boolean }) {
  const element = useRef<HTMLSpanElement>(null);
  const due = Date.parse(dueAt ?? '');
  const [openedAt] = useState(() => Date.now());
  const progressAt = (at: number) => Number.isFinite(due) && quietSeconds > 0
    ? Math.max(0, Math.min(1, 1 - Math.max(0, due - at) / (quietSeconds * 1000))) : 0;
  useEffect(() => {
    const node = element.current;
    if (!node || !animate || !Number.isFinite(due) || due <= openedAt || quietSeconds <= 0) return;
    let frame = 0;
    const paint = () => {
      const progress = Math.max(0, Math.min(1, 1 - Math.max(0, due - Date.now()) / (quietSeconds * 1000)));
      node.style.setProperty('--burst-progress', String(progress));
      if (progress < 1 && !reduced) frame = requestAnimationFrame(paint);
    };
    // Update only the transform layer; React does not rerender chat each frame.
    // Wall time catches up correctly after a background tab resumes.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) { const timer = setInterval(paint, 250); return () => { clearInterval(timer); cancelAnimationFrame(frame); }; }
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [animate, due, quietSeconds, openedAt]);
  return <span ref={element} aria-hidden="true" className="bots-burst-fill" style={{ '--burst-progress': progressAt(openedAt) } as CSSProperties} />;
}
function BurstBubble({ message, batch, botId, attachments, quietSeconds, online, typingUntil, truncated, onOpenReply, sent: delivered, replySource, onReply, threadId, controls }: {
  controls?: BurstConversation; message: BurstMessage; batch: Burst | undefined; botId: string; attachments: BotAttachment[];
  quietSeconds: number; online: boolean; typingUntil: number; truncated: boolean; replySource?: HistoryEntry; threadId?: string; onReply?: (reply: BotReplyReference) => void; sent?: boolean; onOpenReply?: (reply: BotReplyReference) => Promise<boolean>;
}) {
  const [copyStatus, setCopyStatus] = useState('');
  const held = batch?.state === 'paused' && !delivered;
  const sent = delivered || batch?.state === 'sent', pending = batch?.state === 'pending';
  const dueAt = pending && typingUntil > Date.parse(batch?.dueAt ?? '') ? new Date(typingUntil).toISOString() : batch?.dueAt ?? null;
  return <div className="bots-message bots-user" data-burst-message={message.id}>
    <div className={`bots-bubble${sent ? '' : ' bots-bubble-pending'}`} aria-label={sent ? undefined : 'Message waiting to send'}>
      {!sent && <BurstFill key={`${dueAt}:${online}`} dueAt={dueAt} quietSeconds={quietSeconds} animate={pending && online && !controls?.pauseRequested} />}
      <div className="bots-burst-content">{message.reply && <ReplyQuote key={message.reply.id} reply={message.reply} onOpen={onOpenReply}/>}<TextPages text={message.text} render={text => <p>{text}</p>} />
        {truncated && <small>Saved preview · reconnect for complete text</small>}
        {message.attachmentIds.map(id => { const file = attachments.find(file => file.id === id); return file?.mimeType.startsWith('image/') ? <AttachmentImage key={id} botId={botId} attachment={file} /> : <span key={id} className="bots-input-file"><Paperclip size={13} aria-hidden="true" />{file?.name ?? 'File attached'}</span>; })}
      </div>
    </div>
    {held && controls && <div className="bots-burst-message-actions">
      <Button variant="ghost" size="sm" type="button" title={truncated ? 'Reconnect for complete message text' : 'Copy message text'} aria-label="Copy held message text" disabled={truncated} onClick={() => {
        if (!navigator.clipboard) { setCopyStatus('Copy unavailable. Select the text to copy it.'); return; }
        void navigator.clipboard.writeText(message.text).then(() => setCopyStatus('Copied')).catch(() => setCopyStatus('Copy failed. Select the text to copy it.'));
      }}><Copy size={14}/><span>Copy text</span></Button>
      <Button variant="ghost" size="sm" type="button" title="Delete this held message" aria-label="Delete held message" disabled={!online || client.snapshot?.capabilities?.burstControls !== 1 || !controls.discardAction.ready || controls.discardAction.busy || !!controls.discardAction.intent || controls.action.busy || !!controls.action.intent || controls.queuePreparing || controls.queueAction.busy || !!controls.queueAction.intent}
        onClick={() => void controls.discard([message.id], true).catch(() => {})}><Trash2 size={14}/><span>Delete</span></Button>
      {copyStatus && <small role="status">{copyStatus}</small>}
    </div>}
    {sent && replySource && threadId && onReply && <ReplyAction entry={replySource} botId={botId} threadId={threadId} partId={message.id} onReply={onReply}/>}
    <MessageTime seconds={Date.parse(message.createdAt) / 1000} basis="saved" user inline />
  </div>;
}
export function BurstBubbles({ messages, batch, ...props }: { messages: BurstMessage[]; batch?: Burst; botId: string; attachments: BotAttachment[]; quietSeconds: number; online: boolean; typingUntil: number; truncatedIds?: string[]; controls?: BurstConversation; replySource?: HistoryEntry; threadId?: string; onReply?: (reply: BotReplyReference) => void; sent?: boolean; onOpenReply?: (reply: BotReplyReference) => Promise<boolean> }) {
  const [originals,setOriginals]=useState(false);
  const kept=messages.filter(message=>!message.dismissed&&message.state!=='discarded');
  if(kept.length<2)return <>{kept.map(message=><BurstBubble key={message.id} message={message} batch={batch} {...props} truncated={props.truncatedIds?.includes(message.id)||Boolean((message as BurstMessage&{textTruncated?:boolean}).textTruncated)}/>)}</>;
  const sent=props.sent||batch?.state==='sent',files=[...new Set(kept.flatMap(m=>m.attachmentIds))];
  return <div className="bots-message bots-user" data-blast-aggregate>
    <div className={`bots-bubble${sent?'':' bots-bubble-pending'}`}>
      <div className="bots-burst-content"><div className="bots-blast-text">{kept.map((m,index)=><span className="bots-blast-part" data-burst-message={m.id} key={m.id}>
        {index>0&&m.text&&kept.slice(0,index).some(prior=>prior.text)?'\n':null}
        {m.reply&&<ReplyQuote reply={m.reply} onOpen={props.onOpenReply}/>}
        <TextPages text={m.text} render={text=><span>{text}</span>}/>
        {(props.truncatedIds?.includes(m.id)||(m as BurstMessage&{textTruncated?:boolean}).textTruncated)&&<small>Saved preview · reconnect for complete text</small>}
      </span>)}</div>
      {files.map(id=>{const f=props.attachments.find(f=>f.id===id);return f?.mimeType.startsWith('image/')?<AttachmentImage key={id} botId={props.botId} attachment={f}/>:<span className="bots-input-file" key={id}><Paperclip size={13}/>{f?.name??'File attached'}</span>;})}</div>
    </div>
    {sent&&props.replySource&&props.threadId&&props.onReply&&<>
      <ReplyAction entry={props.replySource} botId={props.botId} threadId={props.threadId} onReply={props.onReply}/>
      <details open={originals} onToggle={e=>setOriginals(e.currentTarget.open)}><summary>Original messages</summary>{originals&&<ItemPages items={kept} render={m=><div key={m.id}><TextPages text={m.text} render={text=><p>{text}</p>}/><ReplyAction entry={props.replySource!} botId={props.botId} threadId={props.threadId!} onReply={props.onReply!} partId={m.id}/></div>}/>}</details>
    </>}
    <MessageTime seconds={Date.parse(kept.at(-1)!.createdAt)/1000} basis="saved" user inline/>
  </div>;
}
/** One display aggregate only. Stored members, native history and aliases stay original. */
export function PendingBlastBubble({value,botId,attachments,quietSeconds,online,typingUntil,onOpenReply,submission}: {value:SavedBurstState|null;botId:string;attachments:BotAttachment[];quietSeconds:number;online:boolean;typingUntil:number;onOpenReply?:(reply:BotReplyReference)=>Promise<boolean>;submission?:import('./draft-store').Submission}) {
  const batches=retainedBatches(value).filter(b=>['pending','preparing','paused'].includes(b.state));
  const members=batches.flatMap(b=>b.messageIds.flatMap(id=>value?.messages.find(m=>m.id===id&&!m.dismissed&&m.state!=='discarded')??[]));
  const messages=[...new Map(members.map(m=>[m.id,m])).values()];
  const addition=submission?.method==='bursts.submit'&&submission.botId===botId&&!value?.messages.some(m=>m.id===submission.id)?submission:null;
  if(addition)messages.push({id:addition.id,botId,text:String(addition.params.text??''),attachmentIds:Array.isArray(addition.params.attachments)?addition.params.attachments as string[]:[],createdAt:'',batchId:null,turnId:null,state:'pending',reply:addition.params.reply as BotReplyReference|undefined});
  if(!messages.length)return null;
  const replies=[...new Map(messages.filter(m=>m.reply).map(m=>[m.reply!.id,m.reply!])).values()];
  const files=[...new Set(messages.flatMap(m=>m.attachmentIds))],pending=batches.every(b=>b.state==='pending');
  const deadline=Math.max(typingUntil,...batches.map(b=>Date.parse(b.dueAt??'')).filter(Number.isFinite));
  const dueAt=Number.isFinite(deadline)&&deadline>0?new Date(deadline).toISOString():null;
  const incomplete=!!value?.preview&&(value.preview.messageCount>messages.length||value.preview.truncatedTextIds.some(id=>messages.some(m=>m.id===id)));
  return <div className="bots-message bots-user" data-burst-message={messages[0].id} data-submission-id={addition?.id} data-pending-blast>
    <div className="bots-bubble bots-bubble-pending" aria-label="Blast waiting to send">
      <BurstFill key={`${dueAt}:${online}`} dueAt={dueAt} quietSeconds={quietSeconds} animate={pending&&online}/>
      <div className="bots-burst-content">{replies.map(reply=><ReplyQuote key={reply.id} reply={reply} onOpen={onOpenReply}/>)}<TextPages text={blastText(messages)} render={text=><p>{text}</p>}/>
        {files.map(id=>{const file=attachments.find(f=>f.id===id);return file?.mimeType.startsWith('image/')?<AttachmentImage key={id} botId={botId} attachment={file}/>:<span key={id} className="bots-input-file"><Paperclip size={13}/>{file?.name??'File attached'}</span>;})}
        {incomplete&&<small>Saved preview · reconnect for the complete blast</small>}
        {addition&&<small role="status">{addition.state==='uncertain'?'New addition unconfirmed':'Saving new addition…'}</small>}
      </div>
    </div>{members.at(-1)?.createdAt&&<MessageTime seconds={Date.parse(members.at(-1)!.createdAt)/1000} basis="saved" user inline/>}
  </div>;
}
export function BurstControls({ burst, online, submitting = false, onEdit, editPending=false }: { burst: BurstConversation; online: boolean; submitting?: boolean; onEdit?:(value:SavedBurstState)=>Promise<void>; editPending?:boolean }) {
  const { value, batches, messages, count, action, error, uncertain, dispatching, failed, paused, canStart, refreshDelivery, discardAction, pauseRequested } = burst;
  const [editing,setEditing]=useState(false),[editError,setEditError]=useState(''),editingRef=useRef(false);
  // A terminal rejected Start can remain in the action journal after the
  // original batch was confirmed. Retain the journal, but retire that stale
  // warning only after a full, fresh delivery snapshot proves nothing awaits.
  const settledWarning = online && value && !value.preview && !error && !count && !batches.length && !action.intent && action.error === 'Reconcile the original send before starting another batch; no message was repeated.';
  const actionError = settledWarning ? '' : action.error;
  if (!count && !batches.length && !submitting && !paused && !editPending && !editError && !actionError && !discardAction.error && !burst.queueAction.intent && !burst.queueAction.error && !error) return null;
  const truncatedText = new Set(value?.preview?.truncatedTextIds ?? []);
  const previewOnly = !!value?.preview || !online, completeBatchMetadata = value?.batches !== undefined;
  const baseBusy = !online || action.busy || !action.ready || !!action.intent || discardAction.busy || !!discardAction.intent;
  const busy = baseBusy || editing || burst.queuePreparing || burst.queueAction.busy || !!burst.queueAction.intent;
  const reserved=batches.some(b=>b.state==='editing');
  const deliveryError = actionError || error;
  const sendingNow = action.busy && action.intent?.method === 'bursts.start';
  const deliveryStatus = deliveryError === 'Reconcile the original send before starting another batch; no message was repeated.'
    ? 'Delivery unconfirmed.'
    : deliveryError || (action.intent ? 'Confirmation needed.' : 'Not delivered.');
  return <div className="bots-burst-pending">
    {previewOnly && (!completeBatchMetadata || count > messages.length || truncatedText.size > 0) && <small className="bots-burst-preview">Some saved messages are previews. Reconnect for complete messages and delivery status.</small>}
    <div className="bots-burst-line">
      <small role="status">{!online ? 'Saved · waiting for connection' : sendingNow ? 'Sending…' : pauseRequested ? 'Confirming pause…' : paused ? dispatching || uncertain ? 'Paused · earlier delivery already began' : 'Paused' : uncertain ? 'Checking delivery' : dispatching ? 'Sending' : batches.some(batch => batch.state === 'preparing') ? 'Preparing to send' : ''}</small>
      <div>{!action.intent && <>
        {count>0 && <Button variant="ghost" size="sm" type="button" aria-label={failed ? 'Retry and send retained messages' : 'Send waiting messages now'} title="Send now" disabled={busy||submitting||editPending||!canStart||reserved} onClick={() => void action.perform('bursts.start', {}).then(refreshDelivery).catch(() => {})}><ArrowUp size={16}/>Send now</Button>}
        {(count>0||reserved||editPending)&&<Button variant="ghost" size="sm" type="button" title={client.snapshot?.capabilities?.burstEdit===1?'Return unsent blast to the editor':'Edit requires the updated service'} disabled={busy||submitting||uncertain||dispatching||failed||!value||!onEdit||client.snapshot?.capabilities?.burstEdit!==1} onClick={()=>{
          if(!value||!onEdit||editingRef.current)return;editingRef.current=true;setEditing(true);setEditError('');void onEdit(value).then(refreshDelivery).catch(e=>{setEditError(e instanceof Error?e.message:'Edit is unconfirmed. Recover its original receipt.');refreshDelivery();}).finally(()=>{editingRef.current=false;setEditing(false);});
        }}><Pencil size={16}/>Edit</Button>}
      </>}</div>
    </div>
    {discardAction.error && <div className="bots-burst-recovery" role="alert">{discardAction.error}{discardAction.intent && <Button variant="ghost" size="sm" type="button" disabled={!online || discardAction.busy} onClick={() => void discardAction.retry().then(refreshDelivery).catch(() => {})}>Check deletion</Button>}</div>}
    {(editing||reserved||editPending||editError)&&<div className="bots-burst-recovery" role="status">{editError|| (editing?'Saving blast for editing…':'Blast held for its original Edit receipt. Use Edit to finish in the original browser draft.')}</div>}
    {count>0&&client.snapshot?.capabilities?.burstEdit!==1&&<small>Edit is unavailable on this service; the unsent blast is retained.</small>}
    {(burst.queueAction.intent||burst.queueAction.error)&&<div className="bots-burst-recovery" role="alert">{burst.queueAction.error||'Original queue placement unconfirmed.'}{burst.queueAction.intent&&<Button variant="ghost" size="sm" type="button" disabled={!online||burst.queueAction.busy} onClick={()=>void burst.queueAction.retry().then(refreshDelivery).catch(()=>{})}>Check original placement</Button>}</div>}
    {!sendingNow && (error || actionError || failed || action.intent && !action.busy) && <div className="bots-burst-recovery" role="alert">{deliveryStatus}{action.intent ? <Button variant="ghost" size="sm" type="button" disabled={!online || action.busy} onClick={() => void action.retry().then(refreshDelivery).catch(() => {})}>Check delivery</Button> : <Button variant="ghost" size="sm" type="button" disabled={!online} onClick={refreshDelivery}>Check delivery</Button>}</div>}
  </div>;
}
