"use client";
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronRight, MessageCircle, RefreshCw } from 'lucide-react';
import { botsClient as client } from './client';
import type { BotEvent } from '../../lib/bots-types';
import type { Bot, PeerExchange, PeerRequest } from './single-thread-contract';
import { BotAvatar } from './bot-avatar';
import { BotMessage } from './message';
import { ReturnedArtifact } from './returned-artifact';
import { useRunAction } from './run-action';
import './single-thread.css';
const label = (request: PeerRequest) => request.round >= request.roundLimit && request.state !== 'completed' && request.state !== 'cancelled' ? 'Needs your direction · six rounds reached' : ({ queued: 'Up next', working: 'Working together', waiting: 'Waiting for a reply', completed: 'Result ready', cancelled: 'Cancelled', failed: 'Needs attention', 'delivery-unconfirmed': 'Delivery needs confirmation' }[request.state]);
function Text({ text, botId }: { text: string; botId: string }) { return <BotMessage item={{ type: 'agentMessage', id: 'exchange-text', text, phase: null, delivery: null, memoryCitation: null, questions: null }} attachments={[]} botId={botId} download={() => {}} />; }
export function PeerConversations({ owner, botId, bots, online, historyView = false }: { owner: string; botId: string; bots: Bot[]; online: boolean; historyView?: boolean }) {
  const key = `peers-metadata:v1:${botId}`;
  const [page, setPage] = useState<{ requests: PeerRequest[]; nextCursor: string | null }>(() => client.cache(key, { requests: [], nextCursor: null }));
  const [cursor, setCursor] = useState<string | null>(null), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(''), [changed, setChanged] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const listener = (event: BotEvent) => { if (event.type === 'peer' && event.botId === botId && client.owner === owner) { generation.current++; setChanged(true); } };
    client.events.add(listener); return () => { client.events.delete(listener); };
  }, [owner, botId]);
  useEffect(() => {
    let live = true; const before = generation.current;
    if (online) void Promise.resolve().then(async () => {
      setBusy(true); const next = await client.rpc<{ requests: PeerRequest[]; nextCursor: string | null }>('peers.list', botId, { limit: 12, ...(cursor ? { cursor } : {}) }, undefined, { owner });
      if (!live || client.owner !== owner) return;
      if (next.requests.length > 12 || next.requests.some(item => item.senderBotId !== botId && item.recipientBotId !== botId)) throw Error('These discussions could not be verified. Refresh to try again.');
      setPage(next); setError(''); if (before === generation.current) setChanged(false);
      // Metadata only. Full exchange bodies are never put in the snapshot cache.
      if (!cursor) client.save(key, next);
    }).catch(reason => { if (live) setError(String(reason)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [owner, botId, cursor, online, attempt, key]);
  if (!page.requests.length && !error && !changed) return null;
  return <section className="bots-peer-conversations" aria-label="Bot discussions"><header><MessageCircle size={16} /><span>{historyView ? "Discussions" : "Working together"}</span>{changed && <button disabled={!online || busy} onClick={() => { setCursor(null); setAttempt(value => value + 1); }}>New updates <RefreshCw size={13} /></button>}</header>
    {page.requests.map((request, index) => <Fragment key={request.id}>{historyView && (index === 0 || page.requests[index - 1].createdAt.slice(0, 10) !== request.createdAt.slice(0, 10)) && <h4 className="bots-peer-date">{new Date(request.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</h4>}<PeerCard request={request} owner={owner} botId={botId} bots={bots} online={online} /></Fragment>)}
    {error && <p role="alert">{error}<button disabled={!online || busy} onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    {(cursor || page.nextCursor) && <nav>{cursor && <button disabled={!online || busy} onClick={() => setCursor(null)}>Recent discussions</button>}{page.nextCursor && <button disabled={!online || busy} onClick={() => setCursor(page.nextCursor)}>Earlier discussions</button>}</nav>}
  </section>;
}
function PeerCard({ request, owner, botId, bots, online }: { request: PeerRequest; owner: string; botId: string; bots: Bot[]; online: boolean }) {
  const [open, setOpen] = useState(false), [eventCurrent, setCurrent] = useState<PeerRequest | null>(null), [unread, setUnread] = useState(false);
  const sequence = useRef(0);
  const current = eventCurrent && eventCurrent.updatedAt >= request.updatedAt ? eventCurrent : request;
  useEffect(() => {
    const event = (event: BotEvent) => { const next = (event.data as { request?: PeerRequest }).request; if (client.owner === owner && event.type === 'peer' && event.botId === botId && next?.id === request.id && event.seq > sequence.current) { sequence.current = event.seq; setCurrent(next); setUnread(true); } };
    client.events.add(event); return () => { client.events.delete(event); };
  }, [owner, botId, request.id]);
  const peerId = current.senderBotId === botId ? current.recipientBotId : current.senderBotId, peer = bots.find(bot => bot.id === peerId), name = peer?.name ?? 'Bot';
  return <article className="bots-peer-card"><button className="bots-peer-summary" aria-expanded={open} onClick={() => { setOpen(value => !value); setUnread(false); }}>
    {peer ? <BotAvatar bot={peer} small decorative working={current.state === 'working'} /> : <MessageCircle size={20} />}
    <span><strong>{name}<small>{label(current)}</small></strong><span>{current.summary}</span></span><ChevronRight size={17} className={open ? 'is-open' : ''} /></button>
    {current.result && !open && <div className="bots-peer-result"><Text text={current.result} botId={botId} /></div>}
    {open && <PeerDetail owner={owner} botId={botId} request={current} bots={bots} online={online} changed={unread} />}
  </article>;
}
function PeerDetail({ owner, botId, request, bots, online, changed }: { owner: string; botId: string; request: PeerRequest; bots: Bot[]; online: boolean; changed: boolean }) {
  const [data, setData] = useState<{ request: PeerRequest; exchanges: PeerExchange[] } | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const generation = useRef(0), action = useRunAction(owner, botId, `peer:cancel:${request.id}`);
  useEffect(() => { const event = (event: BotEvent) => { if (event.type === 'peer' && event.botId === botId && (event.data as { request?: PeerRequest }).request?.id === request.id) generation.current++; }; client.events.add(event); return () => { client.events.delete(event); }; }, [botId, request.id]);
  useEffect(() => {
    let live = true; const before = generation.current;
    if (online) void Promise.resolve().then(async () => {
      setBusy(true); const next = await client.rpc<{ request: PeerRequest; exchanges: PeerExchange[] }>('peers.read', botId, { id: request.id }, undefined, { owner });
      if (!live || client.owner !== owner) return;
      if (before !== generation.current) throw Error('A new reply arrived while this discussion was opening. Refresh to see it.');
      if (next.request.id !== request.id || next.exchanges.length > 6) throw Error('The discussion response could not be verified.');
      setData(next); setError('');
    }).catch(reason => { if (live) setError(String(reason)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [owner, botId, request.id, online, attempt]);
  return <div className="bots-peer-detail"><div className="bots-peer-detail-heading"><span>{request.round} of 6 rounds</span><button disabled={!online || busy} onClick={() => setAttempt(value => value + 1)}>{busy ? 'Opening…' : changed ? 'Read new replies' : 'Refresh'}</button></div>
    {!online && !data && <p>Connect to read this exchange. Its result stays in your conversation.</p>}
    {data?.exchanges.map(exchange => <section key={exchange.id} className="bots-peer-exchange"><header><strong>{bots.find(bot => bot.id === exchange.botId)?.name ?? 'Bot'}</strong><time dateTime={exchange.createdAt}>{new Date(exchange.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></header><Text text={exchange.text} botId={botId} />{exchange.attachmentIds.map(id => <ReturnedArtifact key={id} botId={botId} id={id} />)}</section>)}
    {request.result && <section className="bots-peer-outcome"><h4>Result</h4><Text text={request.result} botId={botId} /></section>}
    {request.round >= 6 && request.state !== 'completed' && <p>Six rounds are complete. Continue in your conversation with the direction you want to take.</p>}
    {error && <p role="alert">{error}</p>}
    {!['completed','cancelled','failed'].includes(request.state) && !action.intent && <button className="bots-peer-cancel" disabled={!online || action.busy || !action.ready || request.cancelRequested} onClick={() => void action.perform('peers.cancel', { id: request.id }).catch(() => {})}>{request.cancelRequested ? 'Cancellation requested' : 'Cancel this discussion'}</button>}
    {(action.intent || action.error) && <p role="status">{action.error || 'Checking cancellation…'}<button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check saved action</button></p>}
  </div>;
}
