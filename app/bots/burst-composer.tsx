"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Paperclip, Pause } from 'lucide-react';
import { botsClient as client } from './client';
import type { BotEvent } from '../../lib/bots-types';
import type { BurstState } from './single-thread-contract';
import { useRunAction } from './run-action';
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
export function BurstComposer({ owner, botId, online, draft }: { owner: string; botId: string; online: boolean; draft: string }) {
  const cacheKey = `burst-summary:v1:${botId}`;
  const [value, setValue] = useState<BurstState | null>(() => client.owner === owner ? client.cache(cacheKey, null) : null), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (value && client.owner === owner) client.save(cacheKey, { burst: value.burst, messages: value.messages.slice(-24).map(message => ({ ...message, text: message.text.length > 2000 ? `${message.text.slice(0, 2000)}\n[Saved preview — connect for the complete pending message]` : message.text })) });
  }, [owner, cacheKey, value]);
  const action = useRunAction(owner, botId, 'burst:control'), sequence = useRef(0), typing = useRef({ id: crypto.randomUUID(), last: 0, value: draft });
  useEffect(() => {
    const listener = (event: BotEvent) => {
      if (client.owner !== owner || event.botId !== botId || event.type !== 'burst' || event.seq <= sequence.current) return;
      sequence.current = event.seq;
      const next = event.data as BurstState;
      if (next.messages?.every(message => message.botId === botId) && (!next.burst || next.burst.botId === botId)) { setValue(next); setError(''); }
    };
    client.events.add(listener); return () => { client.events.delete(listener); };
  }, [owner, botId]);
  useEffect(() => {
    let live = true; const before = sequence.current;
    if (online) void client.rpc<BurstState>('bursts.read', botId, {}, undefined, { owner }).then(next => {
      if (live && client.owner === owner && before === sequence.current) { setValue(next); setError(''); }
    }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [owner, botId, online, refresh]);
  useEffect(() => {
    const state = typing.current;
    if (state.value === draft) return;
    state.value = draft;
    if (!online || !draft || value?.burst?.state !== 'pending') return;
    if (Date.now() - state.last >= 4000) {
      state.last = Date.now();
      void client.rpc('bursts.typing', botId, { clientId: state.id, typing: true }, undefined, { owner }).catch(() => {});
    }
    const timer = setTimeout(() => { if (client.owner === owner && client.online) void client.rpc('bursts.typing', botId, { clientId: state.id, typing: false }, undefined, { owner }).catch(() => {}); }, 2000);
    return () => clearTimeout(timer);
  }, [draft, owner, botId, online, value?.burst?.state]);
  const burst = value?.burst, messages = value?.messages.filter(message => message.state !== 'sent') ?? [];
  if (!messages.length && !action.intent && !action.error && !error) return null;
  const paused = burst?.state === 'paused', uncertain = burst?.state === 'uncertain' || burst?.state === 'failed';
  return <div className="bots-burst-pending">
    {burst && burst.messageIds.length > messages.length && !online && <small>Showing {messages.length} saved previews of {burst.messageIds.length} pending messages. Reconnect for the complete batch.</small>}
    <div className="bots-burst-line"><details><summary>{paused ? 'Held for you' : uncertain ? 'Delivery needs attention' : burst?.state === 'dispatching' ? 'Sending together' : 'Ready when you are'}{messages.length > 0 && <span> · {messages.length} {messages.length === 1 ? 'message' : 'messages'}</span>}</summary><div className="bots-burst-messages">{messages.map(message => <p key={message.id}>{message.text}{message.attachmentIds.length > 0 && <small><Paperclip size={12} />{message.attachmentIds.length} {message.attachmentIds.length === 1 ? 'file' : 'files'}</small>}</p>)}</div></details>
      {burst?.state === "pending" && <QuietTime dueAt={burst.dueAt} online={online} />}
      {!action.intent && burst && ['pending','paused'].includes(burst.state) && <div><button type="button" disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('bursts.start', {}).then(() => setRefresh(value => value + 1)).catch(() => {})}><ArrowUp size={14} />Start now</button>{!paused && <button type="button" aria-label="Hold pending messages" disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('bursts.stop', {}).then(() => setRefresh(value => value + 1)).catch(() => {})}><Pause size={14} /></button>}</div>}
    </div>
    {(error || action.error || action.intent || burst?.error) && <div className="bots-burst-recovery" role="status">{action.error || burst?.error || error || 'Waiting for confirmation. Your messages are retained.'}{action.intent ? <button disabled={!online || action.busy} onClick={() => void action.retry().then(() => setRefresh(value => value + 1)).catch(() => {})}>Check saved action</button> : <button disabled={!online} onClick={() => setRefresh(value => value + 1)}>Refresh delivery</button>}</div>}
  </div>;
}
