import { MAX_SIDEBAR_TEAMS, sidebarChoice, type SidebarChoice, type SidebarChoiceMutation } from '../lib/bot-sidebar-preferences';

async function namespace(owner: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(owner));
  return `bot-sidebar:v1:${Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('')}:`;
}
export async function readSidebarChoices(db: D1Database, owner: string): Promise<SidebarChoice[]> {
  const prefix = `${await namespace(owner)}team:`;
  const rows = await db.prepare('SELECT value FROM app_settings WHERE key LIKE ? ORDER BY key LIMIT ?').bind(`${prefix}%`, MAX_SIDEBAR_TEAMS).all<{ value: string }>();
  return rows.results.map(row => JSON.parse(row.value) as SidebarChoice).filter(sidebarChoice).map(({ teamId, collapsed, revision }) => ({ teamId, collapsed, revision }));
}

/** One atomic D1 batch: per-team compare-and-swap plus immutable operation
 * receipt. Independent teams never replace a shared set; replaying an ACK
 * never reapplies a choice after another device has changed it. */
export async function writeSidebarChoice(db: D1Database, owner: string, request: SidebarChoiceMutation) {
  const prefix = await namespace(owner), key = `${prefix}team:${request.teamId}`, receiptKey = `${prefix}receipt:${request.operationId}`;
  const fingerprint = JSON.stringify({ teamId: request.teamId, collapsed: request.collapsed, expectedRevision: request.expectedRevision, operationId: request.operationId });
  const choice = JSON.stringify({ teamId: request.teamId, collapsed: request.collapsed, revision: request.expectedRevision + 1, operationId: request.operationId });
  const empty = JSON.stringify({ teamId: request.teamId, collapsed: false, revision: 0 });
  await db.batch([
    db.prepare(`INSERT INTO app_settings(key,value)
      SELECT ?,? WHERE (?=0 OR EXISTS(SELECT 1 FROM app_settings WHERE key=?)) AND NOT EXISTS(SELECT 1 FROM app_settings WHERE key=?)
      AND (EXISTS(SELECT 1 FROM app_settings WHERE key=?) OR (SELECT count(*) FROM app_settings WHERE key LIKE ?) < ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE json_extract(app_settings.value,'$.revision')=? AND NOT EXISTS(SELECT 1 FROM app_settings WHERE key=?)`)
      .bind(key, choice, request.expectedRevision, key, receiptKey, key, `${prefix}team:%`, MAX_SIDEBAR_TEAMS, request.expectedRevision, receiptKey),
    db.prepare(`INSERT INTO app_settings(key,value)
      SELECT ?,json_object('request',?,'choice',json(COALESCE((SELECT value FROM app_settings WHERE key=?),?)),
        'applied',json(CASE WHEN (SELECT json_extract(value,'$.operationId') FROM app_settings WHERE key=?)=? THEN 'true' ELSE 'false' END))
      ON CONFLICT(key) DO NOTHING`).bind(receiptKey, fingerprint, key, empty, key, request.operationId),
  ]);
  const row = await db.prepare('SELECT value FROM app_settings WHERE key=?').bind(receiptKey).first<{ value: string }>();
  if (!row) throw Error('Preference receipt is unavailable. Retry the same choice.');
  const receipt = JSON.parse(row.value) as { request: string; choice: SidebarChoice; applied: boolean };
  if (receipt.request !== fingerprint) throw Error('This preference operation belongs to a different choice.');
  if (!sidebarChoice(receipt.choice) || typeof receipt.applied !== 'boolean') throw Error('Preference receipt could not be verified.');
  return { operationId: request.operationId, applied: receipt.applied, choice: { teamId: receipt.choice.teamId, collapsed: receipt.choice.collapsed, revision: receipt.choice.revision } };
}
