"use client";

export type OfflineAttachmentKind = "image" | "audio" | "video" | "file";

export type OfflineStoredAttachment = {
  localId: string;
  kind: OfflineAttachmentKind;
  fileName: string;
  mimeType: string;
  durationMs: number;
  blob: Blob;
  remoteAttachmentId?: string;
};

export type OfflineTodoRecord = {
  clientId: string;
  localId: number;
  title: string;
  notes: string;
  status?: "open" | "completed";
  priority?: number;
  dueDate?: string | null;
  project: string | null;
  context?: string | null;
  completedAt?: string | null;
  snoozedUntil?: string | null;
  recurrenceCron?: string | null;
  recurrenceLastFiredAt?: string | null;
  pinned?: boolean;
  sourceKind?: string | null;
  sourceId?: number | null;
  createdAt: string;
  updatedAt?: string;
  draftToken?: string;
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

export type OfflineAssistantAttachment = OfflineStoredAttachment;

export type OfflineAssistantMessage = {
  clientId: string;
  todoId: number;
  text: string;
  attachmentIds: string[];
  attachments: OfflineAssistantAttachment[];
  createdAt: string;
};

export type OfflineAssistantDraft = {
  key: string;
  todoId: number;
  text: string;
  updatedAt: string;
};

export type OfflineTaskAction = {
  operationId: string;
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
  taskIds: number[];
  kind: "bulk" | "task-patch" | "undo";
  optimisticPatches?: Record<string, Record<string, unknown>>;
  optimisticDeletedIds?: number[];
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  undoRequested?: boolean;
};

const DATABASE_NAME = "dawar-todo-offline";
const DATABASE_VERSION = 6;
const TODO_STORE = "pending-todos";
const CACHE_STORE = "cached-state";
const MUTATION_STORE = "pending-mutations";
const ACTION_STORE = "pending-actions";
const CAPTURE_DRAFT_STORE = "capture-draft";
const ASSISTANT_QUEUE_STORE = "assistant-queue";
const ASSISTANT_DRAFT_STORE = "assistant-draft";

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
      if (!database.objectStoreNames.contains(ACTION_STORE)) {
        const store = database.createObjectStore(ACTION_STORE, { keyPath: "operationId" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("nextAttemptAt", "nextAttemptAt");
      }
      if (!database.objectStoreNames.contains(CAPTURE_DRAFT_STORE)) {
        database.createObjectStore(CAPTURE_DRAFT_STORE, { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains(ASSISTANT_QUEUE_STORE)) {
        const store = database.createObjectStore(ASSISTANT_QUEUE_STORE, { keyPath: "clientId" });
        store.createIndex("createdAt", "createdAt");
      }
      if (!database.objectStoreNames.contains(ASSISTANT_DRAFT_STORE)) {
        database.createObjectStore(ASSISTANT_DRAFT_STORE, { keyPath: "key" });
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

export async function getOfflineTodoByLocalId(localId: number) {
  const records = await listOfflineTodos();
  return records.find((record) => record.localId === localId) ?? null;
}

export async function deleteOfflineTodo(clientId: string) {
  await runRequest(TODO_STORE, "readwrite", (store) => store.delete(clientId));
  console.info("[todo-offline] synced task removed", { clientId });
}

export async function updateOfflineTodo(
  localId: number,
  patch: Partial<Omit<OfflineTodoRecord, "clientId" | "localId" | "attachments">>,
) {
  const records = await listOfflineTodos();
  const current = records.find((record) => record.localId === localId);
  if (!current) return null;
  const next: OfflineTodoRecord = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await runRequest(TODO_STORE, "readwrite", (store) => store.put(next));
  console.info("[todo-offline] local task updated", {
    clientId: next.clientId,
    localId,
    fields: Object.keys(patch),
  });
  return next;
}

export async function deleteOfflineTodoByLocalId(localId: number) {
  const records = await listOfflineTodos();
  const current = records.find((record) => record.localId === localId);
  if (!current) return false;
  await deleteOfflineTodo(current.clientId);
  console.info("[todo-offline] local task deleted before synchronization", {
    clientId: current.clientId,
    localId,
  });
  return true;
}

export async function markOfflineTodoAttachmentUploaded(
  localId: number,
  attachmentLocalId: string,
  remoteAttachmentId: string,
  draftToken: string,
) {
  const records = await listOfflineTodos();
  const current = records.find((record) => record.localId === localId);
  if (!current) return null;
  const next: OfflineTodoRecord = {
    ...current,
    draftToken,
    attachments: current.attachments.map((attachment) => attachment.localId === attachmentLocalId
      ? { ...attachment, remoteAttachmentId }
      : attachment),
    updatedAt: new Date().toISOString(),
  };
  await runRequest(TODO_STORE, "readwrite", (store) => store.put(next));
  console.info("[todo-offline] attachment upload checkpoint stored", {
    clientId: current.clientId,
    localId,
    attachmentLocalId,
    remoteAttachmentId,
  });
  return next;
}

export async function appendOfflineTodoAttachments(
  localId: number,
  attachments: OfflineStoredAttachment[],
) {
  const current = await getOfflineTodoByLocalId(localId);
  if (!current) return null;
  const next: OfflineTodoRecord = {
    ...current,
    attachments: [...current.attachments, ...attachments],
    updatedAt: new Date().toISOString(),
  };
  await runRequest(TODO_STORE, "readwrite", (store) => store.put(next));
  console.info("[todo-offline] local task attachments appended", {
    clientId: current.clientId,
    localId,
    added: attachments.length,
    total: next.attachments.length,
    bytes: attachments.reduce((total, attachment) => total + attachment.blob.size, 0),
  });
  return next;
}

export async function deleteOfflineTodoAttachment(localId: number, attachmentLocalId: string) {
  const current = await getOfflineTodoByLocalId(localId);
  if (!current) return null;
  const next: OfflineTodoRecord = {
    ...current,
    attachments: current.attachments.filter((attachment) => attachment.localId !== attachmentLocalId),
    updatedAt: new Date().toISOString(),
  };
  await runRequest(TODO_STORE, "readwrite", (store) => store.put(next));
  console.info("[todo-offline] local task attachment removed", {
    clientId: current.clientId,
    localId,
    attachmentLocalId,
    remaining: next.attachments.length,
  });
  return next;
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

export async function saveOfflineTaskAction(
  input: Omit<OfflineTaskAction, "attempts" | "nextAttemptAt"> &
    Partial<Pick<OfflineTaskAction, "attempts" | "nextAttemptAt">>,
) {
  const action: OfflineTaskAction = {
    ...input,
    attempts: input.attempts ?? 0,
    nextAttemptAt: input.nextAttemptAt ?? new Date().toISOString(),
  };
  await runRequest(ACTION_STORE, "readwrite", (store) => store.put(action));
  console.info("[todo-offline] task action queued", {
    operationId: action.operationId,
    kind: action.kind,
    path: action.path,
    taskIds: action.taskIds,
    undoRequested: Boolean(action.undoRequested),
  });
  return action;
}

export async function listOfflineTaskActions() {
  const actions = await runRequest<OfflineTaskAction[]>(ACTION_STORE, "readonly", (store) => store.getAll());
  return actions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteOfflineTaskAction(operationId: string) {
  await runRequest(ACTION_STORE, "readwrite", (store) => store.delete(operationId));
  console.info("[todo-offline] synchronized task action removed", { operationId });
}

export async function markOfflineTaskActionUndo(operationId: string) {
  const action = await runRequest<OfflineTaskAction | undefined>(
    ACTION_STORE,
    "readonly",
    (store) => store.get(operationId),
  );
  if (!action) return null;
  const next = { ...action, undoRequested: true };
  await runRequest(ACTION_STORE, "readwrite", (store) => store.put(next));
  console.info("[todo-offline] queued task action marked for undo", {
    operationId,
    taskIds: action.taskIds,
  });
  return next;
}

export async function deferOfflineTaskAction(
  operationId: string,
  attempts: number,
  delayMs: number,
) {
  const action = await runRequest<OfflineTaskAction | undefined>(
    ACTION_STORE,
    "readonly",
    (store) => store.get(operationId),
  );
  if (!action) return null;
  const next: OfflineTaskAction = {
    ...action,
    attempts,
    nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
  };
  await runRequest(ACTION_STORE, "readwrite", (store) => store.put(next));
  console.warn("[todo-offline] task action synchronization deferred", {
    operationId,
    attempts,
    delayMs,
  });
  return next;
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

export async function saveOfflineAssistantMessage(record: OfflineAssistantMessage) {
  try {
    await runRequest(ASSISTANT_QUEUE_STORE, "readwrite", (store) => store.put(record));
    console.info("[todo-offline] assistant message queued", {
      clientId: record.clientId,
      todoId: record.todoId,
      textLength: record.text.length,
      existingAttachmentCount: record.attachmentIds.length,
      stagedAttachmentCount: record.attachments.length,
      stagedBytes: record.attachments.reduce((total, attachment) => total + attachment.blob.size, 0),
    });
  } catch (error) {
    console.error("[todo-offline] assistant message queue failed", {
      clientId: record.clientId,
      todoId: record.todoId,
      error,
    });
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error("This device does not have enough offline storage for those assistant attachments.");
    }
    throw error;
  }
}

export async function listOfflineAssistantMessages() {
  const records = await runRequest<OfflineAssistantMessage[]>(ASSISTANT_QUEUE_STORE, "readonly", (store) => store.getAll());
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteOfflineAssistantMessage(clientId: string) {
  await runRequest(ASSISTANT_QUEUE_STORE, "readwrite", (store) => store.delete(clientId));
  console.info("[todo-offline] synchronized assistant message removed", { clientId });
}

export async function saveOfflineAssistantDraft(todoId: number, text: string) {
  const draft: OfflineAssistantDraft = {
    key: `task:${todoId}`,
    todoId,
    text,
    updatedAt: new Date().toISOString(),
  };
  await runRequest(ASSISTANT_DRAFT_STORE, "readwrite", (store) => store.put(draft));
}

export async function loadOfflineAssistantDraft(todoId: number) {
  const draft = await runRequest<OfflineAssistantDraft | undefined>(
    ASSISTANT_DRAFT_STORE,
    "readonly",
    (store) => store.get(`task:${todoId}`),
  );
  return draft ?? null;
}
