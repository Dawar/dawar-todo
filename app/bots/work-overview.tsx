"use client";
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Pause } from 'lucide-react';
import type { Bot } from './single-thread-contract';
import type { BotAdmissionWork, BotObservedInboxItem } from '../../lib/bot-work-view';
import { botsClient as client } from './client';
import { useRunAction } from './run-action';
import './single-thread.css';
export function workLabel(work: BotAdmissionWork | undefined, bot: Bot) {
  if (!work || work.botId !== bot.id || ['provisioning', 'error'].includes(bot.status)) return null;
  if (work.threadId && work.threadId !== bot.threadId) return 'Checking execution';
  if (work.state === 'unconfirmed') return 'Needs confirmation';
  if (work.state === 'starting') return 'Starting';
  if (work.state === 'needs-input') return 'Needs your input';
  // Progress summaries persist across turns. They belong in work details,
  // not the live presence label, where an old summary implies current work.
  if (work.state === 'working') return work.activeTurnId && work.activeTurnId === bot.activeTurnId ? 'Working' : 'Checking execution';
  if (work.paused || work.state === 'paused') return 'Automatic work paused';
  if (work.state === 'waiting' || (work.admission?.waitingCount ?? 0) > 0) return 'Waiting to start';
  return 'Ready';
}
export function WorkOverview({ owner, bot, work, online }: { owner: string; bot: Bot; work?: BotAdmissionWork; online: boolean }) {
  const action = useRunAction(owner, bot.id, 'work:resume');
  work = work?.botId === bot.id && (!work.threadId || work.threadId === bot.threadId) ? work : undefined;
  const admission = work?.admission;
  return <>{work?.paused && <div className="bots-work-pause"><Pause size={17} /><div><strong>Automatic work is paused</strong><p>Your conversation is still open. Resume when you’re ready for queued schedules and discussions.</p></div>{!action.intent && <button disabled={!online || action.busy || !action.ready} onClick={() => void action.perform('work.resume', {}).catch(() => {})}>Resume</button>}</div>}
    {(action.intent || action.error) && <div className="bots-action-recovery" role="status">{action.error || 'Resume is awaiting confirmation.'}<button disabled={!online || action.busy} onClick={() => void action.retry().catch(() => {})}>{action.busy ? 'Checking…' : 'Check saved action'}</button></div>}
    {admission && admission.waitingCount > 0 && <p className="bots-details-lead" role="status">{admission.waitingCount} accepted {admission.waitingCount === 1 ? 'item is' : 'items are'} awaiting a confirmed start. {online ? admission.reason : 'Reconnect to check current execution.'}</p>}
    {work?.goal && <section aria-label="Native objective"><h3>Objective · {work.goal.status}</h3><p className="bots-details-lead">{work.goal.objective}</p></section>}
    {work?.remaining && <p className="bots-details-lead">{work.remaining}</p>}
  </>;
}
export function inboxLabel(item: BotObservedInboxItem, bot: Bot, work: BotAdmissionWork | undefined, online: boolean) {
  if (item.state !== 'accepted') return item.waitReason || ({ queued: 'Up next', dispatching: 'Delivery awaiting confirmation', uncertain: 'Delivery needs confirmation', cancelled: 'Cancelled', failed: 'Could not start' }[item.state]);
  if (!online) return item.turnId ? 'Reconnect to check execution' : 'Accepted · waiting for a confirmed start';
  if (item.threadId && item.threadId !== bot.threadId) return 'Original thread binding needs confirmation';
  if (!work || work.botId !== bot.id || work.threadId && work.threadId !== bot.threadId) return 'Accepted · waiting for execution confirmation';
  const current = item.threadId === bot.threadId && work?.botId === bot.id && (!work.threadId || work.threadId === bot.threadId) &&
    item.turnId && item.turnId === bot.activeTurnId && item.turnId === work.activeTurnId;
  if (current && ['working', 'needs-input'].includes(work.state) && typeof work.activeNeedsInput === 'boolean') return work.activeNeedsInput ? 'Needs your input' : 'Working';
  if (item.turnId || work?.state === 'unconfirmed') return 'Execution needs confirmation';
  if (work?.paused) return 'Accepted · automatic work is paused';
  return 'Accepted · waiting to start';
}

