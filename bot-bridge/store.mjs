// @ts-check
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

// Record shapes for the kinds the state modules read and write. Only identity
// and optional reference fields are typed; everything else stays open. An
// optional ID (string|null|undefined) passed where an ID is required is a type
// error, so a lookup by a missing reference has to be guarded.
/** @typedef {{ id: string, botId?: string|null, [field: string]: any }} StoredRecord */
/**
 * @typedef {{ id: string, slug: string, name?: string, threadId?: string|null, activeTurnId?: string|null, executionMode?: string,
 *   archived?: boolean, archiving?: boolean, deletedAt?: string|null, queuePaused?: boolean, managerPaused?: boolean, extension?: number,
 *   [field: string]: any }} Bot
 */
/**
 * @typedef {{ id: string, botId: string, threadId?: string|null, generation: number, activeTurnId?: string|null, unresolved?: boolean,
 *   unresolvedTurnId?: string|null, dispatchOperationId?: string|null, attempts?: number, reconcileAfter?: string|null, [field: string]: any }} BotActivity
 */
/**
 * @typedef {{ id: string, botId: string, threadId: string, failedTurnId: string, phase: string, attempts: number,
 *   releaseActionId?: string|null, resumeActionId?: string|null, nativeRetry?: boolean, nativeRetryEpoch?: string|null,
 *   originalOperationId?: string|null, [field: string]: any }} NativeErrorRecoveryRecord
 */
/** @typedef {{ id: string, botId: string, threadId: string, kind: string, epoch: string, state: string, [field: string]: any }} NativeRecoveryAction */
/** @typedef {{ id: string, botId: string, state: string, turnId?: string|null, terminalStatus?: string|null, nativeQueueId?: string|null, [field: string]: any }} PrimaryInboxRecord */
/** @typedef {{ id: string, botId: string, state: string, operationId?: string|null, turnId?: string|null, listId?: string|null, [field: string]: any }} PromptQueueRecord */
/**
 * @typedef {{ botActivity: BotActivity, nativeErrorRecovery: NativeErrorRecoveryRecord, nativeRecoveryAction: NativeRecoveryAction,
 *   primaryInbox: PrimaryInboxRecord, promptQueue: PromptQueueRecord }} StateRecords
 */
/** @template {string} K @typedef {K extends keyof StateRecords ? StateRecords[K] : StoredRecord} RecordOf */
/** @typedef {{ id: string, fingerprint: string, status: string, [field: string]: any }} Operation */
/**
 * The runtime surface the state modules use. The store is typed; the rest of
 * the (large, untyped) BotRuntime stays open.
 * @typedef {{ store: Store, epoch: string, codex: any, loaded: Set<string>, locks: Map<string, any>, [member: string]: any }} StateRuntime
 */

/** @param {unknown} row @returns {any} */
const decode = row => JSON.parse(String(/** @type {{json: unknown}} */ (row).json));

