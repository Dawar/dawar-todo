import { announcementJournal } from './announcement-store';
import { announcementEligible, announcementReceipt, freezeAnnouncement, type AnnouncementRecord } from './announcement-state';
import type { Bot, BotSnapshot } from '../../lib/bots-types';

export type AnnouncementTransport = { owner: string; online: boolean; bots: Bot[];
  snapshot: () => Promise<BotSnapshot>; queue: (botId: string, text: string, id: string, owner: string) => Promise<unknown> };
export class AnnouncementController {
  record: AnnouncementRecord | null = null;
  text = ''; selected: string[] | null = null; ready = false; saving = 0; busy = false; error = '';
  private unsaved = false;
  private revision = 0; private listeners = new Set<() => void>(); private writes: Promise<void> = Promise.resolve();
  constructor(readonly owner: string, private transport: AnnouncementTransport, private journal = announcementJournal) {}
  snapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { this.revision++; for (const listener of this.listeners) listener(); }
  private apply(record: AnnouncementRecord) {
    if (this.record && record.draft.revision < this.record.draft.revision) return;
    this.record = record; this.ready = true;
    if (!this.saving && !this.unsaved) { this.text = record.draft.text; this.selected = record.draft.selected; }
    this.notify();
  }
  async read(discardUnsaved = false) {
    try {
      await this.writes; const record = await this.journal(this.owner, { kind: 'read' });
      if (discardUnsaved) this.unsaved = false;
      this.apply(record); if (!this.unsaved) this.error = '';
    }
    catch { this.error = 'Saved announcement is unavailable. Retry storage; do not clear site data.'; }
    this.notify();
  }
  edit(text: string, selected: string[] | null) {
    if (!this.ready || this.record?.intent || this.transport.owner !== this.owner) return;
    this.text = text; this.selected = selected; this.saving++; this.notify();
    this.writes = this.writes.then(async () => {
      if (this.transport.owner !== this.owner) throw Error('Owner changed.');
      const value = await this.journal(this.owner, { kind: 'draft', text, selected, version: crypto.randomUUID(), expected: this.record!.draft.version });
      this.unsaved = false; this.apply(value); this.error = '';
    }).catch(() => { this.unsaved = true; this.error = 'Could not save this announcement, or another tab changed it. Copy unsaved text before reloading the saved draft.'; }).finally(() => { this.saving--; this.notify(); });
  }
  async start(selected: string[], current: () => boolean) {
    if (this.busy || !this.ready || this.record?.intent) return;
    this.busy = true; this.notify();
    const text = this.text;
    try {
      await this.writes;
      if (this.error || text !== this.text || !current() || this.transport.owner !== this.owner || !this.transport.online) throw Error('Review the current saved draft and connection before Send.');
      const snapshot = await this.transport.snapshot();
      if (!current() || this.transport.owner !== this.owner || !this.transport.online || !snapshot.ready) throw Error('The signed-in owner or connection changed. Nothing new was sent.');
      const intent = freezeAnnouncement(this.owner, text, selected, snapshot.bots, crypto.randomUUID());
      this.apply(await this.journal(this.owner, { kind: 'admit', intent, expected: this.record!.draft.version }));
      await this.deliver(current, snapshot.bots);
    } catch (error) { this.error = error instanceof Error ? error.message : 'Announcement is unconfirmed. Review the original saved recipients.'; }
    finally { this.busy = false; this.notify(); }
  }
  async recover(current: () => boolean) {
    if (this.busy || !this.ready || !this.record?.intent) return;
    this.busy = true; this.notify();
    try {
      await this.read();
      const snapshot = await this.transport.snapshot();
      if (!current() || this.transport.owner !== this.owner || !this.transport.online || !snapshot.ready) throw Error('Reconnect as the original owner before continuing.');
      await this.deliver(current, snapshot.bots);
    } catch { this.error = 'The original announcement remains saved. Reconnect as its owner to continue or check the same delivery IDs.'; }
    finally { this.busy = false; this.notify(); }
  }
  private async deliver(current: () => boolean, confirmedBots: Bot[]) {
    const intent = this.record!.intent!;
    for (const original of intent.recipients) {
      if (!current() || this.transport.owner !== this.owner || !this.transport.online) break;
      const saved = await this.journal(this.owner, { kind: 'read' }); this.apply(saved);
      const recipient = saved.intent?.id === intent.id ? saved.intent.recipients.find(value => value.operationId === original.operationId) : null;
      if (!recipient || ['queued', 'accepted', 'rejected'].includes(recipient.state)) continue;
      const matches = (bot: Bot) => bot.id === recipient.id && announcementEligible(bot) && bot.threadId === recipient.threadId;
      const valid = () => current() && this.transport.owner === this.owner && this.transport.online && confirmedBots.some(matches) && this.transport.bots.some(matches);
      if (!valid()) { this.error = 'A recipient or conversation changed. Original unconfirmed identities remain saved; nothing was redirected.'; continue; }
      // Strict save before the request; crash/unknown response cannot become a fresh operation.
      this.apply(await this.journal(this.owner, { kind: 'settle', id: intent.id, operationId: recipient.operationId,
        update: { state: 'unconfirmed', detail: 'Confirmation pending' } }));
      if (!valid()) break;
      let update: Parameters<typeof announcementJournal>[1] & { kind: 'settle' };
      try {
        const result = await this.transport.queue(recipient.id, intent.text, recipient.operationId, this.owner);
        const receipt = announcementReceipt(result, recipient, intent.text);
        update = { kind: 'settle', id: intent.id, operationId: recipient.operationId,
          update: receipt ? { ...receipt, detail: undefined } : { state: 'unconfirmed', detail: 'Reply did not confirm the original delivery' } };
      } catch (error) {
        const outcome = (error as { outcome?: string } | null)?.outcome;
        update = { kind: 'settle', id: intent.id, operationId: recipient.operationId, update:
          outcome === 'rejected' ? { state: 'rejected', detail: 'Queue request rejected' } :
          outcome === 'not-sent' ? { state: 'unsent', detail: 'Not sent; original ID retained' } : { state: 'unconfirmed', detail: 'Delivery unconfirmed; check this original ID' } };
      }
      // Receipt belongs to its original owner even after dialog/account replacement.
      this.apply(await this.journal(this.owner, update));
    }
  }
  async newDraft() {
    if (this.busy || !this.record?.intent || this.transport.owner !== this.owner) return;
    try { this.apply(await this.journal(this.owner, { kind: 'new', id: this.record.intent.id })); this.error = ''; }
    catch { this.error = 'Resolve the original announcement before starting another.'; }
    this.notify();
  }
}
