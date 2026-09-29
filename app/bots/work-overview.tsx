"use client";
import { useEffect, useState } from 'react';
import { ArrowRight, Pause } from 'lucide-react';
import type { Bot, InboxItem, WorkState } from './single-thread-contract';
import { botsClient as client } from './client';
import { useRunAction } from './run-action';
import './single-thread.css';
export function workLabel(work: WorkState | undefined, bots: Bot[]) {
  if (!work) return null;
  if (work.state === 'paused') return 'Paused';
  if (work.state === 'unconfirmed') return 'Needs confirmation';
  if (work.state === 'needs-input') return 'Needs your input';
  if (work.state === 'waiting') return work.waitingFor.length ? `Waiting for ${work.waitingFor.map(id => bots.find(bot => bot.id === id)?.name ?? 'a reply').join(', ')}` : 'Waiting';
  if (work.state === 'working') return work.summary ? `Working on ${work.summary}` : 'Working';
  return 'Ready';
}
export function WorkOverview({ owner, bot, work, online }: { owner: string; bot: Bot; work?: WorkState; online: boolean }) {
  const action = useRunAction(owner, bot.id, 'work:resume');
  return <>{work?.paused && <div className="bots-work-pause"><Pause size={17} /><div><strong>Automatic work is paused</strong><p>Your conversation is still open. Resume when you’re ready for queued schedules and discussions.</p></div>{!action.intent && <button disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('work.resume', {}).catch(() => {})}>Resume</button>}</div>}
    {(action.intent || action.error) && <div className="bots-action-recovery" role="status">{action.error || 'Resume is awaiting confirmation.'}<button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>{action.busy ? 'Checking…' : 'Check saved action'}</button></div>}
    {work?.remaining && <p className="bots-details-lead">{work.remaining}</p>}
  </>;
}
export function AutomaticInbox({ owner, botId, online }: { owner: string; botId: string; online: boolean }) {
  const [page, setPage] = useState<{ items: InboxItem[]; nextCursor: string | null } | null>(null), [cursor, setCursor] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0), [changed, setChanged] = useState(false);
  useEffect(() => { const listener = (event: { botId?: string; type: string }) => { if (client.owner === owner && event.botId === botId && ['work','peer','schedules','queue'].includes(event.type)) setChanged(true); }; client.events.add(listener); return () => { client.events.delete(listener); }; }, [owner, botId]);
  useEffect(() => {
    let live = true;
    if (online) void Promise.resolve().then(async () => { setBusy(true); const value = await client.rpc<{ items: InboxItem[]; nextCursor: string | null }>('inbox.list', botId, { limit: 20, ...(cursor ? { cursor } : {}) }, undefined, { owner }); if (!live || client.owner !== owner) return; setPage(value); setError(''); }).catch(reason => { if (live) setError(String(reason)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [owner, botId, cursor, online, refresh]);
  return <section className="bots-auto-inbox"><header><h3>Scheduled & shared work</h3><button disabled={!online || busy} onClick={() => { setCursor(null); setRefresh(value => value + 1); setChanged(false); }}>{changed ? 'Refresh · updated' : 'Refresh'}</button></header>
    {page?.items.map(item => <article key={item.id}><span className="bots-inbox-dot" /><div><strong>{item.summary}</strong><small>{item.waitReason || ({ queued: 'Up next', dispatching: 'Starting', accepted: 'Started', uncertain: 'Delivery needs confirmation', cancelled: 'Cancelled', failed: 'Could not start' }[item.state])}</small></div><span>{item.kind === 'peer' ? 'Discussion' : 'Schedule'}</span></article>)}
    {!page?.items.length && <p>{!online ? 'Reconnect to see upcoming work.' : busy ? 'Loading upcoming work…' : 'Nothing waiting here.'}</p>}
    {error && <p role="alert">{error}</p>}{page?.nextCursor && <button disabled={busy || !online} onClick={() => setCursor(page.nextCursor)}>More upcoming work <ArrowRight size={14} /></button>}
  </section>;
}
