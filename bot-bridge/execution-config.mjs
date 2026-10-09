import { createHash } from 'node:crypto';

const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A settings selector is future intent, never evidence about an existing turn. */
export class ExecutionConfiguration {
  constructor(runtime) { this.runtime = runtime; this.store = runtime.store; }
  requested(bot, mode = 'default') { return { ...this.runtime.settings(bot), mode }; }
  capture(bot, operationId, threadId, mode, source = 'turn/start', requested = this.requested(bot, mode)) {
    const value = { id: operationId, botId: bot.id, threadId, requested, source, capturedAt: now(),
      settingsRevision: this.store.get('executionSettings', bot.id)?.revision ?? 0,
      confirmation: 'requested', turnId: null, effective: null };
    const prior = this.store.get('executionConfig', operationId);
    if (prior) {
      if (prior.botId !== bot.id || prior.threadId !== threadId || hash(prior.requested) !== hash(requested))
        throw Error('The original configuration intent changed. Nothing was submitted.');
      return prior;
    }
    return this.store.put('executionConfig', value);
  }
  bind(operationId, turnId, evidence) {
    const row = this.store.get('executionConfig', operationId);
    if (!row || typeof turnId !== 'string' || !turnId) return;
    if (row.turnId && row.turnId !== turnId) throw Error('Original configuration acknowledgement conflicts with its turn.');
    // Pinned Turn has no effective model/effort/tier fields. An ACK confirms
    // identity and requested input acceptance, not an invented effective value.
    return this.store.put('executionConfig', { ...row, turnId, confirmation: row.source.includes('queue/add-inherited')?'requested':'accepted-request', evidence, acknowledgedAt: now() });
  }
  saved(bot, operationId, patch) {
    const previous = this.store.get('executionSettings', bot.id);
    return this.store.put('executionSettings', { id: bot.id, botId: bot.id,
      revision: (previous?.revision ?? 0) + 1, operationId, requested: this.requested(bot, bot.mode),
      confirmation: 'saved-for-next-turn', changedFields: Object.keys(patch), capturedAt: now() });
  }
  turn(botId, threadId, turnId) {
    const rows = this.store.db.prepare(`SELECT json FROM records WHERE kind='executionConfig' AND bot_id=?
      AND json_extract(json,'$.threadId')=? AND json_extract(json,'$.turnId')=? ORDER BY rowid LIMIT 2`).all(botId, threadId, turnId);
    // Steering never adds a new config. Multiple original starts for one turn
    // are conflicting evidence and must remain Unknown rather than last-wins.
    return rows.length === 1 ? JSON.parse(rows[0].json) : { turnId, threadId, confirmation: 'unknown', requested: null, effective: null, source: 'missing-or-conflicting-turn-evidence' };
  }
  read(bot, params = {}) {
    if (Object.keys(params).some(k=>!['contextId','turnId','cursor','limit'].includes(k))) throw Error('Unsupported configuration read input.');
    const { contextId, turnId, cursor, limit = 20 } = params;
    const context = contextId ? this.runtime.collaboration.context(bot.id, contextId) : null;
    // A prepared room context has no native thread yet. Do not present the
    // foreground thread's settings/history as that context's evidence.
    const threadId = context ? context.threadId : bot.threadId;
    const activeTurnId = context ? context.activeTurnId : bot.activeTurnId;
    const after = this.runtime.collaboration.cursor(cursor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40) throw Error('Invalid configuration page size.');
    const rows = this.store.db.prepare(`SELECT rowid,json FROM records WHERE kind='executionConfig' AND bot_id=?
      AND json_extract(json,'$.threadId')=? AND rowid>? ORDER BY rowid LIMIT ?`).all(bot.id, threadId, after, limit + 1);
    const pending=this.store.uncertainOperations().filter(op=>op.botId===bot.id && op.method==='bots.update' && ['model','effort','serviceTier','mode'].some(k=>Object.hasOwn(op.params ?? {},k)));
    return { version: 1, contextId: context?.id ?? `foreground:${bot.id}`, threadId,
      active: activeTurnId ? this.turn(bot.id, threadId, activeTurnId) : null,
      selected: turnId ? this.turn(bot.id, threadId, turnId) : null,
      future: { ...(this.store.get('executionSettings', bot.id) ?? { revision: 0, confirmation: 'unknown' }),
        requested: this.requested(bot, context ? 'default' : bot.mode ?? 'default'), executionMode: context ? 'collaboration' : 'foreground',
        ...(pending.length ? {confirmation:pending.some(op=>op.status==='dispatching')?'saving':'unconfirmed',pendingOperationIds:pending.map(op=>op.id)} : {}),
        planIntent: context ? 'not-applicable' : bot.mode === 'plan' ? 'foreground-next-human-start' : 'default' },
      history: rows.slice(0, limit).map(row => JSON.parse(row.json)),
      nextCursor: rows.length > limit ? String(rows[limit - 1].rowid) : null };
  }
  queueIntent(bot, value) {
    if (value === undefined) return null;
    if (!value || typeof value!=='object' || Object.keys(value).some(k=>!['settingsRevision','model','effort','serviceTier','mode'].includes(k)) ||
      !Number.isSafeInteger(value.settingsRevision) || value.settingsRevision!==this.store.get('executionSettings',bot.id)?.revision ||
      hash({model:value.model,effort:value.effort,serviceTier:value.serviceTier,mode:value.mode})!==hash(this.requested(bot,bot.mode ?? 'default')))
      throw Error('Queued configuration must bind the exact confirmed next-turn settings revision. Your input was not submitted.');
    // Queue/add has no per-message model/effort/tier fields in the pinned API.
    // Native auto-advance races with later settings saves: do not claim a
    // turn-bound setting that cannot be enforced. Keep the original local row.
    return {requested:{model:value.model,effort:value.effort,serviceTier:value.serviceTier,mode:value.mode},settingsRevision:value.settingsRevision,
      confirmation:'pending-unsupported',reason:'Native queue admission cannot bind this per-message configuration. Keep/edit this original row; it was not sent.'};
  }
}
