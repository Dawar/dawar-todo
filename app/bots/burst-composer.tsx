"use client";
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowUp, Paperclip, Pause, Trash2 } from 'lucide-react';
import { ReplyQuote, ReplyAction } from "./message-reply";
import type { BotReplyReference } from "../../lib/bot-replies";
import type { BotAttachment } from '../../lib/bots-types';
import type { HistoryEntry } from '../../lib/bot-history-view';
import type { Burst, BurstMessage } from './single-thread-contract';
import { MessageTime } from "./message-time";
import { AttachmentImage } from './message';
import { TextPages } from './lazy-details';
import { botsClient as client } from './client';
import type { BotEvent } from '../../lib/bots-types';
import type { BurstState } from './single-thread-contract';
import { useRunAction } from './run-action';
import { pendingMessageCount, retainedBatches, savedBurstState, validBurstState, type SavedBurstState } from './burst-state';
import './single-thread.css';
/** Receipt-owned staging shares the conversation feed, never native history. */
export function useBurstConversation({ owner, botId, online, draft, enabled, quietSeconds }: { owner: string; botId: string; online: boolean; draft: string; enabled: boolean; quietSeconds: number }) {
  const cacheKey = `burst-summary:v1:${botId}`;
  const [value, setValue] = useState<SavedBurstState | null>(() => { const saved = client.owner === owner ? client.cache<SavedBurstState | null>(cacheKey, null) : null; return saved && validBurstState(saved, botId) ? saved : null; }), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (value && client.owner === owner) client.save(cacheKey, savedBurstState(value));
  }, [owner, cacheKey, value]);
  const discardAction = useRunAction(owner, botId, 'burst:discard');
  const discard = (messageIds: string[]) => discardAction.perform('bursts.discard', { messageIds }).then(() => setRefresh(value => value + 1));
  const action = useRunAction(owner, botId, 'burst:control'), sequence = useRef(0), typing = useRef({ id: crypto.randomUUID(), last: 0, value: draft, inputAt: 0, active: false });
  const [typingUntil, setTypingUntil] = useState(0);
  useEffect(() => {
    const listener = (event: BotEvent) => {
      if (!enabled || client.owner !== owner || event.botId !== botId || event.type !== 'burst' || event.seq <= sequence.current) return;
      sequence.current = event.seq;
      const next = event.data as BurstState;
      if (validBurstState(next, botId)) { setValue(next); setError(''); }
    };
    client.events.add(listener); return () => { client.events.delete(listener); };
  }, [owner, botId, enabled]);
  useEffect(() => {
    let live = true; const before = sequence.current;
    if (enabled && online) void client.rpc<BurstState>('bursts.read', botId, {}, undefined, { owner }).then(next => {
      if (live && client.owner === owner && before === sequence.current) {
        if (!validBurstState(next, botId)) throw Error('Pending delivery could not be verified. Refresh to try again.');
        setValue(next); setError('');
      }
    }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [owner, botId, online, refresh, enabled]);
  const batches = retainedBatches(value).filter(batch => batch.state !== 'sent');
  const hasPending = batches.some(batch => batch.state === 'pending');
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
  const paused = states.includes('paused'), blocked = uncertain || dispatching;
  const canStart = !blocked && (failed || paused || hasPending);
  const refreshDelivery = () => setRefresh(value => value + 1);
  return { value: enabled ? value : null, batches, messages, count, action, error, hasPending, uncertain, dispatching, failed, paused, blocked, canStart, refreshDelivery, typingUntil, discard, discardAction };
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
  const [openedAt] = useState(() => Date.now());
  const due = Date.parse(dueAt ?? ''), remaining = Math.max(0, (due - openedAt) / 1000);
  const progress = Number.isFinite(remaining) && quietSeconds > 0 ? Math.max(0, Math.min(1, 1 - remaining / quietSeconds)) : 0;
  const style = { '--burst-progress': progress, '--burst-remaining': `${Number.isFinite(remaining) ? remaining : 0}s` } as CSSProperties;
  return <span aria-hidden="true" className={`bots-burst-fill${animate && Number.isFinite(due) ? ' is-counting' : ''}`} style={style} />;
}
function BurstBubble({ message, batch, botId, attachments, quietSeconds, online, typingUntil, truncated, onOpenReply, sent: delivered, replySource, onReply, threadId }: {
  message: BurstMessage; batch: Burst | undefined; botId: string; attachments: BotAttachment[];
  quietSeconds: number; online: boolean; typingUntil: number; truncated: boolean; replySource?: HistoryEntry; threadId?: string; onReply?: (reply: BotReplyReference) => void; sent?: boolean; onOpenReply?: (reply: BotReplyReference) => Promise<boolean>;
}) {
  const sent = delivered || batch?.state === 'sent', pending = batch?.state === 'pending';
  const dueAt = pending && typingUntil > Date.parse(batch?.dueAt ?? '') ? new Date(typingUntil).toISOString() : batch?.dueAt ?? null;
  return <div className="bots-message bots-user" data-burst-message={message.id}>
    <div className={`bots-bubble${sent ? '' : ' bots-bubble-pending'}`} aria-label={sent ? undefined : 'Message waiting to send'}>
      {!sent && <BurstFill key={`${dueAt}:${online}`} dueAt={dueAt} quietSeconds={quietSeconds} animate={pending && online} />}
      <div className="bots-burst-content">{message.reply && <ReplyQuote key={message.reply.id} reply={message.reply} onOpen={onOpenReply}/>}<TextPages text={message.text} render={text => <p>{text}</p>} />
        {truncated && <small>Saved preview · reconnect for complete text</small>}
        {message.attachmentIds.map(id => { const file = attachments.find(file => file.id === id); return file?.mimeType.startsWith('image/') ? <AttachmentImage key={id} botId={botId} attachment={file} /> : <span key={id} className="bots-input-file"><Paperclip size={13} aria-hidden="true" />{file?.name ?? 'File attached'}</span>; })}
      </div>
    </div>
    {sent && replySource && threadId && onReply && <ReplyAction entry={replySource} botId={botId} threadId={threadId} partId={message.id} onReply={onReply}/>}
    <MessageTime seconds={Date.parse(message.createdAt) / 1000} basis="saved" user inline />
  </div>;
}
export function BurstBubbles({ messages, batch, ...props }: { messages: BurstMessage[]; batch?: Burst; botId: string; attachments: BotAttachment[]; quietSeconds: number; online: boolean; typingUntil: number; truncatedIds?: string[]; replySource?: HistoryEntry; threadId?: string; onReply?: (reply: BotReplyReference) => void; sent?: boolean; onOpenReply?: (reply: BotReplyReference) => Promise<boolean> }) {
  return <>{messages.filter(message => !message.dismissed && message.state !== 'discarded').map(message => <BurstBubble key={message.id} message={message} batch={batch} {...props} truncated={props.truncatedIds?.includes(message.id) || Boolean((message as BurstMessage & { textTruncated?: boolean }).textTruncated)} />)}</>;
}
export function BurstControls({ burst, online, submitting = false }: { burst: BurstConversation; online: boolean; submitting?: boolean }) {
  const { value, batches, messages, count, action, error, hasPending, uncertain, dispatching, failed, paused, canStart, refreshDelivery, discard, discardAction } = burst;
  if (!count && !batches.length && !submitting && !action.error && !discardAction.error && !error) return null;
  const visibleIds = messages.filter(message => !message.dismissed && message.state !== 'discarded').map(message => message.id);
  const canDiscard = client.snapshot?.capabilities?.burstDiscard === 1;
  const truncatedText = new Set(value?.preview?.truncatedTextIds ?? []);
  const previewOnly = !!value?.preview || !online, completeBatchMetadata = value?.batches !== undefined;
  return <div className="bots-burst-pending">
    {previewOnly && (!completeBatchMetadata || count > messages.length || truncatedText.size > 0) && <small className="bots-burst-preview">Some saved messages are previews. Reconnect for complete messages and delivery status.</small>}
    <div className="bots-burst-line">
      {(!online || paused) && <small>{!online ? 'Saved · waiting for connection' : 'Messages held'}</small>}
      <div>{!action.intent && <>{canStart && <button type="button" aria-label={failed ? 'Retry and start all retained messages' : 'Send waiting messages now'} title={failed ? 'Retry and start all retained messages' : 'Send now'} disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('bursts.start', {}).then(refreshDelivery).catch(() => {})}><ArrowUp size={16} />{failed && 'Retry'}</button>}{hasPending && <button type="button" aria-label="Hold all pending messages" title="Hold waiting messages" disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('bursts.stop', {}).then(refreshDelivery).catch(() => {})}><Pause size={16} /></button>}</>}{visibleIds.length > 0 && <button type="button" aria-label={uncertain || dispatching ? 'Hide retained message previews' : 'Discard waiting messages'} title={canDiscard ? uncertain || dispatching ? 'Clear previews; delivery may already be in progress' : 'Discard waiting messages' : 'Discard available after service update'} disabled={!online || !canDiscard || discardAction.busy || !discardAction.ready || !!discardAction.intent} onClick={() => void discard(visibleIds).catch(() => {})}><Trash2 size={16} /></button>}</div>
    </div>
    {discardAction.error && <div className="bots-burst-recovery" role="alert">{discardAction.error}{discardAction.intent && <button disabled={!online || discardAction.busy} onClick={() => void discardAction.retry().then(refreshDelivery).catch(() => {})}>Check discard</button>}</div>}
    {(error || action.error || failed) && <div className="bots-burst-recovery" role="alert">{action.error || error || 'Not delivered. Retry keeps the original messages and files.'}{action.intent ? <button disabled={!online || action.busy} onClick={() => void action.retry().then(refreshDelivery).catch(() => {})}>Check saved action</button> : <button disabled={!online} onClick={refreshDelivery}>Refresh delivery</button>}</div>}
  </div>;
}
