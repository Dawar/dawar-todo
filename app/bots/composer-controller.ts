import type { BotAttachment, BotQueuedSubmission, BotRunReceipt } from "../../lib/bots-types";
import { queueEditable } from "./queue-state";
import { readQueueAction } from "./queue-action-store";
import {
  BotDraftStore, changeDraft, emptyDraft, emptyRecord, fileLimit, fileReferences, PORTABLE_COMPOSER,
  type Draft, type DraftChange, type DraftRecord, type StagedFile, type Submission, type RunDeliveryResult,
} from "./draft-store";

export type ComposerTransport = {
  owner: string; online: boolean; storageAvailable?: boolean;
  rpc: (method: Submission["method"] | "queue.list" | "runs.receipt", botId: string, params: Record<string, unknown>, id: string | undefined, options: { owner: string; managed: boolean }) => Promise<unknown>;
  upload: (botId: string, file: File, progress: (value: number) => void, id: string, owner: string, mode?:"cloud"|"legacy") => Promise<BotAttachment>;
  download: (botId: string, id: string, owner?: string) => Promise<{ blob: Blob }>;
  copyAttachment?: (source: BotAttachment, botId: string, id: string, owner: string) => Promise<BotAttachment>;
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
  private preparing: "send" | "checkout" | null = null;
  get committing() { return this.preparing !== null; }
  get checkingOut() { return this.preparing === "checkout"; }
  constructor(readonly owner: string, private targetBotId: string, private store: BotDraftStore,
    private transport: ComposerTransport, private committed: () => void = () => {}, private destination?: { runId: string; storageKey: string }, private portable = false) {
    this.record = this.persisted = emptyRecord(owner, this.storageKey);
  }
  get botId() { return this.targetBotId; }
  bindBot(botId: string) { if (this.portable) this.targetBotId = botId; }
  private get storageKey() { return this.destination?.storageKey ?? (this.portable ? PORTABLE_COMPOSER : this.botId); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { for (const listener of this.listeners) listener(); }
  get draft() { return this.record.slots[this.record.active]; }
  get dirty() { return this.changes.length > 0 || Boolean(this.draining); }
  get operation() { return Object.values(this.record.operations).find((op) => op.slot === this.record.active || op.method === "queue.delete"); }
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
        this.persisted = await this.store.load(this.owner, this.storageKey);
        this.renderPending();
        this.ready = true;
        this.storageError = "";
        if (this.draft.queueSource?.removed || this.draft.files.some(file => file.remote?.ready && file.error)) {
          this.enqueue({kind:"normalize"}); await this.flush();
        }
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
      const blob = await this.store.file(this.owner, this.storageKey, file.id);
      if (generation !== this.recovering) return;
      if (!blob && file.remote?.ready) { this.enqueue({kind:"bytesAbsent",id:file.id}); continue; }
      if (!blob) throw new Error(`Saved bytes for ${file.name} could not be recovered. Keep the draft and retry recovery.`);
      this.files.set(file.id, new File([blob], file.name, { type: file.mimeType }));
    }
    this.notify();
  }
  async refresh() {
    if (!this.ready) return this.open();
    if (this.dirty) return; // The transaction will merge against the latest record.
    try {
      const record = await this.store.get(this.owner, this.storageKey);
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
          this.persisted = await this.store.change(this.owner, this.storageKey, item.change, item.bytes);
          this.changes.shift();
          this.storageError = "";
          this.renderPending();
          this.committed();
        } catch (error) {
          if (item.change.kind === "submit" && (error as Error).name === "DraftChangedError") {
            this.changes.shift();
            this.persisted = await this.store.get(this.owner, this.storageKey) ?? this.persisted;
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
  async prepareCopy() {
    await this.open(); await this.flush();
    if (!this.canUseOwner || this.committing || Object.keys(this.record.operations).length)
      throw Error("Confirm the current composer action before copying or moving its draft.");
    for (const file of this.draft.files) if (!file.remote && !file.uploadMode)
      this.enqueue({kind:"uploadMode",id:file.id,mode:this.transport.storageAvailable?"cloud":"legacy",botId:file.uploadBotId??this.botId});
    await this.flush(); await this.refresh();
  }
  async appendForward(id: string, text: string) {
    await this.open(false);
    if (!this.ready || !this.canUseOwner) throw Error("Connect as the draft’s owner before forwarding.");
    await this.flush();
    if (!this.canUseOwner) throw Error("The signed-in owner changed. The forward is retained.");
    this.enqueue({ kind: "forward", id, text, version: `forward:${id}` });
    await this.flush();
    const slot = this.persisted.forwarded?.[id];
    if (!slot) throw Error("The forwarded draft could not be confirmed. Retry this same forward.");
    if (!this.canUseOwner) throw Error("The draft was saved for its original owner. Sign back in to open it.");
    this.select(slot); await this.flush();
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
    if (!queueEditable(item)) { this.actionError = "This queued message is being confirmed. Its draft and files are retained; refresh its status before editing."; this.notify(); return; }
    const slot = `queue:${item.id}`;
    this.actionError = "";
    this.enqueue({ kind: "edit", slot, draft: {
      ...emptyDraft(), queueId: item.id, queueRevision: item.revision, textVersion: crypto.randomUUID(),
      text: item.input.filter((i) => i.type === "text").filter((i) => !i.text.startsWith("Attached file: ")).map((i) => i.text).join("\n"),
      files: item.attachments.map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, hasBytes: false, remote: a })),
    } });
    void this.flush().then(() => this.resumeUploads()).catch(() => {});
  }
  async checkout(item: BotQueuedSubmission) {
    const botId = this.botId;
    if (!this.ready || !this.canUseOwner || !this.transport.online || this.operation || this.committing) return false;
    if (!queueEditable(item)) { this.actionError = "This queued message may already be starting. Refresh its status before editing."; this.notify(); return false; }
    this.preparing = "checkout"; this.notify();
    const slot = `recovered:queue:${item.id}:${item.revision ?? "native"}`;
    try {
      await this.flush();
      const queueAction = readQueueAction(this.owner, botId);
      if (queueAction.pending || queueAction.error) throw Error("Confirm the saved queue action before taking this message out for editing.");
      if (this.persisted.checkedOut?.[slot]) return true;
      const draft: Draft = {
        ...emptyDraft(), textVersion: crypto.randomUUID(),
        text: item.input.flatMap(i => i.type === "text" && !i.text.startsWith("Attached file: ") ? [i.text] : []).join("\n"),
        files: item.attachments.map(a => ({ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size, hasBytes: false, remote: a })),
        queueSource: { id: item.id, listId: item.listId ?? null, removed: false },
      };
      this.actionError = "";
      this.enqueue({ kind: "checkout", draft, operation: {
        id: crypto.randomUUID(), botId, slot, method: "queue.delete", activateFrom: this.record.active,
        params: { id: item.id, ...(item.revision === undefined ? {} : { expectedRevision: item.revision }) },
        textVersion: draft.textVersion, fileIds: draft.files.map(f => f.id), state: "pending",
      } });
      await this.flush();
      const operation = Object.values(this.persisted.operations).find(op => op.slot === slot);
      if (operation) await this.dispatch(operation);
      if (!this.record.checkedOut?.[slot] || this.record.operations[operation?.id ?? ""]) return false;
      void this.resumeUploads();
      return true;
    } catch (error) { this.actionError = message(error); this.notify(); return false; }
    finally { this.preparing = null; this.notify(); }
  }
  select(slot: string) { this.actionError = ""; this.enqueue({ kind: "select", slot }); }
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
    // Retry the retained upload identity, including a lost cloud receipt.
    for (const file of this.draft.files) if (file.error && !file.remote && !this.transferring.has(file.id))
      this.enqueue({ kind: "restartUpload", id: file.id, uploadId: file.uploadMode === "cloud" ? file.uploadId ?? file.id : crypto.randomUUID() });
    try { await this.flush(); await this.resumeUploads(true); } catch { /* storageError is visible */ }
  }
  async resumeUploads(retry = false) {
    if (!this.ready || !this.canUseOwner || !(this.transport.online || this.transport.storageAvailable) || this.storageError) return;
    // Sequential per controller; a second invocation is harmless.
    const files = [...new Map(Object.values(this.persisted.slots).flatMap((d) => d.files).map((f) => [f.id, f])).values()];
    for (const file of files) {
      if (!this.canUseOwner || !(this.transport.online || this.transport.storageAvailable)) return;
      const current = Object.values(this.persisted.slots).flatMap((d) => d.files).find((f) => f.id === file.id);
      if (!current || this.transferring.has(file.id) || (current.error && !retry)) continue;
      if (current.remote?.ready) continue; // An offline preview is optional, never a send dependency.
      this.transferring.add(file.id);
      try {
        if (!file.hasBytes && file.remote) {
          const { blob } = await this.transport.download(this.botId, file.remote.id, this.owner);
          if (!this.canUseOwner) return;
          this.files.set(file.id, new File([blob], file.name, { type: file.mimeType }));
          this.enqueue({ kind: "bytes", id: file.id }, new Map([[file.id, blob]]));
        } else {
          const bytes = await this.store.file(this.owner, this.storageKey, file.id);
          if (!bytes) throw new Error("Attachment bytes are unavailable. Retry recovery before sending.");
          if (!this.canUseOwner || !Object.values(this.record.slots).some((d) => d.files.some((f) => f.id === file.id))) continue;
          const uploadBotId = file.uploadBotId ?? this.botId;
          let mode=file.uploadMode ?? (this.transport.storageAvailable ? "cloud" : "legacy");
          if (!file.uploadMode) { this.enqueue({kind:"uploadMode",id:file.id,mode,botId:uploadBotId}); await this.flush(); }
          mode=Object.values(this.persisted.slots).flatMap(draft=>draft.files).find(current=>current.id===file.id)?.uploadMode ?? mode;
          const uploaded = await this.transport.upload(uploadBotId, new File([bytes], file.name, { type: file.mimeType }), (value) => {
            this.progress.set(file.id, value); this.notify();
          }, file.uploadId ?? file.id, this.owner,mode);
          if (!this.canUseOwner) return;
          if (!uploaded?.ready || uploaded.botId !== uploadBotId || !uploaded.id) throw new Error("The server did not confirm this file upload. Your local bytes are retained.");
          this.enqueue({ kind: "uploaded", id: file.id, uploadId: file.uploadId ?? file.id, remote: uploaded });
        }
        await this.flush();
      } catch (error) {
        if (this.canUseOwner) this.enqueue({ kind: "fileError", id: file.id, error: message(error) });
      } finally { this.transferring.delete(file.id); this.progress.delete(file.id); this.notify(); }
    }
  }
  async send(queueNext = false, burst = false, listId: string | null = null) {
    if (!this.ready || !this.canUseOwner || !this.transport.online || this.committing) return;
    this.preparing = "send"; this.notify();
    const slot = this.record.active;
    const botId = this.botId;
    this.actionError = "";
    try {
      await this.flush();
      const existing = Object.values(this.persisted.operations).find((op) => op.slot === slot || op.method === "queue.delete");
      if (existing) { await this.dispatch(existing); if (existing.method === "queue.delete") void this.resumeUploads(); return; }
      let draft = this.persisted.slots[slot];
      const textVersion = draft.textVersion, fileIds = draft.files.map(file => file.id).join("|");
      if (draft.queueSource && !draft.queueSource.removed) throw Error("Removal was not confirmed. Refresh the queue before editing this saved copy; the original may already be starting.");
      if (draft.queueId) {
        // Read-only preflight, only for a NEW update. An already submitted
        // operation above always reconciles its exact ID/parameters instead.
        const checkQueueAction = () => {
          const action = readQueueAction(this.owner, botId);
          if (action.pending || action.error) throw new Error("A saved queue action needs confirmation before this edit can be submitted. Your draft is retained; check the queue action first.");
        };
        checkQueueAction();
        const queue = await this.transport.rpc("queue.list", botId, {}, undefined, { owner: this.owner, managed: false }) as BotQueuedSubmission[];
        if (!this.canUseOwner || !this.transport.online) return;
        checkQueueAction();
        if (!Array.isArray(queue)) throw new Error("Queue status is unavailable. Your edit is saved; reconnect before saving it to the queue.");
        const current = queue.find(item => item.id === draft.queueId);
        if (!current) throw new Error("This message is no longer queued. Your edited draft and files are still saved; cancel the edit to return to your conversation.");
        if (!queueEditable(current)) throw new Error("This queued message is being confirmed. Your edit is saved; wait for its status before changing it.");
        if (current.revision !== draft.queueRevision) throw new Error("This queued message changed. Your edited draft is saved. Open Edit on the current message to review its latest version; your previous edit will remain in draft recovery.");
      }
      if (draft.text.trim().length > 200000) throw new Error("This message is too long (maximum 200,000 characters).");
      const limit = fileLimit(draft.files);
      if (limit) throw new Error(limit);
      if (draft.files.some((f) => !f.remote?.ready)) throw new Error("Attachments are saved locally. Finish or retry their uploads before sending.");
      if (!draft.text.trim() && !draft.files.length) return;
      for (const file of draft.files) if (file.remote!.botId !== botId && !file.copies?.[botId]) {
        if (!this.transport.copyAttachment) throw Error("This attachment cannot move to this bot yet. Your draft is saved.");
        this.enqueue({kind:"copyIdentity",id:file.id,botId,copyId:crypto.randomUUID()}); await this.flush();
        const current = this.persisted.slots[slot].files.find(current => current.id === file.id);
        if (!current?.remote) throw Error("The draft changed. Try sending again.");
        const copy = await this.transport.copyAttachment(current.remote, botId, current.copyIds![botId], this.owner);
        if (!copy.ready || copy.botId !== botId || copy.size !== current.size) throw Error("Attachment transfer could not be confirmed. Try again.");
        this.enqueue({kind:"copied",id:file.id,botId,remote:copy}); await this.flush();
      }
      draft = this.persisted.slots[slot];
      if (!this.canUseOwner || !this.transport.online) return;
      if (!draft || draft.textVersion !== textVersion || draft.files.map(file => file.id).join("|") !== fileIds) throw Error("The draft changed during attachment transfer. Review it and send again.");
      const op: Submission = {
        id: crypto.randomUUID(), botId, slot, method: this.destination ? "runs.send" : draft.queueId ? "queue.update" : queueNext ? "queue.add" : burst ? "bursts.submit" : "turn.send",
        params: { ...(queueNext && !draft.queueId && !this.destination && listId ? { listId } : {}), ...(this.destination ? { runId: this.destination.runId } : {}), ...(draft.queueId ? { id: draft.queueId, ...(draft.queueRevision === undefined ? {} : { expectedRevision: draft.queueRevision }) } : {}), text: draft.text.trim(), attachments: draft.files.map((f) => (f.remote!.botId === botId ? f.remote! : f.copies![botId]).id) },
        ...(this.destination ? { runDelivery: { state: "prepared" as const, token: crypto.randomUUID() } } : {}),
        textVersion: draft.textVersion, fileIds: draft.files.map((f) => f.id), state: "pending",
      };
      // This durable record is the authorization to reconcile after restart.
      // No unsubmitted draft is ever promoted to an operation on reconnect.
      this.enqueue({ kind: "submit", operation: op });
      await this.flush();
      const submitted = Object.values(this.persisted.operations).find((p) => p.slot === slot);
      if (submitted) await this.dispatch(submitted);
    } catch (error) { this.actionError = message(error); this.notify(); }
    finally { this.preparing = null; this.notify(); }
  }
  async reconcile() {
    if (!this.ready || !this.canUseOwner || !this.transport.online || this.storageError) return;
    try { await this.flush(); } catch { return; }
    for (const op of Object.values(this.persisted.operations)) await this.dispatch(op);
  }
  private async runChange(change: Extract<DraftChange, { kind: "run-claim" | "run-result" }>) {
    // Use this controller's existing write queue as well as the store's strict
    // cross-tab transaction. Concurrent typing cannot publish an older record
    // over a newer local commit while the claim is awaiting storage.
    const queued = { change };
    this.changes.push(queued);
    try { await this.flush(); }
    catch (error) {
      if (change.kind === "run-claim") {
        this.changes = this.changes.filter(value => value !== queued);
        if (this.persisted.operations[change.id]?.runDelivery?.token === change.token) {
          // The claim committed but a subsequent queued write failed. No RPC
          // has run; retain its exact release for the next explicit save retry.
          this.changes.push({ change: { kind: "run-result", id: change.id, expectedToken: change.token, nextToken: crypto.randomUUID(), outcome: "not-sent", error: "Saved reply is waiting to send." } });
        }
        this.renderPending(); this.notify();
      }
      throw error;
    }
    return this.persisted.operations[change.id];
  }
  private async dispatchRun(saved: Submission) {
    if (this.sending.has(saved.id) || !this.canUseOwner || !this.transport.online) return;
    this.sending.add(saved.id); this.notify();
    let op: Submission | undefined, claimed = false;
    const claim = crypto.randomUUID();
    const settle = async (outcome: RunDeliveryResult, error?: string) => {
      if (!op) return;
      await this.runChange({ kind: "run-result", id: op.id, expectedToken: op.runDelivery?.token ?? null, nextToken: crypto.randomUUID(), outcome, error });
    };
    try {
      if (!this.destination || saved.params.runId !== this.destination.runId) throw Error("This reply's destination could not be verified. Its draft is retained.");
      // Exactly one tab can move this existing prepared operation across the
      // durable boundary. Legacy/possible rows get only a receipt lookup.
      op = await this.runChange({ kind: "run-claim", id: saved.id, token: claim });
      if (!op) return;
      claimed = op.runDelivery?.token === claim;
      if (!this.canUseOwner || !this.transport.online) {
        if (claimed) await settle("not-sent", "Saved reply is waiting to send. Reconnect or resume this same reply.");
        return;
      }
      const receipt = await this.transport.rpc(claimed ? "runs.send" : "runs.receipt", this.botId,
        claimed ? op.params : { runId: this.destination.runId, operationId: op.id }, claimed ? op.id : undefined,
        { owner: this.owner, managed: true }) as BotRunReceipt;
      if (receipt?.operationId !== op.id || receipt.runId !== this.destination.runId || !receipt.laneId || !["accepted", "queued", "uncertain", "rejected"].includes(receipt.state)) throw Error("The run receipt could not be verified. Your reply is retained.");
      if (receipt.state === "accepted" && receipt.turnId) { await settle("success"); this.actionError = ""; }
      else if (receipt.state === "rejected") { await settle("rejected"); this.actionError = receipt.waitReason || "This reply was not delivered. Your draft and files are retained."; }
      else {
        // Positive server receipt is stronger than an outstanding claimant's
        // local not-sent result; advance the token to fence that stale result.
        await settle("queued", receipt.state === "queued" ? "Queued for this run. Check delivery when it is ready; your reply and files are retained." : "Run delivery is unconfirmed. Check its original receipt; your reply and files are retained.");
      }
    } catch (error) {
      const outcome = (error as { outcome?: string }).outcome;
      try {
        if (claimed && outcome === "not-sent") await settle("not-sent", "Saved reply was not sent. Reconnect or resume this same reply.");
        else if (claimed && outcome === "rejected") { await settle("rejected"); this.actionError = `Not sent: ${message(error)}`; }
        else if (op) await settle("uncertain", "Delivery is unconfirmed. Check the original receipt; your reply and files are retained.");
        else this.actionError = message(error);
      } catch (storage) { this.storageError = `${message(storage)} Your saved reply identity is retained. Retry saving before closing this tab.`; }
    } finally { this.sending.delete(saved.id); this.notify(); }
  }
  private async dispatch(op: Submission) {
    if (op.method === "runs.send") return this.dispatchRun(op);
    if (this.sending.has(op.id) || !this.canUseOwner || !this.transport.online) return;
    this.sending.add(op.id); this.notify();
    try {
      const result = await this.transport.rpc(op.method, op.botId ?? this.botId, op.params, op.id, { owner: this.owner, managed: true });
      if (op.method === "queue.delete" && (result as { deleted?: boolean } | null)?.deleted !== true)
        throw Error("Queue removal did not confirm deletion.");
      this.actionError = "";
      // Even after an owner/selection change, settle the originating record only.
      this.record = changeDraft(this.record, { kind: "settle", id: op.id, outcome: "success" });
      this.changes.push({ change: { kind: "settle", id: op.id, outcome: "success" } });
      await this.flush();
    } catch (error) {
      const outcome = (error as { outcome?: string }).outcome;
      // A not-sent retry says nothing about a previous attempt with this ID.
      const uncertain = outcome !== "rejected";
      const detail = op.method === "queue.delete" ? uncertain ? "Queue removal is unconfirmed. Check the same removal before editing; your draft and files are saved." : `Could not take this message out of the queue: ${message(error)} Your saved copy is retained.` : uncertain ? "Send acknowledgement is unconfirmed. Check again to reconcile the same send; your draft is retained." : `Not sent: ${message(error)}`;
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
