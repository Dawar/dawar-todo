"use client";

export type OfflineAttachmentKind = "image" | "audio" | "video" | "file";

export type OfflineStoredAttachment = {
  localId: string;
  kind: OfflineAttachmentKind;
  fileName: string;
  mimeType: string;
  durationMs: number;
  blob: Blob;
};

export type OfflineTodoRecord = {
  clientId: string;
  localId: number;
  title: string;
  notes: string;
  project: string | null;
  createdAt: string;
  attachments: OfflineStoredAttachment[];
};

export type OfflineTodoMutation = {
  todoId: number;
  mutationId: string;
  patch: Record<string, unknown>;
  fieldTimestamps: Record<string, string>;
  createdAt: string;
};

export type OfflineCaptureDraft = {
  key: "quick-add";
  text: string;
  updatedAt: string;
  clientId: string;
  version: string;
};

const DATABASE_NAME = "dawar-todo-offline";
const DATABASE_VERSION = 4;
const TODO_STORE = "pending-todos";
const CACHE_STORE = "cached-state";
const MUTATION_STORE = "pending-mutations";
const CAPTURE_DRAFT_STORE = "capture-draft";

export type CachedServerState<T> = {
  key: "server";
  todos: T[];
  projects: string[];
  revision?: number;
  savedAt: string;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser cannot save tasks for offline use."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TODO_STORE)) {
        const store = database.createObjectStore(TODO_STORE, { keyPath: "clientId" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(CACHE_STORE)) database.createObjectStore(CACHE_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(MUTATION_STORE)) {
        const store = database.createObjectStore(MUTATION_STORE, { keyPath: "todoId" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(CAPTURE_DRAFT_STORE)) {
        database.createObjectStore(CAPTURE_DRAFT_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage could not be opened."));
  });
}

function runRequest<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage request failed."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Offline storage transaction failed."));
    };
  }));
}

export async function persistOfflineStorage() {
  if (navigator.storage?.persist) {
    const granted = await navigator.storage.persist().catch(() => false);
    console.info("[todo-offline] persistent browser storage requested", { granted });
  }
}

export async function saveOfflineTodo(record: OfflineTodoRecord) {
  try {
    await runRequest(TODO_STORE, "readwrite", (store) => store.put(record));
    console.info("[todo-offline] task stored", {
      clientId: record.clientId,
      localId: record.localId,
      project: record.project,
      attachments: record.attachments.length,
      bytes: record.attachments.reduce((total, attachment) => total + attachment.blob.size, 0),
    });
  } catch (error) {
    console.error("[todo-offline] task storage failed", { clientId: record.clientId, error });
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error("This device does not have enough offline storage for those attachments.");
    }
    throw error;
  }
}

export async function listOfflineTodos() {
  const records = await runRequest<OfflineTodoRecord[]>(TODO_STORE, "readonly", (store) => store.getAll());
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteOfflineTodo(clientId: string) {
  await runRequest(TODO_STORE, "readwrite", (store) => store.delete(clientId));
  console.info("[todo-offline] synced task removed", { clientId });
}

export async function saveOfflineTodoMutation(
  todoId: number,
  patch: Record<string, unknown>,
  fieldTimestamps: Record<string, string>,
) {
  const previous = await runRequest<OfflineTodoMutation | undefined>(MUTATION_STORE, "readonly", (store) => store.get(todoId));
  const mergedPatch = { ...(previous?.patch ?? {}) };
  const mergedTimestamps = { ...(previous?.fieldTimestamps ?? {}) };
  for (const [field, value] of Object.entries(patch)) {
    const timestamp = fieldTimestamps[field];
    if (!timestamp) continue;
    if (!mergedTimestamps[field] || timestamp >= mergedTimestamps[field]) {
      mergedPatch[field] = value;
      mergedTimestamps[field] = timestamp;
    }
  }
  const record: OfflineTodoMutation = {
    todoId,
    mutationId: crypto.randomUUID(),
    patch: mergedPatch,
    fieldTimestamps: mergedTimestamps,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  await runRequest(MUTATION_STORE, "readwrite", (store) => store.put(record));
  console.info("[todo-offline] task edit queued", {
    todoId,
    mutationId: record.mutationId,
    fields: Object.keys(record.patch),
  });
  return record;
}

export async function listOfflineTodoMutations() {
  const records = await runRequest<OfflineTodoMutation[]>(MUTATION_STORE, "readonly", (store) => store.getAll());
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteOfflineTodoMutation(todoId: number) {
  await runRequest(MUTATION_STORE, "readwrite", (store) => store.delete(todoId));
  console.info("[todo-offline] synchronized task edit removed", { todoId });
}

export async function saveOfflineCaptureDraft(draft: OfflineCaptureDraft) {
  await runRequest(CAPTURE_DRAFT_STORE, "readwrite", (store) => store.put(draft));
}

export async function loadOfflineCaptureDraft() {
  const draft = await runRequest<OfflineCaptureDraft | undefined>(
    CAPTURE_DRAFT_STORE,
    "readonly",
    (store) => store.get("quick-add"),
  );
  return draft ?? null;
}

export async function saveCachedServerState<T>(todos: T[], projects: string[], revision?: number) {
  const state: CachedServerState<T> = { key: "server", todos, projects, revision, savedAt: new Date().toISOString() };
  await runRequest(CACHE_STORE, "readwrite", (store) => store.put(state));
  console.info("[todo-offline] server snapshot cached", { todos: todos.length, projects: projects.length, revision });
}

export async function loadCachedServerState<T>() {
  const state = await runRequest<CachedServerState<T> | undefined>(CACHE_STORE, "readonly", (store) => store.get("server"));
  return state ?? null;
}
