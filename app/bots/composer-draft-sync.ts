import { portableHeaders } from '../../lib/portable-csrf';
import { validSharedDraft, draftContentFingerprint, type ComposerDraftReceipt, type SharedComposerDraft } from '../../lib/bot-composer-draft';
import { BotDraftStore, sharedDraftContent } from './draft-store';
import type { BotComposer } from './composer-controller';

/** Only unsent drafts, never native sends or operation journals. Pending sync
 * IDs commit in IDB before PATCH and survive lost acknowledgements/reload. */
export class ComposerDraftSync {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private again = false;
  private stream?: EventSource;
  private selected = false;
  private failures = 0;
  constructor(private composer: BotComposer, private store: BotDraftStore, private allowed: () => boolean) {}
  private get url() { return `/api/bots/drafts?${new URLSearchParams({ owner: this.composer.owner, botId: this.composer.botId })}`; }
  schedule = (immediate = false) => {
    if (!this.allowed()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.sync(); }, immediate ? 0 : 250);
  };
  select(selected: boolean) {
    this.selected = selected;
    this.stream?.close(); this.stream = undefined;
    if (!selected || !this.allowed()) return;
    this.schedule(true);
    if (typeof EventSource !== 'undefined') {
      const stream = new EventSource(this.url.replace('/drafts?', '/drafts/events?'));
      this.stream = stream;
      stream.addEventListener('changed', () => this.schedule(true));
      let errors = 0;
      stream.onopen = () => { errors = 0; };
      stream.onerror = () => { if (!this.allowed() || ++errors >= 3) { stream.close(); if (this.stream === stream) this.stream = undefined; } };
    }
  }
  refresh() { this.select(this.selected); this.schedule(true); }
  private async request(method: 'GET' | 'PATCH', body?: unknown) {
    const response = await fetch(this.url, { method, credentials: 'same-origin', cache: 'no-store',
      headers: portableHeaders({ 'Content-Type': 'application/json' }), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    const result = await response.json() as { owner: string; botId: string; draft: SharedComposerDraft } & Partial<ComposerDraftReceipt>;
    if (!response.ok || result.owner !== this.composer.owner || result.botId !== this.composer.botId || !validSharedDraft(result.draft, this.composer.botId)) throw Error('Draft sync unavailable.');
    return result;
  }
  private async sync() {
    if (this.running) { this.again = true; return; }
    if (!this.allowed() || !this.composer.ready) return;
    this.running = true;
    try {
      await this.composer.flush();
      let record = await this.store.get(this.composer.owner, this.composer.botId);
      if (!record || !this.allowed()) return;
      const fingerprint = draftContentFingerprint(sharedDraftContent(record));
      if (!record.sync?.pending && (!record.sync || record.sync.base === fingerprint || record.sync.blocked === fingerprint)) {
        const observed = draftContentFingerprint(sharedDraftContent(record));
        const result = await this.request('GET');
        if (!this.allowed()) return;
        await this.store.integrateSharedDraft(this.composer.owner, this.composer.botId, result.draft, observed);
        await this.composer.refresh();
      }
      record = await this.store.prepareSharedDraft(this.composer.owner, this.composer.botId);
      const pending = record.sync?.pending;
      if (pending && this.allowed()) {
        const result = await this.request('PATCH', pending);
        if (!this.allowed()) return;
        if (result.operationId !== pending.operationId || typeof result.applied !== 'boolean') throw Error('Draft sync receipt unavailable.');
        await this.store.integrateSharedDraft(this.composer.owner, this.composer.botId, result.draft, undefined,
          { operationId: pending.operationId, applied: result.applied });
        await this.composer.refresh();
        if (draftContentFingerprint(sharedDraftContent(this.composer.record)) !== this.composer.record.sync?.base && !this.composer.record.sync?.blocked) this.again = true;
      }
      this.failures = 0;
    } catch {
      // Bounded backoff, then future focus/reconnect/edit events. No local
      // clearing, and no replacement ID after an ambiguous timeout.
      if (++this.failures <= 3 && this.allowed()) this.timer = setTimeout(() => { this.timer = undefined; void this.sync(); }, 1000 * 2 ** this.failures);
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.schedule(); }
    }
  }
}
