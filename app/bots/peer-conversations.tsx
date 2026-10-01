"use client";
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronRight, MessageCircle, RefreshCw, AlertCircle } from 'lucide-react';
import { botsClient as client } from './client';
import type { BotEvent } from '../../lib/bots-types';
import type { Bot, PeerExchange, PeerRequest } from './single-thread-contract';
import { BotAvatar } from './bot-avatar';
import { BotMessage } from './message';
import { ReturnedArtifact } from './returned-artifact';
import { useRunAction } from './run-action';
import './single-thread.css';
const label = (request: PeerRequest, bots: Bot[]) => ({ queued: 'Up next', working: request.executions?.some(e => bots.some(b => b.id === e.botId && b.activeTurnId === e.turnId)) ? 'Working together' : 'Waiting for a reply', waiting: 'Waiting for a reply', completed: 'Result ready', cancelled: 'Cancelled', failed: 'Needs attention', 'delivery-unconfirmed': 'Delivery needs confirmation' }[request.state]);
function Text({ text, botId }: { text: string; botId: string }) { return <BotMessage item={{ type: 'agentMessage', id: 'exchange-text', text, phase: null, delivery: null, memoryCitation: null, questions: null }} attachments={[]} botId={botId} download={() => {}} />; }
export function useDiscussionStatus(owner: string, botId: string | null, online: boolean, supported: boolean) {
  const scope = JSON.stringify([owner, botId]);
  const [value, setValue] = useState<{ scope: string; requests: PeerRequest[]; error: boolean }>({ scope: "", requests: [], error: false });
  useEffect(() => {
    if (!botId || !supported || client.owner !== owner) return;
    let live = true;
    const records = new Map<string, PeerRequest>();
    const concurrent = new Map<string, PeerRequest>();
    const key = `peers-status:v1:${botId}`;
    const relevant = (r: PeerRequest) => r.senderBotId === botId || r.recipientBotId === botId;
    const retain = (r: PeerRequest) => !["completed", "cancelled"].includes(r.state) || Boolean(r.executions?.length);
    const publish = (error = false) => {
      if (!live || client.owner !== owner) return;
      const requests = [...records.values()].filter(retain).map(r => ({ ...r, result: null }));
      setValue({ scope, requests, error }); client.save(key, requests);
    };
    for (const r of client.cache<PeerRequest[]>(key, [])) if (relevant(r)) records.set(r.id, r);
    const event = (event: BotEvent) => {
      if (event.type !== "peer" || event.botId !== botId || client.owner !== owner) return;
      const r = (event.data as { request?: PeerRequest }).request;
      if (r && relevant(r) && (!records.has(r.id) || records.get(r.id)!.updatedAt <= r.updatedAt)) { concurrent.set(r.id, { ...r, result: null }); records.set(r.id, { ...r, result: null }); publish(); }
    };
    client.events.add(event);
    void Promise.resolve().then(async () => {
      publish(); if (!online) return;
      const found = new Map<string, PeerRequest>(), cursors = new Set<string>(); let cursor: string | null = null;
      // Read request metadata only; completed exchange bodies remain lazy in Discussions.
      do {
        const next: { requests: PeerRequest[]; nextCursor: string | null } = await client.rpc("peers.list", botId, { limit: 100, ...(cursor ? { cursor } : {}) }, undefined, { owner });
        if (!live || client.owner !== owner) return;
        if (!Array.isArray(next.requests) || next.requests.length > 100 || next.requests.some(r => !relevant(r)) || next.nextCursor && cursors.has(next.nextCursor)) throw Error("Invalid discussion metadata");
        for (const r of next.requests) found.set(r.id, { ...r, result: null });
        cursor = next.nextCursor; if (cursor) cursors.add(cursor);
      } while (cursor);
      // Only live events racing the read survive absence from a full read.
      // Old cache rows cannot indefinitely resurrect obsolete requests.
      for (const [id, r] of concurrent) if (!found.has(id) || r.updatedAt >= found.get(id)!.updatedAt) found.set(id, r);
      records.clear(); for (const [id, r] of found) if (retain(r)) records.set(id, r); publish();
    }).catch(() => publish(true));
    return () => { live = false; client.events.delete(event); };
  }, [scope, owner, botId, online, supported]);
  const requests = value.scope === scope ? value.requests : [];
  return { requests, attention: requests.filter(r => ["failed", "delivery-unconfirmed"].includes(r.state)), error: value.scope === scope && value.error };
}
export function discussionNeedsAttention(request: PeerRequest, botId: string, bots: Bot[], online: boolean) {
  if (["failed", "delivery-unconfirmed"].includes(request.state)) return true;
  return online && Boolean(request.executions?.some(e => e.botId !== botId && client.snapshot?.pending.some(p =>
    p.botId === e.botId && "turnId" in p.request.params && "threadId" in p.request.params &&
    p.request.params.turnId === e.turnId && p.request.params.threadId === bots.find(b => b.id === e.botId)?.threadId)));
}
export function DiscussionStatus({ status, bots, botId, online, onOpen, attentionOnly = false }: {
  status: ReturnType<typeof useDiscussionStatus>; bots: Bot[]; botId: string; online: boolean; onOpen: (id?: string | null) => void; attentionOnly?: boolean;
}) {
  const peerFor = (r: PeerRequest) => bots.find(b => b.id === (r.senderBotId === botId ? r.recipientBotId : r.senderBotId));
  const executions = (r: PeerRequest) => online ? (r.executions ?? []).filter(e => bots.some(b => b.id === e.botId && b.activeTurnId === e.turnId)) : [];
  const blocked = status.requests.find(r => discussionNeedsAttention(r, botId, bots, online));
  if (attentionOnly) return blocked ? <button type="button" className="bots-discussion-notice" onClick={() => onOpen(blocked.id)}><AlertCircle size={15} aria-hidden="true" /><span>{blocked.state === "delivery-unconfirmed" ? "Discussion needs confirmation" : blocked.state === "failed" ? "Discussion needs attention" : `${peerFor(blocked)?.name.split(":")[0] ?? "A bot"} needs input`}</span><ChevronRight size={15} aria-hidden="true" /></button> : status.error ? <button type="button" className="bots-discussion-notice" onClick={() => onOpen()}><AlertCircle size={15} aria-hidden="true" /><span>Check discussions</span><ChevronRight size={15} aria-hidden="true" /></button> : null;
  const active = online && status.requests.find(r => executions(r).length && !r.cancelRequested);
  if (!active || blocked) return null;
  const peer = peerFor(active);
  return <button type="button" className="bots-discussion-presence" onClick={() => onOpen(active.id)} title="Open discussion">{peer && <BotAvatar bot={peer} small decorative working />}<span>Working with {peer?.name.split(":")[0] ?? "a bot"}{status.requests.filter(r => executions(r).length).length > 1 ? " + others" : ""}</span></button>;
}
export function PeerConversations({ owner, botId, bots, online, historyView = false, targetId = null }: { owner: string; botId: string; bots: Bot[]; online: boolean; historyView?: boolean; targetId?: string | null }) {
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
  const [target, setTarget] = useState<PeerRequest | null>(null);
  useEffect(() => {
    let live = true;
    if (targetId && online) void client.rpc<{ request: PeerRequest; exchanges: PeerExchange[] }>("peers.read", botId, { id: targetId }, undefined, { owner }).then(next => {
      if (live && client.owner === owner && next.request.id === targetId && [next.request.senderBotId, next.request.recipientBotId].includes(botId)) setTarget(next.request);
    }).catch(reason => { if (live) setError(String(reason)); });
    return () => { live = false; };
  }, [targetId, online, botId, owner]);
  const requests = targetId && target?.id === targetId && !page.requests.some(r => r.id === targetId) ? [target, ...page.requests] : page.requests;

  return <section className="bots-peer-conversations" aria-label="Bot discussions"><header><MessageCircle size={16} /><span>{historyView ? "Discussions" : "Working together"}</span>{changed && <button disabled={!online || busy} onClick={() => { setCursor(null); setAttempt(value => value + 1); }}>New updates <RefreshCw size={13} /></button>}</header>
    {requests.map((request, index) => <Fragment key={request.id}>{historyView && (index === 0 || requests[index - 1].createdAt.slice(0, 10) !== request.createdAt.slice(0, 10)) && <h4 className="bots-peer-date">{new Date(request.createdAt).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}</h4>}<PeerCard request={request} owner={owner} botId={botId} bots={bots} online={online} historyView={historyView} targetId={targetId} /></Fragment>)}
    {!requests.length && !error && <p className="bots-details-lead">{busy ? "Loading discussions…" : "No discussions yet."}</p>}
    {error && <p role="alert">{error}<button disabled={!online || busy} onClick={() => setAttempt(value => value + 1)}>Retry</button></p>}
    {(cursor || page.nextCursor) && <nav>{cursor && <button disabled={!online || busy} onClick={() => setCursor(null)}>Recent discussions</button>}{page.nextCursor && <button disabled={!online || busy} onClick={() => setCursor(page.nextCursor)}>Earlier discussions</button>}</nav>}
  </section>;
}
function PeerCard({ request, owner, botId, bots, online, historyView, targetId }: { request: PeerRequest; owner: string; botId: string; bots: Bot[]; online: boolean; historyView: boolean; targetId: string | null }) {
  const [open, setOpen] = useState(false), [eventCurrent, setCurrent] = useState<PeerRequest | null>(null), [unread, setUnread] = useState(false);
  useEffect(() => { let live = true; if (targetId === request.id) queueMicrotask(() => { if (live) setOpen(true); }); return () => { live = false; }; }, [targetId, request.id]);
  const sequence = useRef(0);
  const current = eventCurrent && eventCurrent.updatedAt >= request.updatedAt ? eventCurrent : request;
  useEffect(() => {
    const event = (event: BotEvent) => { const next = (event.data as { request?: PeerRequest }).request; if (client.owner === owner && event.type === 'peer' && event.botId === botId && next?.id === request.id && event.seq > sequence.current) { sequence.current = event.seq; setCurrent(next); setUnread(true); } };
    client.events.add(event); return () => { client.events.delete(event); };
  }, [owner, botId, request.id]);
  const peerId = current.senderBotId === botId ? current.recipientBotId : current.senderBotId, peer = bots.find(bot => bot.id === peerId), name = peer?.name ?? 'Bot';
  return <article className="bots-peer-card"><button data-history-key={historyView ? `peer:${request.id}` : undefined} className="bots-peer-summary" aria-expanded={open} onClick={() => { setOpen(value => !value); setUnread(false); }}>
    {peer ? <BotAvatar bot={peer} small decorative working={online && Boolean(current.executions?.some(e => bots.some(b => b.id === e.botId && b.activeTurnId === e.turnId)))} /> : <MessageCircle size={20} />}
    <span><strong>{name}<small>{label(current, bots)}</small></strong><span>{current.summary}</span></span><ChevronRight size={17} className={open ? 'is-open' : ''} /></button>
    {open && <PeerDetail owner={owner} botId={botId} request={current} bots={bots} online={online} changed={unread} onRead={() => setUnread(false)} historyView={historyView} />}
  </article>;
}
function PeerDetail({ owner, botId, request, bots, online, changed, onRead, historyView }: { owner: string; botId: string; request: PeerRequest; bots: Bot[]; online: boolean; changed: boolean; onRead: () => void; historyView: boolean }) {
  const [data, setData] = useState<{ request: PeerRequest; exchanges: PeerExchange[] } | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const onReadRef = useRef(onRead);
  useEffect(() => { onReadRef.current = onRead; }, [onRead]);
  const generation = useRef(0), action = useRunAction(owner, botId, `peer:cancel:${request.id}`);
  useEffect(() => { const event = (event: BotEvent) => { if (client.owner === owner && event.type === 'peer' && event.botId === botId && (event.data as { request?: PeerRequest }).request?.id === request.id) generation.current++; }; client.events.add(event); return () => { client.events.delete(event); }; }, [owner, botId, request.id]);
  useEffect(() => {
    let live = true; const before = generation.current;
    if (online) void Promise.resolve().then(async () => {
      setBusy(true); const next = await client.rpc<{ request: PeerRequest; exchanges: PeerExchange[] }>('peers.read', botId, { id: request.id }, undefined, { owner });
      if (!live || client.owner !== owner) return;
      if (before !== generation.current) throw Error('A new reply arrived while this discussion was opening. Refresh to see it.');
      if (next.request.id !== request.id || (next.request.senderBotId !== botId && next.request.recipientBotId !== botId) || next.exchanges.length > 13 || next.exchanges.some(exchange => exchange.requestId !== request.id)) throw Error('The discussion response could not be verified.');
      // The backend returns acceptance order. A reserved reply may follow a
      // higher-numbered handoff, so never sort these records by round.
      setData(next); setError(''); onReadRef.current();
    }).catch(reason => { if (live) setError(String(reason)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [owner, botId, request.id, online, attempt]);
  return <div className="bots-peer-detail"><div className="bots-peer-detail-heading"><span>{request.round} of {request.roundLimit} discussion rounds used</span><button disabled={!online || busy} onClick={() => setAttempt(value => value + 1)}>{!online ? 'Offline' : busy ? 'Opening…' : changed ? 'Read new replies' : 'Refresh'}</button></div>
    {!online && <p>{data ? 'Saved in this view. Reconnect for new replies.' : 'Connect to read this exchange. Its result stays in your conversation.'}</p>}
    {data?.exchanges.map(exchange => <section key={exchange.id} data-history-key={historyView ? `peer-exchange:${exchange.id}` : undefined} className="bots-peer-exchange"><header><strong>{bots.find(bot => bot.id === exchange.botId)?.name ?? 'Bot'}{exchange.kind === 'cancel' ? ' · Cancellation' : ''}</strong><time dateTime={exchange.createdAt}>{new Date(exchange.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></header><Text text={exchange.text} botId={botId} />{exchange.attachmentIds.map(id => <ReturnedArtifact key={id} botId={botId} id={id} />)}</section>)}
    {request.result && <section className="bots-peer-outcome"><h4>Result</h4><Text text={request.result} botId={botId} /></section>}
    {error && <p role="alert">{error}</p>}
    {!['completed','cancelled','failed'].includes(request.state) && !action.intent && <button className="bots-peer-cancel" disabled={!online || action.busy || !action.ready || request.cancelRequested} onClick={() => void action.perform('peers.cancel', { id: request.id }).catch(() => {})}>{request.cancelRequested ? 'Cancellation requested' : 'Cancel this discussion'}</button>}
    {(action.intent || action.error) && <p role="status">{action.error || 'Checking cancellation…'}<button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check saved action</button></p>}
  </div>;
}
