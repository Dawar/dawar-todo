import { createHash } from 'node:crypto';
import { artifactDate, artifactDateMillis, UNKNOWN_DATE_KEY } from './artifact-dates.mjs';

const kinds = ['image', 'pdf', 'document', 'audio', 'video', 'other'];
const extensions = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm' };
export function artifactMime(name, mime) {
  return typeof mime === 'string' && mime !== 'application/octet-stream' && /^[\w.+-]+\/[\w.+-]+$/.test(mime)
    ? mime.toLowerCase() : extensions[String(name).split('.').at(-1).toLowerCase()] ?? 'application/octet-stream';
}
export function artifactKind(name, mime) {
  mime = artifactMime(name, mime);
  if (mime === 'application/pdf') return 'pdf';
  for (const kind of ['image', 'audio', 'video']) if (mime.startsWith(`${kind}/`)) return kind;
  return mime.startsWith('text/') || /json|officedocument|msword|opendocument|rtf/.test(mime) ? 'document' : 'other';
}
export function artifactVersion(a) {
  return createHash('sha256').update(JSON.stringify([a.id, a.botId, a.size, a.mimeType, a.createdAt, a.sha256])).digest('hex').slice(0, 24);
}
export function artifactMetadata(a, bot) {
  const kind = artifactKind(a.name, a.mimeType);
  const provenance = {};
  for (const key of ['threadId', 'turnId', 'itemId', 'operationId']) if (typeof a.provenance?.[key] === 'string') provenance[key] = a.provenance[key];
  return { id: a.id, botId: bot.id, botName: bot.name, botColor: bot.color, botArchived: Boolean(bot.archived),
    name: a.name, mimeType: artifactMime(a.name, a.mimeType), size: a.size, ready: true,
    createdAt: artifactDate(a.createdAt),
    direction: a.artifact ? 'output' : 'input', source: a.source === 'native' ? 'native' : a.artifact ? 'published' : 'upload',
    kind, provenance, preview: { kind: ['image', 'pdf'].includes(kind) ? kind : 'none', version: artifactVersion(a) } };
}
const initialized = new WeakSet();
export function listArtifacts(runtime, botId, p) {
  if (botId !== undefined) runtime.store.bot(String(botId));
  const search = p.search ?? '', type = p.type ?? 'all', direction = p.direction ?? 'all', sort = p.sort ?? 'newest', limit = p.limit ?? 36;
  if (typeof search !== 'string' || search.length > 160 || !['all', ...kinds].includes(type) ||
      !['all', 'input', 'output'].includes(direction) || !['newest', 'oldest', 'name'].includes(sort) ||
      !Number.isInteger(limit) || limit < 1 || limit > 60) throw new Error('Invalid artifact filters or page size.');
  const db = runtime.store.db;
  if (!initialized.has(db)) {
    db.function('artifact_kind', { deterministic: true }, artifactKind);
    db.function('artifact_text', { deterministic: true }, (value) => String(value ?? '').normalize('NFKC').toLowerCase());
    db.function('artifact_date_key', { deterministic: true }, (value) => artifactDateMillis(value) ?? UNKNOWN_DATE_KEY);
    runtime.store.transaction(() => db.exec(`
      CREATE TABLE IF NOT EXISTS artifact_library_sequence(seq INTEGER PRIMARY KEY AUTOINCREMENT, attachment_id TEXT UNIQUE NOT NULL);
      INSERT OR IGNORE INTO artifact_library_sequence(attachment_id)
        SELECT id FROM records WHERE kind='attachment' AND json_extract(json,'$.ready')=1
        AND NOT EXISTS(SELECT 1 FROM artifact_library_sequence WHERE attachment_id=records.id) ORDER BY rowid;
      CREATE TRIGGER IF NOT EXISTS artifact_library_insert AFTER INSERT ON records
        WHEN NEW.kind='attachment' AND json_extract(NEW.json,'$.ready')=1
        BEGIN INSERT OR IGNORE INTO artifact_library_sequence(attachment_id) VALUES(NEW.id); END;
      CREATE TRIGGER IF NOT EXISTS artifact_library_ready AFTER UPDATE ON records
        WHEN NEW.kind='attachment' AND json_extract(NEW.json,'$.ready')=1 AND COALESCE(json_extract(OLD.json,'$.ready'),0)!=1
        BEGIN INSERT OR IGNORE INTO artifact_library_sequence(attachment_id) VALUES(NEW.id); END;
      CREATE INDEX IF NOT EXISTS attachment_library_date ON records(COALESCE(json_extract(json,'$.createdAt'),''),id)
        WHERE kind='attachment' AND json_extract(json,'$.ready')=1;
    `));
    initialized.add(db);
  }
  const needle = search.trim().normalize('NFKC').toLowerCase();
  const scope = createHash('sha256').update(JSON.stringify([botId ?? null, needle, type, direction, sort])).digest('hex');
  let position;
  if (p.cursor != null) {
    try {
      if (typeof p.cursor !== 'string' || p.cursor.length > 2048) throw new Error();
      position = JSON.parse(Buffer.from(p.cursor, 'base64url').toString());
      const validKey = sort === 'name' ? typeof position.key === 'string' && position.key.length <= 512
        : Number.isSafeInteger(position.key) && position.key >= UNKNOWN_DATE_KEY && position.key <= -UNKNOWN_DATE_KEY - 1;
      if (position.v !== 2 || position.scope !== scope || !Number.isSafeInteger(position.ceiling) || position.ceiling < 0 ||
          !validKey || typeof position.id !== 'string' || position.id.length > 200) throw new Error();
    } catch { throw new Error('Artifact cursor does not match this library. Refresh the files.'); }
  }
  const ceiling = position?.ceiling ?? Number(db.prepare("SELECT COALESCE(MAX(seq),0) AS n FROM artifact_library_sequence").get().n);
  // json_extract serializes arrays/objects as strings; only original JSON text
  // can be a date, matching artifactMetadata's interpretation exactly.
  const date = "artifact_date_key(CASE WHEN json_type(a.json,'$.createdAt')='text' THEN json_extract(a.json,'$.createdAt') END)", name = "artifact_text(json_extract(a.json,'$.name'))";
  const key = sort === 'name' ? name : date, order = sort === 'newest' ? 'DESC' : 'ASC', compare = sort === 'newest' ? '<' : '>';
  const where = ["a.kind='attachment'", "json_extract(a.json,'$.ready')=1", 'l.seq<=?'];
  const values = [ceiling];
  if (botId !== undefined) { where.push('a.bot_id=?'); values.push(String(botId)); }
  if (needle) { where.push(`instr(${name},?)>0`); values.push(needle); }
  if (type !== 'all') { where.push("artifact_kind(json_extract(a.json,'$.name'),json_extract(a.json,'$.mimeType'))=?"); values.push(type); }
  if (direction !== 'all') { where.push("COALESCE(json_extract(a.json,'$.artifact'),0)=?"); values.push(direction === 'output' ? 1 : 0); }
  if (position) { where.push(`(${key} ${compare} ? OR (${key}=? AND a.id ${compare} ?))`); values.push(position.key, position.key, position.id); }
  // Keyset paging uses a fixed insertion ceiling. New files cannot shift later
  // pages; a removed anchor does not cause duplicate or skipped older records.
  const rows = db.prepare(`SELECT a.json,b.json AS bot,${key} AS sort_key FROM records a JOIN bots b ON b.id=a.bot_id JOIN artifact_library_sequence l ON l.attachment_id=a.id WHERE ${where.join(' AND ')} ORDER BY ${key} ${order},a.id ${order} LIMIT ?`).all(...values, limit + 1);
  const page = rows.slice(0, limit), last = page.at(-1);
  return { items: page.map((row) => artifactMetadata(JSON.parse(row.json), JSON.parse(row.bot))),
    nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({ v: 2, scope, ceiling, key: last.sort_key, id: JSON.parse(last.json).id })).toString('base64url') : null };
}
