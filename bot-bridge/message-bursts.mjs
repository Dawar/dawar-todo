import { randomUUID, createHash } from 'node:crypto';

const now = () => new Date().toISOString();
const open = b => !b.supersededBy && ['pending', 'paused', 'dispatching', 'uncertain', 'failed'].includes(b.state);
const message = m => { const { id, botId, text, attachmentIds, createdAt, state, batchId, turnId } = m;
  return { id, botId, text, attachmentIds, createdAt, state, batchId, turnId }; };
const batch = b => b && ({ id: b.id, botId: b.botId, state: b.state, messageIds: b.messageIds, dueAt: b.dueAt,
  operationId: b.id, turnId: b.turnId ?? null, error: b.error ?? null });

// A debounce of accepted human sends, not another execution engine. Only the
// existing runtime.send + operation receipt may cross the native boundary.
export class MessageBursts {
  constructor(runtime) { this.runtime = runtime; this.store = runtime.store; this.leases = new Map(); this.timers = new Map(); }
  batches(botId, history = false) {
    return this.store.db.prepare(`SELECT json FROM records WHERE kind='messageBurst' AND bot_id=? AND
      (json_extract(json,'$.state') != 'sent' OR (? AND rowid IN (SELECT rowid FROM records WHERE kind='messageBurst' AND bot_id=? ORDER BY rowid DESC LIMIT 50)))
      AND json_extract(json,'$.supersededBy') IS NULL ORDER BY json_extract(json,'$.sequence'),rowid`)
      .all(botId, history ? 1 : 0, botId).map(r => JSON.parse(r.json));
  }
  messages(botId, history = false) {
    return this.store.db.prepare(`SELECT json FROM records WHERE kind='burstMessage' AND bot_id=? AND
      (json_extract(json,'$.state') != 'sent' OR (? AND rowid IN (SELECT rowid FROM records WHERE kind='burstMessage' AND bot_id=? ORDER BY rowid DESC LIMIT 50))) ORDER BY rowid`)
      .all(botId, history ? 1 : 0, botId).map(r => JSON.parse(r.json));
  }
  read(bot) {
    const batches = this.batches(bot.id, true), active = batches.filter(open);
    const messages = this.messages(bot.id, true);
    const recent = []; let recentBytes = 0;
    for (const m of messages.filter(m => m.state === 'sent').sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
      const size = Buffer.byteLength(JSON.stringify(message(m))); if (recentBytes + size > 2 * 1024 * 1024) break;
      recent.push(m); recentBytes += size;
    }
    return { messages: [...messages.filter(m => m.state !== 'sent'), ...recent].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence).map(message),
      burst: batch(active[0] ?? batches.at(-1) ?? null), batches: [...active, ...batches.filter(b => b.state === 'sent').slice(-50)].map(batch) };
  }
  publish(botId) { this.runtime.emitEvent('burst', this.read(this.store.bot(botId)), botId); this.store.afterCommit(() => this.arm(botId)); }
  typing(bot, p) {
    if (typeof p.clientId !== 'string' || !/^[a-zA-Z0-9:_-]{1,120}$/.test(p.clientId) || typeof p.typing !== 'boolean') throw new Error('Invalid typing lease.');
    const first = this.batches(bot.id).find(b => b.state === 'pending');
    if (!first || first.immediate) return {};
    const key = `${bot.id}:${p.clientId}`;
    for (const [k, value] of this.leases) if (value.until <= Date.now()) this.leases.delete(k);
    if (!p.typing) this.leases.delete(key);
    else if (this.leases.size < 1000 || this.leases.has(key)) this.leases.set(key, { batchId: first.id,
      until: Math.min(Date.now() + 10000, Date.parse(first.lastSubmitAt) + 60000) });
    this.arm(bot.id); return {};
  }
  async prepare(bot, p, id) {
    if (!this.runtime.primary.single(bot)) throw new Error('Message bursts require single-thread execution. Your draft was retained.');
    if (bot.archived || bot.archiving) throw new Error('Restore this bot before submitting.');
    const input = await this.runtime.messageInput(bot, p);
    return () => {
      const pending = this.messages(bot.id);
      if (pending.length >= 200 || pending.reduce((n, m) => n + Buffer.byteLength(m.text), 0) + Buffer.byteLength(String(p.text ?? '')) > 1024 * 1024)
        throw new Error('Resolve or send retained messages before adding more (200 messages / 1 MB of pending text). Your draft was not submitted.');
      const attachments = [...(p.attachments ?? [])];
      const images = ids => ids.filter(a => this.runtime.owned('attachment', a, bot.id).mimeType.startsWith('image/')).length;
      let current = this.batches(bot.id).filter(b => ['pending', 'paused'].includes(b.state)).at(-1);
      const members = current?.messageIds.map(mid => this.store.get('burstMessage', mid)) ?? [];
      const allFiles = [...members.flatMap(m => m.attachmentIds), ...attachments];
      if (current && (allFiles.length > 12 || images(allFiles) > 6 || members.reduce((n, m) => n + m.text.length, 0) + String(p.text ?? '').length > 190000)) current = null;
      if (!current) current = { id: `burst:${randomUUID()}`, botId: bot.id, threadId: bot.threadId, messageIds: [], createdAt: now(), sequence: Number(this.store.db.prepare("SELECT COALESCE(MAX(json_extract(json,'$.sequence')),0)+1 n FROM records WHERE kind='messageBurst' AND bot_id=?").get(bot.id).n) };
      // Explicit Send resumes retained pending batches; Queue/work.resume do not.
      for (const old of this.batches(bot.id)) if (old.state === 'paused') this.store.put('messageBurst', { ...old, state: 'pending', dueAt: new Date(Date.now() + (bot.burstQuietSeconds ?? 8) * 1000).toISOString() });
      const m = this.store.put('burstMessage', { id, botId: bot.id, text: String(p.text ?? '').trim(), input,
        attachmentIds: attachments, createdAt: now(), sequence: pending.length, state: 'pending', batchId: current.id, turnId: null });
      current = this.store.put('messageBurst', { ...current, state: 'pending', messageIds: [...current.messageIds, id],
        lastSubmitAt: now(), dueAt: new Date(Date.now() + (bot.burstQuietSeconds ?? 8) * 1000).toISOString(), immediate: bot.burstQuietSeconds === 0 });
      this.publish(bot.id);
      return { message: message(m), burst: batch(current) };
    };
  }
  pause(botId) {
    for (const b of this.batches(botId)) if (b.state === 'pending') this.store.put('messageBurst', { ...b, state: 'paused', dueAt: null });
    this.publish(botId); return this.read(this.store.bot(botId));
  }
  start(bot, retryId) {
    if (this.batches(bot.id).some(b => !b.supersededBy && ['dispatching', 'uncertain'].includes(b.state))) throw new Error('Reconcile the original send before starting another batch; no message was repeated.');
    for (const old of this.batches(bot.id).filter(b => b.state === 'failed' && !b.supersededBy)) {
      const op = this.store.operation(old.id);
      if (op?.outcome !== 'rejected') throw new Error('The retained send has no definite rejection. Its original ID must reconcile.');
      const nextId = `burst:${createHash('sha256').update(`${old.id}:${retryId}`).digest('hex')}`;
      this.store.put('messageBurst', { ...old, supersededBy: nextId });
      this.store.put('messageBurst', { ...old, id: nextId, state: 'pending', error: null, dueAt: now(), immediate: true, supersedes: old.id, supersededBy: null });
      for (const id of old.messageIds) this.store.put('burstMessage', { ...this.store.get('burstMessage', id), state: 'pending', batchId: nextId });
    }
    for (const b of this.batches(bot.id)) if (['pending', 'paused'].includes(b.state)) this.store.put('messageBurst', { ...b, state: 'pending', dueAt: now(), immediate: true });
    this.publish(bot.id); return this.read(bot);
  }
  settle(b, result) {
    const turnId = result?.turn?.id ?? result?.turnId;
    if (typeof turnId !== 'string' || !turnId) return false;
    this.store.transaction(() => {
      this.store.put('messageBurst', { ...this.store.get('messageBurst', b.id), state: 'sent', turnId, error: null, dueAt: null });
      for (const id of b.messageIds) this.store.put('burstMessage', { ...this.store.get('burstMessage', id), state: 'sent', turnId });
      this.publish(b.botId);
    }); return true;
  }
  async dispatch(bot, b) {
    const messages = b.messageIds.map(id => this.store.get('burstMessage', id));
    const params = { text: messages.map(m => m.text).join('\n\n'), attachments: messages.flatMap(m => m.attachmentIds) };
    // Use the ordinary send fingerprint so generic exact-ID reconciliation is
    // identical after process loss. Body/ordering freeze with this reservation.
    const fingerprint = createHash('sha256').update(JSON.stringify({ method: 'turn.send', botId: bot.id, params })).digest('hex');
    const data = { method: 'turn.send', botId: bot.id, params, createdAt: now(), burstId: b.id };
    this.store.transaction(() => {
      this.store.put('messageBurst', { ...b, state: 'dispatching', params, dueAt: null });
      for (const m of messages) this.store.put('burstMessage', { ...m, state: 'dispatching' });
      this.store.put('queuedAttachments', { id: b.id, botId: bot.id, attachmentIds: params.attachments, immutable: true });
      this.store.saveOperation(b.id, fingerprint, 'dispatching', data);
      this.publish(bot.id);
    });
    const attempt = { started: false, rejected: false };
    try {
      const result = await this.runtime.send(bot, params, b.id, null, attempt, false, null, messages.flatMap(m => m.input));
      this.store.transaction(() => { this.store.saveOperation(b.id, fingerprint, 'done', { ...data, result }); this.settle(b, result); });
    } catch (error) {
      if (this.store.operation(b.id)?.status === 'done') { this.settle(b, this.store.operation(b.id).result); return; }
      const uncertain = attempt.started && !attempt.rejected;
      this.store.transaction(() => {
        this.store.saveOperation(b.id, fingerprint, uncertain ? 'uncertain' : 'failed', { ...data, error: error.message, outcome: uncertain ? 'uncertain' : 'rejected' });
        this.store.put('messageBurst', { ...this.store.get('messageBurst', b.id), state: uncertain ? 'uncertain' : 'failed', error: error.message });
        for (const m of messages) this.store.put('burstMessage', { ...this.store.get('burstMessage', m.id), state: uncertain ? 'uncertain' : 'failed' });
        this.publish(bot.id);
      });
    }
  }
  arm(botId) {
    clearTimeout(this.timers.get(botId)); this.timers.delete(botId);
    if (!this.runtime.ready) return;
    const first = this.batches(botId).find(open);
    if (!first || first.state !== 'pending') return;
    const lease = first.immediate ? 0 : Math.max(0, ...[...this.leases.values()].filter(l => l.batchId === first.id).map(l => l.until));
    const due = Math.max(Date.parse(first.dueAt), lease);
    const timer = setTimeout(() => { this.timers.delete(botId); void this.pump(botId, false).catch(error => this.runtime.emit('fault', error)); }, Math.max(1, Math.min(60000, due - Date.now())));
    timer.unref?.(); this.timers.set(botId, timer);
  }
  async pump(botId, recovery) {
    if (!this.runtime.ready) return;
    await this.runtime.lock(botId, async () => {
      const bot = this.store.bot(botId);
      if (bot.archived || bot.archiving) return;
      const first = this.batches(bot.id).find(open);
      if (!first) return;
      if (['dispatching', 'uncertain'].includes(first.state)) {
        if (!recovery || Date.parse(first.reconcileAfter ?? '') > Date.now()) return;
        this.store.put('messageBurst', { ...first, reconcileAfter: new Date(Date.now() + 30000).toISOString() });
        const op = this.store.operation(first.id);
        const result = op?.status === 'done' ? op.result : op && await this.runtime.reconcileOperation(op);
        if (result) this.settle(first, result);
        return;
      }
      if (first.state !== 'pending' || this.runtime.activityUnresolved(bot.id) || this.store.list('pending', bot.id).length) return;
      const lease = first.immediate ? 0 : Math.max(0, ...[...this.leases.values()].filter(l => l.batchId === first.id).map(l => l.until));
      if (Date.now() < Math.max(Date.parse(first.dueAt), lease)) { this.arm(botId); return; }
      await this.dispatch(bot, first);
    });
  }
  async tick() {
    const candidates = this.store.bots().filter(bot => !bot.archived && !bot.archiving && !this.runtime.locks.has(bot.id))
      .map(bot => ({ bot, first: this.batches(bot.id).find(open) })).filter(row => row.first);
    // Already-confirmed receipts settle locally, independent of native read
    // backoff/budget. Other recovery candidates rotate only after becoming due.
    for (const { bot, first } of candidates) if (['dispatching', 'uncertain'].includes(first.state) && this.store.operation(first.id)?.status === 'done')
      await this.runtime.lock(bot.id, () => this.settle(first, this.store.operation(first.id).result)).catch(error => this.runtime.emit('fault', error));
    const due = candidates.filter(({ first }) => ['dispatching', 'uncertain'].includes(first.state) && this.store.operation(first.id)?.status !== 'done' &&
      !(Date.parse(first.reconcileAfter ?? '') > Date.now())).sort((a, b) => a.first.id < b.first.id ? -1 : a.first.id > b.first.id ? 1 : 0);
    const split = due.findIndex(({ first }) => first.id > (this.recoveryAfter ?? ''));
    const ordered = split < 0 ? due : [...due.slice(split), ...due.slice(0, split)];
    for (const { bot, first } of ordered.slice(0, 2)) {
      this.recoveryAfter = first.id;
      await this.pump(bot.id, true).catch(error => this.runtime.emit('fault', error));
    }
    for (const { bot } of candidates) if (!['dispatching', 'uncertain'].includes(this.batches(bot.id).find(open)?.state))
      await this.pump(bot.id, false).catch(error => this.runtime.emit('fault', error));
  }
}
