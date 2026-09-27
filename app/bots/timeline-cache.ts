import { historyBefore, historyKey, type HistoryEntry, type HistoryPosition, type HistoryGap } from "../../lib/bot-history-view";
import type { BotAttachment } from "../../lib/bots-types";

export type TimelineMetadata = {
  owner: string; botId: string; revision: string; eventCursor: number;
  order: string[]; partialTurn?: boolean; olderCursor: string | null; complete: boolean;
  attachments: BotAttachment[]; contextEntries?: HistoryEntry[]; gaps?: HistoryGap[]; position?: HistoryPosition; touched: number;
};
export type TimelineCacheValue = { metadata: TimelineMetadata; entries: HistoryEntry[] };
const MAX_THREADS = 12, MAX_ENTRIES = 2000;

/** Only disposable history lives here. Draft/outbox/blob stores are never opened. */
export function createTimelineCache(factory?: IDBFactory) {
  let connection: Promise<IDBDatabase> | undefined;
  function open() {
    connection ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = (factory ?? indexedDB).open("dawar-bot-timeline-v1", 1);
      request.onupgradeneeded = () => {
        const meta = request.result.createObjectStore("threads", { keyPath: ["owner", "botId"] });
        meta.createIndex("touched", "touched"); meta.createIndex("owner", "owner");
        const items = request.result.createObjectStore("items", { keyPath: ["owner", "botId", "key"] });
        items.createIndex("thread", ["owner", "botId"]);
      };
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
  function transaction<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (tx: IDBTransaction, value: (result: T) => void) => void) {
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(["threads", "items"], mode); let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(tx.error ?? new Error("History transaction aborted."));
      tx.onerror = () => {}; // onabort owns rejection, after rollback.
      run(tx, (value) => { result = value; });
    });
  }
  const remove = (tx: IDBTransaction, owner: string, botId: string) => {
    tx.objectStore("threads").delete([owner, botId]);
    const cursor = tx.objectStore("items").index("thread").openKeyCursor(IDBKeyRange.only([owner, botId]));
    cursor.onsuccess = () => { if (cursor.result) { tx.objectStore("items").delete(cursor.result.primaryKey); cursor.result.continue(); } };
  };
  return {
    async read(owner: string, botId: string): Promise<TimelineCacheValue | null> {
      if (!owner) return null;
      const db = await open();
      return transaction(db, "readonly", (tx, done) => {
        const request = tx.objectStore("threads").get([owner, botId]);
        request.onsuccess = () => {
          const metadata = request.result as TimelineMetadata | undefined;
          if (!metadata) { done(null); return; }
          const entries: HistoryEntry[] = [];
          for (const key of metadata.order) {
            const item = tx.objectStore("items").get([owner, botId, key]);
            item.onsuccess = () => { if (item.result) entries.push(item.result.entry); };
          }
          done({ metadata, entries });
        };
      });
    },
    async write(metadata: TimelineMetadata, dirty: HistoryEntry[]): Promise<void> {
      if (!metadata.owner) return;
      const db = await open();
      return transaction(db, "readwrite", (tx, done) => {
        const old = tx.objectStore("threads").get([metadata.owner, metadata.botId]);
        old.onsuccess = () => {
          const order = metadata.order.slice(-MAX_ENTRIES), keep = new Set(order);
          const pruned = order.length !== metadata.order.length;
          const first = dirty.find((item) => historyKey(item.turnId, item.id) === order[0]);
          for (const key of (old.result?.order ?? []) as string[]) if (!keep.has(key)) tx.objectStore("items").delete([metadata.owner, metadata.botId, key]);
          for (const entry of dirty) {
            const key = historyKey(entry.turnId, entry.id);
            if (keep.has(key)) tx.objectStore("items").put({ owner: metadata.owner, botId: metadata.botId, key, entry });
          }
          const save = (oldest?: HistoryEntry) => tx.objectStore("threads").put({ ...metadata, order,
            ...(pruned ? { complete: false, olderCursor: oldest ? historyBefore(oldest) : metadata.olderCursor } : {}) });
          if (pruned && !first) {
            const item = tx.objectStore("items").get([metadata.owner, metadata.botId, order[0]]);
            item.onsuccess = () => save(item.result?.entry);
          } else save(first);
          // Eviction traverses only small metadata, never getAll() history bodies.
          const cursor = tx.objectStore("threads").index("touched").openCursor(null, "prev"); let count = 0;
          cursor.onsuccess = () => {
            if (!cursor.result) return;
            const value = cursor.result.value as TimelineMetadata;
            if (++count > MAX_THREADS) remove(tx, value.owner, value.botId);
            cursor.result.continue();
          };
          done(undefined);
        };
      });
    },
    async clearOwner(owner: string) {
      const db = await open();
      return transaction<void>(db, "readwrite", (tx, done) => {
        const cursor = tx.objectStore("threads").index("owner").openCursor(IDBKeyRange.only(owner));
        cursor.onsuccess = () => { if (cursor.result) { remove(tx, owner, cursor.result.value.botId); cursor.result.continue(); } };
        done(undefined);
      });
    },
    async close() { (await connection)?.close(); connection = undefined; },
  };
}
export const timelineCache = createTimelineCache();
