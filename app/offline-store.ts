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
  sortOrder?: number;
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

export type OfflineTalkMessage = {
  clientId: string;
  threadId: string;
  todoId: number | null;
  text: string;
  attachmentIds: string[];
  attachments: OfflineAssistantAttachment[];
  createdAt: string;
};

export type OfflineTalkDraft = {
  key: string;
  threadId: string;
  text: string;
  updatedAt: string;
};

export type OfflineTaskAction = {
  operationId: string;
  path: string;
  method: "POST" | "PATCH" | "DELETE";
  body: Record<string, unknown>;
  taskIds: number[];
  kind: "bulk" | "task-patch" | "undo" | "reorder";
  optimisticPatches?: Record<string, Record<string, unknown>>;
  optimisticDeletedIds?: number[];
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  undoRequested?: boolean;
};

const DATABASE_NAME = "dawar-todo-offline";
const DATABASE_VERSION = 8;
const TODO_STORE = "pending-todos";
const CACHE_STORE = "cached-state";
const MUTATION_STORE = "pending-mutations";
const ACTION_STORE = "pending-actions";
const CAPTURE_DRAFT_STORE = "capture-draft";
const ASSISTANT_QUEUE_STORE = "assistant-queue";
const ASSISTANT_DRAFT_STORE = "assistant-draft";
const TALK_QUEUE_STORE = "talk-queue";
const TALK_DRAFT_STORE = "talk-draft";

export type CachedServerState<T> = {
  key: "server";
  todos: T[];
  projects: string[];
  revision?: number;
  savedAt: string;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
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
      const todos = request.transaction!.objectStore(TODO_STORE);
      if (!todos.indexNames.contains("localId")) todos.createIndex("localId", "localId");
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
      if (!database.objectStoreNames.contains(TALK_QUEUE_STORE)) {
        const store = database.createObjectStore(TALK_QUEUE_STORE, { keyPath: "clientId" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("threadId", "threadId");
      }
      if (!database.objectStoreNames.contains(TALK_DRAFT_STORE)) {
        database.createObjectStore(TALK_DRAFT_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); databasePromise = null; };
      database.onclose = () => { databasePromise = null; };
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("Offline storage could not be opened."));
  }).catch((error) => { databasePromise = null; throw error; });
  return databasePromise;
}

function runRequest<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    // A successful request can still be rolled back. Acknowledge only commit.
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? request.error ?? new Error("Offline storage transaction failed."));
  }));
}

