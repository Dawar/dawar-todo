/** Disposable, owner-scoped gallery pages and thumbnails. Never opens draft/file stores. */
let database: Promise<IDBDatabase> | undefined;
const limits = { page: { count: 16, bytes: 2 * 1024 * 1024 }, preview: { count: 48, bytes: 8 * 1024 * 1024 } };
type Kind = keyof typeof limits;
function open() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("dawar-bot-artifact-gallery-v1", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("data");
      request.result.createObjectStore("metadata", { keyPath: "key" }).createIndex("kindTouched", ["kind", "touched"]);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Gallery cache is unavailable."));
    request.onsuccess = () => {
      const db = request.result; db.onversionchange = () => { db.close(); database = undefined; };
      db.onclose = () => { database = undefined; }; resolve(db);
    };
  }).catch((error) => { database = undefined; throw error; });
  return database;
}
export async function readArtifactCache<T>(owner: string, kind: Kind, id: string): Promise<T | null> {
  if (!owner) return null;
  try {
    const db = await open();
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction("data").objectStore("data").get(JSON.stringify([owner, kind, id]));
      request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}
export async function writeArtifactCache(owner: string, kind: Kind, id: string, value: unknown) {
  if (!owner) return;
  const bytes = value instanceof Blob ? value.size : new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > limits[kind].bytes / 2) return;
  try {
    const db = await open(), key = JSON.stringify([owner, kind, id]);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["data", "metadata"], "readwrite");
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => {};
      tx.objectStore("data").put(value, key);
      tx.objectStore("metadata").put({ key, kind, bytes, touched: Date.now() });
      const request = tx.objectStore("metadata").index("kindTouched").openCursor(IDBKeyRange.bound([kind, 0], [kind, Number.MAX_SAFE_INTEGER]), "prev");
      let count = 0, total = 0;
      request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return;
        total += cursor.value.bytes;
        if (++count > limits[kind].count || total > limits[kind].bytes) { tx.objectStore("data").delete(cursor.value.key); cursor.delete(); }
        cursor.continue();
      };
    });
  } catch { /* Disposable preview failure never changes drafts or original files. */ }
}
