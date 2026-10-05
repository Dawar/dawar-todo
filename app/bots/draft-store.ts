import type { BotReplyReference } from "../../lib/bot-replies";
import type { BotAttachment, BridgeRequest } from "../../lib/bots-types";
import { pdfReviewTarget, pdfReviewMessage } from "./pdf-review";

// Critical data only. Histories and other disposable caches never enter this DB.
export const DRAFT_DATABASE = "dawar-bot-drafts";
export const PORTABLE_COMPOSER = "portable:composer:v1";
export type StagedFile = {
  /** PDF review note page; ordinary composer files leave this absent. */
  reviewPage?: number;
  id: string; name: string; mimeType: string; size: number;
  remote?: BotAttachment; uploadId?: string; uploadMode?: "cloud" | "legacy"; hasBytes: boolean; error?: string;
  uploadBotId?: string;
  copies?: Record<string, BotAttachment>;
  copyIds?: Record<string, string>;
};
export type Draft = {
  reply?: BotReplyReference;
  text: string; textVersion: string; files: StagedFile[]; queueId?: string; queueRevision?: number;
  queueSource?: { id: string; listId: string | null; removed: boolean };
};
export type Submission = {
  botId?: string;
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
  portableSeeded?: boolean;
  checkedOut?: Record<string, boolean>;
  clipboardSource?: { botId: string; storageKey: string; slot: string; fingerprint: string };
  receivedTransfers?: Record<string, string>;
  restoredTo?: string;
  restoredFingerprint?: string;
};
export type RunDeliveryResult = "not-sent" | "uncertain" | "queued" | "success" | "rejected";
export type DraftChange =
  | { kind: "text"; slot: string; text: string; version: string; base: string }
  | { kind: "reply"; slot: string; reply?: BotReplyReference; version: string; base: string }
  | { kind: "add"; slot: string; files: StagedFile[] }
  | { kind: "remove"; slot: string; id: string }
  | { kind: "uploaded"; id: string; uploadId: string; remote: BotAttachment }
  | { kind: "restartUpload"; id: string; uploadId: string }
  | { kind: "uploadMode"; id: string; mode: "cloud" | "legacy"; botId?: string }
  | { kind: "copyIdentity"; id: string; botId: string; copyId: string }
  | { kind: "copied"; id: string; botId: string; remote: BotAttachment }
  | { kind: "normalize" }
  | { kind: "fileError"; id: string; error?: string }
  | { kind: "bytes" | "bytesAbsent"; id: string }
  | { kind: "edit"; slot: string; draft: Draft }
  | { kind: "checkout"; draft: Draft; operation: Submission }
  | { kind: "select"; slot: string }
  | { kind: "forward"; id: string; text: string; version: string }
  | { kind: "submit"; operation: Submission }
  | { kind: "run-claim"; id: string; token: string }
  | { kind: "run-result"; id: string; expectedToken: string | null; nextToken: string; outcome: RunDeliveryResult; error?: string }
  | { kind: "settle"; id: string; outcome: "success" | "rejected" | "uncertain"; error?: string };
