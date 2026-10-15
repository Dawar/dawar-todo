"use client";
import { useRef, useState } from 'react';
import { botsClient } from './client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Settings = { enabled: boolean; scanMinutes: number; baselineMinutes: number; perBotDaily: number; globalDaily: number; spacingMinMinutes: number;
  spacingMaxMinutes: number; reminderHours: number; priorities: string; coverage: 'all' | 'selected'; revision: number; model: string; effort: string;
  looseThreads: boolean; triage: boolean; bots: Record<string, { enabled?: boolean; priorities?: string }> };
type LooseThread = { id: string; title: string; category: string; importance: string; status: string; due: boolean; ageHours: number; lastTouchedAt: string;
  responsibleName: string; snoozedUntil: string | null; resolution: { kind: string; evidence: string | null } | null;
  mentions: { bot: string; at: string; quote: string }[] };
type RoomArm = { arm: string; rooms: number; delivered: number; nothing: number; tokens: number; approvalRate: number | null; completionRate: number | null; tokensPerUseful: number | null };
type Room = { settings: { enabled: boolean; panelSize: number; dailyTokens: number; experiment: { enabled: boolean } }; budget: { dailyTokens: number; usedToday: number }; arms: RoomArm[];
  recent: { id: string; arm: string; stage: string; reason: string | null; tokens: number | null; panel: { name: string; role: string; style: string | null }[] }[];
  contributions: { name: string; points: number }[] };
type Status = { settings: Settings; lastScanAt: string | null; looseThreads: LooseThread[]; room: Room;
  metrics: { publishedToday: number; published: number; accepted: number; dismissed: number; held: number; uncertain: number; reviews: number; reviewTokens: number;
    reviewTokensToday: number; extractions: number; extractionTokens: number; extractionTokensToday: number; openLooseThreads: number; dueLooseThreads: number };
  bot: { enabled: boolean; supported: boolean; lastReviewAt: string | null; nextReviewAt: string | null; lastOutcome: string | null; failures: number;
    lastError: string | null; lastErrorAt: string | null; backoffUntil: string | null; lastExtractionAt: string | null; items: { id: string; title: string; kind: string; status: string }[] } };
const when = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not yet';
const age = (hours: number) => hours < 1 ? 'just now' : hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
const percent = (n: number | null) => n === null ? '—' : `${Math.round(n * 100)}%`;
const tokens = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);

/** Owner controls and concise operational state for private initiative reviews.
 * Review traces stay private; only counts, times and failures appear here. */
