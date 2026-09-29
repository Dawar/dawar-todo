"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Pause } from 'lucide-react';
import { botsClient as client } from './client';
import type { BotEvent } from '../../lib/bots-types';
import type { BurstState } from './single-thread-contract';
import { useRunAction } from './run-action';
import { pendingMessageCount, retainedBatches, savedBurstState, validBurstState, type SavedBurstState } from './burst-state';
import './single-thread.css';
function QuietTime({ dueAt, online }: { dueAt: string | null; online: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!online || !dueAt) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => { if (!document.hidden) setNow(Date.now()); };
    const visibility = () => { if (timer) clearInterval(timer); timer = undefined; if (!document.hidden) { update(); timer = setInterval(update, 1000); } };
    visibility(); document.addEventListener('visibilitychange', visibility);
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [dueAt, online]);
  const remaining = Math.max(0, Math.ceil((Date.parse(dueAt ?? '') - now) / 1000));
  return <span className="bots-burst-time" aria-label={online && remaining > 0 ? `Ready in about ${remaining} seconds; typing can extend this` : 'Awaiting delivery'}>{online && Number.isFinite(remaining) && remaining > 0 ? `${remaining}s` : '…'}</span>;
}
/** No optimistic native bubbles. Pending messages are receipt-owned here until
 * their one canonical batch appears in native history with batch.operationId. */