function updateRecord<T>(storeName: string, key: IDBValidKey, update: (current: T | undefined) => T | undefined, index?: string) {
  return openDatabase().then((database) => new Promise<T | undefined>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const read = index ? store.index(index).get(key) : store.get(key);
    let next: T | undefined;
    read.onsuccess = () => {
      try {
        next = update(read.result as T | undefined);
        if (next !== undefined) store.put(next);
      } catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => resolve(next);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Offline storage update failed."));
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
  return await runRequest<OfflineTodoRecord | undefined>(TODO_STORE, "readonly", (store) => store.index("localId").get(localId)) ?? null;
}

export async function deleteOfflineTodo(clientId: string) {
  await runRequest(TODO_STORE, "readwrite", (store) => store.delete(clientId));
  console.info("[todo-offline] synced task removed", { clientId });
}

export async function updateOfflineTodo(
  localId: number,
  patch: Partial<Omit<OfflineTodoRecord, "clientId" | "localId" | "attachments">>,
) {
  const next = await updateRecord<OfflineTodoRecord>(TODO_STORE, localId, (current) => current ? {
    ...current, ...patch, updatedAt: new Date().toISOString(),
  } : undefined, "localId");
  if (!next) return null;
  console.info("[todo-offline] local task updated", {
    clientId: next.clientId,
    localId,
    fields: Object.keys(patch),
  });
  return next;
}

export async function deleteOfflineTodoByLocalId(localId: number) {
  const current = await getOfflineTodoByLocalId(localId);
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
  const next = await updateRecord<OfflineTodoRecord>(TODO_STORE, localId, (current) => current ? {
    ...current,
    draftToken,
    attachments: current.attachments.map((attachment) => attachment.localId === attachmentLocalId
      ? { ...attachment, remoteAttachmentId } : attachment),
    updatedAt: new Date().toISOString(),
  } : undefined, "localId");
  if (!next) return null;
  console.info("[todo-offline] attachment upload checkpoint stored", {
    clientId: next.clientId,
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
  const next = await updateRecord<OfflineTodoRecord>(TODO_STORE, localId, (current) => current ? {
    ...current,
    attachments: [...current.attachments, ...attachments],
    updatedAt: new Date().toISOString(),
  } : undefined, "localId");
  if (!next) return null;
  console.info("[todo-offline] local task attachments appended", {
    clientId: next.clientId,
    localId,
    added: attachments.length,
    total: next.attachments.length,
    bytes: attachments.reduce((total, attachment) => total + attachment.blob.size, 0),
  });
  return next;
}

export async function deleteOfflineTodoAttachment(localId: number, attachmentLocalId: string) {
  const next = await updateRecord<OfflineTodoRecord>(TODO_STORE, localId, (current) => current ? {
    ...current,
    attachments: current.attachments.filter((attachment) => attachment.localId !== attachmentLocalId),
    updatedAt: new Date().toISOString(),
  } : undefined, "localId");
  if (!next) return null;
  console.info("[todo-offline] local task attachment removed", {
    clientId: next.clientId,
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
  const record = (await updateRecord<OfflineTodoMutation>(MUTATION_STORE, todoId, (previous) => {
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
    return {
      todoId,
      mutationId: crypto.randomUUID(),
      patch: mergedPatch,
      fieldTimestamps: mergedTimestamps,
      createdAt: previous?.createdAt ?? new Date().toISOString(),
    };
  }))!;
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

export async function deleteOfflineTodoMutation(todoId: number, expectedMutationId?: string) {
  if (!expectedMutationId) {
    await runRequest(MUTATION_STORE, "readwrite", (store) => store.delete(todoId));
    console.info("[todo-offline] synchronized task edit removed", { todoId, conditional: false });
    return true;
  }
  const removed = await openDatabase().then((database) => new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(MUTATION_STORE, "readwrite");
    const store = transaction.objectStore(MUTATION_STORE);
    const read = store.get(todoId);
    let matched = false;
    read.onsuccess = () => {
      const current = read.result as OfflineTodoMutation | undefined;
      if (current?.mutationId === expectedMutationId) {
        matched = true;
        store.delete(todoId);
      }
    };
    read.onerror = () => reject(read.error ?? new Error("Offline task edit could not be inspected."));
    transaction.oncomplete = () => {
      resolve(matched);
    };
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Offline task edit cleanup failed."));
  }));
  console.info("[todo-offline] synchronized task edit cleanup checked", {
    todoId,
    expectedMutationId,
    removed,
    newerMutationPreserved: !removed,
  });
  return removed;
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

export async function deleteOfflineTaskAction(operationId: string, expectedUndoRequested?: boolean) {
  if (expectedUndoRequested === undefined) {
    await runRequest(ACTION_STORE, "readwrite", (store) => store.delete(operationId));
    return true;
  }
  return openDatabase().then((database) => new Promise<boolean>((resolve, reject) => {
    const transaction = database.transaction(ACTION_STORE, "readwrite");
    const store = transaction.objectStore(ACTION_STORE);
    const read = store.get(operationId);
    let removed = false;
    read.onsuccess = () => {
      const current = read.result as OfflineTaskAction | undefined;
      if (!current || Boolean(current.undoRequested) === expectedUndoRequested) {
        store.delete(operationId);
        removed = true;
      }
    };
    transaction.oncomplete = () => resolve(removed);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Queued action acknowledgement failed."));
  }));
}

export async function markOfflineTaskActionUndo(operationId: string) {
  const next = await updateRecord<OfflineTaskAction>(ACTION_STORE, operationId, (action) => action ? { ...action, undoRequested: true } : undefined);
  if (!next) return null;
  console.info("[todo-offline] queued task action marked for undo", {
    operationId,
    taskIds: next.taskIds,
  });
  return next;
}

export async function deferOfflineTaskAction(
  operationId: string,
  attempts: number,
  delayMs: number,
) {
  const next = await updateRecord<OfflineTaskAction>(ACTION_STORE, operationId, (action) => action ? {
    ...action, attempts, nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
  } : undefined);
  if (!next) return null;
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

export async function saveOfflineTalkMessage(record: OfflineTalkMessage) {
  try {
    await runRequest(TALK_QUEUE_STORE, "readwrite", (store) => store.put(record));
    console.info("[todo-offline] Talk message queued", {
      clientId: record.clientId,
      threadId: record.threadId,
      todoId: record.todoId,
      textLength: record.text.length,
      attachmentCount: record.attachmentIds.length + record.attachments.length,
      stagedBytes: record.attachments.reduce((total, attachment) => total + attachment.blob.size, 0),
    });
  } catch (error) {
    console.error("[todo-offline] Talk message queue failed", {
      clientId: record.clientId,
      threadId: record.threadId,
      error,
    });
    if (error instanceof DOMException && error.name === "QuotaExceededError") {
      throw new Error("This device does not have enough offline storage for those assistant attachments.");
    }
    throw error;
  }
}

export async function listOfflineTalkMessages(threadId?: string) {
  const records = await runRequest<OfflineTalkMessage[]>(TALK_QUEUE_STORE, "readonly", (store) => store.getAll());
  return records
    .filter((record) => !threadId || record.threadId === threadId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function deleteOfflineTalkMessage(clientId: string) {
  await runRequest(TALK_QUEUE_STORE, "readwrite", (store) => store.delete(clientId));
  console.info("[todo-offline] synchronized Talk message removed", { clientId });
}

export async function saveOfflineTalkDraft(threadId: string, text: string) {
  const draft: OfflineTalkDraft = {
    key: `thread:${threadId}`,
    threadId,
    text,
    updatedAt: new Date().toISOString(),
  };
  await runRequest(TALK_DRAFT_STORE, "readwrite", (store) => store.put(draft));
}

export async function loadOfflineTalkDraft(threadId: string) {
  const draft = await runRequest<OfflineTalkDraft | undefined>(
    TALK_DRAFT_STORE,
    "readonly",
    (store) => store.get(`thread:${threadId}`),
  );
  return draft ?? null;
}