export function InitiativeSettings({ owner, botId, botName, online }: { owner: string; botId: string; botName: string; online: boolean }) {
  const sequence = useRef(0), [status, setStatus] = useState<Status | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run(method: 'initiative.read' | 'initiative.configure' | 'initiative.thread', params: Record<string, unknown> = {}) {
    if (!online || busy) return;
    const current = ++sequence.current; setBusy(true); setError('');
    try {
      const result = await botsClient.rpc<Status>(method, botId, params, undefined, { owner });
      if (sequence.current === current && botsClient.owner === owner) setStatus(result);
    } catch (e) { if (sequence.current === current) setError(e instanceof Error ? e.message : 'Initiative settings are unavailable.'); }
    finally { if (sequence.current === current) setBusy(false); }
  }
  const save = (patch: Record<string, unknown>) => run('initiative.configure', { patch, expectedRevision: status?.settings.revision ?? null });
  const act = (itemId: string, action: 'dismiss' | 'snooze' | 'resolve') => run('initiative.thread', { itemId, action, until: action === 'snooze' ? new Date(Date.now() + 7 * 864e5).toISOString() : null });
  const s = status?.settings, b = status?.bot, override = s?.bots[botId] ?? {};
  return <details className="bots-details-section" onToggle={event => { if (event.currentTarget.open) void run('initiative.read'); }}>
    <summary>Proactive initiative</summary>
    {!status ? <p className="bots-details-lead">{busy ? 'Reading initiative settings…' : error || 'Open to read initiative settings.'}</p> : <div className="grid gap-3">
      <p className="bots-details-lead">Idle bots remember what you mention and privately review their work, then may send a proposal as an ordinary message. Reviews are tool-free and never touch the conversation; approved work follows the normal path.</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.enabled} disabled={!online || busy} onChange={event => void save({ enabled: event.target.checked })} />Enable for all bots</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.coverage === 'selected'} disabled={!online || busy} onChange={event => void save({ coverage: event.target.checked ? 'selected' : 'all' })} />Pilot: only bots selected below</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.coverage === 'selected' ? override.enabled === true : override.enabled !== false} disabled={!online || busy} onChange={event => void save({ bots: { [botId]: { enabled: s!.coverage === 'selected' ? (event.target.checked ? true : null) : (event.target.checked ? null : false) } } })} />Review {botName}</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.looseThreads} disabled={!online || busy} onChange={event => void save({ looseThreads: event.target.checked })} />Track loose threads (what you mention that never reached a conclusion)</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.triage} disabled={!online || busy} onChange={event => void save({ triage: event.target.checked })} />Triage: review only bots with something to raise</label>
      <form className="grid gap-3" onSubmit={event => {
        event.preventDefault(); const f = new FormData(event.currentTarget), n = (k: string) => Number(f.get(k));
        void save({ priorities: String(f.get('priorities') ?? ''), baselineMinutes: n('baselineHours') * 60, scanMinutes: n('scanMinutes'), perBotDaily: n('perBotDaily'), globalDaily: n('globalDaily'),
          bots: { [botId]: { priorities: String(f.get('botPriorities') ?? '') || null } } });
      }} key={`${botId}:${s!.revision}`}>
        <label>Owner priorities (all bots)<Textarea name="priorities" defaultValue={s!.priorities} maxLength={8000} rows={3} /></label>
        <label>Priorities for {botName}<Textarea name="botPriorities" defaultValue={override.priorities ?? ''} maxLength={4000} rows={2} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label>Review every (hours)<Input name="baselineHours" type="number" min={0.5} max={168} step={0.5} defaultValue={s!.baselineMinutes / 60} /></label>
          <label>Eligibility scan (minutes)<Input name="scanMinutes" type="number" min={5} max={1440} defaultValue={s!.scanMinutes} /></label>
          <label>Messages per bot per day<Input name="perBotDaily" type="number" min={0} max={20} defaultValue={s!.perBotDaily} /></label>
          <label>Messages per day (all bots)<Input name="globalDaily" type="number" min={0} max={100} defaultValue={s!.globalDaily} /></label>
        </div>
        <Button className="justify-self-start" type="submit" disabled={!online || busy}>Save initiative settings</Button>
      </form>
      <dl className="bots-details-lead grid grid-cols-[auto_1fr] gap-x-3">
        <dt>Last review</dt><dd>{when(b!.lastReviewAt)}{b!.lastOutcome ? ` · ${b!.lastOutcome}` : ''}</dd>
        <dt>Next review</dt><dd>{b!.enabled ? when(b!.nextReviewAt) : 'Off'}</dd>
        <dt>Failures</dt><dd>{b!.failures}{b!.lastError ? ` · ${b!.lastError} (${when(b!.lastErrorAt)})` : ''}{b!.backoffUntil ? ` · retry after ${when(b!.backoffUntil)}` : ''}</dd>
        <dt>Today</dt><dd>{status.metrics.publishedToday} of {s!.globalDaily} proposals sent · {status.metrics.held} held</dd>
        <dt>Outcomes</dt><dd>{status.metrics.accepted} accepted · {status.metrics.dismissed} dismissed · {status.metrics.reviews} reviews</dd>
        <dt>Tokens</dt><dd>Reviews {tokens(status.metrics.reviewTokensToday)} today ({tokens(status.metrics.reviewTokens)} total) · mention capture {tokens(status.metrics.extractionTokensToday)} today ({tokens(status.metrics.extractionTokens)} total, {status.metrics.extractions} runs)</dd>
      </dl>
      <div className="grid gap-2">
        <label className="flex items-center gap-2"><input type="checkbox" checked={status.room.settings.enabled} disabled={!online || busy} onChange={event => void save({ room: { enabled: event.target.checked } })} />Writers&apos; room for high-value loose threads ({status.room.settings.panelSize} bots draft, critique and refine; a blind judge picks one or nothing)</label>
        <p className="bots-details-lead">Room budget today: {tokens(status.room.budget.usedToday)} of {tokens(status.room.budget.dailyTokens)} tokens{status.room.settings.experiment.enabled ? ' · experiment running' : ''}</p>
        {status.room.arms.length > 0 && <ul className="bots-details-lead">{status.room.arms.map(a => <li key={a.arm}>{a.arm}: {a.rooms} rooms · {a.delivered} sent · {a.nothing} nothing · approved {percent(a.approvalRate)} · completed {percent(a.completionRate)} · {a.tokensPerUseful === null ? 'no useful proposal yet' : `${tokens(a.tokensPerUseful)} tokens per useful proposal`}</li>)}</ul>}
        {status.room.recent.length > 0 && <ul className="bots-details-lead">{status.room.recent.map(r => <li key={r.id}>{r.stage}{r.reason ? ` (${r.reason})` : ''} · {r.arm} · {r.panel.map(p => `${p.name} ${p.role}`).join(', ')}{r.tokens ? ` · ${tokens(r.tokens)} tokens` : ''}</li>)}</ul>}
        {status.room.contributions.length > 0 && <p className="bots-details-lead">Contribution record: {status.room.contributions.map(c => `${c.name} ${c.points}`).join(' · ')}</p>}
      </div>
      <div className="grid gap-2">
        <p className="bots-details-lead">Loose threads: {status.metrics.openLooseThreads} open · {status.metrics.dueLooseThreads} due to come back</p>
        {status.looseThreads.length === 0 ? <p className="bots-details-lead">Nothing tracked yet.</p> : <ul className="grid gap-2">{status.looseThreads.map(thread => {
          const open = !['resolved', 'dismissed'].includes(thread.status), first = thread.mentions[0];
          return <li key={thread.id} className="bots-details-lead grid gap-1">
            <span><strong>{thread.title}</strong> · {thread.category} · {thread.importance} · {thread.status}{thread.due ? ' · due' : ''}{thread.snoozedUntil ? ` until ${when(thread.snoozedUntil)}` : ''}</span>
            {first && <span>“{first.quote}” — to {first.bot}, {age(thread.ageHours)}{thread.mentions.length > 1 ? ` · mentioned ${thread.mentions.length}×` : ''} · {thread.responsibleName} follows up</span>}
            {thread.resolution && <span>Concluded: {thread.resolution.kind}{thread.resolution.evidence ? ` — ${thread.resolution.evidence}` : ''}</span>}
            {open && <span className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={!online || busy} onClick={() => void act(thread.id, 'resolve')}>Done</Button>
              <Button type="button" size="sm" variant="outline" disabled={!online || busy} onClick={() => void act(thread.id, 'snooze')}>Next week</Button>
              <Button type="button" size="sm" variant="outline" disabled={!online || busy} onClick={() => void act(thread.id, 'dismiss')}>Leave it</Button>
            </span>}
          </li>;
        })}</ul>}
      </div>
      {b!.items.length > 0 && <ul className="bots-details-lead">{b!.items.map(item => <li key={item.id}>{item.title} · {item.kind} · {item.status}</li>)}</ul>}
    </div>}
    {status && error && <p role="status" className="bots-details-lead">{error}</p>}
  </details>;
}
