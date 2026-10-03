import { env } from "cloudflare:workers";
import { ensureTodoDatabase } from "./todos";

// Frozen legacy tables exist only for the narrowly authorized migration and
// untouched other tenants. Runtime calls never create or depend on Chat threads.
export const RETIREMENT_ID = "dwight-legacy-chat-retirement-20261003-v1";
const transcriptColumns = "id, session_id, user_key, realtime_item_id, role, content, focused_todo_id, metadata_json, created_at";
const callSession = `(s.transport LIKE 'phone%' OR s.transport LIKE 'browser%' OR EXISTS
  (SELECT 1 FROM todo_talk_phone_calls p WHERE p.user_key=s.user_key AND p.talk_session_id=s.id)
  OR EXISTS (SELECT 1 FROM todo_operator_sessions o WHERE o.user_key=s.user_key AND o.id=s.id))`;
const retainedMessage = `(EXISTS (SELECT 1 FROM todo_talk_sessions s WHERE s.id=m.session_id AND s.user_key=m.user_key AND ${callSession})
  OR (m.session_id='system-phone' AND (json_extract(m.metadata_json,'$.kind')='phone-recording'
    OR json_extract(m.metadata_json,'$.transport') LIKE 'twilio%')))`;

let schema: Promise<void> | undefined;
async function ensureSchema() {
  await ensureTodoDatabase();
  if (!schema) schema = (async () => {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS todo_call_messages (
        id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, user_key TEXT NOT NULL,
        realtime_item_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        focused_todo_id INTEGER, metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_call_messages_realtime_idx ON todo_call_messages(user_key,realtime_item_id)"),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS todo_call_messages_session_idx ON todo_call_messages(user_key,session_id,created_at,id)"),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS todo_legacy_chat_retirements (
        operation_id TEXT PRIMARY KEY NOT NULL, user_key TEXT NOT NULL,
        backup_sha256 TEXT NOT NULL, ciphertext_sha256 TEXT NOT NULL, salt TEXT NOT NULL, iv TEXT NOT NULL,
        chunks INTEGER NOT NULL, counts_json TEXT NOT NULL, completed_at TEXT NOT NULL)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS todo_legacy_chat_backup_chunks (
        operation_id TEXT NOT NULL, ordinal INTEGER NOT NULL, ciphertext TEXT NOT NULL,
        PRIMARY KEY(operation_id,ordinal))`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS todo_legacy_chat_retirement_guard (
        operation_id TEXT PRIMARY KEY NOT NULL, valid INTEGER NOT NULL CHECK(valid=1))`),
    ]);
  })().catch(error => { schema = undefined; throw error; });
  await schema;
}
function copyTranscripts(userKey: string) {
  return env.DB.prepare(`INSERT OR IGNORE INTO todo_call_messages (${transcriptColumns})
    SELECT ${transcriptColumns.split(", ").map(c => `m.${c}`).join(", ")}
    FROM todo_talk_messages m WHERE m.user_key=? AND ${retainedMessage}`).bind(userKey);
}
const copied = new Map<string, Promise<void>>();
export async function ensureCallStorage(userKey: string) {
  await ensureSchema();
  if (!copied.has(userKey)) copied.set(userKey, copyTranscripts(userKey).run().then(() => undefined).catch(error => { copied.delete(userKey); throw error; }));
  await copied.get(userKey);
}

const snapshotTables = ["todo_talk_threads", "todo_talk_messages", "todo_talk_sessions", "todo_talk_tool_calls", "todo_talk_workspaces"] as const;
const encoder = new TextEncoder();
function base64(bytes: Uint8Array) {
  let text = ""; for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}
async function digest(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes))), b => b.toString(16).padStart(2, "0")).join("");
}

/** One authorized owner, exact scoped snapshot, private encrypted backup and
 * transactional compare/copy/delete/receipt. A race rolls back the ENTIRE batch.
 * No phone authentication/profile, recordings, tasks, native histories or other
 * tenant rows are deleted. A new call or old isolate write defers, never forces. */
