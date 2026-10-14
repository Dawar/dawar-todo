"use client";
import { openDatabase, loadOfflineCaptureDraft, type OfflineStoredAttachment, type OfflineTodoRecord, type OfflineCaptureDraft } from "./offline-store";
import { offlineRecordTodo } from "./task-model";
import { notifyOfflineChange } from "./offline-events";

// Separate key: a v10 document's legacy text-only put cannot erase these files.
const KEY = "task-capture-v1";
export type TaskCapture = { key: typeof KEY; token: string; revision: string; draft: OfflineCaptureDraft | null; project: string; attachments: OfflineStoredAttachment[] };
const empty = (): TaskCapture => ({ key: KEY, token: crypto.randomUUID(), revision: "", draft: null, project: "", attachments: [] });

export class TaskCaptureSession {
  private value = empty();
  private loading: Promise<TaskCapture> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  load() {
    this.loading ??= (async () => {
      const database = await openDatabase();
      const stored = await new Promise<TaskCapture | undefined>((resolve, reject) => {
        const tx = database.transaction("capture-draft", "readonly");
        const request = tx.objectStore("capture-draft").get(KEY);
        tx.oncomplete = () => resolve(request.result);
        tx.onabort = tx.onerror = () => reject(tx.error);
      });
      this.value = stored ?? { ...this.value, draft: await loadOfflineCaptureDraft() };
      return this.value;
    })().catch((error) => { this.loading = undefined; throw error; });
    return this.loading.then(() => this.value);
  }
  snapshot() { return this.value; }
  /** Serialize checkpoints; only the tab that read this revision may replace it. */
  save(input: Omit<TaskCapture, "key" | "revision">) {
    const operation = this.tail.catch(() => undefined).then(async () => {
      await this.load();
      if (input.token !== this.value.token) throw new Error("This capture changed in another tab. Keep this text and save the selected files before reopening it.");
      const next: TaskCapture = { ...input, key: KEY, revision: crypto.randomUUID() };
      await this.write(next);
      this.value = next;
    });
    this.tail = operation;
    return operation;
  }
  async flush() { await this.tail; }
  consume(record: OfflineTodoRecord) {
    const operation = this.tail.then(async () => {
      await this.load();
      if (record.title !== this.value.draft?.text.trim() || (record.project ?? "") !== this.value.project
        || record.attachments.length !== this.value.attachments.length
        || record.attachments.some((item) => !this.value.attachments.some((saved) => saved.localId === item.localId && saved.blob.size === item.blob.size))) {
        throw new Error("The capture changed while adding. Review the current text and files, then add again.");
      }
      if (record.draftToken !== this.value.token) throw new Error("The capture changed. Review it before adding.");
      const next = { ...empty(), revision: crypto.randomUUID() };
      await this.write(next, record);
      this.value = next;
      notifyOfflineChange("local");
      return next;
    });
    this.tail = operation;
    return operation;
  }
  private async write(next: TaskCapture, record?: OfflineTodoRecord) {
    const database = await openDatabase();
    const expected = this.value.revision;
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(record ? ["capture-draft", "pending-todos", "task-state"] : ["capture-draft"], "readwrite");
      const store = tx.objectStore("capture-draft");
      const request = store.get(KEY);
      let problem: Error | undefined;
      request.onsuccess = () => {
        if ((request.result?.revision ?? "") !== expected) {
          problem = new Error("This draft changed in another tab. Your input is still here; copy text and save files before reopening the draft.");
          tx.abort(); return;
        }
        if (record) {
          // Move intent and original Blobs atomically. A crash cannot leave an
          // acknowledged task without its files, or submit the same draft twice.
          tx.objectStore("pending-todos").add(record);
          tx.objectStore("task-state").put(offlineRecordTodo(record));
        }
        store.put(next);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(problem ?? tx.error ?? new Error("The capture could not be saved on this device."));
    });
  }
}

/** Admission gate shared by every capture entry point, including late file pickers. */
export class TaskCaptureGate {
  ready = false;
  adding = false;
  preparing = 0;
  private waiting = new Set<() => void>();
  hydrate() { this.ready = true; this.release(); }
  private release() { if (this.ready && !this.adding) { this.waiting.forEach(done => done()); this.waiting.clear(); } }
  async prepare<T>(operation: () => Promise<T>) {
    this.preparing++; // Reserve admission synchronously, including pending hydration.
    try {
      if (!this.ready || this.adding) await new Promise<void>(resolve => this.waiting.add(resolve));
      return await operation();
    } finally { this.preparing--; }
  }
  beginAdd() { if (!this.ready || this.adding || this.preparing) return false; this.adding = true; return true; }
  endAdd() { this.adding = false; this.release(); }
}
