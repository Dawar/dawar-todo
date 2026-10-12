import { readAt, validReadPosition, type BotReadPosition } from '../lib/bot-read-position';
async function hash(value: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('');
}
const prefixFor = async (owner: string) => `bot-read-position:v1:${await hash(owner)}:`;
const upperBound = (prefix: string) => `${prefix.slice(0, -1)};`;
export async function readBotPositions(db: D1Database, owner: string): Promise<BotReadPosition[]> {
  const prefix = await prefixFor(owner);
  const rows = await db.prepare('SELECT value FROM app_settings WHERE key>=? AND key<? ORDER BY key LIMIT 1024').bind(prefix, upperBound(prefix)).all<{ value: string }>();
  return rows.results.map(row => JSON.parse(row.value)).filter(value => validReadPosition(value));
}
/** Atomic max: duplicates and lost acknowledgements cannot regress position.
 * Uses the application's existing fenced writer, without touching bot state. */
export async function writeBotPosition(db: D1Database, owner: string, position: BotReadPosition) {
  const prefix = await prefixFor(owner), key = `${prefix}${await hash([position.botId, position.threadId])}`;
  const value = { ...position, at: readAt(position.at) };
  const result = await db.prepare(`INSERT INTO app_settings(key,value)
    SELECT ?,? WHERE EXISTS(SELECT 1 FROM app_settings WHERE key=?) OR
      (SELECT count(*) FROM app_settings WHERE key>=? AND key<?) < 1024
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE json_extract(excluded.value,'$.at') > json_extract(app_settings.value,'$.at')`)
    .bind(key, JSON.stringify(value), key, prefix, upperBound(prefix)).run();
  const row = await db.prepare('SELECT value FROM app_settings WHERE key=?').bind(key).first<{ value: string }>();
  if (!row) throw Error('Read position capacity reached.');
  return { position: JSON.parse(row.value) as BotReadPosition, changed: result.meta.changes > 0 };
}