async function retireLegacyChatTransaction(progress: { stage: string }) {
  await ensureSchema();
  progress.stage = "configuration";
  const userKey = env.BOTS_OWNER_EMAIL?.trim().toLowerCase();
  if (!userKey || !env.BOTS_TICKET_SECRET) throw Error("Legacy Chat retirement needs the existing owner and private backup key.");
  const existing = await env.DB.prepare("SELECT operation_id,counts_json FROM todo_legacy_chat_retirements WHERE operation_id=? AND user_key=?").bind(RETIREMENT_ID,userKey).first();
  if (existing) return { completed: true, replayed: true };
  // Inspect actual foreign-key ownership before the reviewed deletes. Unknown
  // inbound dependencies are a concrete deferral, never a cascade assumption.
  progress.stage = "foreign-keys";
  const schemaRows = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>();
  let inspectedForeignKeys = 0;
  for (const {name} of schemaRows.results) {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) throw Error("Unexpected database schema; no data deleted.");
    const fks = await env.DB.prepare(`PRAGMA foreign_key_list(${name})`).all<{ table: string }>();
    inspectedForeignKeys += fks.results.length;
    if (fks.results.some(f => ["todo_talk_threads", "todo_talk_messages", "todo_talk_sessions"].includes(f.table)))
      throw Error("Legacy Chat has an unreviewed foreign-key dependency; no data deleted.");
  }
  const active = await env.DB.prepare("SELECT COUNT(*) AS n FROM todo_talk_sessions WHERE user_key=? AND status='active' AND last_activity_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes')").bind(userKey).first<{ n: number }>();
  if (active?.n) return { completed: false, deferred: "active-call" };
  progress.stage = "snapshot";
  const snapshot: Record<string, Record<string, unknown>[]> = {};
  for (const table of snapshotTables) {
    // Bounded finite data migration; do not truncate an oversized backup.
    const rows = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_key=? LIMIT 5001`).bind(userKey).all<Record<string, unknown>>();
    if (rows.results.length > 5000) throw Error("Legacy Chat snapshot exceeds the reviewed migration bound; no data deleted.");
    snapshot[table] = rows.results;
  }
  const plain = encoder.encode(JSON.stringify({ format: 1, operationId: RETIREMENT_ID, userKey, snapshot }));
  if (plain.byteLength > 8*1024*1024) throw Error("Legacy Chat backup exceeds the reviewed byte bound; no data deleted.");
  progress.stage = "encrypt-backup";
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey("raw",encoder.encode(env.BOTS_TICKET_SECRET),"HKDF",false,["deriveKey"]);
  const key = await crypto.subtle.deriveKey({name:"HKDF",hash:"SHA-256",salt,info:encoder.encode(`dawar-private-retirement-backup:${RETIREMENT_ID}`)},material,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]);
  const aad = encoder.encode(RETIREMENT_ID);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:aad},key,plain));
  const verified = new Uint8Array(await crypto.subtle.decrypt({name:"AES-GCM",iv,additionalData:aad},key,cipher));
  const backupHash = await digest(plain);
  if (await digest(verified) !== backupHash) throw Error("Private backup validation failed; no data deleted.");
  progress.stage = "backup-bound";
  const encoded = base64(cipher), chunks = encoded.match(/.{1,1000}/g) ?? [];
  if (chunks.length > 800) throw Error("Legacy Chat backup exceeds the reviewed transactional statement bound; no data deleted.");
  const statements: D1PreparedStatement[] = [];
  // A row-set comparison covers every snapshot field, including nulls, without
  // placing private contents in logs or literals. Counts detect new/deleted rows.
  const guards: string[] = [], values: (string|number)[] = [];
  for (const table of snapshotTables) {
    const rows = snapshot[table];
    guards.push(`(SELECT COUNT(*) FROM ${table} WHERE user_key=?)=?`);
    values.push(userKey,rows.length);
    if (rows.length) {
      const primary = table === "todo_talk_tool_calls" ? "call_id" : table === "todo_talk_workspaces" ? "user_key" : "id";
      const fields = Object.keys(rows[0]);
      if (fields.some(c => !/^[a-z_]+$/.test(c))) throw Error("Legacy Chat schema changed; no data deleted.");
      guards.push(`NOT EXISTS (SELECT 1 FROM json_each(?) j LEFT JOIN ${table} t
        ON t.${primary}=json_extract(j.value,'$.${primary}') AND t.user_key=?
        WHERE t.${primary} IS NULL OR NOT (${fields.map(c => `t.${c} IS json_extract(j.value,'$.${c}')`).join(" AND ")}))`);
      values.push(JSON.stringify(rows),userKey);
    }
  }
  guards.push("NOT EXISTS (SELECT 1 FROM todo_talk_sessions WHERE user_key=? AND status='active' AND last_activity_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 minutes'))"); values.push(userKey);
  statements.push(env.DB.prepare(`INSERT INTO todo_legacy_chat_retirement_guard(operation_id,valid) SELECT ?,CASE WHEN ${guards.join(" AND ")} THEN 1 ELSE 0 END`).bind(RETIREMENT_ID,...values));
  chunks.forEach((chunk,ordinal) => statements.push(env.DB.prepare("INSERT INTO todo_legacy_chat_backup_chunks(operation_id,ordinal,ciphertext) VALUES(?,?,?)").bind(RETIREMENT_ID,ordinal,chunk)));
  statements.push(copyTranscripts(userKey));
  statements.push(env.DB.prepare(`UPDATE todo_legacy_chat_retirement_guard SET valid=CASE WHEN NOT EXISTS (
    SELECT 1 FROM todo_talk_messages m LEFT JOIN todo_call_messages c ON c.id=m.id AND c.user_key=m.user_key
    WHERE m.user_key=? AND ${retainedMessage} AND (c.id IS NULL OR NOT (
      ${transcriptColumns.split(", ").map(col => `c.${col} IS m.${col}`).join(" AND ")}
    ))) THEN 1 ELSE 0 END WHERE operation_id=?`).bind(userKey,RETIREMENT_ID));
  // Old voice sessions/receipts survive. Only imported obsolete text-session
  // records are removed, and never if a phone/Operator record references one.
  const obsolete = `user_key=? AND transport='legacy-assistant' AND NOT ${callSession}`;
  statements.push(env.DB.prepare(`DELETE FROM todo_talk_tool_calls WHERE user_key=? AND session_id IN (SELECT s.id FROM todo_talk_sessions s WHERE ${obsolete})`).bind(userKey,userKey));
  statements.push(env.DB.prepare(`DELETE FROM todo_talk_sessions AS s WHERE ${obsolete}`).bind(userKey));
  statements.push(env.DB.prepare("UPDATE todo_talk_sessions SET thread_id=NULL WHERE user_key=?").bind(userKey));
  statements.push(env.DB.prepare("UPDATE todo_talk_tool_calls SET thread_id=NULL WHERE user_key=?").bind(userKey));
  statements.push(env.DB.prepare("DELETE FROM todo_talk_messages WHERE user_key=?").bind(userKey));
  statements.push(env.DB.prepare("DELETE FROM todo_talk_threads WHERE user_key=?").bind(userKey));
  const counts = { ...Object.fromEntries(snapshotTables.map(t => [t,snapshot[t].length])), inspectedForeignKeys };
  statements.push(env.DB.prepare(`INSERT INTO todo_legacy_chat_retirements(operation_id,user_key,backup_sha256,ciphertext_sha256,salt,iv,chunks,counts_json,completed_at)
    VALUES(?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(RETIREMENT_ID,userKey,backupHash,await digest(cipher),base64(salt),base64(iv),chunks.length,JSON.stringify(counts)));
  progress.stage = "atomic-transaction";
  await env.DB.batch(statements);
  console.info("[legacy-chat] scoped retirement completed", { operationId: RETIREMENT_ID, counts, backupChunks: chunks.length });
  return { completed: true, replayed: false, counts, backupChunks: chunks.length };
}

