// @ts-check
// Read-only state invariant checker for the hub store (control.sqlite) and the
// node stores (native-control.sqlite, node-journal.sqlite). It never writes:
// callers pass connections opened read-only (openReadOnly below). Every query
// is bounded by a row limit, and the whole scan by a deadline, so it can run
// beside live traffic. Findings name the bot, the record and a next step; the
// checker itself repairs nothing.

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

/** @typedef {'high'|'medium'|'low'} Severity */
/**
 * @typedef {object} Finding
 * @property {string} key Stable identity: the same stuck record gives the same key on every run.
 * @property {string} check
 * @property {Severity} severity
 * @property {'hub'|'node'|'journal'} store
 * @property {string|null} botId
 * @property {string|null} botName
 * @property {{kind:string,id:string}} record
 * @property {string} message
 * @property {string} suggestedAction
 * @property {number|null} ageMs
 */
/**
 * @typedef {object} Report
 * @property {1} version
 * @property {string} checkedAt
 * @property {number} durationMs
 * @property {boolean} truncated
 * @property {{high:number,medium:number,low:number}} counts
 * @property {Finding[]} findings
 * @property {string[]} errors
 */
/**
 * @typedef {object} Options
 * @property {number} [now] Epoch milliseconds the ages are measured against.
 * @property {string|null} [currentEpoch] The live bridge process epoch. Unknown (null) in an offline copy.
 * @property {number} [staleMs] Accepted/uncertain/in-flight rows older than this are reported (medium).
 * @property {number} [criticalMs] ...and older than this are high.
 * @property {number} [activityAttemptBudget] Unresolved activity past this many reconciliation attempts.
 * @property {number} [mailboxStaleMs] Hub mailbox rows non-terminal for longer than this.
 * @property {number} [recoveryStaleMs] Offline only: a native-retry row untouched for this long is treated as orphaned.
 * @property {number} [initiativeSkipMs] Initiative bots skipped for longer than this.
 * @property {number} [rowLimit] Rows read per check.
 * @property {number} [maxFindings]
 * @property {number} [budgetMs] Wall-clock budget for one scan.
 * @property {(botId:string)=>boolean|null} [idleProbe] Live idle predicate (true idle, false busy, null unknown).
 */

const HOUR = 3600000, DAY = 24 * HOUR;
export const DEFAULTS = Object.freeze({
  staleMs: 6 * HOUR, criticalMs: DAY, activityAttemptBudget: 12, mailboxStaleMs: HOUR,
  recoveryStaleMs: 30 * 60000, initiativeSkipMs: DAY, rowLimit: 500, maxFindings: 200, budgetMs: 2000,
});
/** Every promptQueue state any writer produces. Anything else is unknown. */
export const QUEUE_STATES = new Set(['queued', 'staged', 'dispatching', 'uncertain', 'native-queued', 'delivered', 'merged', 'consumed', 'deleted', 'failed', 'cancelled']);
/** Queue items that are finished history (the shared idle predicate's set). */
export const FINISHED_QUEUE_STATES = new Set(['consumed', 'deleted', 'failed', 'cancelled', 'delivered', 'merged']);
const IN_FLIGHT_QUEUE_STATES = ['dispatching', 'uncertain', 'native-queued'];
export const INBOX_STATES = new Set(['queued', 'dispatching', 'accepted', 'uncertain', 'cancelled', 'failed']);
export const MAILBOX_STATES = new Set(['queued', 'received', 'native-accepted', 'running', 'terminal', 'unknown']);
export const JOURNAL_STATES = new Set(['received', 'dispatching', 'native-accepted', 'running', 'terminal', 'unknown']);
const ACTIVE_RUN = ['queued', 'starting', 'running', 'uncertain'];

/** Opens an existing SQLite file read-only. Never creates, migrates or locks for writing. */
export function openReadOnly(/** @type {string} */ path) {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA busy_timeout=2000; PRAGMA query_only=1');
  return db;
}

/** @param {unknown} value */
const time = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
/** @param {string} text */
const short = text => createHash('sha256').update(text).digest('hex').slice(0, 24);
/** @param {number} ms */
export function age(ms) {
  if (!Number.isFinite(ms)) return 'an unknown time';
  const minutes = Math.round(ms / 60000);
  return minutes < 120 ? `${minutes} min` : ms < 2 * DAY ? `${Math.round(ms / HOUR)} h` : `${Math.round(ms / DAY)} days`;
}
/** @param {DatabaseSync} db @param {string} table */
const hasTable = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

