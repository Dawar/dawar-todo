"use client";
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Megaphone, X } from 'lucide-react';
import { ControlledDialog } from '@/components/ui/controlled-dialog';
import { Button } from '@/components/ui/button';
import { botsClient as client } from './client';
import { BotAvatar } from './bot-avatar';
import { AnnouncementController } from './announcement-controller';
import { ANNOUNCEMENT_TEXT_LIMIT, announcementEligible, announcementFinished, announcementGroups } from './announcement-state';
import type { BotSnapshot } from '../../lib/bots-types';
import './announcements.css';

const controllers = new Map<string, AnnouncementController>();
function controllerFor(owner: string) {
  let controller = controllers.get(owner);
  if (!controller) {
    controller = new AnnouncementController(owner, {
      get owner() { return client.owner; }, get online() { return client.online; }, get bots() { return client.snapshot?.bots ?? []; },
      snapshot: () => client.rpc<BotSnapshot>('snapshot', undefined, {}, undefined, { owner, managed: true }),
      queue: (botId, text, id, owner) => client.rpc('queue.add', botId, { text, attachments: [], listId: null }, id, { owner, managed: true }),
    }); controllers.set(owner, controller);
  }
  return controller;
}
/** Outside selected-conversation remounts. This draft never enters the bot composer. */
export function AnnouncementDialog({ owner, onClose }: { owner: string; onClose: () => void }) {
  const controller = controllerFor(owner), mounted = useRef(true);
  useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
  useEffect(() => {
    mounted.current = true; void controller.read();
    const refresh = () => { if (!controller.busy && !controller.saving) void controller.read(); };
    window.addEventListener('focus', refresh);
    let channel: BroadcastChannel | null = null;
    try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('dawar-announcements-v1'); } catch { /* Focus/reopen also reload the original journal. */ }
    if (channel) channel.onmessage = refresh;
    return () => { mounted.current = false; channel?.close(); window.removeEventListener('focus', refresh); };
  }, [controller]);
  const current = () => mounted.current && client.owner === owner;
  const bots = client.snapshot?.bots ?? [], eligible = bots.filter(announcementEligible), ids = eligible.map(bot => bot.id);
  const selected = controller.selected ?? ids, intent = controller.record?.intent;
  const groups = announcementGroups(bots, client.snapshot?.teams ?? []);
  const editable = controller.ready && !intent && !controller.busy && client.owner === owner;
  const change = (next: string[]) => controller.edit(controller.text, next);
  const closed = () => { mounted.current = false; onClose(); };
  return <ControlledDialog title={<span className="announcement-title"><Megaphone size={19} aria-hidden="true" />Announcement</span>}
    description="Queue the same message in each selected bot’s Next queue. It runs when that bot is eligible."
    className="announcement-dialog" onClose={closed}>
    {!controller.ready ? <p role="status">Loading saved announcement…</p> : intent ? <>
      <p className="announcement-text">{intent.text}</p>
      <p className="text-sm text-muted-foreground">{intent.recipients.filter(r => ['queued', 'accepted'].includes(r.state)).length} of {intent.recipients.length} confirmed. Queue acceptance is separate from completing the work.</p>
      <ul className="announcement-results" aria-label="Announcement delivery results">{intent.recipients.map(recipient => <li key={recipient.operationId}>
        <span>{recipient.name}</span><span>{({ unsent: 'Not queued', unconfirmed: 'Unconfirmed', queued: 'Queued in Next', accepted: 'Native accepted', rejected: 'Rejected' })[recipient.state]}</span>
        {recipient.detail && <small>{recipient.detail}</small>}
        <details><summary>Delivery reference</summary><code>{recipient.operationId}</code>{recipient.queueId && <code>{recipient.queueId}</code>}{recipient.turnId && <code>{recipient.turnId}</code>}</details>
      </li>)}</ul>
      {announcementFinished(intent) ? <Button type="button" variant="outline" disabled={controller.busy} onClick={() => void controller.newDraft()}>New announcement</Button> :
        <Button type="button" disabled={!client.online || controller.busy} onClick={() => void controller.recover(current)}>{controller.busy ? 'Queueing…' : 'Continue / check original deliveries'}</Button>}
    </> : <>
      <label className="announcement-label" htmlFor="announcement-message">Message</label>
      <textarea id="announcement-message" rows={5} maxLength={ANNOUNCEMENT_TEXT_LIMIT} value={controller.text} disabled={!editable} onChange={event => controller.edit(event.target.value, selected)} placeholder="Write an announcement…" />
      <div className="announcement-selection"><strong>{selected.filter(id => ids.includes(id)).length} recipients</strong>
        <Button type="button" size="sm" variant="ghost" disabled={!editable} onClick={() => change(ids)}>Select all</Button>
        <Button type="button" size="sm" variant="ghost" disabled={!editable} onClick={() => change([])}>Clear all</Button></div>
      <div className="announcement-recipients">{groups.map(group => {
        const chosen = group.bots.filter(bot => selected.includes(bot.id));
        return <section key={group.id} aria-label={group.name}><div className="announcement-team-heading"><strong>{group.name}</strong>
          <Button type="button" size="sm" variant="ghost" disabled={!editable} onClick={() => change(chosen.length ? selected.filter(id => !group.bots.some(bot => bot.id === id)) : [...new Set([...selected, ...group.bots.map(bot => bot.id)])])}>{chosen.length ? 'Clear team' : 'Restore team'}</Button></div>
          <div className="announcement-chips">{group.bots.map(bot => <button key={bot.id} type="button" className="announcement-chip" aria-pressed={selected.includes(bot.id)} disabled={!editable}
            aria-label={`${selected.includes(bot.id) ? 'Remove' : 'Add'} ${bot.name}`} onClick={() => change(selected.includes(bot.id) ? selected.filter(id => id !== bot.id) : [...selected, bot.id])}>
            <BotAvatar bot={bot} small decorative working={false} /><span>{bot.name}</span>{selected.includes(bot.id) && <X size={14} aria-hidden="true" />}</button>)}</div>
        </section>;
      })}{!eligible.length && <p>No active bots available.</p>}</div>
      <p className="text-sm text-muted-foreground" role="status">{controller.saving ? 'Saving…' : controller.error ? 'Draft save is unconfirmed' : 'Draft saved in this browser'}{!client.online && ' · Reconnect to send'}</p>
      <Button type="button" disabled={!editable || controller.saving > 0 || !client.online || !controller.text.trim() || !selected.length || selected.some(id => !ids.includes(id)) || Boolean(controller.error)}
        onClick={() => void controller.start(selected, current)}>Send announcement</Button>
    </>}
    {controller.error && <div role="alert" className="announcement-error"><p>{controller.error}</p>{!controller.busy && <Button type="button" variant="outline" onClick={() => void controller.read(true)}>Reload saved announcement</Button>}</div>}
    <Button type="button" variant="ghost" onClick={closed}>Close</Button>
  </ControlledDialog>;
}
