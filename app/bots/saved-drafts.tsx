"use client";
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Bot } from '../../lib/bots-types';
import type { DraftRecord } from './draft-store';
import type { BotComposer } from './composer-controller';
import { botComposers } from './composer-service';

type DraftRead = { owner: string; records: DraftRecord[]; error: string; loading: boolean };
/** Recovery is deliberate. An owner change never renders the previous owner's list. */
export function SavedDrafts({ owner, bots, composer }: { owner: string; bots: Bot[]; composer: BotComposer | null }) {
  const [read, setRead] = useState<DraftRead | null>(null), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) setRead({ owner, records: [], error: '', loading: true }); });
    void botComposers.savedDrafts(owner).then(records => {
      if (active) setRead({ owner, records, error: '', loading: false });
    }).catch(() => {
      if (active) setRead({ owner, records: [], error: 'Saved drafts could not load.', loading: false });
    });
    return () => { active = false; };
  }, [owner, attempt]);
  if (!composer || composer.owner !== owner) return null;
  const current = read?.owner === owner ? read : null;
  const records = current?.records ?? [], loading = current?.loading ?? true, error = current?.error ?? '';
  return <details className="bots-saved-drafts"><summary>Saved drafts</summary>
    {loading && <p role="status" className="text-sm text-muted-foreground">Loading saved drafts…</p>}
    {error && <div className="flex flex-wrap items-center gap-3"><p role="alert">{error}</p><Button variant="outline" type="button" onClick={() => setAttempt(value => value + 1)}>Retry</Button></div>}
    {records.map(record => <div key={record.botId}><span>{bots.find(bot => bot.id === record.botId)?.name ?? 'Earlier shared draft'} — {record.slots.normal.text.slice(0, 100) || 'Attachments'}</span>
      <Button variant="outline" type="button" disabled={Boolean(composer.operation) || Boolean(Object.keys(record.operations).length)} onClick={() => void botComposers.restoreDraft(owner, record.botId, composer.botId).then(restored => {
        if (restored) setRead(value => value?.owner === owner ? { ...value, records: value.records.filter(row => row.botId !== record.botId) } : value);
      }).catch(() => setRead(value => value?.owner === owner ? { ...value, error: 'Could not restore this draft. Its original is retained.' } : value))}>{Object.keys(record.operations).length ? 'Awaiting send confirmation' : 'Restore'}</Button></div>)}
    {composer.recoveries.map(slot => <div key={slot}><span>{composer.record.slots[slot].text.slice(0, 100) || 'Attachments'}</span><Button variant="outline" type="button" disabled={Boolean(composer.operation) || Boolean(composer.record.slots[slot].queueSource && !composer.record.slots[slot].queueSource?.removed)} onClick={() => composer.select(slot)}>Restore</Button></div>)}
    {!loading && !error && !records.length && !composer.recoveries.length && <p>No earlier drafts.</p>}
  </details>;
}
