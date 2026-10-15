import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { runtime } from './helpers/load-ts.mjs';

// The real draft CAS (db/bot-composer-drafts.ts) over a D1-shaped SQLite.
function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  return { prepare: sql => ({ bind: (...args) => ({ first: async () => db.prepare(sql).get(...args) ?? null, run: async () => db.prepare(sql).run(...args) }) }) };
}
function storage() {
  const entries = new Map();
  return { get length() { return entries.size; }, key: i => [...entries.keys()][i] ?? null, getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, String(v)), removeItem: k => entries.delete(k) };
}
async function until(check, label) { for (let i = 0; i < 300; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail(label); }

function server() {
  const env = runtime({ localStorage: storage() }), db = d1();
  const { readComposerDraft, writeComposerDraft } = env.load('db/bot-composer-drafts.ts');
  const state = { down: false, calls: 0 };
  const fetch = async (url, init = {}) => {
    state.calls++;
    const u = new URL(url, 'https://work.example.test'), owner = u.searchParams.get('owner'), botId = u.searchParams.get('botId');
    if (state.down) return Response.json({ error: 'Draft sync unavailable; local text is retained.' }, { status: 503 });
    if ((init.method ?? 'GET') === 'GET') return Response.json({ owner, botId, draft: await readComposerDraft(db, owner, botId) });
    return Response.json({ owner, botId, ...await writeComposerDraft(db, owner, botId, JSON.parse(init.body)) });
  };
  return { fetch, state };
}
function device(fetch) {
  const env = runtime({ localStorage: storage(), fetch, EventSource: undefined, URLSearchParams, Error, TypeError });
  const { BotDraftStore } = env.load('app/bots/draft-store.ts');
  const { BotComposer } = env.load('app/bots/composer-controller.ts');
  const { ComposerDraftSync } = env.load('app/bots/composer-draft-sync.ts');
  const store = new BotDraftStore(env.indexedDB, storage());
  const transport = { owner: 'alice', online: true, rpc: async () => ({}), upload: async () => ({}), download: async () => ({}) };
  let sync;
  const composer = new BotComposer('alice', 'bot-a', store, transport, () => sync?.schedule());
  sync = new ComposerDraftSync(composer, store, () => true);
  return { composer, sync };
}

test('per-bot drafts move between devices, survive a sync outage and resume after reconnect', async () => {
  const hub = server();
  const phone = device(hub.fetch), laptop = device(hub.fetch);
  await phone.composer.open(); await laptop.composer.open();
  phone.sync.select(true);
  phone.composer.setText('started on the phone');
  await until(async () => { const r = await hub.fetch('/api/bots/drafts?owner=alice&botId=bot-a'); return (await r.json()).draft.content?.text === 'started on the phone'; }, 'phone draft reached the server');
  laptop.sync.select(true);
  await until(() => laptop.composer.draft.text === 'started on the phone', 'laptop adopts the central draft');
  // The site is unreachable while the laptop keeps typing: nothing is lost.
  hub.state.down = true;
  laptop.composer.setText('started on the phone, finished on the laptop');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(laptop.composer.draft.text, 'started on the phone, finished on the laptop', 'local text retained during outage');
  hub.state.down = false;
  laptop.sync.refresh();
  phone.sync.refresh();
  await until(async () => { phone.sync.refresh(); return phone.composer.draft.text === 'started on the phone, finished on the laptop'; }, 'reconnect delivers the laptop edit to the phone');
  phone.sync.select(false); laptop.sync.select(false);
});
