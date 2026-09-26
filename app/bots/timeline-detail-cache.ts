import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";
import type { BotAttachment } from "../../lib/bots-types";
const LIMIT = 4 * 1024 * 1024, TOTAL = 12 * 1024 * 1024;
let connection: Promise<IDBDatabase> | undefined;
function open() {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("dawar-bot-opened-details-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("bodies");
      request.result.createObjectStore("metadata", { keyPath: "key" }).createIndex("touched", "touched");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connection = undefined; }; resolve(request.result); };
  }).catch((error) => { connection = undefined; throw error; });
  return connection;
}
export async function readOpenedDetail(owner: string, botId: string, key: string): Promise<{ item: ThreadItem; attachments: BotAttachment[]; savedAt: number; version: string } | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("bodies").objectStore("bodies").get(JSON.stringify([owner, botId, key]));
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
  });
}
/** Completed on-demand details only. Streaming tokens never serialize this store. */
export async function saveOpenedDetail(owner: string, botId: string, itemKey: string, item: ThreadItem, attachments: BotAttachment[], version: string) {
  const bytes = new TextEncoder().encode(JSON.stringify(item)).length;
  if (bytes > LIMIT) return false;
  const db = await open(), key = JSON.stringify([owner, botId, itemKey]);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["bodies", "metadata"], "readwrite"), touched = Date.now();
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    tx.objectStore("bodies").put({ item, attachments, savedAt: touched, version }, key);
    tx.objectStore("metadata").put({ key, bytes, touched });
    // Metadata-only eviction; no full-body getAll/clone while pruning.
    const request = tx.objectStore("metadata").index("touched").openCursor(null, "prev"); let size = 0, count = 0;
    request.onsuccess = () => {
      const cursor = request.result; if (!cursor) return;
      size += cursor.value.bytes; count++;
      if (size > TOTAL || count > 12) { tx.objectStore("bodies").delete(cursor.value.key); cursor.delete(); }
      cursor.continue();
    };
  });
  return true;
}