class Scan {
  /** @param {Options} options */
  constructor(options) {
    this.o = { ...DEFAULTS, ...options };
    this.now = options.now ?? Date.now();
    this.started = Date.now();
    /** @type {Finding[]} */ this.findings = [];
    /** @type {string[]} */ this.errors = [];
    this.truncated = false;
    /** @type {Map<string,string>} */ this.names = new Map();
    /** @type {Array<{name:string,fn:()=>void}>} */ this.tasks = [];
  }
  get expired() { return Date.now() - this.started > this.o.budgetMs; }
  /** @param {Omit<Finding,'key'|'botName'> & {key?:string}} f */
  add(f) {
    if (this.findings.length >= this.o.maxFindings) { this.truncated = true; return; }
    const key = f.key ?? `${f.store}:${f.check}:${f.record.kind}:${short(f.record.id)}`;
    if (this.findings.some(x => x.key === key)) return;
    this.findings.push({ ...f, key, botName: f.botId ? this.names.get(f.botId) ?? null : null });
  }
  /** @param {number} ms @returns {Severity} */
  severity(ms) { return ms >= this.o.criticalMs ? 'high' : 'medium'; }
  /** Queues one check. Checks run in order; a failure is recorded, never thrown, so later checks still run. */
  run(/** @type {string} */ name, /** @type {()=>void} */ fn) { this.tasks.push({ name, fn }); }
  /** @param {{name:string,fn:()=>void}} task */
  execute(task) {
    if (this.expired) { this.truncated = true; return; }
    try { task.fn(); } catch (error) { this.errors.push(`${task.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  /** @returns {Report} */
  report() {
    const order = { high: 0, medium: 1, low: 2 };
    const findings = this.findings.sort((a, b) => order[a.severity] - order[b.severity] || (b.ageMs ?? 0) - (a.ageMs ?? 0));
    const counts = { high: 0, medium: 0, low: 0 };
    for (const f of findings) counts[f.severity]++;
    return { version: 1, checkedAt: new Date(this.now).toISOString(), durationMs: Date.now() - this.started,
      truncated: this.truncated, counts, findings, errors: this.errors };
  }
}

/**
 * @param {DatabaseSync} db
 * @param {string} kind
 * @param {string} where SQL over `json` (a records row); bound parameters follow.
 * @param {number} limit
 * @param {...(string|number|null)} params
 * @returns {Array<Record<string, any> & {id:string}>}
 */
function records(db, kind, where, limit, ...params) {
  return /** @type {Array<{json:string}>} */ (db.prepare(`SELECT json FROM records WHERE kind=? AND (${where}) LIMIT ?`).all(kind, ...params, limit))
    .map(row => JSON.parse(row.json));
}
/** @param {DatabaseSync} db @param {Map<string,string>} names */
function loadBots(db, names) {
  /** @type {Map<string, Record<string, any>>} */ const bots = new Map();
  if (!hasTable(db, 'bots')) return bots;
  for (const row of /** @type {Array<{json:string}>} */ (db.prepare('SELECT json FROM bots LIMIT 2000').all())) {
    const bot = JSON.parse(row.json);
    bots.set(bot.id, bot);
    if (!names.has(bot.id)) names.set(bot.id, bot.name ?? bot.slug ?? bot.id);
  }
  return bots;
}

/**
 * What a bridge store (hub or node; same schema) shows as pending work for a
 * bot. Mirrors the shared idle predicate (memory maintenance, proactive
 * reviews) but treats finished queue history as history.
 * @param {DatabaseSync} db
 * @param {Record<string, any>} bot
 * @returns {string[]}
 */
export function bridgeBlockers(db, bot) {
  const blockers = [];
  const count = (/** @type {string} */ kind, /** @type {string} */ where, /** @type {Array<string|null>} */ ...params) =>
    Number(/** @type {{n:number}} */ (db.prepare(`SELECT count(*) AS n FROM records WHERE kind=? AND bot_id=? AND (${where})`).get(kind, bot.id, ...params)).n);
  if (bot.activeTurnId) blockers.push(`active turn ${bot.activeTurnId}`);
  if (bot.queuePaused) blockers.push('queue paused (Stop)');
  if (bot.managerPaused) blockers.push('manager paused');
  const activity = db.prepare("SELECT json FROM records WHERE kind='botActivity' AND id=?").get(bot.id);
  const a = activity ? JSON.parse(/** @type {{json:string}} */ (activity).json) : null;
  if (a && (a.unresolved === true || a.threadId !== bot.threadId)) blockers.push(`unresolved activity (${a.reason ?? 'thread changed'})`);
  if (count('pending', '1')) blockers.push('pending question');
  const finished = [...FINISHED_QUEUE_STATES].map(s => `'${s}'`).join(',');
  const queue = count('promptQueue', `COALESCE(json_extract(json,'$.state'),'') NOT IN (${finished})`);
  if (queue) blockers.push(`${queue} waiting queue item(s)`);
  const inbox = count('primaryInbox', `json_extract(json,'$.terminalStatus') IS NULL AND COALESCE(json_extract(json,'$.state'),'') NOT IN ('cancelled','failed')`);
  if (inbox) blockers.push(`${inbox} open inbox item(s)`);
  const runs = count('run', `json_extract(json,'$.status') IN (${ACTIVE_RUN.map(s => `'${s}'`).join(',')})`);
  if (runs) blockers.push(`${runs} active run(s)`);
  if (count('executionStop', `COALESCE(json_extract(json,'$.state'),'')<>'done'`)) blockers.push('Stop in progress');
  if (count('planExecution', `json_extract(json,'$.state') IN ('preparing','dispatching','queued','running','uncertain')`)) blockers.push('Plan execution in progress');
  if (count('collaborationContext', `json_extract(json,'$.activeTurnId') IS NOT NULL OR json_extract(json,'$.status')='unknown' OR json_extract(json,'$.provisioning') IN ('dispatching','uncertain')`) ||
      count('collaborationDelivery', `json_extract(json,'$.state') IN ('dispatching','uncertain','accepted') AND json_extract(json,'$.terminalStatus') IS NULL`) ||
      count('collaborationPending', '1') || count('collaborationResource', `COALESCE(json_extract(json,'$.state'),'')<>'released'`) ||
      count('collaborationGoal', `json_extract(json,'$.goal.status')='active'`)) blockers.push('team collaboration in progress');
  // A lane is finished only once bound with no active turn (BackgroundRuns.unfinished); count any other as work.
  if (count('runLane', `COALESCE(json_extract(json,'$.provisioning'),'')<>'bound' OR json_extract(json,'$.activeTurnId') IS NOT NULL`)) blockers.push('background run lane open');
  if (count('managerTask', `COALESCE(json_extract(json,'$.state'),'') NOT IN ('completed','failed','cancelled')`)) blockers.push('manager task open');
  if (count('nativeGoal', `json_extract(json,'$.goal.status')='active'`)) blockers.push('active Goal');
  if (count('messageBurst', `json_extract(json,'$.state') NOT IN ('sent','discarded','queued','edited') AND json_extract(json,'$.supersededBy') IS NULL`)) blockers.push('message burst open');
  if (count('runTurn', `json_extract(json,'$.status') IN ('starting','uncertain')`)) blockers.push('scheduled turn unconfirmed');
  const uncertain = Number(/** @type {{n:number}} */ (db.prepare(`SELECT count(*) AS n FROM operations WHERE status IN ('dispatching','uncertain') AND json_extract(json,'$.botId')=?`).get(bot.id)).n);
  if (uncertain) blockers.push(`${uncertain} uncertain operation(s)`);
  return blockers;
}

/**
 * Checks shared by both bridge stores: the hub's (control.sqlite) and the node's
 * (native-control.sqlite) records tables.
 * @param {Scan} s @param {DatabaseSync} db @param {'hub'|'node'} store
 */
function checkBridgeRecords(s, db, store) {
  if (!hasTable(db, 'records')) return;
  const { rowLimit: limit, staleMs } = s.o, cutoff = new Date(s.now - staleMs).toISOString();
  s.run('inbox-stale', () => {
    for (const r of records(db, 'primaryInbox', `json_extract(json,'$.state') IN ('accepted','uncertain','dispatching') AND json_extract(json,'$.terminalStatus') IS NULL
        AND COALESCE(json_extract(json,'$.acceptedAt'),json_extract(json,'$.attemptedAt'),json_extract(json,'$.createdAt'))<?`, limit, cutoff)) {
      const ms = s.now - time(r.acceptedAt ?? r.attemptedAt ?? r.createdAt);
      s.add({ check: 'inbox-stale', severity: s.severity(ms), store, botId: r.botId ?? null, record: { kind: 'primaryInbox', id: r.id }, ageMs: ms,
        message: `Inbox item is ${r.state} with no terminal status after ${age(ms)}${r.turnId ? ` (turn ${r.turnId})` : ''}.`,
        suggestedAction: r.turnId ? `Read native turn ${r.turnId}; if it is terminal, the inbox reconciler (reconcileAcceptedInbox) should settle it — check that it runs for this bot. Never resend.`
          : 'No turn was bound. Confirm with the native queue whether the original submission exists before settling it by hand; never resend.' });
    }
  });
  s.run('queue-stale', () => {
    for (const r of records(db, 'promptQueue', `json_extract(json,'$.state') IN (${IN_FLIGHT_QUEUE_STATES.map(x => `'${x}'`).join(',')})
        AND COALESCE(json_extract(json,'$.updatedAt'),json_extract(json,'$.attemptedAt'),json_extract(json,'$.createdAt'))<?`, limit, cutoff)) {
      const ms = s.now - time(r.updatedAt ?? r.attemptedAt ?? r.createdAt);
      s.add({ check: 'queue-stale', severity: s.severity(ms), store, botId: r.botId ?? null, record: { kind: 'promptQueue', id: r.id }, ageMs: ms,
        message: `Queue item has been ${r.state} for ${age(ms)}.`,
        suggestedAction: 'Find the original operation and its native outcome; settle the item from that evidence. Do not resend an uncertain delivery.' });
    }
  });
  s.run('queue-state-unknown', () => {
    const known = [...QUEUE_STATES].map(x => `'${x}'`).join(',');
    for (const r of records(db, 'promptQueue', `COALESCE(json_extract(json,'$.state'),'') NOT IN (${known})`, limit))
      s.add({ check: 'queue-state-unknown', severity: 'medium', store, botId: r.botId ?? null, record: { kind: 'promptQueue', id: r.id }, ageMs: null,
        message: `Queue item is in unknown state ${JSON.stringify(r.state ?? null)}.`,
        suggestedAction: 'Add the state to the queue state sets (idle predicate, admission, this checker) or migrate the row; until then the idle check treats it as pending work.' });
  });
  s.run('inbox-state-unknown', () => {
    const known = [...INBOX_STATES].map(x => `'${x}'`).join(',');
    for (const r of records(db, 'primaryInbox', `COALESCE(json_extract(json,'$.state'),'') NOT IN (${known})`, limit))
      s.add({ check: 'inbox-state-unknown', severity: 'medium', store, botId: r.botId ?? null, record: { kind: 'primaryInbox', id: r.id }, ageMs: null,
        message: `Inbox item is in unknown state ${JSON.stringify(r.state ?? null)}.`, suggestedAction: 'Identify the writer of this state and add it to the known inbox states.' });
  });
  s.run('operation-uncertain', () => {
    const rows = /** @type {Array<{id:string,status:string,json:string}>} */ (db.prepare(`SELECT id,status,json FROM operations WHERE status IN ('dispatching','uncertain')
      AND COALESCE(json_extract(json,'$.updatedAt'),json_extract(json,'$.createdAt'))<? LIMIT ?`).all(cutoff, limit));
    for (const row of rows) {
      const op = JSON.parse(row.json), ms = s.now - time(op.updatedAt ?? op.createdAt);
      s.add({ check: 'operation-uncertain', severity: s.severity(ms), store, botId: op.botId ?? null, record: { kind: 'operation', id: row.id }, ageMs: ms,
        message: `Operation ${op.method ?? ''} has been ${row.status} for ${age(ms)}.`.replace('  ', ' '),
        suggestedAction: 'Reconcile from the native or hub receipt for this exact operation ID; an uncertain outcome is never retried automatically.' });
    }
  });
}

/**
 * Node-only checks on native-control.sqlite.
 * @param {Scan} s @param {DatabaseSync} db @param {Map<string, Record<string, any>>} bots
 */
function checkNodeStore(s, db, bots) {
  if (!hasTable(db, 'records')) return;
  const { rowLimit: limit } = s.o;
  s.run('activity-over-budget', () => {
    for (const a of records(db, 'botActivity', `json_extract(json,'$.unresolved')=1 AND COALESCE(json_extract(json,'$.attempts'),0)>=?`, limit, s.o.activityAttemptBudget)) {
      const bot = bots.get(a.botId);
      if (!bot || bot.archived || bot.deletedAt) continue;
      const since = time(a.recoveryCheckedAt), ms = Number.isFinite(since) ? s.now - since : null;
      s.add({ check: 'activity-over-budget', severity: 'high', store: 'node', botId: a.botId, record: { kind: 'botActivity', id: a.id }, ageMs: ms,
        message: `Current activity has been unresolved for ${a.attempts} reconciliation attempts (${a.reason ?? 'no reason'}). Last error: ${String(a.reconciliationError ?? 'none').slice(0, 200)}`,
        suggestedAction: 'The bot refuses new input while this holds. Read the native thread status; if the error repeats identically, the recovery path itself is failing — fix it rather than waiting.' });
    }
  });
  s.run('recovery-dead-epoch', () => {
    for (const r of records(db, 'nativeErrorRecovery', `COALESCE(json_extract(json,'$.phase'),'') NOT IN ('recovered','superseded')`, limit)) {
      const bot = bots.get(r.botId);
      if (!bot || bot.archived || bot.deletedAt) continue;
      if (r.threadId !== bot.threadId) {
        s.add({ check: 'recovery-superseded-thread', severity: 'low', store: 'node', botId: r.botId, record: { kind: 'nativeErrorRecovery', id: r.id }, ageMs: null,
          message: `Recovery row in phase ${r.phase} belongs to an older thread.`, suggestedAction: 'Harmless; it is ignored for the current thread. Mark it superseded when convenient.' });
        continue;
      }
      const updated = s.now - time(r.updatedAt ?? r.createdAt);
      const deadRetry = r.nativeRetry === true && (s.o.currentEpoch ? r.nativeRetryEpoch !== s.o.currentEpoch : updated > s.o.recoveryStaleMs);
      const missing = /** @type {string[]} */ ([]);
      for (const field of ['releaseActionId', 'resumeActionId'])
        if (r[field] && !db.prepare("SELECT 1 FROM records WHERE kind='nativeRecoveryAction' AND id=?").get(r[field])) missing.push(field);
      if (deadRetry || missing.length) {
        const why = [deadRetry ? `waits on a native retry owned by process epoch ${r.nativeRetryEpoch ?? 'unknown'}, which is no longer running` : null,
          !r.releaseActionId ? 'it has no releaseActionId (the failure never reached the unload step)' : null,
          missing.length ? `${missing.join(' and ')} point(s) to no action record` : null].filter(Boolean).join('; ');
        s.add({ check: 'recovery-dead-epoch', severity: 'high', store: 'node', botId: r.botId, record: { kind: 'nativeErrorRecovery', id: r.id }, ageMs: Number.isFinite(updated) ? updated : null,
          message: `Native error recovery for turn ${r.failedTurnId} (phase ${r.phase}, ${r.attempts ?? 0} attempts) ${why}.`,
          suggestedAction: 'Check that recovery passes are not failing on this row (activity reconciliationError). A dead process cannot finish its retry: the next pass must treat it as a fresh recovery.' });
      }
    }
  });
  s.run('recovery-action-dead-epoch', () => {
    if (!s.o.currentEpoch) return; // Offline copies cannot tell a live epoch from a dead one.
    for (const a of records(db, 'nativeRecoveryAction', `json_extract(json,'$.state') IN ('dispatching','uncertain','acknowledged') AND COALESCE(json_extract(json,'$.epoch'),'')<>?`, limit, s.o.currentEpoch))
      s.add({ check: 'recovery-action-dead-epoch', severity: 'medium', store: 'node', botId: a.botId ?? null, record: { kind: 'nativeRecoveryAction', id: a.id }, ageMs: s.now - time(a.createdAt),
        message: `Recovery ${a.kind ?? 'action'} is still ${a.state} from process epoch ${a.epoch}, which is no longer running.`,
        suggestedAction: 'Startup should have marked it connection-ended. Confirm the original native process exited, then the recovery can proceed.' });
  });
  s.run('bridge-busy-native-idle', () => {
    for (const bot of bots.values()) {
      if (bot.archived || bot.deletedAt || !bot.threadId) continue;
      const row = db.prepare("SELECT json FROM records WHERE kind='botActivity' AND id=?").get(bot.id);
      const a = row ? JSON.parse(/** @type {{json:string}} */ (row).json) : null;
      const nativeIdle = a && a.unresolved !== true && a.threadId === bot.threadId && !a.activeTurnId;
      if (nativeIdle && (bot.activeTurnId || bot.status === 'running'))
        s.add({ check: 'bridge-busy-native-idle', severity: 'medium', store: 'node', botId: bot.id, record: { kind: 'bot', id: bot.id }, ageMs: s.now - time(bot.updatedAt),
          message: `The last native observation is idle, but the bridge shows ${bot.activeTurnId ? `active turn ${bot.activeTurnId}` : `status ${bot.status}`}.`,
          suggestedAction: 'A turn/completed was probably missed. The active-turn reconciler should settle it from the native turn; check that it runs for this bot.' });
      // Only single-thread bots take part in the shared idle check.
      if (!s.o.idleProbe || bot.executionMode !== 'single-thread' || bot.archiving) continue;
      // Store, live predicate, store again: work that starts or ends while the
      // predicate runs shows up in one of the two store reads and is skipped.
      if (bridgeBlockers(db, bot).length || s.o.idleProbe(bot.id) !== false || bridgeBlockers(db, bot).length) continue;
      s.add({ check: 'busy-without-blocker', severity: 'high', store: 'node', botId: bot.id, record: { kind: 'bot', id: bot.id }, ageMs: null,
        message: 'The shared idle check reports this bot busy, but no pending work, open turn, question, run or Stop exists. Proactive reviews and memory maintenance never run for it.',
        suggestedAction: 'Find which term of the idle predicate is true (often finished history counted as pending) and fix the predicate.' });
    }
  });
}

/** @param {Scan} s @param {DatabaseSync} db */
function checkJournal(s, db) {
  if (!hasTable(db, 'node_commands')) return;
  const { rowLimit: limit, mailboxStaleMs } = s.o;
  s.run('journal-command', () => {
    const rows = /** @type {Array<{operation_id:string,state:string,command:string}>} */ (db.prepare(`SELECT operation_id,state,command FROM node_commands WHERE state<>'terminal' ORDER BY rowid LIMIT ?`).all(limit));
    for (const row of rows) {
      let command = /** @type {Record<string, any>} */ ({});
      try { command = JSON.parse(row.command); } catch { /* reported below as unknown age */ }
      const ms = s.now - time(command.updated_at ?? command.created_at), record = { kind: 'nodeCommand', id: row.operation_id };
      if (!JOURNAL_STATES.has(row.state)) {
        s.add({ check: 'journal-state-unknown', severity: 'medium', store: 'journal', botId: command.bot_id ?? null, record, ageMs: Number.isFinite(ms) ? ms : null,
          message: `Node command is in unknown state ${JSON.stringify(row.state)}.`, suggestedAction: 'Identify the writer of this state; settle() refuses transitions out of it.' });
        continue;
      }
      if (!(ms > mailboxStaleMs)) continue;
      s.add({ check: 'journal-command-stale', severity: row.state === 'unknown' || ms >= s.o.criticalMs ? 'high' : 'medium', store: 'journal', botId: command.bot_id ?? null, record, ageMs: ms,
        message: `Node command ${JSON.parse(command.payload ?? '{}').method ?? ''} has been ${row.state} for ${age(ms)}.`.replace('  ', ' '),
        suggestedAction: row.state === 'unknown' ? 'Needs exact original native evidence (turn or creation proof) to settle; never retried.'
          : 'The agent recovery loop retries received/dispatching rows two at a time; check agent faults for this operation.' });
    }
  });
  s.run('journal-events-backlog', () => {
    const n = Number(/** @type {{n:number}} */ (db.prepare('SELECT count(*) AS n FROM (SELECT 1 FROM node_events WHERE acked=0 LIMIT 5001)').get()).n);
    if (n > 1000) s.add({ check: 'journal-events-backlog', severity: n > 5000 ? 'high' : 'medium', store: 'journal', botId: null, record: { kind: 'nodeEvents', id: 'pending' }, ageMs: null,
      message: `${n > 5000 ? 'Over 5000' : n} native events are not acknowledged by the hub.`, suggestedAction: 'Check the hub connection; the browser timeline lags until these are delivered.' });
  });
}

/**
 * Hub-only checks on control.sqlite (portable_* tables plus the hub Store).
 * @param {Scan} s @param {DatabaseSync} db @param {Map<string, Record<string, any>>} bots
 */
function checkHubStore(s, db, bots) {
  const { rowLimit: limit, mailboxStaleMs } = s.o;
  if (hasTable(db, 'portable_mailbox')) s.run('mailbox', () => {
    const rows = /** @type {Array<Record<string, any>>} */ (db.prepare(`SELECT m.sequence,m.operation_id,m.bot_id,m.node_id,m.epoch,m.state,m.payload,m.created_at,m.updated_at,
        p.epoch AS placement_epoch,p.node_id AS placement_node FROM portable_mailbox m LEFT JOIN portable_placements p ON p.bot_id=m.bot_id
        WHERE m.state<>'terminal' ORDER BY m.sequence LIMIT ?`).all(limit));
    for (const m of rows) {
      const record = { kind: 'mailbox', id: m.operation_id }, ms = s.now - m.updated_at;
      let method = '';
      try { method = JSON.parse(m.payload).method ?? ''; } catch { /* unreadable payload: method stays blank */ }
      if (!MAILBOX_STATES.has(m.state)) {
        s.add({ check: 'mailbox-state-unknown', severity: 'high', store: 'hub', botId: m.bot_id, record, ageMs: ms,
          message: `Mailbox row ${method} is in unknown state ${JSON.stringify(m.state)}.`, suggestedAction: 'No receipt can move it; place() and Send stay refused for this bot.' });
        continue;
      }
      if (m.placement_epoch !== m.epoch || m.placement_node !== m.node_id) {
        s.add({ check: 'mailbox-dead-placement', severity: 'high', store: 'hub', botId: m.bot_id, record, ageMs: ms,
          message: `Mailbox row ${method} is ${m.state} for placement epoch ${m.epoch}, but the bot is now at epoch ${m.placement_epoch ?? 'none'}. No node will ever settle it.`,
          suggestedAction: 'Settle it terminally from the old node journal’s receipt, or mark it withdrawn if the old node never received it.' });
        continue;
      }
      if (ms > mailboxStaleMs)
        s.add({ check: 'mailbox-nonterminal', severity: m.state === 'unknown' || ms >= s.o.criticalMs ? 'high' : 'medium', store: 'hub', botId: m.bot_id, record, ageMs: ms,
          message: `Mailbox row ${method} has been ${m.state} for ${age(ms)}. Resume, Send and re-placement are refused while it is open.`,
          suggestedAction: m.state === 'unknown' ? 'Needs the original native receipt from the node journal; never resent.' : 'Check the node is connected and its journal has this operation; the receipt may be lost.' });
    }
  });
  if (!hasTable(db, 'records')) return;
  s.run('initiative-skipped', () => {
    const meta = hasTable(db, 'meta') ? /** @type {{json:string}|undefined} */ (db.prepare("SELECT json FROM meta WHERE key='initiative-settings'").get()) : undefined;
    const settings = meta ? JSON.parse(meta.json) : null;
    if (settings?.enabled !== true) return;
    for (const st of records(db, 'initiativeBot', `json_extract(json,'$.lastSkipAt') IS NOT NULL`, limit)) {
      const bot = bots.get(st.botId);
      if (!bot || bot.archived || bot.deletedAt) continue;
      const lastReview = time(st.lastThinkAt ?? st.lastReviewAt), lastSkip = time(st.lastSkipAt);
      if (Number.isFinite(lastReview) && lastReview >= lastSkip) continue;
      const since = time(st.skippedSince ?? st.skippingSince ?? st.lastThinkAt ?? st.lastReviewAt), ms = s.now - since;
      if (!(ms > s.o.initiativeSkipMs) || s.now - lastSkip > s.o.initiativeSkipMs) continue;
      s.add({ check: 'initiative-skipped', severity: 'medium', store: 'hub', botId: st.botId, record: { kind: 'initiativeBot', id: st.id }, ageMs: ms,
        message: `Proactive thinking has skipped this bot for ${age(ms)} (last reason: ${st.lastSkip}).`,
        suggestedAction: st.lastSkip === 'not-idle' ? 'The node’s idle check keeps reporting busy; compare it with the node’s pending work (busy-without-blocker).' : 'Check why the probe keeps refusing this bot.' });
    }
  });
  s.run('initiative-review-stuck', () => {
    for (const r of records(db, 'initiativeReview', `json_extract(json,'$.state') IN ('starting','running','uncertain') AND json_extract(json,'$.createdAt')<?`, limit, new Date(s.now - mailboxStaleMs).toISOString())) {
      const ms = s.now - time(r.createdAt);
      s.add({ check: 'initiative-review-stuck', severity: 'medium', store: 'hub', botId: r.botId, record: { kind: 'initiativeReview', id: r.id }, ageMs: ms,
        message: `Private review has been ${r.state} for ${age(ms)}. New reviews are not admitted while one is uncertain or starting.`,
        suggestedAction: 'Reconcile it against the node’s privateReview record; mark it interrupted if the node no longer has it.' });
    }
  });
}

/**
 * @param {{hub?:DatabaseSync|null, node?:DatabaseSync|null, journal?:DatabaseSync|null}} stores
 * @param {Options} options
 */
function plan(stores, options) {
  const s = new Scan(options);
  const hubBots = stores.hub ? loadBots(stores.hub, s.names) : new Map();
  const nodeBots = stores.node ? loadBots(stores.node, s.names) : new Map();
  if (stores.hub) { checkHubStore(s, stores.hub, hubBots); checkBridgeRecords(s, stores.hub, 'hub'); }
  if (stores.node) { checkNodeStore(s, stores.node, nodeBots); checkBridgeRecords(s, stores.node, 'node'); }
  if (stores.journal) checkJournal(s, stores.journal);
  // Cross-store: a bot skipped as "not idle" for a day, with what the node shows.
  const node = stores.node;
  if (stores.hub && node) s.run('initiative-node-blockers', () => {
    for (const f of s.findings) {
      const bot = f.check === 'initiative-skipped' && f.botId ? nodeBots.get(f.botId) : null;
      if (!bot) continue;
      const blockers = bridgeBlockers(node, bot);
      f.message += blockers.length ? ` Node shows: ${blockers.join(', ')}.` : ' The node store shows no pending work for it.';
    }
  });
  return s;
}

/**
 * Scans whichever stores are given, synchronously. Each handle must be a read-only connection.
 * @param {{hub?:DatabaseSync|null, node?:DatabaseSync|null, journal?:DatabaseSync|null}} stores
 * @param {Options} [options]
 * @returns {Report}
 */
export function checkInvariants(stores, options = {}) {
  const s = plan(stores, options);
  for (const task of s.tasks) s.execute(task);
  return s.report();
}

/**
 * The same scan, yielding to the event loop between checks so a live process
 * never blocks on more than one bounded query batch at a time.
 * @param {{hub?:DatabaseSync|null, node?:DatabaseSync|null, journal?:DatabaseSync|null}} stores
 * @param {Options} [options]
 * @returns {Promise<Report>}
 */
export async function checkInvariantsYielding(stores, options = {}) {
  const s = plan(stores, options);
  for (const task of s.tasks) { await new Promise(resolve => setImmediate(resolve)); s.execute(task); }
  return s.report();
}

/** Opens the given paths read-only, scans, and closes them. Missing paths are skipped. */
export function checkPaths(/** @type {{hub?:string|null,node?:string|null,journal?:string|null}} */ paths, /** @type {Options} */ options = {}) {
  /** @type {{hub?:DatabaseSync|null,node?:DatabaseSync|null,journal?:DatabaseSync|null}} */ const stores = {};
  try {
    for (const key of /** @type {const} */ (['hub', 'node', 'journal'])) { const path = paths[key]; if (path) stores[key] = openReadOnly(path); }
    return checkInvariants(stores, options);
  } finally { for (const db of Object.values(stores)) db?.close(); }
}

/** A short human summary for notifications and logs. */
export function findingText(/** @type {Finding} */ f) {
  return `${f.botName ? `${f.botName}: ` : ''}${f.message} Next: ${f.suggestedAction}`.slice(0, 1000);
}
