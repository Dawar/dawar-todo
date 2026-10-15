import { MAX_CHAPTERS, boundedChapterTitle, sortChapters, validChapter, type BotChapter, type ChapterMutation, type ChapterScope, type ChapterTarget } from '../lib/bot-chapters';

const hex = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), n => n.toString(16).padStart(2, '0')).join('');
/** Hashed owner/conversation namespace in the existing app_settings store.
 * Rows hold only the bookmark identity, title and ordering metadata. */
async function prefix(owner: string, scope: ChapterScope) {
  return `bot-chapters:v1:${await hex(owner)}:${await hex(JSON.stringify([scope.botId, scope.threadId]))}:`;
}
async function key(owner: string, target: ChapterTarget) {
  return `${await prefix(owner, target)}${await hex(JSON.stringify([target.turnId, target.itemId]))}`;
}
export async function readChapters(db: D1Database, owner: string, scope: ChapterScope): Promise<BotChapter[]> {
  const rows = await db.prepare('SELECT value FROM app_settings WHERE key LIKE ? ORDER BY key LIMIT ?').bind(`${await prefix(owner, scope)}%`, MAX_CHAPTERS).all<{ value: string }>();
  return sortChapters(rows.results.flatMap(row => { try { const value: unknown = JSON.parse(row.value); return validChapter(value) && value.botId === scope.botId && value.threadId === scope.threadId ? [value] : []; } catch { return []; } }));
}
/** Pin and unpin are idempotent; rename is last-writer-wins on one row. */
export async function writeChapter(db: D1Database, owner: string, mutation: ChapterMutation): Promise<BotChapter | null> {
  const id = await key(owner, mutation);
  if (mutation.action === 'unpin') { await db.prepare('DELETE FROM app_settings WHERE key=?').bind(id).run(); return null; }
  if (mutation.action === 'rename') {
    await db.prepare(`UPDATE app_settings SET value=json_set(value,'$.title',?),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key=?`).bind(boundedChapterTitle(mutation.title), id).run();
  } else {
    const { botId, threadId, turnId, itemId, messageAt } = mutation;
    const chapter: BotChapter = { botId, threadId, turnId, itemId, title: boundedChapterTitle(mutation.title), messageAt, pinnedAt: new Date().toISOString() };
    await db.prepare(`INSERT INTO app_settings(key,value) SELECT ?,? WHERE (SELECT count(*) FROM app_settings WHERE key LIKE ?) < ?
      ON CONFLICT(key) DO NOTHING`).bind(id, JSON.stringify(chapter), `${await prefix(owner, mutation)}%`, MAX_CHAPTERS).run();
  }
  const row = await db.prepare('SELECT value FROM app_settings WHERE key=?').bind(id).first<{ value: string }>();
  if (!row) { if (mutation.action === 'pin') throw Error(`This conversation already has ${MAX_CHAPTERS} chapters. Unpin one first.`); return null; }
  const value: unknown = JSON.parse(row.value);
  if (!validChapter(value)) throw Error('Chapter could not be verified.');
  return value;
}
