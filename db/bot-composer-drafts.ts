import { emptySharedDraft, type ComposerDraftMutation, type ComposerDraftReceipt, type SharedComposerDraft } from '../lib/bot-composer-draft';

async function keyFor(owner: string, botId: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([owner, botId])));
  return `bot-composer-draft:v1:${Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')}`;
}
type Row = SharedComposerDraft & { recent: { id: string; fingerprint: string; revision: number }[] };
export async function readComposerDraft(db: D1Database, owner: string, botId: string): Promise<SharedComposerDraft> {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key=?').bind(await keyFor(owner, botId)).first<{ value: string }>();
  const d: Row = row ? JSON.parse(row.value) : { ...emptySharedDraft(), recent: [] };
  return { revision: d.revision, content: d.content };
}
/** CAS and original mutation identity commit in a single SQLite statement.
 * Even beyond the bounded receipt tail an old expected revision cannot reapply.
 * No client timestamps, body logging, native input or new database writer. */
export async function writeComposerDraft(db: D1Database, owner: string, botId: string, request: ComposerDraftMutation): Promise<ComposerDraftReceipt> {
  const key = await keyFor(owner, botId);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)));
  const fingerprint = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  const receipt = JSON.stringify({ id: request.operationId, fingerprint, revision: request.expectedRevision + 1 });
  const candidate = JSON.stringify({ revision: request.expectedRevision + 1, content: request.content, recent: [JSON.parse(receipt)] });
  await db.prepare(`INSERT INTO app_settings(key,value)
    SELECT ?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM app_settings WHERE key=?))
      AND (EXISTS(SELECT 1 FROM app_settings WHERE key=?) OR
        (SELECT count(*) FROM app_settings WHERE key LIKE 'bot-composer-draft:v1:%') < 1024)
    ON CONFLICT(key) DO UPDATE SET value=json_set(excluded.value,'$.recent',
      json((SELECT json_group_array(json(value)) FROM
        (SELECT value FROM json_each(json_insert(app_settings.value,'$.recent[#]',json(?)),'$.recent') ORDER BY json_extract(value,'$.revision') DESC LIMIT 32)))),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE json_extract(app_settings.value,'$.revision')=?
      AND NOT EXISTS(SELECT 1 FROM json_each(app_settings.value,'$.recent') WHERE json_extract(value,'$.id')=?)`)
    .bind(key, candidate, request.expectedRevision, key, key, receipt, request.expectedRevision, request.operationId).run();
  const row = await db.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>();
  const d: Row = row ? JSON.parse(row.value) : { ...emptySharedDraft(), recent: [] };
  const prior = d.recent.find(r => r.id === request.operationId);
  if (prior && prior.fingerprint !== fingerprint) throw Error('Original draft operation changed.');
  return { operationId: request.operationId, applied: Boolean(prior), draft: { revision: d.revision, content: d.content } };
}