export class Store {
  /** @param {string} path */
  constructor(path) {
    /** Nesting depth of the open transaction (0: none). */
    this.transactionDepth = 0;
    /** @type {Array<() => void>} Publications that run after the outermost commit. */
    this.commitCallbacks = [];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bots(id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, thread_id TEXT UNIQUE, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, id TEXT NOT NULL, bot_id TEXT, json TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS operator_native_request ON records(bot_id,json_extract(json,'$.nativeOperationId')) WHERE kind='operatorRequest';
      CREATE INDEX IF NOT EXISTS operator_call_records ON records(kind,json_extract(json,'$.callId')) WHERE kind IN ('operatorRequest','operatorSegment','operatorTranscript');
      CREATE INDEX IF NOT EXISTS operator_segment_records ON records(kind,json_extract(json,'$.segmentId')) WHERE kind IN ('operatorRequest','operatorTranscript');
      CREATE INDEX IF NOT EXISTS records_bot ON records(kind,bot_id);
      CREATE INDEX IF NOT EXISTS run_state_bot ON records(json_extract(json,'$.status'),bot_id) WHERE kind='run';
      CREATE INDEX IF NOT EXISTS prompt_queue_client ON records(bot_id,json_extract(json,'$.clientUserMessageId')) WHERE kind='promptQueue';
      CREATE INDEX IF NOT EXISTS prompt_queue_list_state ON records(bot_id,COALESCE(json_extract(json,'$.listId'),''),json_extract(json,'$.state')) WHERE kind='promptQueue';
      CREATE INDEX IF NOT EXISTS primary_intake_source ON records(json_extract(json,'$.sourceId'),json_extract(json,'$.state')) WHERE kind='primaryInbox';
      CREATE INDEX IF NOT EXISTS primary_intake_state ON records(bot_id,json_extract(json,'$.state')) WHERE kind='primaryInbox';
      CREATE INDEX IF NOT EXISTS burst_message_state ON records(bot_id,json_extract(json,'$.state')) WHERE kind='burstMessage';
      CREATE INDEX IF NOT EXISTS run_turn_page ON records(bot_id,json_extract(json,'$.runId'),id) WHERE kind='runTurn';
      CREATE INDEX IF NOT EXISTS run_turn_identity ON records(kind,bot_id,json_extract(json,'$.turnId')) WHERE kind IN ('run','runTurn');
      CREATE UNIQUE INDEX IF NOT EXISTS run_lane_thread ON records(json_extract(json,'$.threadId')) WHERE kind='runLane';
      CREATE INDEX IF NOT EXISTS run_finding_page ON records(bot_id,json_extract(json,'$.runId'),id) WHERE kind='runFinding';
      CREATE INDEX IF NOT EXISTS artifact_publication_context ON records(bot_id,json_extract(json,'$.provenance.threadId'),json_extract(json,'$.provenance.turnId'),json_extract(json,'$.provenance.itemId')) WHERE kind='artifactPublication';
      CREATE INDEX IF NOT EXISTS history_attachment_path ON records(bot_id,json_extract(json,'$.path'),id)
        WHERE kind='attachment' AND json_extract(json,'$.ready')=1;
      CREATE INDEX IF NOT EXISTS history_attachment_item ON records(bot_id,json_extract(json,'$.provenance.turnId'),json_extract(json,'$.provenance.itemId'),COALESCE(json_extract(json,'$.provenance.threadId'),''),id)
        WHERE kind='attachment' AND json_extract(json,'$.ready')=1 AND json_extract(json,'$.artifact')=1;
      CREATE UNIQUE INDEX IF NOT EXISTS manager_thread_mapping
        ON records(json_extract(json, '$.threadId')) WHERE kind='managerWorker';
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS answer_operation_question ON operations(
        json_extract(json,'$.botId'),json_extract(json,'$.params.key'))
        WHERE json_extract(json,'$.method')='requests.respond';
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_bot_cursor ON events(json_extract(json,'$.botId'),seq);
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
    // Every context/config mutation advances a scalar cutover fence in the
    // SAME SQLite transaction. Maintenance never reads room bodies to hash a
    // transcript, and equal busy counts cannot hide changed original records.
    for (const operation of ['INSERT','UPDATE','DELETE']) this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS collaboration_change_${operation.toLowerCase()} AFTER ${operation} ON records
      WHEN ${operation==='DELETE'?'OLD':'NEW'}.kind LIKE 'collaboration%' OR ${operation==='DELETE'?'OLD':'NEW'}.kind IN ('executionConfig','executionSettings')
      BEGIN INSERT INTO meta(key,json) VALUES('collaboration-change','1')
        ON CONFLICT(key) DO UPDATE SET json=CAST(CAST(meta.json AS INTEGER)+1 AS TEXT); END;`);
    // Incrementally observed native cursor locations, not history or execution
    // authority. Exact native identity is verified whenever a hint is used.
    this.db.exec(`CREATE TABLE IF NOT EXISTS native_history_locations(
      thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, cursor TEXT, page_limit INTEGER NOT NULL,
      PRIMARY KEY(thread_id,turn_id))`);
    this.transaction(() => {
      const bots = this.db.prepare("SELECT json FROM bots ORDER BY rowid").all().map(decode);
      let next = Math.max(2, Number(this.meta("next-bot-extension")) || 2,
        ...bots.filter(bot => Number.isSafeInteger(bot.extension) && bot.extension >= 2).map(bot => bot.extension + 1));
      const used = new Set();
      for (const bot of bots) {
        if (!Number.isSafeInteger(bot.extension) || bot.extension < 2 || used.has(bot.extension)) {
          bot.extension = next++;
          this.db.prepare("UPDATE bots SET json=? WHERE id=?").run(JSON.stringify(bot), bot.id);
        }
        used.add(bot.extension);
      }
      this.meta("next-bot-extension", next);
    });
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS bot_extension ON bots(json_extract(json,'$.extension')) WHERE json_extract(json,'$.extension') IS NOT NULL");
  }
  /** @returns {Bot[]} */
  bots({ includeDeleted = false } = {}) {
    return this.db
      .prepare("SELECT json FROM bots")
      .all()
      .map(decode).filter(bot => includeDeleted || !bot.deletedAt);
  }
  /** @param {string} id @returns {Bot} */
  bot(id) {
    const row = this.db.prepare("SELECT json FROM bots WHERE id=?").get(id);
    if (!row) throw new Error("Bot not found.");
    return decode(row);
  }
  /** @param {string} id */
  teamPlacement(id) {
    const row = this.db.prepare("SELECT json_extract(json,'$.teamId') AS teamId, json_extract(json,'$.teamOrder') AS teamOrder FROM bots WHERE id=?").get(id);
    return row ? { teamId: row.teamId ?? null, teamOrder: row.teamOrder ?? 0 } : {};
  }
  /** @param {Bot} bot @returns {Bot} */
  saveBot(bot) {
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT json_extract(json,'$.extension') AS extension FROM bots WHERE id=?").get(bot.id);
      const extension = Number(prior?.extension ?? this.meta("next-bot-extension") ?? 2);
      if (!prior) this.meta("next-bot-extension", extension + 1);
      bot = { ...bot, extension };
      this.db
        .prepare(
          "INSERT INTO bots VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET slug=excluded.slug,thread_id=excluded.thread_id,json=excluded.json",
        )
        // A bot that is not provisioned yet has no thread; SQLite cannot bind undefined.
        .run(bot.id, bot.slug, bot.threadId ?? null, JSON.stringify(bot));
      return bot;
    });
  }
  /**
   * The ID is required by type: guard an optional reference before looking it
   * up. At run time a missing ID still returns null rather than throwing.
   * @template {string} K @param {K} kind @param {string} id @returns {RecordOf<K> | null}
   */
  get(kind, id) {
    // A record that was never created (an absent optional ID) is not a query error.
    if (id === undefined || id === null) return null;
    const row = this.db
      .prepare("SELECT json FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? decode(row) : null;
  }
  /** @template {string} K @param {K} kind @param {string|null} [botId] @returns {RecordOf<K>[]} */
  list(kind, botId) {
    return (
      botId
        ? this.db
            .prepare("SELECT json FROM records WHERE kind=? AND bot_id=?")
            .all(kind, botId)
        : this.db.prepare("SELECT json FROM records WHERE kind=?").all(kind)
    ).map(decode);
  }
  /** Runs in one status (run_state_bot index), without decoding the history. */
  /** @param {string} status @param {string|null} [botId] @returns {StoredRecord[]} */
  runsWithStatus(status, botId = null) {
    return this.db.prepare(`SELECT json FROM records WHERE kind='run' AND json_extract(json,'$.status')=? AND (? IS NULL OR bot_id=?)`)
      .all(status, botId, botId).map(decode);
  }
  /**
   * The newest runs of the given bots (null: all), in the order list() + a stable
   * scheduledAt sort produced: newest first, then bot ID, then insertion.
   */
  /** @param {string[]|null} botIds @param {number} limit @returns {StoredRecord[]} */
  recentRuns(botIds, limit) {
    if (botIds && !botIds.length) return [];
    const ids = botIds && JSON.stringify(botIds);
    return this.db.prepare(`SELECT json FROM records WHERE kind='run' AND (? IS NULL OR bot_id IN (SELECT value FROM json_each(?)))
      ORDER BY json_extract(json,'$.scheduledAt') DESC, bot_id, rowid LIMIT ?`)
      .all(ids, ids, limit).map(decode);
  }
  /** @param {string} botId @param {string|null} [listId] @returns {PromptQueueRecord[]} */
  queuedPrompts(botId, listId = null) {
    // Read pending messages only; merged/delivered originals remain durable
    // without being decoded on every queue or scheduler refresh.
    return this.db.prepare(`SELECT json FROM records WHERE kind='promptQueue' AND bot_id=?
      AND COALESCE(json_extract(json,'$.listId'),'')=?
      AND json_extract(json,'$.state') IN ('queued','dispatching','uncertain','failed')`)
      .all(botId, listId ?? '').map(decode);
  }
  /** @param {string} kind @param {string|null} [botId] @returns {StoredRecord[]} */
  executionMetadata(kind, botId = null) {
    if (!["runLane", "runIntake", "managerExecution"].includes(kind)) throw new Error("Unknown execution metadata kind.");
    // Admission/snapshots inspect metadata without hydrating frozen profiles,
    // full submitted input or native parameters for the historical library.
    return this.db.prepare(`SELECT json_remove(json,'$.profile','$.nativeParams','$.input','$.text','$.selectedContext') AS json
      FROM records WHERE kind=? AND (? IS NULL OR bot_id=?)`).all(kind, botId, botId).map(decode);
  }
  /** @template {string} K @template {RecordOf<K>} R @param {K} kind @param {R} record @returns {R} */
  put(kind, record) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET bot_id=excluded.bot_id,json=excluded.json",
      )
      .run(kind, record.id, record.botId ?? null, JSON.stringify(record));
    return record;
  }
  /** @param {string} kind @param {string} id */
  remove(kind, id) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  /** @param {string} key @param {unknown} [value] @returns {any} */
  meta(key, value) {
    if (value !== undefined)
      this.db
        .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
        .run(key, JSON.stringify(value));
    const row = this.db.prepare("SELECT json FROM meta WHERE key=?").get(key);
    return row ? decode(row) : null;
  }
  /** @param {string} id @returns {Operation|null} */
  operation(id) {
    const r = this.db.prepare("SELECT * FROM operations WHERE id=?").get(id);
    return r
      ? {
          ...decode(r),
          id: String(r.id),
          fingerprint: String(r.fingerprint),
          status: String(r.status),
        }
      : null;
  }
  /** @param {string} id @param {string} fingerprint @param {string} status @param {object} data */
  saveOperation(id, fingerprint, status, data) {
    this.db
      .prepare(
        "INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,json=excluded.json",
      )
      .run(id, fingerprint, status, JSON.stringify(data));
  }
  /** @returns {Operation[]} */
  uncertainOperations() {
    return this.db
      .prepare(
        "SELECT * FROM operations WHERE status IN ('dispatching','uncertain')",
      )
      .all()
      .map((r) => ({
        ...decode(r),
        id: String(r.id),
        fingerprint: String(r.fingerprint),
        status: String(r.status),
      }));
  }
  /** @param {string} botId @param {string} key @param {string|null} [excludeId] */
  retainedAnswerOperation(botId, key, excludeId = null) {
    // Earliest retained attempt, never the new retry's payload. Indexed by the
    // bot/question key; rowid is insertion order, not a wall-clock authority.
    const row = this.db.prepare(`SELECT id FROM operations
      WHERE json_extract(json,'$.method')='requests.respond'
      AND json_extract(json,'$.botId')=? AND json_extract(json,'$.params.key')=?
      AND (? IS NULL OR id<>?)
      AND COALESCE(json_extract(json,'$.outcome'),'uncertain')<>'rejected'
      ORDER BY rowid LIMIT 1`).get(botId, key, excludeId, excludeId);
    return row ? this.operation(String(row.id)) : null;
  }
  /** @param {string} botId @param {string} since */
  unconfirmedModeIntent(botId, since) {
    // Older bridges used status=failed for some transport/local exceptions;
    // only a proven rejected outcome makes those settings safe to supersede.
    return Boolean(this.db.prepare(`SELECT 1 FROM operations
      WHERE status <> 'done' AND COALESCE(json_extract(json,'$.outcome'),'uncertain') <> 'rejected'
      AND json_extract(json,'$.method')='bots.update' AND json_extract(json,'$.botId')=?
      AND json_extract(json,'$.createdAt')>=?
      AND json_type(json,'$.params.mode') IS NOT NULL
      LIMIT 1`).get(botId, since));
  }
  /** @param {object} event */
  event(event) {
    const result = this.db
      .prepare("INSERT INTO events(json) VALUES(?)")
      .run(JSON.stringify(event));
    const seq = Number(result.lastInsertRowid);
    if (seq % 1000 === 0)
      this.db.prepare("DELETE FROM events WHERE seq < ?").run(seq - 10000);
    return { seq, ...event };
  }
  cursor() {
    return Number(
      this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM events").get()
        ?.seq ?? 0,
    );
  }
  /** @param {number} after */
  replay(after) {
    return this.db
      .prepare(
        "SELECT seq,json FROM events WHERE seq>? ORDER BY seq LIMIT 10000",
      )
      .all(after)
      .map((r) => ({ seq: Number(r.seq), ...decode(r) }));
  }
  /** @template T @param {() => T} fn @returns {T} */
  transaction(fn) {
    const depth = this.transactionDepth ?? 0;
    const mark = this.commitCallbacks.length;
    this.db.exec(depth ? `SAVEPOINT nested_${depth}` : "BEGIN IMMEDIATE");
    this.transactionDepth = depth + 1;
    /** @type {T} */ let result;
    try {
      result = fn();
      if (result && typeof (/** @type {any} */ (result)).then === "function")
        throw new Error("Store transactions must be synchronous.");
      this.db.exec(depth ? `RELEASE nested_${depth}` : "COMMIT");
    } catch (e) {
      this.db.exec(depth ? `ROLLBACK TO nested_${depth}; RELEASE nested_${depth}` : "ROLLBACK");
      this.commitCallbacks.length = mark;
      throw e;
    } finally {
      this.transactionDepth = depth;
    }
    // Publication happens only after the durable commit. A listener failure
    // must not attempt to roll back an already committed transaction.
    if (!depth) {
      const callbacks = this.commitCallbacks.splice(0);
      let failure;
      for (const callback of callbacks) try { callback(); } catch (error) { failure ??= error; }
      if (failure) throw failure;
    }
    return result;
  }
  /** @param {() => void} callback */
  afterCommit(callback) {
    if (this.transactionDepth) this.commitCallbacks.push(callback);
    else callback();
  }
  close() {
    this.db.close();
  }
}