/** Diagnostic metadata excludes raw D1 errors, SQL and private row values. */
export async function retireLegacyChat() {
  const progress = { stage: "schema" };
  try { return await retireLegacyChatTransaction(progress); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const categories: [RegExp, string][] = [
      [/existing owner and private backup key/i, "configuration-missing"],
      [/foreign-key dependency/i, "unreviewed-foreign-key"],
      [/transactional statement bound/i, "backup-statement-bound"],
      [/byte bound|snapshot exceeds/i, "backup-size-bound"],
      [/too many sql variables/i, "d1-variable-limit"],
      [/too many.*(subrequests|queries)|limit.*(subrequests|queries)/i, "d1-query-limit"],
      [/statement.*(too long|length)|SQL.*too.*large/i, "d1-statement-limit"],
      [/CHECK constraint/i, "snapshot-or-copy-race"],
      [/UNIQUE constraint/i, "existing-claim-or-copy-conflict"],
      [/not authorized|authorization|permission/i, "d1-permission"],
      [/syntax error/i, "d1-syntax"],
      [/no such (table|column)/i, "d1-schema"],
    ];
    const category = categories.find(([pattern]) => pattern.test(message))?.[1] ?? "unclassified";
    console.error("[legacy-chat] retirement diagnostic", { operationId: RETIREMENT_ID, stage: progress.stage, category });
    throw new Error("Scoped retirement deferred; diagnostic metadata recorded.");
  }
}