export function BurstComposer({ owner, botId, online, draft, submitting = false }: { owner: string; botId: string; online: boolean; draft: string; submitting?: boolean }) {
  const cacheKey = `burst-summary:v1:${botId}`;
  const [value, setValue] = useState<SavedBurstState | null>(() => { const saved = client.owner === owner ? client.cache<SavedBurstState | null>(cacheKey, null) : null; return saved && validBurstState(saved, botId) ? saved : null; }), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (value && client.owner === owner) client.save(cacheKey, savedBurstState(value));
  }, [owner, cacheKey, value]);
  const action = useRunAction(owner, botId, 'burst:control'), sequence = useRef(0), typing = useRef({ id: crypto.randomUUID(), last: 0, value: draft });
  useEffect(() => {
    const listener = (event: BotEvent) => {
      if (client.owner !== owner || event.botId !== botId || event.type !== 'burst' || event.seq <= sequence.current) return;
      sequence.current = event.seq;
      const next = event.data as BurstState;
      if (validBurstState(next, botId)) { setValue(next); setError(''); }
    };
    client.events.add(listener); return () => { client.events.delete(listener); };
  }, [owner, botId]);
  useEffect(() => {
    let live = true; const before = sequence.current;
    if (online) void client.rpc<BurstState>('bursts.read', botId, {}, undefined, { owner }).then(next => {
      if (live && client.owner === owner && before === sequence.current) {
        if (!validBurstState(next, botId)) throw Error('Pending delivery could not be verified. Refresh to try again.');
        setValue(next); setError('');
      }
    }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [owner, botId, online, refresh]);
  const batches = retainedBatches(value).filter(batch => batch.state !== 'sent');
  const hasPending = batches.some(batch => batch.state === 'pending');
  useEffect(() => {
    const state = typing.current;
    if (state.value === draft) return;
    state.value = draft;
    if (!online || !draft || !hasPending) return;
    if (Date.now() - state.last >= 4000) {
      state.last = Date.now();
      void client.rpc('bursts.typing', botId, { clientId: state.id, typing: true }, undefined, { owner }).catch(() => {});
    }
    const timer = setTimeout(() => { if (client.owner === owner && client.online) void client.rpc('bursts.typing', botId, { clientId: state.id, typing: false }, undefined, { owner }).catch(() => {}); }, 2000);
    return () => clearTimeout(timer);
  }, [draft, owner, botId, online, hasPending]);
  const messages = value?.messages.filter(message => message.state !== 'sent') ?? [], count = pendingMessageCount(value);
  if (!count && !batches.length && !submitting && !action.intent && !action.error && !error) return null;
  // Start is bot-wide. A later uncertain split blocks retry of an earlier
  // definite failure too; neither text nor a missing native echo proves failure.
  const states = [...batches.map(batch => batch.state), ...messages.map(message => message.state)];
  const uncertain = states.includes('uncertain'), dispatching = states.includes('dispatching'), failed = states.includes('failed');
  const paused = states.includes('paused'), blocked = uncertain || dispatching;
  const canStart = !blocked && (failed || paused || hasPending);
  const first = batches[0];
  const truncatedText = new Set(value?.preview?.truncatedTextIds ?? []);
  const previewOnly = !!value?.preview || !online, completeBatchMetadata = value?.batches !== undefined;
  const batchLabel = { pending: 'Waiting to send', paused: 'Held for you', dispatching: 'Sending · awaiting confirmation', uncertain: 'Delivery needs confirmation', failed: 'Not delivered · retry available', sent: 'Sent' };
  const refreshDelivery = () => setRefresh(value => value + 1);
  return <div className="bots-burst-pending">
    {previewOnly && (!completeBatchMetadata || count > messages.length || truncatedText.size > 0) && <small className="bots-burst-preview">Showing {messages.length} saved {messages.length === 1 ? 'preview' : 'previews'} of {!completeBatchMetadata ? 'at least ' : ''}{count} retained {count === 1 ? 'message' : 'messages'}{truncatedText.size > 0 ? '; some text is shortened' : ''}. Reconnect for complete messages and current delivery status{!completeBatchMetadata ? '; other pending messages may not be saved here' : ''}.</small>}
    <div className="bots-burst-line"><details><summary>{uncertain ? 'Delivery needs confirmation' : failed ? 'Delivery needs attention' : submitting ? 'Saving your message…' : dispatching ? 'Sending together' : paused ? 'Held for you' : 'Ready when you are'}{count > 0 && <span> · {!completeBatchMetadata ? 'at least ' : ''}{count} {count === 1 ? 'message' : 'messages'}{!online ? ' · Offline' : ''}</span>}</summary>
      <div className="bots-burst-messages">{batches.map((batch, index) => <div className="bots-burst-batch" key={batch.id}><strong>{batches.length > 1 ? `Group ${index + 1} · ` : ''}{batchLabel[batch.state]} · {batch.messageIds.length} {batch.messageIds.length === 1 ? 'message' : 'messages'}</strong>{batch.error && <span>{batch.error}</span>}</div>)}
        {messages.map(message => <p key={message.id}>{message.text}{truncatedText.has(message.id) && <small>Saved preview · text continues when connected</small>}{message.attachmentIds.length > 0 && <small><Paperclip size={12} />{message.attachmentIds.length} {message.attachmentIds.length === 1 ? 'file' : 'files'}</small>}</p>)}
      </div></details>
      {first?.state === 'pending' && !blocked && !failed && <QuietTime dueAt={first.dueAt} online={online} />}
      {!action.intent && <div>{canStart && <button type="button" title="Start all retained messages in order, including retrying any definite delivery failures" disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('bursts.start', {}).then(refreshDelivery).catch(() => {})}><ArrowUp size={14} />{failed ? 'Retry & start all' : 'Start all now'}</button>}{hasPending && <button type="button" aria-label="Hold all pending messages" disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('bursts.stop', {}).then(refreshDelivery).catch(() => {})}><Pause size={14} /></button>}</div>}
    </div>
    {(error || action.error || action.intent || failed || uncertain) && <div className="bots-burst-recovery" role="status">{action.error || error || (action.intent ? 'The saved control action needs confirmation. Your messages are retained.' : uncertain ? 'Waiting for the original delivery to be confirmed. Start is unavailable; no message will be repeated.' : blocked ? 'Retry waits until every in-flight delivery is confirmed.' : 'Not delivered. Retry & start all keeps the original messages and files, then starts retained messages in order.')}{action.intent ? <button disabled={!online || action.busy} onClick={() => void action.retry().then(refreshDelivery).catch(() => {})}>Check saved action</button> : <button disabled={!online} onClick={refreshDelivery}>Refresh delivery</button>}</div>}
  </div>;
}
