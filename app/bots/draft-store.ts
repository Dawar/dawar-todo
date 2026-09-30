import type { BotAttachment, BridgeRequest } from "../../lib/bots-types";

// Critical data only. Histories and other disposable caches never enter this DB.
export const DRAFT_DATABASE = "dawar-bot-drafts";
export type StagedFile = {
  id: string; name: string; mimeType: string; size: number;
  remote?: BotAttachment; uploadId?: string; hasBytes: boolean; error?: string;
};
export type Draft = {
  text: string; textVersion: string; files: StagedFile[]; queueId?: string; queueRevision?: number;
  queueSource?: { id: string; listId: string | null; removed: boolean };
};
export type Submission = {
  id: string; slot: string; method: "bursts.submit" | "turn.send" | "queue.add" | "queue.update" | "queue.delete" | "runs.send";
  activateFrom?: string;
  params: Record<string, unknown>; textVersion: string; fileIds: string[];
  state: "pending" | "uncertain"; error?: string;
  /** Run sends only. Absent on older rows means possibly dispatched, never prepared. */
  runDelivery?: { state: "prepared" | "possible"; token: string };
};
export type DraftRecord = {
  owner: string; botId: string; revision: string; active: string;
  slots: Record<string, Draft>; operations: Record<string, Submission>;
  /** Local Forward acceptance tombstones. Never resent or pruned with caches. */
  forwarded?: Record<string, string>;
  migrated: boolean;
};
export type RunDeliveryResult = "not-sent" | "uncertain" | "queued" | "success" | "rejected";
export type DraftChange =
  | { kind: "text"; slot: string; text: string; version: string; base: string }
  | { kind: "add"; slot: string; files: StagedFile[] }
  | { kind: "remove"; slot: string; id: string }
  | { kind: "uploaded"; id: string; uploadId: string; remote: BotAttachment }
  | { kind: "restartUpload"; id: string; uploadId: string }
  | { kind: "fileError"; id: string; error?: string }
  | { kind: "bytes"; id: string }
  | { kind: "edit"; slot: string; draft: Draft }
  | { kind: "checkout"; draft: Draft; operation: Submission }
  | { kind: "select"; slot: string }
  | { kind: "forward"; id: string; text: string; version: string }
  | { kind: "submit"; operation: Submission }
  | { kind: "run-claim"; id: string; token: string }
  | { kind: "run-result"; id: string; expectedToken: string | null; nextToken: string; outcome: RunDeliveryResult; error?: string }
  | { kind: "settle"; id: string; outcome: "success" | "rejected" | "uncertain"; error?: string };
export const emptyDraft = (): Draft => ({ text: "", textVersion: "empty", files: [] });
export const emptyRecord = (owner: string, botId: string): DraftRecord => ({
  owner, botId, revision: "empty", active: "normal", slots: { normal: emptyDraft() }, operations: {}, migrated: false,
});
export function fileReferences(record: DraftRecord) {
  return new Set([
    ...Object.values(record.slots).flatMap((d) => d.files.map((f) => f.id)),
    ...Object.values(record.operations).flatMap((op) => op.fileIds),
  ]);
}
export function fileLimit(files: Pick<StagedFile, "mimeType" | "size">[]) {
  if (files.length > 12) return "Attach at most 12 files per message.";
  if (files.filter((f) => f.mimeType.startsWith("image/")).length > 6) return "Attach at most 6 images per message.";
  if (files.some((f) => f.size > 100 * 1024 * 1024)) return "Files must be at most 100 MB.";
  return "";
}

