// Real serialized routes/DB helpers with synthetic SQLite + private object storage only.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { runtime } from '../helpers/load-ts.mjs';
export function attachmentRouteRuntime() {
  const sql = new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE todos (id INTEGER PRIMARY KEY); INSERT INTO todos VALUES (7);
    CREATE TABLE todo_attachments (id TEXT PRIMARY KEY, todo_id INTEGER, draft_token TEXT, upload_state TEXT, expires_at TEXT, deleted_at TEXT, file_name TEXT, mime_type TEXT, byte_size INTEGER, kind TEXT DEFAULT 'image', original_key TEXT, display_key TEXT, thumbnail_key TEXT, width INTEGER, height INTEGER, duration_ms INTEGER DEFAULT 0, sort_order INTEGER, created_at TEXT DEFAULT '2026-09-27', updated_at TEXT DEFAULT '2026-09-27');`);
  const DB = { prepare(query) { const bound = (args = []) => ({
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async run() { return sql.prepare(query).run(...args); },
  }); return { ...bound(), bind: (...args) => bound(args) }; }, batch: queries => Promise.all(queries.map(q => q.run())) };
  const objects = new Map(), calls = [];
  const faults = { capability: 'actual', loseFinalize: false, rejectPrepare: false, rejectStorage: false };
  const storageFetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === 'POST') {
      if (faults.rejectStorage) throw new TypeError('synthetic interrupted storage');
      const form = await request.formData(); const file = form.get('file');
      objects.set(String(form.get('key')), new Uint8Array(await file.arrayBuffer()));
      calls.push({ type: 'storage', bytes: file.size });
      return new Response(null, { status: 204 });
    }
    const key = decodeURIComponent(new URL(request.url).pathname.slice(1)).replace(/^synthetic\//, '');
    const bytes = objects.get(key);
    if (!bytes) return new Response('missing synthetic object', { status: 404 });
    return new Response(request.method === 'HEAD' ? null : bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const env = runtime({ btoa, fetch: storageFetch }, {
    'cloudflare:workers': { env: { DB, S3_ACCESS_KEY: 'synthetic-secret', S3_ACCESS_KEY_ID: 'synthetic-key', S3_BUCKET: 'synthetic', S3_ENDPOINT_URL: 'https://storage.invalid' }, waitUntil(p) { void p.catch(() => {}); } },
    [resolve('db/todos.ts')]: { ensureTodoDatabase: async () => {}, getTodo: async id => sql.prepare('SELECT * FROM todos WHERE id = ?').get(id) },
  });
  const recovery = env.load('app/api/attachments/recovery/route.ts');
  const upload = env.load('app/api/todos/[id]/attachments/route.ts');
  async function fetch(input, init) {
    const request = input instanceof Request ? input : new Request(new URL(input, 'https://synthetic.test'), init);
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/')) return storageFetch(request);
    if (path === '/api/attachments/recovery') {
      const response = await recovery.POST(request);
      const body = await response.json(); calls.push({ type: 'recovery', capability: body.imageProcessingAvailable });
      if (faults.capability === 'absent') delete body.imageProcessingAvailable;
      if (faults.capability === 'stale-true') body.imageProcessingAvailable = true;
      return Response.json(body, { status: response.status, headers: response.headers });
    }
    if (path !== '/api/todos/7/attachments') throw new Error('Unexpected synthetic API route');
    const type = request.method === 'PATCH' ? 'finalize' : request.headers.get('content-type')?.includes('multipart') ? 'multipart' : 'prepare';
    calls.push({ type });
    if (type === 'prepare' && faults.rejectPrepare) return Response.json({ error: 'Synthetic retryable failure.' }, { status: 503 });
    const response = await upload[request.method](request, { params: Promise.resolve({ id: '7' }) });
    if (type === 'finalize' && response.ok && faults.loseFinalize) { faults.loseFinalize = false; return Response.json({ error: 'Synthetic gateway lost committed result.' }, { status: 503 }); }
    return response;
  }
  return { sql, objects, calls, faults, fetch, recovery, close: () => sql.close() };
}
