import type { BotAttachment } from "../../lib/bots-types";
import type { Turn } from "../../lib/codex-protocol/v2/Turn";

export type CachedBotHistory = { turns: Turn[]; attachments: BotAttachment[]; truncated?: boolean; cachedAt?: number };
const DATABASE = "dawar-bot-history-cache";
const ENTRY_LIMIT = 1024 * 1024;
const ENTRY_COUNT = 6;
let connection: Promise<IDBDatabase> | undefined;
function open() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("histories", { keyPath: ["owner", "botId"] });
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("History cache is blocked."));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      db.onclose = () => { connection = undefined; };
      resolve(db);
    };
  }).catch((error) => { connection = undefined; throw error; });
  return connection;
}
// Bound disposable storage without serializing a long conversation on each
// update. Strings dominate history size; UTF-16 gives a conservative byte cap.
function size(value: unknown, remaining: number): number {
  if (remaining < 0) return ENTRY_LIMIT + 1;
  if (typeof value === "string") return value.length * 2;
  if (!value || typeof value !== "object") return 16;
  let bytes = 0;
  for (const [key, child] of Object.entries(value)) {
    bytes += key.length * 2 + size(child, remaining - bytes);
    if (bytes > remaining) break;
  }
  return bytes;
}
export function boundedHistory(history: CachedBotHistory): CachedBotHistory | null {
  const turns: Turn[] = [];
  let bytes = size(history.attachments, ENTRY_LIMIT);
  if (bytes > ENTRY_LIMIT) return null;
  for (const turn of history.turns.slice(-100).reverse()) {
    const next = size(turn, ENTRY_LIMIT - bytes);
    if (bytes + next > ENTRY_LIMIT) break;
    turns.unshift(turn); bytes += next;
  }
  if (history.turns.length && !turns.length) return null;
  return { turns, attachments: history.attachments, truncated: Boolean(history.truncated || turns.length !== history.turns.length), cachedAt: Date.now() };
}
export async function saveBotHistory(owner: string, botId: string, history: CachedBotHistory) {
  const bounded = boundedHistory(history);
  if (!owner || !bounded) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("histories", "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
    const store = tx.objectStore("histories");
    store.put({ owner, botId, history: bounded, touched: Date.now() });
    const all = store.getAll();
    all.onsuccess = () => {
      const rows = all.result as { owner: string; botId: string; touched: number }[];
      rows.sort((a, b) => b.touched - a.touched);
      for (const row of rows.slice(ENTRY_COUNT)) store.delete([row.owner, row.botId]);
    };
  });
  // Only a committed usable cache replaces an older persistent cache.
  try { localStorage.removeItem(`dawar-bots:${owner}:history:${botId}`); } catch {}
}
export async function readBotHistory(owner: string, botId: string): Promise<CachedBotHistory | null> {
  try {
    const db = await open();
    const row = await new Promise<{ history: CachedBotHistory } | undefined>((resolve, reject) => {
      const tx = db.transaction("histories", "readonly");
      const request = tx.objectStore("histories").get([owner, botId]);
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
    if (row) return row.history;
  } catch { /* The legacy cache is still useful when IndexedDB is unavailable. */ }
  try {
    const history = JSON.parse(localStorage.getItem(`dawar-bots:${owner}:history:${botId}`) ?? "null") as CachedBotHistory | null;
    if (history && Array.isArray(history.turns) && Array.isArray(history.attachments)) {
      void saveBotHistory(owner, botId, history).catch(() => {});
      return history;
    }
  } catch { /* A disposable cache cannot block draft recovery. */ }
  return null;
}

// Keep streaming updates and navigation useful offline without writing a full
// history on every render. The performance pass can replace this cache boundary.
const pendingWrites = new Map<string, { owner: string; botId: string; history: CachedBotHistory; timer: ReturnType<typeof setTimeout> }>();
let listening = false;
export function flushBotHistories() {
  for (const [key, pending] of pendingWrites) {
    clearTimeout(pending.timer); pendingWrites.delete(key);
    void saveBotHistory(pending.owner, pending.botId, pending.history).catch(() => {});
  }
}
export function queueBotHistory(owner: string, botId: string, history: CachedBotHistory) {
  if (!listening && typeof window !== "undefined") {
    listening = true;
    window.addEventListener("pagehide", flushBotHistories);
    window.addEventListener("dawar-before-navigation", flushBotHistories);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushBotHistories(); });
  }
  const key = JSON.stringify([owner, botId]);
  clearTimeout(pendingWrites.get(key)?.timer);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    void saveBotHistory(owner, botId, history).catch(() => {});
  }, 400);
  pendingWrites.set(key, { owner, botId, history, timer });
}