export const emptyDraft = (): Draft => ({ text: "", textVersion: "empty", files: [] });
// No-reply drafts retain172's fingerprint, including legacy restore receipts.
export const draftFingerprint = (record: DraftRecord) => JSON.stringify([record.active, record.slots[record.active].textVersion, record.slots[record.active].files.map(file => file.id), ...(record.slots[record.active].reply ? [record.slots[record.active].reply] : [])]);
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
  const promoteNormal = (draft: Draft, slot: string) => {
    const previous = record.slots.normal;
    if (previous !== draft && (previous.text || previous.files.length || previous.reply) && previous.textVersion !== draft.textVersion)
      record.slots[`recovered:${previous.textVersion}`] = previous;
    const { queueId, queueRevision, queueSource, ...plain } = draft;
    void queueId; void queueRevision; void queueSource;
    record.slots.normal = { ...plain, files: plain.files.map(file => file.remote?.ready ? { ...file, error: undefined } : file) };
    if (slot !== "normal") delete record.slots[slot];
    record.active = "normal";
  };
  if (change.kind === "normalize") {
    if (!Object.keys(record.operations).length && record.slots[record.active]?.queueSource?.removed)
      promoteNormal(record.slots[record.active], record.active);
    for (const draft of Object.values(record.slots)) for (const file of draft.files)
      if (file.remote?.ready) delete file.error;
  } else if (change.kind === "text" || change.kind === "reply") {
    const draft = record.slots[change.slot];
    if (!draft) throw new Error("Draft is no longer available. Reopen it before editing.");
    if (draft.textVersion !== change.base && draft.textVersion !== change.version && (change.kind === "reply" || draft.text !== change.text)) {
      record.slots[`recovered:${draft.textVersion}`] = { ...draft, files: [...draft.files] };
    }
    record.active = change.slot;
    if (change.kind === "text") draft.text = change.text;
    else draft.reply = change.reply;
    draft.textVersion = change.version;
  } else if (change.kind === "add") {
    const draft = record.slots[change.slot];
    for (const file of change.files) if (!draft.files.some((f) => f.id === file.id)) draft.files.push(file);
  } else if (change.kind === "remove") {
    record.slots[change.slot].files = record.slots[change.slot].files.filter((f) => f.id !== change.id);
  } else if (change.kind === "uploaded" || change.kind === "restartUpload" || change.kind === "uploadMode" || change.kind === "fileError" || change.kind === "bytes" || change.kind === "bytesAbsent" || change.kind === "copyIdentity" || change.kind === "copied") {
    for (const draft of Object.values(record.slots)) {
      const file = draft.files.find((f) => f.id === change.id);
      if (!file) continue; // A late upload must not resurrect a removed file.
      if (change.kind === "uploaded" && (file.uploadId ?? file.id) === change.uploadId) { file.remote = change.remote; delete file.error; }
      if (change.kind === "restartUpload" && !file.remote) { file.uploadId = change.uploadId; delete file.error; }
      if (change.kind === "uploadMode" && !file.remote && !file.uploadMode) { file.uploadMode = change.mode; file.uploadBotId = change.botId; }
      if (change.kind === "copyIdentity") file.copyIds = { ...file.copyIds, [change.botId]: file.copyIds?.[change.botId] ?? change.copyId };
      if (change.kind === "copied") file.copies = { ...file.copies, [change.botId]: change.remote };
      if (change.kind === "fileError") file.error = change.error;
      if (change.kind === "bytes") { file.hasBytes = true; delete file.error; }
      if (change.kind === "bytesAbsent" && file.remote?.ready) { file.hasBytes = false; delete file.error; }
    }
  } else if (change.kind === "edit") {
    const existing = record.slots[change.slot];
    const pending = Object.values(record.operations).some((op) => op.slot === change.slot);
    if (existing && !pending && existing.queueRevision !== change.draft.queueRevision) {
      // A later server revision must not silently inherit an older edit. Keep
      // its exact text/file references in the established recovery surface.
      if (existing.text || existing.files.length || existing.reply) record.slots[`recovered:${existing.textVersion}`] = { ...existing, files: [...existing.files] };
      record.slots[change.slot] = change.draft;
    } else if (!existing || (!existing.text && !existing.files.length && !existing.reply && !pending)) record.slots[change.slot] = change.draft;
    record.active = change.slot;
  } else if (change.kind === "checkout") {
    // Snapshot and exact removal identity commit together before any RPC.
    // Concurrent tabs adopt the original operation for this queue revision.
    const saved = record.slots[change.operation.slot];
    if (record.checkedOut?.[change.operation.slot] || saved?.queueSource?.removed || Object.values(record.operations).some(op => op.slot === change.operation.slot)) return source;
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
          record.checkedOut = { ...record.checkedOut, [op.slot]: true };
          promoteNormal(draft, op.slot);
        }
      } else if (change.outcome === "success" && draft) {
        if (draft.textVersion === op.textVersion) {
          delete draft.reply;
          draft.text = "";
          draft.textVersion = `ack:${op.id}`;
        }
        draft.files = draft.files.filter((f) => !op.fileIds.includes(f.id));
        if (!draft.text && !draft.files.length && !draft.reply && op.slot !== "normal" && record.active === op.slot)
          record.active = "normal";
      }
    }
  }
  return record;
}