// Used both optimistically and inside a readwrite transaction. Concurrent text
// writers retain the displaced version as a recoverable draft, never discard it.
export function changeDraft(source: DraftRecord, change: DraftChange): DraftRecord {
  const record: DraftRecord = {
    ...source, slots: Object.fromEntries(Object.entries(source.slots).map(([key, d]) => [key, { ...d, files: d.files.map((f) => ({ ...f })) }])),
    operations: { ...source.operations },
  };
  if (change.kind === "text") {
    const draft = record.slots[change.slot];
    if (!draft) throw new Error("Draft is no longer available. Reopen it before editing.");
    if (draft.textVersion !== change.base && draft.textVersion !== change.version && draft.text !== change.text) {
      record.slots[`recovered:${draft.textVersion}`] = { ...draft, files: [...draft.files] };
    }
    record.active = change.slot;
    draft.text = change.text;
    draft.textVersion = change.version;
  } else if (change.kind === "add") {
    const draft = record.slots[change.slot];
    for (const file of change.files) if (!draft.files.some((f) => f.id === file.id)) draft.files.push(file);
  } else if (change.kind === "remove") {
    record.slots[change.slot].files = record.slots[change.slot].files.filter((f) => f.id !== change.id);
  } else if (change.kind === "uploaded" || change.kind === "restartUpload" || change.kind === "fileError" || change.kind === "bytes") {
    for (const draft of Object.values(record.slots)) {
      const file = draft.files.find((f) => f.id === change.id);
      if (!file) continue; // A late upload must not resurrect a removed file.
      if (change.kind === "uploaded" && (file.uploadId ?? file.id) === change.uploadId) { file.remote = change.remote; delete file.error; }
      if (change.kind === "restartUpload" && !file.remote) { file.uploadId = change.uploadId; delete file.error; }
      if (change.kind === "fileError") file.error = change.error;
      if (change.kind === "bytes") { file.hasBytes = true; delete file.error; }
    }
  } else if (change.kind === "edit") {
    const existing = record.slots[change.slot];
    const pending = Object.values(record.operations).some((op) => op.slot === change.slot);
    if (existing && !pending && existing.queueRevision !== change.draft.queueRevision) {
      // A later server revision must not silently inherit an older edit. Keep
      // its exact text/file references in the established recovery surface.
      if (existing.text || existing.files.length) record.slots[`recovered:${existing.textVersion}`] = { ...existing, files: [...existing.files] };
      record.slots[change.slot] = change.draft;
    } else if (!existing || (!existing.text && !existing.files.length && !pending)) record.slots[change.slot] = change.draft;
    record.active = change.slot;
  } else if (change.kind === "checkout") {
    // Snapshot and exact removal identity commit together before any RPC.
    // Concurrent tabs adopt the original operation for this queue revision.
    const saved = record.slots[change.operation.slot];
    if (saved?.queueSource?.removed || Object.values(record.operations).some(op => op.slot === change.operation.slot)) return source;
    record.slots[change.operation.slot] = saved ?? change.draft;
    record.operations[change.operation.id] = change.operation;
  } else if (change.kind === "select") {
    if (record.slots[change.slot]) record.active = change.slot;
  } else if (change.kind === "forward") {
    if (record.forwarded?.[change.id]) return source;
    // Forward is always an unsent normal draft, never an edit to a queued or
    // recovered submission. The same transaction appends and records identity.
    const draft = record.slots.normal;
    draft.text = draft.text ? `${draft.text}\n\n---\n\n${change.text}` : change.text;
    draft.textVersion = change.version;
    record.forwarded = { ...record.forwarded, [change.id]: "normal" };
    record.active = "normal";
  } else if (change.kind === "submit") {
    const op = change.operation;
    // Two tabs submitting the same slot share the first durable operation.
    if (!Object.values(record.operations).some((p) => p.slot === op.slot)) {
      const draft = record.slots[op.slot];
      if (!draft || draft.textVersion !== op.textVersion ||
          JSON.stringify(draft.files.map((f) => f.id)) !== JSON.stringify(op.fileIds))
        throw Object.assign(new Error("The draft changed in another tab. Review it before sending."), { name: "DraftChangedError" });
      record.operations[op.id] = op;
    }
  } else if (change.kind === "run-claim") {
    const op = record.operations[change.id];
    if (op?.method !== "runs.send" || op.runDelivery?.state !== "prepared") return source;
    record.operations[op.id] = { ...op, runDelivery: { state: "possible", token: change.token }, error: undefined };
  } else if (change.kind === "run-result") {
    const op = record.operations[change.id];
    // A delayed attempt cannot release a newer claim, overwrite server evidence,
    // or recreate an operation already retired by another tab.
    if (op?.method !== "runs.send" || (op.runDelivery?.token ?? null) !== change.expectedToken) return source;
    if (change.outcome === "success" || change.outcome === "rejected")
      return changeDraft(record, { kind: "settle", id: op.id, outcome: change.outcome, error: change.error });
    record.operations[op.id] = { ...op, state: change.outcome === "not-sent" ? "pending" : "uncertain", error: change.error,
      ...(change.outcome === "uncertain" ? {} : { runDelivery: { state: change.outcome === "not-sent" ? "prepared" : "possible", token: change.nextToken } }) };
  } else if (change.kind === "settle") {
    const op = record.operations[change.id];
    if (!op) return source; // A repeated acknowledgement is harmless.
    if (change.outcome === "uncertain") {
      record.operations[op.id] = { ...op, state: "uncertain", error: change.error };
    } else {
      delete record.operations[op.id];
      const draft = record.slots[op.slot];
      if (op.method === "queue.delete") {
        // Removal confirms draft ownership, not delivery. Never clear its files.
        if (change.outcome === "success" && draft) {
          if (draft.queueSource) draft.queueSource = { ...draft.queueSource, removed: true };
          if (record.active === op.activateFrom) record.active = op.slot;
        }
      } else if (change.outcome === "success" && draft) {
        if (draft.textVersion === op.textVersion) {
          draft.text = "";
          draft.textVersion = `ack:${op.id}`;
        }
        draft.files = draft.files.filter((f) => !op.fileIds.includes(f.id));
        if (!draft.text && !draft.files.length && op.slot !== "normal" && record.active === op.slot)
          record.active = "normal";
      }
    }
  }
  return record;
}

