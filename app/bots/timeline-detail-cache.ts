import type { ThreadItem } from "../../lib/codex-protocol/v2/ThreadItem";
import type { BotAttachment, BotRunContext } from "../../lib/bots-types";
const LIMIT = 4 * 1024 * 1024, TOTAL = 12 * 1024 * 1024;
const connections = new Map<string, Promise<IDBDatabase>>();
function open(namespace = "main") {
  let connection = connections.get(namespace);
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(namespace === "main" ? "dawar-bot-opened-details-v1" : "dawar-bot-run-details-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("bodies");
      request.result.createObjectStore("metadata", { keyPath: "key" }).createIndex("touched", "touched");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); connections.delete(namespace); }; resolve(request.result); };
  }).catch((error) => { connections.delete(namespace); throw error; });
  connections.set(namespace, connection);
  return connection;
}
export async function readOpenedDetail(owner: string, botId: string, key: string, namespace = "main"): Promise<{ item: ThreadItem; attachments: BotAttachment[]; savedAt: number; version: string } | null> {
  const db = await open(namespace);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["bodies", "metadata"]), storedKey = JSON.stringify([owner, botId, key]);
    const body = tx.objectStore("bodies").get(storedKey), metadata = tx.objectStore("metadata").get(storedKey);
    tx.oncomplete = () => {
      const value = body.result, meta = metadata.result;
      resolve(value && meta?.version === value.version && meta.attachments
        ? { ...value, attachments: meta.attachments, savedAt: meta.touched } : value ?? null);
    };
    tx.onabort = () => reject(tx.error); tx.onerror = () => {};
  });
}
/** Refresh metadata without reserializing or cloning the unchanged native body. */
export async function updateOpenedDetailAttachments(owner: string, botId: string, itemKey: string, attachments: BotAttachment[], version: string, namespace = "main", current = () => true) {
  const db = await open(namespace), key = JSON.stringify([owner, botId, itemKey]);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("metadata", "readwrite"), store = tx.objectStore("metadata"), request = store.get(key);
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    request.onsuccess = () => {
      const prior = request.result;
      // Legacy metadata has no version; a concurrent newer body save does.
      if (current() && prior && (!prior.version || prior.version === version)) store.put({ ...prior, attachments, version, touched: Date.now() });
    };
  });
}
/** Completed on-demand details only. Streaming tokens never serialize this store. */
export async function saveOpenedDetail(owner: string, botId: string, itemKey: string, item: ThreadItem, attachments: BotAttachment[], version: string, namespace = "main", current = () => true) {
  const bytes = new TextEncoder().encode(JSON.stringify(item)).length;
  if (bytes > LIMIT) return false;
  const db = await open(namespace), key = JSON.stringify([owner, botId, itemKey]);
  if (!current()) return false;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["bodies", "metadata"], "readwrite"), touched = Date.now();
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    tx.objectStore("bodies").put({ item, attachments, savedAt: touched, version }, key);
    tx.objectStore("metadata").put({ key, bytes, touched, version });
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

/** Only the bounded run-detail metadata is walked, never bodies or main cache. */
export async function invalidateOpenedRunDetails(owner: string, botId: string, context: BotRunContext, turnId: string, itemId: string) {
  const db = await open("run");
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["bodies", "metadata"], "readwrite");
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
    const request = tx.objectStore("metadata").openCursor(); let count = 0;
    request.onsuccess = () => {
      const row = request.result; if (!row || count++ >= 12) return;
      try {
        const [savedOwner, savedBot, key] = JSON.parse(String(row.key));
        const [source, item] = JSON.parse(key), [savedTurn, savedItem] = JSON.parse(item);
        if (savedOwner === owner && savedBot === botId && source.runId === context.runId && source.laneId === context.laneId && source.threadId === context.threadId && savedTurn === turnId && itemId === savedItem) {
          tx.objectStore("bodies").delete(row.key); row.delete();
        }
      } catch { /* A foreign/older cache key is not a matching run body. */ }
      row.continue();
    };
  });
}
