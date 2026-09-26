import type { BotAttachment, BotQueuedSubmission } from "../../lib/bots-types";
import {
  BotDraftStore, changeDraft, emptyDraft, emptyRecord, fileLimit, fileReferences,
  type DraftChange, type DraftRecord, type StagedFile, type Submission,
} from "./draft-store";

export type ComposerTransport = {
  owner: string; online: boolean;
  rpc: (method: Submission["method"], botId: string, params: Record<string, unknown>, id: string, options: { owner: string; managed: boolean }) => Promise<unknown>;
  upload: (botId: string, file: File, progress: (value: number) => void, id: string, owner: string) => Promise<BotAttachment>;
  download: (botId: string, id: string, owner?: string) => Promise<{ blob: Blob }>;
};
type QueuedChange = { change: DraftChange; bytes?: Map<string, Blob> };
const message = (error: unknown) => error instanceof Error ? error.message : "Draft recovery failed.";

// A service-owned controller survives React Activity teardown, navigation and
// selection changes. No asynchronous callback targets the selected composer.
export class BotComposer {
  record: DraftRecord;
  ready = false;
  storageError = "";
  actionError = "";
  progress = new Map<string, number>();
  files = new Map<string, File>();
  private persisted: DraftRecord;
  private changes: QueuedChange[] = [];
  private draining?: Promise<void>;
  private opening?: Promise<void>;
  private transferring = new Set<string>();
  private sending = new Set<string>();
  private listeners = new Set<() => void>();
  private recovering = 0;
  constructor(readonly owner: string, readonly botId: string, private store: BotDraftStore,
    private transport: ComposerTransport, private committed: () => void = () => {}) {
    this.record = this.persisted = emptyRecord(owner, botId);
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  get draft() { return this.record.slots[this.record.active]; }
  get dirty() { return this.changes.length > 0 || Boolean(this.draining); }
  get operation() { return Object.values(this.record.operations).find((op) => op.slot === this.record.active); }
  get sendingNow() { return this.operation ? this.sending.has(this.operation.id) : false; }
  get recoveries() { return Object.keys(this.record.slots).filter((key) => key.startsWith("recovered:") && (this.record.slots[key].text || this.record.slots[key].files.length)); }
  get canUseOwner() { return this.transport.owner === this.owner; }
  get saved() { return this.ready && !this.dirty && !this.storageError; }
  private renderPending() {
    const active = this.record.active;
    this.record = this.changes.reduce((record, item) => changeDraft(record, item.change), this.persisted);
    if (this.ready && this.record.slots[active] && (active === "normal" || this.record.slots[active].text || this.record.slots[active].files.length) && !this.changes.some((c) => c.change.kind === "select" || c.change.kind === "edit")) {
      // Remote tab navigation must not switch the composer under local typing.
      this.record = { ...this.record, active };
    }
    const refs = fileReferences(this.record);
    for (const id of this.files.keys()) if (!refs.has(id)) this.files.delete(id);
  }
  async open(hydrate = true) {
    if (this.ready) { if (hydrate) await this.recoverFiles().catch((error) => { this.storageError = message(error); this.notify(); }); return; }
    if (this.opening) { await this.opening; if (hydrate && this.ready) await this.recoverFiles().catch((error) => { this.storageError = message(error); this.notify(); }); return; }
    this.opening = (async () => {
      try {
        this.persisted = await this.store.load(this.owner, this.botId);
        this.renderPending();
        this.ready = true;
        this.storageError = "";
        if (hydrate) await this.recoverFiles();
      } catch (error) { this.storageError = message(error); }
      finally { this.opening = undefined; this.notify(); }
    })();
    return this.opening;
  }
  private async recoverFiles() {
    const generation = ++this.recovering;
    for (const file of Object.values(this.record.slots).flatMap((d) => d.files)) {
      if (this.files.has(file.id) || !file.hasBytes) continue;
      const blob = await this.store.file(this.owner, this.botId, file.id);
      if (generation !== this.recovering) return;
      if (!blob) throw new Error(`Saved bytes for ${file.name} could not be recovered. Keep the draft and retry recovery.`);
      this.files.set(file.id, new File([blob], file.name, { type: file.mimeType }));
    }
    this.notify();
  }
  async refresh() {
    if (!this.ready) return this.open();
    if (this.dirty) return; // The transaction will merge against the latest record.
    try {
      const record = await this.store.get(this.owner, this.botId);
      if (this.dirty || !record || record.revision === this.persisted.revision) return;
      this.persisted = record;
      this.renderPending();
      await this.recoverFiles();
      this.notify();
    } catch (error) { this.storageError = message(error); this.notify(); }
  }
  private enqueue(change: DraftChange, bytes?: Map<string, Blob>) {
    if (!this.ready || !this.canUseOwner) return;
    this.record = changeDraft(this.record, change);
    // Coalesce only text that has not started a transaction, retaining its base.
    const last = this.changes.at(-1);
    if (change.kind === "text" && last?.change.kind === "text" && last.change.slot === change.slot && this.changes.length > 1) {
      last.change = { ...change, base: last.change.base };
    } else this.changes.push({ change, bytes });
    this.notify();
    void this.flush().catch(() => {});
  }
  async flush() {
    if (this.draining) return this.draining;
    if (!this.changes.length) return;
    this.draining = (async () => {
      while (this.changes.length) {
        const item = this.changes[0];
        try {
          this.persisted = await this.store.change(this.owner, this.botId, item.change, item.bytes);
          this.changes.shift();
          this.storageError = "";
          this.renderPending();
          this.committed();
        } catch (error) {
          if (item.change.kind === "submit" && (error as Error).name === "DraftChangedError") {
            this.changes.shift();
            this.persisted = await this.store.get(this.owner, this.botId) ?? this.persisted;
            this.renderPending();
            this.actionError = message(error);
          } else this.storageError = `${message(error)} Changes are still in this tab. Retry saving before closing it.`;
          throw error;
        } finally { this.notify(); }
      }
    })().finally(() => { this.draining = undefined; this.notify(); });
    return this.draining;
  }
  setText(text: string) {
    if (text === this.draft.text) return;
    this.enqueue({ kind: "text", slot: this.record.active, text, version: crypto.randomUUID(), base: this.draft.textVersion });
  }
  addFiles(input: File[]) {
    const files: StagedFile[] = input.map((f) => ({ id: crypto.randomUUID(), name: f.name, mimeType: f.type || "application/octet-stream", size: f.size, hasBytes: true }));
    const limit = fileLimit([...this.draft.files, ...files]);
    if (limit) { this.actionError = limit; this.notify(); return; }
    const bytes = new Map<string, Blob>();
    files.forEach((file, index) => { this.files.set(file.id, input[index]); bytes.set(file.id, input[index]); });
    this.actionError = "";
    this.enqueue({ kind: "add", slot: this.record.active, files }, bytes);
    // Upload only after file bytes AND metadata have committed.
    void this.flush().then(() => this.resumeUploads()).catch(() => {});
  }
  removeFile(id: string) { this.enqueue({ kind: "remove", slot: this.record.active, id }); }
  edit(item: BotQueuedSubmission) {
    const slot = `queue:${item.id}`;
    this.enqueue({ kind: "edit", slot, draft: {
      ...emptyDraft(), queueId: item.id, textVersion: crypto.randomUUID(),
      text: item.input.filter((i) => i.type === "text").filter((i) => !i.text.startsWith("Attached file: ")).map((i) => i.text).join("\n"),
      files: item.attachments.map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, hasBytes: false, remote: a })),
    } });
    void this.flush().then(() => this.resumeUploads()).catch(() => {});
  }
  select(slot: string) { this.enqueue({ kind: "select", slot }); }
  async retry() {
    if (!this.ready) await this.open();
    try {
      await this.flush();
      await this.recoverFiles();
      this.storageError = "";
      await this.resumeUploads(true);
    } catch (error) { this.storageError ||= message(error); }
    this.notify();
  }
  async restartFailedUploads() {
    // A server may lose an incomplete upload checkpoint. Explicitly starting a
    // fresh transfer keeps the same local file/bytes; it never submits a message.
    for (const file of this.draft.files) if (file.error && !file.remote && !this.transferring.has(file.id))
      this.enqueue({ kind: "restartUpload", id: file.id, uploadId: crypto.randomUUID() });
    try { await this.flush(); await this.resumeUploads(true); } catch { /* storageError is visible */ }
  }
  async resumeUploads(retry = false) {
    if (!this.ready || !this.canUseOwner || !this.transport.online || this.storageError) return;
    // Sequential per controller; a second invocation is harmless.
    const files = [...new Map(Object.values(this.persisted.slots).flatMap((d) => d.files).map((f) => [f.id, f])).values()];
    for (const file of files) {
      if (!this.canUseOwner || !this.transport.online) return;
      const current = Object.values(this.persisted.slots).flatMap((d) => d.files).find((f) => f.id === file.id);
      if (!current || this.transferring.has(file.id) || (current.error && !retry)) continue;
      if (current.remote && current.hasBytes) continue;
      if (file.remote && file.hasBytes) continue;
      this.transferring.add(file.id);
      try {
        if (!file.hasBytes && file.remote) {
          const { blob } = await this.transport.download(this.botId, file.remote.id, this.owner);
          if (!this.canUseOwner) return;
          this.files.set(file.id, new File([blob], file.name, { type: file.mimeType }));
          this.enqueue({ kind: "bytes", id: file.id }, new Map([[file.id, blob]]));
        } else {
          const bytes = await this.store.file(this.owner, this.botId, file.id);
          if (!bytes) throw new Error("Attachment bytes are unavailable. Retry recovery before sending.");
          if (!this.canUseOwner || !Object.values(this.record.slots).some((d) => d.files.some((f) => f.id === file.id))) continue;
          const uploaded = await this.transport.upload(this.botId, new File([bytes], file.name, { type: file.mimeType }), (value) => {
            this.progress.set(file.id, value); this.notify();
          }, file.uploadId ?? file.id, this.owner);
          if (!this.canUseOwner) return;
          if (!uploaded?.ready || uploaded.botId !== this.botId || !uploaded.id) throw new Error("The server did not confirm this file upload. Your local bytes are retained.");
          this.enqueue({ kind: "uploaded", id: file.id, uploadId: file.uploadId ?? file.id, remote: uploaded });
        }
        await this.flush();
      } catch (error) {
        if (this.canUseOwner) this.enqueue({ kind: "fileError", id: file.id, error: message(error) });
      } finally { this.transferring.delete(file.id); this.progress.delete(file.id); this.notify(); }
    }
  }
  async send(queueNext = false) {
    if (!this.ready || !this.canUseOwner || !this.transport.online) return;
    const slot = this.record.active;
    this.actionError = "";
    try {
      await this.flush();
      const existing = Object.values(this.persisted.operations).find((op) => op.slot === slot);
      if (existing) { await this.dispatch(existing); return; }
      const draft = this.persisted.slots[slot];
      if (draft.text.trim().length > 200000) throw new Error("This message is too long (maximum 200,000 characters).");
      const limit = fileLimit(draft.files);
      if (limit) throw new Error(limit);
      if (draft.files.some((f) => !f.remote?.ready)) throw new Error("Attachments are saved locally. Finish or retry their uploads before sending.");
      if (!draft.text.trim() && !draft.files.length) return;
      const op: Submission = {
        id: crypto.randomUUID(), slot, method: draft.queueId ? "queue.update" : queueNext ? "queue.add" : "turn.send",
        params: { ...(draft.queueId ? { id: draft.queueId } : {}), text: draft.text.trim(), attachments: draft.files.map((f) => f.remote!.id) },
        textVersion: draft.textVersion, fileIds: draft.files.map((f) => f.id), state: "pending",
      };
      // This durable record is the authorization to reconcile after restart.
      // No unsubmitted draft is ever promoted to an operation on reconnect.
      this.enqueue({ kind: "submit", operation: op });
      await this.flush();
      const submitted = Object.values(this.persisted.operations).find((p) => p.slot === slot);
      if (submitted) await this.dispatch(submitted);
    } catch (error) { this.actionError = message(error); this.notify(); }
  }
  async reconcile() {
    if (!this.ready || !this.canUseOwner || !this.transport.online || this.storageError) return;
    try { await this.flush(); } catch { return; }
    for (const op of Object.values(this.persisted.operations)) await this.dispatch(op);
  }
  private async dispatch(op: Submission) {
    if (this.sending.has(op.id) || !this.canUseOwner || !this.transport.online) return;
    this.sending.add(op.id); this.notify();
    try {
      await this.transport.rpc(op.method, this.botId, op.params, op.id, { owner: this.owner, managed: true });
      this.actionError = "";
      // Even after an owner/selection change, settle the originating record only.
      this.record = changeDraft(this.record, { kind: "settle", id: op.id, outcome: "success" });
      this.changes.push({ change: { kind: "settle", id: op.id, outcome: "success" } });
      await this.flush();
    } catch (error) {
      const outcome = (error as { outcome?: string }).outcome;
      // A not-sent retry says nothing about a previous attempt with this ID.
      const uncertain = outcome !== "rejected";
      const detail = uncertain ? "Send acknowledgement is unconfirmed. Check again to reconcile the same send; your draft is retained." : `Not sent: ${message(error)}`;
      // Uncertainty belongs to the durable operation. A second tab may already
      // have confirmed it, or confirm it later; a separate actionError would
      // keep falsely warning after that operation has been retired.
      this.actionError = uncertain ? "" : detail;
      this.changes.push({ change: { kind: "settle", id: op.id, outcome: uncertain ? "uncertain" : "rejected", error: detail } });
      this.renderPending();
      await this.flush().catch(() => {});
    } finally { this.sending.delete(op.id); this.notify(); }
  }
}