type FileRow = { owner: string; botId: string; id: string; blob: Blob };
const plainTransferredDraft = (source:Draft,botId:string):Draft => ({
  text:source.text,textVersion:source.textVersion,...(source.reply ? { reply: {...source.reply} } : {}),files:source.files.map(file=>({...JSON.parse(JSON.stringify(file)),uploadBotId:file.uploadBotId??file.remote?.botId??botId}))
});
function copyDraftBytes(tx:IDBTransaction,owner:string,from:string,to:string,draft:Draft,changed:()=>void,fail:(error:unknown)=>void){
  const files=tx.objectStore("files");
  for(const file of draft.files)if(file.hasBytes){
    const request=files.get([owner,from,file.id]);request.onsuccess=()=>{
      const row=request.result as FileRow|undefined;
      if(!row){if(file.remote?.ready){file.hasBytes=false;changed();}else fail(new Error(`Saved bytes for ${file.name} are unavailable. Original drafts are retained.`));return;}
      if(row.blob.size!==file.size){fail(new Error(`Saved bytes for ${file.name} failed validation. Original drafts are retained.`));return;}
      files.put({...row,botId:to});
    };
  }
}

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
  /** Adopt the first selected legacy draft atomically; keep all other originals. */
  async seedPortable(owner: string, sourceBotId: string, restore = false) {
    await this.load(owner, PORTABLE_COMPOSER);
    await this.load(owner, sourceBotId);
    return this.transaction<DraftRecord>(["drafts", "files"], "readwrite", (tx, done, fail) => {
      const drafts = tx.objectStore("drafts"), files = tx.objectStore("files");
      const sourceRequest = drafts.get([owner, sourceBotId]), targetRequest = drafts.get([owner, PORTABLE_COMPOSER]);
      let source: DraftRecord | undefined, target: DraftRecord | undefined;
      const seed = () => {
        if (!source || !target) return;
        if (target.portableSeeded && !restore) { done(target); return; }
        const sourceSlot = restore || source.slots[source.active].queueId ? "normal" : source.active;
        const draft = source.slots[sourceSlot];
        if (Object.keys(source.operations).length) { if (restore) { fail(new Error("Confirm the original send before restoring this draft.")); return; } done(target); return; }
        target.portableSeeded = true;
        if (!Object.keys(source.operations).length && !draft.queueId && (!draft.queueSource || draft.queueSource.removed) &&
            !Object.keys(target.operations).length && (restore || !target.slots.normal.text && !target.slots.normal.files.length && !target.slots.normal.reply)) {
          const { queueId, queueRevision, queueSource, ...plain } = draft;
          void queueId; void queueRevision; void queueSource;
          if (restore && (target.slots.normal.text || target.slots.normal.files.length || target.slots.normal.reply)) target.slots[`recovered:${target.slots.normal.textVersion}`] = target.slots.normal;
          target.active = "normal";
          target.slots.normal = { ...plain, files: plain.files.map(file => ({ ...file, uploadBotId: file.uploadBotId ?? sourceBotId, ...(file.remote?.ready ? {error:undefined} : {}) })) };
          for (const file of plain.files) if (file.hasBytes) {
            const request = files.get([owner, sourceBotId, file.id]);
            request.onsuccess = () => {
              if (!request.result) {
                if (!file.remote?.ready) { tx.abort(); return; }
                const adopted=target!.slots.normal.files.find(current=>current.id===file.id)!;
                adopted.hasBytes=false; drafts.put(target!); return;
              }
              files.put({ ...request.result, botId: PORTABLE_COMPOSER });
            };
          }
          source.slots[sourceSlot] = emptyDraft();
          source.revision = crypto.randomUUID();
          drafts.put(source);
        }
        target.revision = crypto.randomUUID(); drafts.put(target); done(target);
      };
      sourceRequest.onsuccess = () => { source = sourceRequest.result; seed(); };
      targetRequest.onsuccess = () => { target = targetRequest.result; seed(); };
    });
  }
  /** Add feedback to its original unsent PDF draft in one acknowledged transaction. */
  async appendPdfReview(owner: string, sourceKey: string, botId: string, documentFileId: string, expected: string, operationId: string) {
    const scope = pdfReviewTarget(sourceKey);
    if (!scope || scope.botId !== botId || scope.attachmentId !== documentFileId) throw Error("The review belongs to another PDF or bot.");
    return this.transaction<DraftRecord>(["drafts", "files"], "readwrite", (tx, done, fail) => {
      const drafts = tx.objectStore("drafts"), sourceRequest = drafts.get([owner, sourceKey]), targetRequest = drafts.get([owner, botId]);
      let source: DraftRecord | undefined, target: DraftRecord | undefined, reads = 0;
      const apply = () => {
        if (++reads !== 2) return;
        if (target?.receivedTransfers?.[operationId] === sourceKey) { done(target); return; }
        if (!source?.migrated || !target?.migrated || Object.keys(source.operations).length || Object.keys(target.operations).length ||
            draftFingerprint(source) !== expected || target.active !== "normal" || !target.slots.normal.files.some(file => file.id === documentFileId)) {
          fail(Error("The PDF draft changed or has a send awaiting confirmation. Your review is retained; reopen the PDF in its original composer.")); return;
        }
        try {
          const draft = source.slots.normal, text = pdfReviewMessage(draft.text, botId, documentFileId, draft.files, false);
          if (!text) { fail(Error("Add feedback or a page attachment first.")); return; }
          const combined = target.slots.normal.text ? `${target.slots.normal.text}\n\n${text}` : text;
          const newFiles = draft.files.filter(file => !target!.slots.normal.files.some(existing => existing.id === file.id));
          const limit = fileLimit([...target.slots.normal.files, ...newFiles]);
          if (limit || combined.length > 200000) { fail(Error(limit || "This message is too long (maximum 200,000 characters). Your review is retained.")); return; }
          target.slots.normal.text = combined; target.slots.normal.textVersion = `review:${operationId}`;
          target.slots.normal.files.push(...newFiles.map(file => ({ ...file })));
          target.receivedTransfers = { ...target.receivedTransfers, [operationId]: sourceKey }; target.revision = crypto.randomUUID();
          copyDraftBytes(tx, owner, sourceKey, botId, { ...draft, files: target.slots.normal.files.filter(file => newFiles.some(added => added.id === file.id)) }, () => drafts.put(target!), fail);
          drafts.put(target);
          source.slots.normal = emptyDraft(); source.revision = crypto.randomUUID(); drafts.put(source);
          done(target);
        } catch (error) { fail(error); }
      };
      sourceRequest.onsuccess = () => { source = sourceRequest.result; apply(); };
      targetRequest.onsuccess = () => { target = targetRequest.result; apply(); };
    });
  }
  /** Local snapshots contain file bytes and provenance, never submission operations. */
  async captureComposer(owner: string, sourceKey: string, botId: string, expected: string) {
    const id = `clipboard:composer:${crypto.randomUUID()}`;
    await this.transaction(["drafts", "files"], "readwrite", (tx, done, fail) => {
      const drafts = tx.objectStore("drafts"), request = drafts.get([owner, sourceKey]);
      request.onsuccess = () => {
        const source = request.result as DraftRecord | undefined;
        if (!source?.migrated || Object.keys(source.operations).length || draftFingerprint(source) !== expected) {
          fail(new Error("The source draft changed or has a send awaiting confirmation. Copy it again when ready.")); return;
        }
        const draft = source.slots[source.active];
        if (!draft.text && !draft.files.length && !draft.reply) { fail(new Error("The source composer is empty.")); return; }
        if (draft.queueId || draft.queueSource && !draft.queueSource.removed) { fail(new Error("Finish taking this message out of its queue before copying.")); return; }
        const record = emptyRecord(owner, id); record.migrated = true; record.revision = crypto.randomUUID();
        record.clipboardSource = {botId, storageKey:sourceKey, slot:source.active, fingerprint:expected};
        record.slots.normal = plainTransferredDraft(draft, botId);
        copyDraftBytes(tx, owner, sourceKey, id, record.slots.normal, () => drafts.put(record), fail);
        drafts.put(record); done(id);
      };
    });
    return (await this.get(owner, id))!;
  }
  /** Destination + optional source removal + receipt commit in one transaction. */
  async pasteComposer(owner: string, snapshotId: string, targetBotId: string, expected: string, operationId: string, move = false) {
    if (!snapshotId.startsWith("clipboard:composer:") || targetBotId.startsWith("clipboard:") || targetBotId === PORTABLE_COMPOSER)
      throw new Error("This clipboard is not a bot draft.");
    return this.transaction<DraftRecord>(["drafts", "files"], "readwrite", (tx, done, fail) => {
      const drafts=tx.objectStore("drafts"), snapshotRequest=drafts.get([owner,snapshotId]), targetRequest=drafts.get([owner,targetBotId]);
      let snapshot:DraftRecord|undefined, target:DraftRecord|undefined, read=0;
      const paste=()=>{
        if (++read!==2) return;
        if (!snapshot?.clipboardSource || !target?.migrated) {fail(new Error("Copied draft is unavailable on this device. Copy it again from the source bot."));return;}
        if (target.receivedTransfers?.[operationId]===snapshotId) {done(target);return;}
        if (Object.keys(target.operations).length || draftFingerprint(target)!==expected) {fail(new Error("The destination draft changed. Review it before replacing it."));return;}
        const finish=(source?:DraftRecord)=>{
          if (move && (!source || Object.keys(source.operations).length || draftFingerprint(source)!==snapshot!.clipboardSource!.fingerprint)) {fail(new Error("The source draft changed. It was kept; start the move again."));return;}
          const previous=target!.slots[target!.active];
          if (previous.text || previous.files.length || previous.reply) target!.slots[`recovered:transfer:${operationId}`]=previous;
          target!.slots.normal=plainTransferredDraft(snapshot!.slots.normal,snapshot!.clipboardSource!.botId);
          target!.slots.normal.textVersion=`transfer:${operationId}`;target!.active="normal";
          target!.receivedTransfers={...target!.receivedTransfers,[operationId]:snapshotId};target!.revision=crypto.randomUUID();
          copyDraftBytes(tx,owner,snapshotId,targetBotId,target!.slots.normal,()=>drafts.put(target!),fail);
          drafts.put(target!);
          if(move && source){
            // Retain a quiet recovery copy; the visible source composer is empty.
            source.slots[`recovered:move:${operationId}`]=source.slots[source.active];
            if(source.active!=="normal"&&(source.slots.normal.text||source.slots.normal.files.length||source.slots.normal.reply))source.slots[`recovered:normal:${operationId}`]=source.slots.normal;
            source.slots[source.active]=emptyDraft();source.slots.normal=emptyDraft();source.active="normal";source.revision=crypto.randomUUID();drafts.put(source);
          }
          done(target!);
        };
        if(move){
          if(snapshot.clipboardSource.storageKey===targetBotId){fail(new Error("Choose a different bot to move this draft."));return;}
          const request=drafts.get([owner,snapshot.clipboardSource.storageKey]);request.onsuccess=()=>finish(request.result);
        }else finish();
      };
      snapshotRequest.onsuccess=()=>{snapshot=snapshotRequest.result;paste();};targetRequest.onsuccess=()=>{target=targetRequest.result;paste();};
    });
  }
  /** Upgrade171 without discarding either shared or per-bot drafts or operations. */
  async restorePortable(owner:string,targetBotId:string){
    await this.load(owner,targetBotId);
    return this.transaction(["drafts","files"],"readwrite",(tx,done,fail)=>{
      const drafts=tx.objectStore("drafts"), a=drafts.get([owner,PORTABLE_COMPOSER]), b=drafts.get([owner,targetBotId]);
      let source:DraftRecord|undefined,target:DraftRecord|undefined,read=0;
      const restore=()=>{
        if(++read!==2)return;
        if(!source || source.restoredTo || !target || Object.keys(source.operations).length || Object.keys(target.operations).length || target.slots[target.active].text || target.slots[target.active].files.length || target.slots[target.active].reply){done(undefined);return;}
        const original=source.slots[source.active];
        if(!original || original.queueId || original.queueSource&&!original.queueSource.removed || !original.text&&!original.files.length&&!original.reply){done(undefined);return;}
        target.slots.normal=plainTransferredDraft(original,targetBotId);target.active="normal";target.revision=crypto.randomUUID();
        source.restoredTo=targetBotId;source.restoredFingerprint=draftFingerprint(source);source.revision=crypto.randomUUID();
        copyDraftBytes(tx,owner,PORTABLE_COMPOSER,targetBotId,target.slots.normal,()=>drafts.put(target!),fail);
        drafts.put(source);drafts.put(target);done(undefined);
      };
      a.onsuccess=()=>{source=a.result;restore();};b.onsuccess=()=>{target=b.result;restore();};
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