type FileRow = { owner: string; botId: string; id: string; blob: Blob };
export class BotDraftStore {
  private connection?: Promise<IDBDatabase>;
  constructor(private factory: IDBFactory = indexedDB, private legacy?: Storage, private database = DRAFT_DATABASE) {}
  private open() {
    if (!this.connection) {
      this.connection = new Promise<IDBDatabase>((resolve, reject) => {
        const request = this.factory.open(this.database, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("drafts", { keyPath: ["owner", "botId"] }).createIndex("owner", "owner");
          db.createObjectStore("files", { keyPath: ["owner", "botId", "id"] });
        };
        request.onerror = () => reject(request.error ?? new Error("Draft storage could not open."));
        request.onblocked = () => reject(new Error("Draft storage is blocked by another tab. Close older app tabs and retry."));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.connection = undefined; };
          db.onclose = () => { this.connection = undefined; };
          resolve(db);
        };
      }).catch((error) => { this.connection = undefined; throw error; });
    }
    return this.connection;
  }
  private async transaction<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void) {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      // Resolve only on commit, never on a successful individual request.
      const tx = db.transaction(stores, mode, mode === "readwrite" ? { durability: "strict" } : undefined);
      let value: T;
      let failure: unknown;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Draft storage transaction was aborted. Your unsaved changes are still in this tab."));
      tx.onerror = () => { /* onabort reports the transaction's final outcome */ };
      try { work(tx, (next) => { value = next; }, (error) => { failure = error; tx.abort(); }); }
      catch (error) { failure = error; tx.abort(); }
    });
  }
  async get(owner: string, botId: string): Promise<DraftRecord | undefined> {
    return this.transaction(["drafts"], "readonly", (tx, done) => {
      const request = tx.objectStore("drafts").get([owner, botId]);
      request.onsuccess = () => done(request.result);
    });
  }
  async list(owner: string): Promise<DraftRecord[]> {
    return this.transaction(["drafts"], "readonly", (tx, done) => {
      const request = tx.objectStore("drafts").index("owner").getAll(owner);
      request.onsuccess = () => done((request.result as DraftRecord[]).filter((r) => r.owner === owner));
    });
  }
  async file(owner: string, botId: string, id: string): Promise<Blob | undefined> {
    return this.transaction(["files"], "readonly", (tx, done) => {
      const request = tx.objectStore("files").get([owner, botId, id]);
      request.onsuccess = () => done((request.result as FileRow | undefined)?.blob);
    });
  }
  async change(owner: string, botId: string, change: DraftChange, bytes: Map<string, Blob> = new Map()): Promise<DraftRecord> {
    if (!owner || !botId) throw new Error("Sign in as the bot owner before saving a draft.");
    return this.transaction(["drafts", "files"], "readwrite", (tx, done, fail) => {
      const drafts = tx.objectStore("drafts"), files = tx.objectStore("files");
      const request = drafts.get([owner, botId]);
      request.onsuccess = () => {
        try {
          const previous = request.result as DraftRecord | undefined;
          if (!previous?.migrated) throw new Error("Recover the existing draft before changing it.");
          const record = changeDraft(previous, change);
          record.revision = crypto.randomUUID();
          const refs = fileReferences(record);
          for (const [id, blob] of bytes) if (refs.has(id)) files.put({ owner, botId, id, blob } satisfies FileRow);
          for (const id of fileReferences(previous)) if (!refs.has(id)) files.delete([owner, botId, id]);
          drafts.put(record);
          done(record);
        } catch (error) {
          fail(error);
        }
      };
    });
  }
  private legacySeed(owner: string, botId: string) {
    const record = emptyRecord(owner, botId);
    if (!this.legacy) return record;
    const read = <T,>(key: string, fallback: T): T => {
      const raw = this.legacy!.getItem(`dawar-bots:${owner}:${key}`);
      if (raw === null) return fallback;
      try { return JSON.parse(raw) as T; }
      catch { throw new Error("An older bot draft could not be read. Its original data has been kept; retry recovery before editing."); }
    };
    const text = read(`draft:${botId}`, "");
    const uploads = read<BotAttachment[]>(`uploads:${botId}`, []);
    if (typeof text !== "string" || !Array.isArray(uploads) || uploads.some((a) => !a || typeof a.id !== "string" || a.botId !== botId || typeof a.name !== "string" || typeof a.mimeType !== "string" || !Number.isFinite(a.size)))
      throw new Error("An older bot draft has invalid data. Its originals have been kept for recovery.");
    record.slots.normal = { text, textVersion: "legacy", files: uploads.map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, remote: a, hasBytes: false })) };
    const operations = read<Record<string, BridgeRequest>>("operations", {});
    if (!operations || typeof operations !== "object" || Array.isArray(operations)) throw new Error("Older pending bot sends could not be read. Original data has been kept.");
    for (const op of Object.values(operations)) {
      if (op.botId !== botId || !["turn.send", "queue.add", "queue.update"].includes(op.method)) continue;
      if (!op.operationId || !op.params || typeof op.params.text !== "string") throw new Error("An older pending send could not be recovered. Original data has been kept.");
      record.operations[op.operationId] = {
        id: op.operationId, slot: "normal", method: op.method as Submission["method"], params: op.params,
        // Old sends did not capture versions. Never guess that the current draft
        // is the submitted one; retain it for review after reconciliation.
        textVersion: "legacy-unverifiable", fileIds: [], state: "uncertain",
        error: "Recovered an older submitted message. Check its acknowledgement before sending again.",
      };
    }
    return record;
  }
  async load(owner: string, botId: string) {
    const existing = await this.get(owner, botId);
    if (existing?.migrated) return existing;
    const seed = this.legacySeed(owner, botId);
    return this.transaction<DraftRecord>(["drafts"], "readwrite", (tx, done, fail) => {
      const store = tx.objectStore("drafts");
      const request = store.get([owner, botId]);
      request.onsuccess = () => {
        try {
          const record: DraftRecord = request.result ?? { ...seed, migrated: true, revision: crypto.randomUUID() };
          store.put(record);
          done(record);
        } catch (error) { fail(error); }
      };
      // Legacy entries deliberately remain intact, including after success.
      // The committed migrated marker prevents resurrection on subsequent loads.
    });
  }
  legacyBotIds(owner: string) {
    if (!this.legacy) return [];
    const ids = new Set<string>();
    const prefix = `dawar-bots:${owner}:`;
    for (let i = 0; i < this.legacy.length; i++) {
      const key = this.legacy.key(i);
      if (key?.startsWith(`${prefix}draft:`)) ids.add(key.slice(`${prefix}draft:`.length));
      if (key?.startsWith(`${prefix}uploads:`)) ids.add(key.slice(`${prefix}uploads:`.length));
    }
    const raw = this.legacy.getItem(`${prefix}operations`);
    if (raw) {
      const ops = JSON.parse(raw) as Record<string, BridgeRequest>;
      for (const op of Object.values(ops)) if (op.botId && ["turn.send", "queue.add", "queue.update"].includes(op.method)) ids.add(op.botId);
    }
    return [...ids];
  }
}