export function AutomaticInbox({ owner, bot, work, online }: { owner: string; bot: Bot; work?: BotAdmissionWork; online: boolean }) {
  const botId = bot.id, scope = JSON.stringify([owner, botId, bot.threadId]);
  type Page = { items: BotObservedInboxItem[]; nextCursor: string | null };
  const [savedPage, setPage] = useState<(Page & { scope: string }) | null>(null), [position, setPosition] = useState<{ scope: string; cursor: string | null } | null>(null);
  const [status, setStatus] = useState<{ scope: string; error: string; busy: boolean } | null>(null), [refresh, setRefresh] = useState(0), [update, setUpdate] = useState<{ scope: string; changed: boolean } | null>(null);
  const generation = useRef(0), page = savedPage?.scope === scope ? savedPage : null, cursor = position?.scope === scope ? position.cursor : null;
  const error = status?.scope === scope ? status.error : '', busy = status?.scope === scope && status.busy, changed = update?.scope === scope && update.changed;
  useEffect(() => { const listener = (event: { botId?: string; type: string }) => { if (client.owner === owner && event.botId === botId && ['work','peer','schedules','queue'].includes(event.type)) { generation.current++; setUpdate({ scope, changed: true }); } }; client.events.add(listener); return () => { client.events.delete(listener); }; }, [owner, botId, scope]);
  useEffect(() => {
    let live = true;
    if (online && client.owner === owner) void Promise.resolve().then(async () => {
      if (!live || client.owner !== owner) return;
      const observed = generation.current;
      setStatus({ scope, busy: true, error: '' });
      const value = await client.rpc<Page>('inbox.list', botId, { limit: 20, ...(cursor ? { cursor } : {}) }, undefined, { owner });
      if (!live || client.owner !== owner) return;
      if (!Array.isArray(value.items) || value.items.length > 20 || value.items.some(item => item.botId !== botId) || value.nextCursor === cursor && cursor !== null) throw Error('Upcoming work could not be confirmed. Refresh to try again.');
      setPage({ ...value, scope }); setStatus({ scope, busy: false, error: '' });
      setUpdate({ scope, changed: generation.current !== observed });
    }).catch(reason => { if (live && client.owner === owner) setStatus({ scope, busy: false, error: String(reason) }); });
    return () => { live = false; };
  }, [owner, botId, scope, cursor, online, refresh]);
  return <section className="bots-auto-inbox"><header><h3>Scheduled & shared work</h3><button disabled={!online || busy} onClick={() => { setPosition({ scope, cursor: null }); setRefresh(value => value + 1); }}>{changed ? 'Refresh · updated' : 'Refresh'}</button></header>
    {page?.items.map(item => { const label = inboxLabel(item, bot, work, online), detail = item.waitReason && !['Working', 'Needs your input', 'Accepted · waiting to start.', 'Accepted · automatic work is paused.', 'Execution needs confirmation.'].includes(item.waitReason) ? item.waitReason : null;
      return <article key={item.id}><span className="bots-inbox-dot" /><div><strong>{item.summary}</strong><small>{label}{detail && detail.replace(/\.$/, '') !== label.replace(/\.$/, '') ? ` · ${detail}` : ''}</small></div><span>{item.kind === 'peer' ? 'Discussion' : item.kind === 'secure-input' ? 'Input' : 'Schedule'}</span></article>; })}
    {!page?.items.length && <p>{!online ? 'Reconnect to see upcoming work.' : error ? 'Upcoming work could not be confirmed.' : busy || !page ? 'Loading upcoming work…' : 'Nothing waiting here.'}</p>}
    {error && <p role="alert">{error}</p>}{page?.nextCursor && <button disabled={busy || !online} onClick={() => setPosition({ scope, cursor: page.nextCursor })}>More upcoming work <ArrowRight size={14} /></button>}
  </section>;
}
