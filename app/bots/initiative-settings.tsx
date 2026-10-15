"use client";
import { useRef, useState } from 'react';
import { botsClient } from './client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

type Settings = { enabled: boolean; scanMinutes: number; baselineMinutes: number; perBotDaily: number; globalDaily: number; spacingMinMinutes: number;
  spacingMaxMinutes: number; reminderHours: number; priorities: string; coverage: 'all' | 'selected'; revision: number; model: string; effort: string; bots: Record<string, { enabled?: boolean; priorities?: string }> };
type Status = { settings: Settings; lastScanAt: string | null;
  metrics: { publishedToday: number; published: number; accepted: number; dismissed: number; held: number; uncertain: number; reviews: number; reviewTokens: number };
  bot: { enabled: boolean; supported: boolean; lastReviewAt: string | null; nextReviewAt: string | null; lastOutcome: string | null; failures: number;
    lastError: string | null; lastErrorAt: string | null; backoffUntil: string | null; items: { id: string; title: string; kind: string; status: string }[] } };
const when = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not yet';

/** Owner controls and concise operational state for private initiative reviews.
 * Review traces stay private; only counts, times and failures appear here. */
export function InitiativeSettings({ owner, botId, botName, online }: { owner: string; botId: string; botName: string; online: boolean }) {
  const sequence = useRef(0), [status, setStatus] = useState<Status | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function run(method: 'initiative.read' | 'initiative.configure', params: Record<string, unknown> = {}) {
    if (!online || busy) return;
    const current = ++sequence.current; setBusy(true); setError('');
    try {
      const result = await botsClient.rpc<Status>(method, botId, params, undefined, { owner });
      if (sequence.current === current && botsClient.owner === owner) setStatus(result);
    } catch (e) { if (sequence.current === current) setError(e instanceof Error ? e.message : 'Initiative settings are unavailable.'); }
    finally { if (sequence.current === current) setBusy(false); }
  }
  const save = (patch: Record<string, unknown>) => run('initiative.configure', { patch, expectedRevision: status?.settings.revision ?? null });
  const s = status?.settings, b = status?.bot, override = s?.bots[botId] ?? {};
  return <details className="bots-details-section" onToggle={event => { if (event.currentTarget.open) void run('initiative.read'); }}>
    <summary>Proactive initiative</summary>
    {!status ? <p className="bots-details-lead">{busy ? 'Reading initiative settings…' : error || 'Open to read initiative settings.'}</p> : <div className="grid gap-3">
      <p className="bots-details-lead">Idle bots privately review their work and may send a proposal as an ordinary message. Reviews are read-only; approved work follows the normal path.</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.enabled} disabled={!online || busy} onChange={event => void save({ enabled: event.target.checked })} />Enable for all bots</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.coverage === 'selected'} disabled={!online || busy} onChange={event => void save({ coverage: event.target.checked ? 'selected' : 'all' })} />Pilot: only bots selected below</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={s!.coverage === 'selected' ? override.enabled === true : override.enabled !== false} disabled={!online || busy || !b!.supported} onChange={event => void save({ bots: { [botId]: { enabled: s!.coverage === 'selected' ? (event.target.checked ? true : null) : (event.target.checked ? null : false) } } })} />Review {botName}{!b!.supported && ' (not supported for this provider)'}</label>
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
      </dl>
      {b!.items.length > 0 && <ul className="bots-details-lead">{b!.items.map(item => <li key={item.id}>{item.title} · {item.kind} · {item.status}</li>)}</ul>}
    </div>}
    {status && error && <p role="status" className="bots-details-lead">{error}</p>}
  </details>;
}
