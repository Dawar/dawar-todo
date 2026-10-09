import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { profileContext } from './profiles.mjs';
import { MEMORY_TRIGGER, MEMORY_VERSION, profileFile, prepareMemory, verifyMemory, commitMemory, memoryOperation, memoryReceipt, memoryId } from './memory-files.mjs';
import { observedActiveTurn } from './turn-state.mjs';

// Reconcile this already-staged owner schedule; no extra timer/nightly schedule.
export const MEMORY_NIGHTLY_SCHEDULE_ID = 'tool:exec-fe42a6bd-08e8-4717-8836-194c9d51e5a1';
export const MEMORY_TOOL = {
  name: 'bots_memory_maintenance',
  description: 'Own bot file-memory maintenance, not native history compaction. inspect is metadata only. prepare returns the original source-hash operation and private archive/candidate paths; read the full archive, write candidate.md (0600), preserve current constraints/approvals/unfinished work/uncertainty IDs/references. verify binds your semantic review and exact candidate SHA-256. commit atomically replaces only unchanged source; retry SAME ID/hash after unknown ACK. Stop/human work take priority. Never echo or publish archives. nightlyCheck is restricted to the installed single owner-approved nightly occurrence.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['operation'], properties: {
    operation: { type: 'string', enum: ['inspect', 'prepare', 'verify', 'commit', 'nightlyCheck'] },
    operationId: { type: 'string' }, candidateHash: { type: 'string' },
    review: { type: 'object', additionalProperties: false, required: ['constraints', 'approvals', 'unfinishedWork', 'uncertainOperations', 'references'], properties:
      Object.fromEntries(['constraints', 'approvals', 'unfinishedWork', 'uncertainOperations', 'references'].map(k => [k, { type: 'string', maxLength: 800 }])) },
  } },
};
const now = () => new Date().toISOString();
export class BotMemoryMaintenance {
  constructor(runtime) { this.runtime = runtime; this.store = runtime.store; this.pending = new Map(); this.running = false; this.after = null; this.scanAfter = new Map(); }
  setStatus(botId, status) {
    const bot = this.store.bot(botId), previous = bot.profilePreparation ?? null;
    const next = status ? { ...status, message: String(status.message).slice(0, 1000), file: String(status.file).slice(0, 80), botId, threadId: bot.threadId } : null;
    // Stable content prevents a routine scan from churning bot recency/events.
    if (JSON.stringify(previous && { ...previous, observedAt: undefined }) !== JSON.stringify(next))
      this.runtime.saveBot(bot, { profilePreparation: next ? { ...next, observedAt: now() } : null });
  }
  async context(bot, team = null, maintenanceId = null, onMemoryContent = () => {}) {
    let memoryState;
    try {
      const matches = () => { const current = this.store.bot(bot.id); return current.threadId === bot.threadId && current.cwd === bot.cwd && !current.deletedAt; };
      if (!matches()) throw Error('Bot workspace/thread changed before profile preparation.');
      const context = await profileContext(bot, team, { maintenanceId, onMemoryContent, onMemoryState: state => { memoryState = state; } });
      if (!matches()) throw Error('Bot workspace/thread changed during profile preparation.');
      if (memoryState !== undefined) this.setStatus(bot.id, memoryState);
      return context;
    } catch (error) {
      this.setStatus(bot.id, memoryState?.state === 'blocked' ? memoryState : { state: 'blocked', file: 'profiles',
        message: `Profile preparation failed: ${error.message} Your message and files are retained; this is separate from runtime connectivity.` });
      throw Object.assign(error, { outcome: 'rejected' });
    }
  }
  idle(bot, except = null) {
    const runtime = this.runtime;
    return !bot.archived && !bot.archiving && !bot.deletedAt && !!bot.threadId && runtime.primary.single(bot) &&
      !bot.queuePaused && !bot.managerPaused && !bot.activeTurnId && !runtime.activityUnresolved(bot.id) &&
      !this.store.list('pending', bot.id).length && !runtime.scheduledUncertain(bot.id) && !runtime.plans.blocked(bot.id) &&
      !this.store.list('promptQueue', bot.id).some(row => !['consumed', 'deleted', 'failed', 'cancelled'].includes(row.state)) &&
      !this.store.list('primaryInbox', bot.id).some(row => row.id !== except && !row.terminalStatus && !['cancelled', 'failed'].includes(row.state)) &&
      !this.store.list('run', bot.id).some(row => ['queued', 'starting', 'running', 'uncertain'].includes(row.status)) &&
      !this.store.list('executionStop', bot.id).some(row => row.state !== 'done') &&
      !this.store.list('planExecution', bot.id).some(row => ['preparing', 'dispatching', 'queued', 'running', 'uncertain'].includes(row.state)) &&
      !this.store.list('collaborationContext',bot.id).some(row=>row.activeTurnId||row.status==='unknown'||['dispatching','uncertain'].includes(row.provisioning)) &&
      !runtime.collaboration.deliveries(bot.id).length &&
      !this.store.list('collaborationPending',bot.id).length &&
      !this.store.list('collaborationResource',bot.id).some(row=>row.state!=='released') &&
      !this.store.list('collaborationGoal',bot.id).some(row=>row.goal?.status==='active') &&
      !this.store.list('runLane', bot.id).some(row => runtime.runs.unfinished(row)) &&
      !this.store.list('managerTask', bot.id).some(row => !['completed', 'failed', 'cancelled'].includes(row.state)) &&
      this.store.get('nativeGoal', bot.id)?.goal?.status !== 'active' &&
      !this.store.uncertainOperations().some(row => row.botId === bot.id && ['dispatching', 'uncertain'].includes(row.status)) &&
      !runtime.bursts.batches(bot.id).length;
  }
  owned(bot, origin) {
    const current = this.store.bot(bot.id);
    if (current.archived || current.archiving || !current.threadId || current.threadId !== bot.threadId || current.cwd !== bot.cwd ||
        origin?.threadId && origin.threadId !== bot.threadId || origin?.runId ||
        !['native-tool', 'authenticated-bot-mcp'].includes(origin?.authority)) throw Error('Memory tools belong to this named bot and its current primary thread.');
    if (origin.authority === 'native-tool' && (!origin.turnId || current.activeTurnId !== origin.turnId || this.runtime.activityUnresolved(bot.id)))
      throw Error('Memory mutation requires the current native turn.');
    return current;
  }
  async inspect(bot) {
    const source = await profileFile(bot, 'MEMORY.md');
    return { botId: bot.id, threadId: bot.threadId, bytes: source.size, sourceHash: source.hash, thresholdBytes: MEMORY_TRIGGER, version: MEMORY_VERSION,
      maintenanceNeeded: source.size >= MEMORY_TRIGGER, status: this.store.bot(bot.id).profilePreparation ?? null };
  }
  async tool(bot, args, origin) {
    bot = this.owned(bot, origin);
    const allowed = { inspect: ['operation', 'operationId'], prepare: ['operation', 'operationId'], verify: ['operation', 'operationId', 'candidateHash', 'review'], commit: ['operation', 'operationId', 'candidateHash'], nightlyCheck: ['operation'] }[args?.operation];
    if (!allowed || !args || Array.isArray(args) || Object.keys(args).some(k => !allowed.includes(k))) throw Error('Use only the declared own-memory operation fields.');
    if (args?.operation === 'inspect') return args.operationId ? this.receipt(bot, args.operationId) : this.inspect(bot);
    if (args?.operation === 'nightlyCheck') return this.nightlyCheck(bot, origin);
    if (!observedActiveTurn(this.runtime, bot.id, bot.activeTurnId) || this.runtime.activityUnresolved(bot.id)) throw Error('Semantic memory maintenance requires this bot\'s current observed native turn.');
    if (bot.queuePaused || bot.managerPaused || this.store.list('pending', bot.id).length) throw Error('Stop or a current question holds memory maintenance.');
    if (this.pending.has(bot.id)) throw Error('Memory maintenance is already preparing. Reconcile its original operation.');
    const token = { threadId: bot.threadId, cwd: bot.cwd, turnId: bot.activeTurnId, pauseRevision: bot.queuePauseRevision ?? 0,
      generation: this.store.get('botActivity', bot.id)?.generation ?? 0 };
    const unchanged = () => {
      const current = this.store.bot(bot.id);
      return current.threadId === token.threadId && current.cwd === token.cwd && current.activeTurnId === token.turnId &&
        (current.queuePauseRevision ?? 0) === token.pauseRevision && (this.store.get('botActivity', bot.id)?.generation ?? 0) === token.generation &&
        !current.archived && !current.archiving && !current.queuePaused && !current.managerPaused && !this.store.list('pending', bot.id).length;
    };
    const controller = new AbortController(); this.pending.set(bot.id, controller);
    try {
      let result;
      if (args.operation === 'prepare') result = args.operationId ? await this.receipt(bot, args.operationId) : await prepareMemory(bot, controller.signal);
      else if (args.operation === 'verify') result = await verifyMemory(bot, args.operationId, args.candidateHash, args.review,
        { authority: origin.authority, botId: bot.id, threadId: bot.threadId, turnId: bot.activeTurnId, source: 'own-model-semantic-review' });
      else if (args.operation === 'commit') result = await commitMemory(bot, args.operationId, args.candidateHash, () => !controller.signal.aborted && unchanged(), controller.signal);
      else throw Error('Unknown memory operation.');
      // A receipt after completed replacement remains recoverable even if new
      // human work arrived while the reply was in flight; never replay it.
      if (result.state === 'done') {
        this.store.put('botMemory', { ...this.store.get('botMemory', bot.id), id: bot.id, botId: bot.id, operationId: result.operationId, state: 'done', receipt: result });
        const current = await profileFile(this.store.bot(bot.id), 'MEMORY.md');
        if (current.hash === result.resultHash) this.setStatus(bot.id, null);
      }
      return result;
    } finally { this.pending.delete(bot.id); }
  }
  async nightlyCheck(bot, origin) {
    if (!observedActiveTurn(this.runtime, bot.id, bot.activeTurnId) || this.runtime.activityUnresolved(bot.id)) throw Error('Nightly inspection requires its current observed native occurrence.');
    const active = this.runtime.scheduledContext(bot.id, origin.turnId ?? bot.activeTurnId), run = active && this.store.get('run', active.runId);
    const schedule = this.store.get('schedule', MEMORY_NIGHTLY_SCHEDULE_ID);
    if (!run || run.scheduleId !== MEMORY_NIGHTLY_SCHEDULE_ID || !schedule?.enabled || schedule.botId !== bot.id ||
        schedule.cron !== '30 3 * * *' || schedule.timeZone !== 'America/Toronto') throw Error('Nightly memory inspection requires the installed original owner-approved schedule occurrence.');
    const id = `memory-nightly:${run.id}`, previous = this.store.get('memoryNightly', id);
    if (previous?.acceptedAt) return { requested: true, occurrenceId: run.id, repeat: true, idleChecksPending: true };
    // Only a due-check marker: no other bot is loaded/steered or inspected under
    // this tool's lock. The rotating metadata scanner handles their own idle gates.
    this.store.transaction(() => {
      for (const target of this.store.bots()) if (!target.archived && !target.deletedAt) this.store.put('botMemoryCheck', { id: target.id, botId: target.id, due: true, occurrenceId: run.id });
      this.store.put('memoryNightly', { id, botId: bot.id, runId: run.id, acceptedAt: now() });
    });
    this.scanAfter.clear(); return { requested: true, occurrenceId: run.id, idleChecksPending: true };
  }
  async tick() {
    if (this.running || !this.runtime.ready) return;
    this.running = true;
    try {
      const candidates = this.store.bots().filter(bot => !this.runtime.locks.has(bot.id) && !this.pending.has(bot.id) &&
        !(this.scanAfter.get(bot.id) > Date.now()) && this.idle(bot)).sort((a, b) => a.id.localeCompare(b.id));
      const bot = candidates.find(row => row.id > (this.after ?? '')) ?? candidates[0];
      if (!bot) return;
      this.after = bot.id; this.scanAfter.set(bot.id, Date.now() + 5 * 60_000);
      const marker = this.store.get('botMemoryCheck', bot.id);
      try {
        const stat = await lstat(join(bot.cwd, 'MEMORY.md'));
        if (stat.size < MEMORY_TRIGGER) {
          if (this.store.bot(bot.id).profilePreparation) await this.context(this.store.bot(bot.id));
          if (marker?.due) this.store.put('botMemoryCheck', { ...marker, due: false }); return;
        }
        const controller = new AbortController(); this.pending.set(bot.id, controller);
        try {
          // Bounded current metadata, never history/semantics under admission.
          const generation = this.store.get('botActivity', bot.id)?.generation ?? 0;
          const evidence = await Promise.all([
            this.runtime.codex.call('thread/read', { threadId: bot.threadId, includeTurns: false }, 3000),
            this.runtime.codex.call('thread/goal/get', { threadId: bot.threadId }, 3000),
          ]).catch(() => null);
          controller.signal.throwIfAborted();
          if (!evidence) { this.setStatus(bot.id, { state: 'warning', file: 'MEMORY.md', bytes: stat.size,
            message: 'Memory maintenance is deferred until current native idle/goal state can be confirmed. Current memory and input are retained.' }); return; }
          const [observed, goal] = evidence;
          if (observed?.thread?.id !== bot.threadId || observed.thread.status?.type !== 'idle' || !goal || !Object.hasOwn(goal, 'goal') ||
              goal.goal && (goal.goal.threadId !== bot.threadId || !['paused', 'blocked', 'complete', 'usageLimited', 'budgetLimited'].includes(goal.goal.status)) ||
              (this.store.get('botActivity', bot.id)?.generation ?? 0) !== generation || !this.idle(this.store.bot(bot.id)) || this.runtime.locks.has(bot.id)) return;
          const receipt = await prepareMemory(bot, controller.signal), previous = this.store.get('botMemory', bot.id);
          if (!this.idle(this.store.bot(bot.id)) || this.runtime.locks.has(bot.id) || controller.signal.aborted) return;
          const intakeId = `maintenance:${receipt.operationId}`;
          // A completed/failed native attempt is not automatically re-created.
          const original = this.store.get('primaryInbox', intakeId);
          if (original) {
            if (original.terminalStatus && receipt.state !== 'done') this.setStatus(bot.id, { state: 'warning', file: 'MEMORY.md', bytes: receipt.sourceBytes,
              sourceHash: receipt.sourceHash, operationId: receipt.operationId, message: 'Memory maintenance needs a current semantic review. The original archive, candidate and receipt are retained.' });
            return;
          }
          if (previous?.operationId === receipt.operationId && previous.state === 'done') return;
          this.runtime.primary.accept(bot, intakeId, { kind: 'memory-maintenance', sourceId: receipt.operationId, summary: 'File memory maintenance',
            text: `Approved file-memory maintenance for this bot only. Original operation ${receipt.operationId}; source SHA-256 ${receipt.sourceHash}; ${receipt.sourceBytes} UTF-8 bytes. Read current mandatory profiles and the FULL private archive ${receipt.archive}. Write a smaller, focused # Memory candidate at ${receipt.candidate} (0600), with the exact archive reference. Preserve current constraints/preferences, approvals, unfinished scopes, uncertain action IDs and evidence pointers. Verify with bots_memory_maintenance using candidateHash and the five explicit review categories, then commit the SAME operation/hash. Do not overwrite MEMORY.md directly, compact native history, resume Goals, change settings or perform unrelated work. Human Send/Stop/questions take priority; if steered, retain the candidate and return to the human's work. Quiet unchanged; after confirmed compaction report before/after bytes and archive only. Source mismatch or uncertain ACK requires original-ID reconciliation, not another intake.` });
          this.store.put('botMemory', { id: bot.id, botId: bot.id, operationId: receipt.operationId, sourceHash: receipt.sourceHash, state: 'queued', intakeId });
          this.setStatus(bot.id, { state: 'warning', file: 'MEMORY.md', bytes: receipt.sourceBytes, sourceHash: receipt.sourceHash, operationId: receipt.operationId,
            message: 'Memory maintenance is waiting for idle. Current files and messages are retained.' });
          if (marker?.due) this.store.put('botMemoryCheck', { ...marker, due: false });
        } finally { this.pending.delete(bot.id); }
      } catch (error) {
        if (/Human input\/activity takes priority/.test(error.message)) return;
        try { await this.context(this.store.bot(bot.id)); } catch { return; }
        this.setStatus(bot.id, { state: 'warning', file: 'MEMORY.md', message: `Memory maintenance needs inspection: ${error.message} Current memory/input were retained.` });
      }
    } finally { this.running = false; }
  }
  eligible(bot, item) {
    return item.kind !== 'memory-maintenance' || this.idle(bot, item.id);
  }
  async preparation(bot, item, team) {
    if (item.kind !== 'memory-maintenance') { await this.context(bot, team); return this.fallbackReference(bot, item.text); }
    if (!this.eligible(bot, item)) return null;
    const source = await profileFile(bot, 'MEMORY.md');
    if (memoryId(bot, source, source.workspaceIdentity) !== item.sourceId) {
      const current = this.store.get('primaryInbox', item.id);
      if (current?.state === 'queued') this.store.put('primaryInbox', { ...current, state: 'failed', error: 'Memory source version changed before native submission. Original receipt/files remain; new facts require a fresh review.' });
      return null;
    }
    await this.context(bot, team, item.sourceId);
    // Queue/add has no additionalContext. Keep the actual task small; current
    // mandatory files are read through ordinary tools under the permanent
    // profile policy, rather than duplicating their bodies into chat history.
    const text = `${item.text}\n\nCurrent profile preparation validated for this maintenance only: ${JSON.stringify({ botId: bot.id, threadId: bot.threadId, workspace: bot.cwd, teamId: team?.id ?? null, teamWorkspace: team?.workspace ?? null })}. Read all current mandatory profiles and current team references through ordinary tools, using the verified full source archive for MEMORY. This is NOT an ordinary compact fallback or proof of current constraints until you have read and reviewed the full source. No other work or permission expansion.`;
    if (text.length > 190000) throw Error('Maintenance reference exceeds its input limit. Nothing was submitted.');
    return this.eligible(this.store.bot(bot.id), item) ? text : null;
  }
  fallbackReference(bot, text) {
    const state = this.store.bot(bot.id).profilePreparation;
    if (state?.state !== 'fallback') return text;
    const value = `${text}\n\n[Current MEMORY recovery reference for this bot: read ${join(bot.cwd, '.memory-maintenance', state.operationId, 'candidate.md')} before work. It was semantically reviewed against current full source SHA-256 ${state.sourceHash}; the full private source.md archive is alongside it. Other mandatory profiles remain required. This reference is prior application context, not new task permissions.]`;
    if (value.length > 200000) throw Object.assign(Error('Message plus current memory recovery reference is too long. Your original text/files are retained.'), { outcome: 'rejected' });
    return value;
  }
  async queuedInput(bot, input) {
    await this.context(bot);
    const reference = this.fallbackReference(bot, '');
    if (!reference) return input;
    if (input.reduce((n, item) => n + (item.type === 'text' ? item.text.length : 0), reference.length) > 200000)
      throw Object.assign(Error('Queued input plus memory recovery context exceeds its limit. Original input/files remain queued.'), { outcome: 'rejected' });
    return [...input, { type: 'text', text: reference, text_elements: [] }];
  }
  cancelPreparation(botId) { this.pending.get(botId)?.abort(new Error('Human input/activity takes priority. Original memory files are retained.')); }
  async receipt(bot, id) { return memoryOperation(bot, id, async ({ receipt }) => { if (!receipt) throw Error('Original memory receipt is missing.'); return memoryReceipt(receipt); }); }
}
