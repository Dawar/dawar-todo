"use client";
import { Fragment, useEffect, useRef, useState } from 'react';
import { ChevronRight, MessageCircle, RefreshCw, AlertCircle } from 'lucide-react';
import { botsClient as client } from './client';
import type { BotEvent, BotPeerBodyPage, BotPeerStatus } from '../../lib/bots-types';
import type { Bot, PeerExchange, PeerRequest } from './single-thread-contract';
import { BotAvatar } from './bot-avatar';
import { BotMessage } from './message';
import { ReturnedArtifact } from './returned-artifact';
import { useRunAction } from './run-action';
import { PeerRootControls } from './peer-timeline';
import { readPeerStatus } from './peer-timeline-store';
import './single-thread.css';
const currentExecution = (request: PeerRequest, bots: Bot[], online: boolean) => online && Boolean(request.executions?.some(e => bots.some(b => b.id === e.botId && ["running", "waiting"].includes(b.status) && b.activeTurnId === e.turnId)));
const label = (request: PeerRequest, bots: Bot[], online: boolean) => ({ queued: request.root?.state === 'paused' ? 'Discussion paused' : request.root?.state === 'stopped' ? 'Discussion stopped' : 'Up next', working: currentExecution(request, bots, online) ? 'Working together' : 'Waiting for a reply', waiting: 'Waiting for a reply', completed: 'Result ready', cancelled: 'Cancelled', failed: 'Needs attention', 'delivery-unconfirmed': 'Delivery needs confirmation' }[request.state]);
function Text({ text, botId }: { text: string; botId: string }) { return <BotMessage item={{ type: 'agentMessage', id: 'exchange-text', text, phase: null, delivery: null, memoryCitation: null, questions: null }} attachments={[]} botId={botId} download={() => {}} />; }
export function useDiscussionStatus(owner: string, botId: string | null, online: boolean, supported: boolean) {
  const scope = JSON.stringify([owner, botId]);
  const [value, setValue] = useState<{ scope: string; requests: PeerRequest[]; error: boolean; more: boolean; totals?: BotPeerStatus["totals"] }>({ scope: "", requests: [], error: false, more: false });
  const paged = client.snapshot?.capabilities?.peerBodyPaging === 1;
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!botId || !supported || client.owner !== owner) return;
    let live = true;
    const records = new Map<string, PeerRequest>();
    const concurrent = new Map<string, PeerRequest>();
    const key = `peers-status:v1:${botId}`;
    const relevant = (r: PeerRequest) => r.senderBotId === botId || r.recipientBotId === botId;
    const retain = (r: PeerRequest) => !["completed", "cancelled"].includes(r.state) || Boolean(r.executions?.length);
    let more = false, totals: BotPeerStatus["totals"] | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (error = false) => {
      if (!live || client.owner !== owner) return;
      const requests = [...records.values()].filter(retain).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0,12).map(r => ({ ...r, result: null }));
      setValue({ scope, requests, error, more, totals }); client.save(key, requests.map(r => ({ ...r, executions: [] })));
    };
    for (const r of client.cache<PeerRequest[]>(key, [])) if (relevant(r)) records.set(r.id, { ...r, executions: [] });
    const event = (event: BotEvent) => {
      if (paged && client.owner === owner && event.type === "peer-root" && [...records.values()].some(r => r.rootId === (event.data as { root?: { id?: string } }).root?.id)) { timer ??= setTimeout(() => { if (live) setAttempt(v => v+1); },100); return; }
      if (event.type !== "peer" || event.botId !== botId || client.owner !== owner) return;
      const r = (event.data as { request?: PeerRequest }).request;
      if (r && relevant(r) && (!records.has(r.id) || records.get(r.id)!.updatedAt <= r.updatedAt)) { concurrent.set(r.id, { ...r, result: null }); records.set(r.id, { ...r, result: null }); publish(); }
    };
    client.events.add(event);
    void Promise.resolve().then(async () => {
      publish(); if (!online) return;
      const found = new Map<string, PeerRequest>();
      // One representative page. Its absence never settles/deletes other
      // requests; all original records stay navigable in Discussions.
      const next: { requests: PeerRequest[]; nextCursor: string | null; totals?: BotPeerStatus["totals"] } = paged ? await readPeerStatus(client, owner, botId) : await client.rpc<{ requests: PeerRequest[]; nextCursor: string | null }>("peers.list", botId, { limit: 12 }, undefined, { owner });
      if (!live || client.owner !== owner) return;
      if (!Array.isArray(next.requests) || next.requests.length > 12 || next.requests.some(r => !relevant(r))) throw Error("Invalid discussion metadata");
      for (const r of next.requests) found.set(r.id, { ...r, result: null });
      more = Boolean(next.nextCursor); if ("totals" in next) totals = next.totals;
      for (const [id, r] of concurrent) if (!found.has(id) || r.updatedAt >= found.get(id)!.updatedAt) found.set(id, r);
      records.clear(); for (const [id, r] of found) if (retain(r)) records.set(id, r); publish();
    }).catch(() => publish(true));
    return () => { live = false; client.events.delete(event); if (timer) clearTimeout(timer); };
  }, [scope, owner, botId, online, supported, paged, attempt]);
  const requests = value.scope === scope ? value.requests : [];
  return { requests, attention: requests.filter(r => ["failed", "delivery-unconfirmed"].includes(r.state)), error: value.scope === scope && value.error, more: value.scope === scope && value.more, totals: value.scope === scope ? value.totals : undefined };
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
  const executions = (r: PeerRequest) => online ? (r.executions ?? []).filter(e => bots.some(b => b.id === e.botId && ["running", "waiting"].includes(b.status) && b.activeTurnId === e.turnId)) : [];
  const blocked = status.requests.find(r => discussionNeedsAttention(r, botId, bots, online));
  if (attentionOnly) return blocked ? <button type="button" className="bots-discussion-notice" onClick={() => onOpen(blocked.id)}><AlertCircle size={15} aria-hidden="true" /><span>{blocked.state === "delivery-unconfirmed" ? "Discussion needs confirmation" : blocked.state === "failed" ? "Discussion needs attention" : `${peerFor(blocked)?.name.split(":")[0] ?? "A bot"} needs input`}</span><ChevronRight size={15} aria-hidden="true" /></button> : status.error ? <button type="button" className="bots-discussion-notice" onClick={() => onOpen()}><AlertCircle size={15} aria-hidden="true" /><span>Check discussions</span><ChevronRight size={15} aria-hidden="true" /></button> : null;
  const active = online && status.requests.find(r => executions(r).length && !r.cancelRequested);
  if (!active || blocked) return status.more ? <button type="button" className="bots-discussion-presence" onClick={() => onOpen()}><MessageCircle size={15}/><span>More discussions{status.totals?.pausedRoots ? ` · ${status.totals.pausedRoots} paused` : ""}</span></button> : null;
  const peer = peerFor(active);
  return <button type="button" className="bots-discussion-presence" onClick={() => onOpen(active.id)} title="Open discussion">{peer && <BotAvatar bot={peer} small decorative working />}<span>Working with {peer?.name.split(":")[0] ?? "a bot"}{status.requests.filter(r => executions(r).length).length > 1 ? " + others" : ""}</span></button>;
}
export function PeerConversations({ owner, botId, bots, online, historyView = false, targetId = null }: { owner: string; botId: string; bots: Bot[]; online: boolean; historyView?: boolean; targetId?: string | null }) {
  const key = `peers-metadata:v1:${botId}`;
  const [page, setPage] = useState<{ requests: PeerRequest[]; nextCursor: string | null }>(() => { const saved = client.cache<{ requests: PeerRequest[]; nextCursor: string | null }>(key, { requests: [], nextCursor: null }); return { ...saved, requests: saved.requests.map(r => ({ ...r, executions: [] })) }; });
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
      if (!cursor) client.save(key, { ...next, requests: next.requests.map(r => ({ ...r, executions: [] })) });
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
    {peer ? <BotAvatar bot={peer} small decorative working={currentExecution(current, bots, online)} /> : <MessageCircle size={20} />}
    <span><strong>{name}<small>{label(current, bots, online)}</small></strong><span>{current.summary}</span></span><ChevronRight size={17} className={open ? 'is-open' : ''} /></button>
    {open && <PeerDetail owner={owner} botId={botId} request={current} bots={bots} online={online} changed={unread} onRead={() => setUnread(false)} historyView={historyView} />}
  </article>;
}
function PeerDetail({ owner, botId, request, bots, online, changed, onRead, historyView }: { owner: string; botId: string; request: PeerRequest; bots: Bot[]; online: boolean; changed: boolean; onRead: () => void; historyView: boolean }) {
  const [data, setData] = useState<BotPeerBodyPage | null>(null), [error, setError] = useState(''), [attempt, setAttempt] = useState(0), [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null), [trail, setTrail] = useState<(string | null)[]>([]);
  const paged = client.snapshot?.capabilities?.peerBodyPaging === 1;
  const onReadRef = useRef(onRead);
  useEffect(() => { onReadRef.current = onRead; }, [onRead]);
  const generation = useRef(0), action = useRunAction(owner, botId, `peer:cancel:${request.id}`);
  useEffect(() => { const event = (event: BotEvent) => { if (client.owner === owner && event.type === 'peer' && event.botId === botId && (event.data as { request?: PeerRequest }).request?.id === request.id) generation.current++; }; client.events.add(event); return () => { client.events.delete(event); }; }, [owner, botId, request.id]);
  useEffect(() => {
    let live = true; const before = generation.current;
    if (online) void Promise.resolve().then(async () => {
      setBusy(true); const next = await client.rpc<BotPeerBodyPage>('peers.read', botId, { id: request.id, ...(paged ? { limit: 12, cursor } : {}) }, undefined, { owner });
      if (!live || client.owner !== owner) return;
      if (before !== generation.current) throw Error('A new reply arrived while this discussion was opening. Refresh to see it.');
      if (next.request.id !== request.id || (next.request.senderBotId !== botId && next.request.recipientBotId !== botId) || next.exchanges.length > (paged ? 12 : 13) || next.exchanges.some(exchange => exchange.requestId !== request.id) || cursor && next.nextCursor === cursor || paged && new TextEncoder().encode(JSON.stringify(next)).length > 256 * 1024) throw Error('The discussion response could not be verified.');
      // The backend returns acceptance order. A reserved reply may follow a
      // higher-numbered handoff, so never sort these records by round.
      setData(next); setError(''); onReadRef.current();
    }).catch(reason => { if (live) setError(String(reason)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [owner, botId, request.id, online, attempt, paged, cursor]);
  return <div className="bots-peer-detail"><div className="bots-peer-detail-heading"><span>{paged ? `${request.round} lifetime contributions` : `${request.round} of ${request.roundLimit} discussion rounds used`}</span><button disabled={!online || busy} onClick={() => { setCursor(null); setTrail([]); setAttempt(value => value + 1); }}>{!online ? 'Offline' : busy ? 'Opening…' : changed ? 'Read new replies' : 'Refresh'}</button></div>
    {!online && <p>{data ? 'Saved in this view. Reconnect for new replies.' : 'Connect to read this exchange. Its result stays in your conversation.'}</p>}
    {data?.exchanges.map(exchange => <section key={exchange.id} data-history-key={historyView ? `peer-exchange:${exchange.id}` : undefined} className="bots-peer-exchange"><header><strong>{bots.find(bot => bot.id === exchange.botId)?.name ?? 'Bot'}{exchange.kind === 'cancel' ? ' · Cancellation' : ''}</strong><time dateTime={exchange.createdAt}>{new Date(exchange.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></header><Text text={exchange.text} botId={botId} />{exchange.attachmentIds.map(id => <ReturnedArtifact key={id} botId={botId} id={id} />)}</section>)}
    {paged && (cursor || data?.nextCursor) && <nav>{trail.length > 0 && <button type="button" disabled={!online || busy} onClick={() => { setCursor(trail.at(-1) ?? null); setTrail(v => v.slice(0,-1)); }}>Previous exchanges</button>}{data?.nextCursor && <button type="button" disabled={!online || busy} onClick={() => { setTrail(v => [...v.slice(-63),cursor]); setCursor(data.nextCursor!); }}>Next exchanges</button>}{cursor && <button type="button" disabled={!online || busy} onClick={() => { setCursor(null); setTrail([]); }}>First exchanges</button>}</nav>}
    {!paged && request.result && !data?.exchanges.some(e => e.kind === 'reply' && e.text === request.result) && <section className="bots-peer-outcome"><h4>Result</h4><Text text={request.result} botId={botId} /></section>}
    {paged && <PeerRootControls key={`${owner}:${botId}:${request.rootId}`} owner={owner} botId={botId} rootId={request.rootId} online={online}/>}
    {error && <p role="alert">{error}</p>}
    {!['completed','cancelled','failed'].includes(request.state) && !action.intent && <button className="bots-peer-cancel" disabled={!online || action.busy || !action.ready || request.cancelRequested} onClick={() => void action.perform('peers.cancel', { id: request.id }).catch(() => {})}>{request.cancelRequested ? 'Cancellation requested' : 'Cancel this discussion'}</button>}
    {(action.intent || action.error) && <p role="status">{action.error || 'Checking cancellation…'}<button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>Check saved action</button></p>}
  </div>;
}
