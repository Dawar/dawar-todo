"use client";
import { offlineRecordTodo, type Todo, type SyncResponse } from "./task-model";
import { notifyOfflineChange } from "./offline-events";

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
  deleted?: boolean;
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
  previousTodos?: Todo[];
};

const DATABASE_NAME = "dawar-todo-offline";
const DATABASE_VERSION = 9;
const TASK_STORE = "task-state";
const IDENTITY_STORE = "task-identities";
const UPLOAD_STORE = "attachment-outbox";
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
  settings?: SyncResponse["settings"];
  captureDraft?: SyncResponse["captureDraft"];
};

let databasePromise: Promise<IDBDatabase> | null = null;

export function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser cannot save tasks for offline use."));
      return;
    }
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const migrateTasks = !database.objectStoreNames.contains(TASK_STORE);
      if (migrateTasks) database.createObjectStore(TASK_STORE, { keyPath: "id" });
      if (!database.objectStoreNames.contains(IDENTITY_STORE)) database.createObjectStore(IDENTITY_STORE, { keyPath: "localId" });
      if (!database.objectStoreNames.contains(UPLOAD_STORE)) database.createObjectStore(UPLOAD_STORE, { keyPath: "localId" });
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
      if (migrateTasks) {
        const transaction = request.transaction!;
        const tasks = transaction.objectStore(TASK_STORE);
        const cached = transaction.objectStore(CACHE_STORE).get("server");
        cached.onsuccess = () => {
          for (const todo of cached.result?.todos ?? []) tasks.put(todo);
          const pending = transaction.objectStore(TODO_STORE).getAll();
          pending.onsuccess = () => { for (const record of pending.result) tasks.put(offlineRecordTodo(record)); };
        };
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
    const transaction = database.transaction(storeName === TODO_STORE ? [storeName, TASK_STORE] : storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const read = index ? store.index(index).get(key) : store.get(key);
    let next: T | undefined;
    read.onsuccess = () => {
      try {
        next = update(read.result as T | undefined);
        if (next !== undefined) {
          store.put(next);
          if (storeName === TODO_STORE) {
            const record = next as OfflineTodoRecord;
            if (record.deleted) transaction.objectStore(TASK_STORE).delete(record.localId);
            else transaction.objectStore(TASK_STORE).put(offlineRecordTodo(record));
          }
        }
      } catch (error) { transaction.abort(); reject(error); }
    };
    transaction.oncomplete = () => { resolve(next); if (storeName === TODO_STORE) notifyOfflineChange("local"); };
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
    await taskTransaction([TODO_STORE, TASK_STORE], (transaction) => {
      transaction.objectStore(TODO_STORE).put(record);
      transaction.objectStore(TASK_STORE).put(offlineRecordTodo(record));
    });
    notifyOfflineChange("local");
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
  await updateRecord<OfflineTodoRecord>(TODO_STORE, clientId, (current) => current ? { ...current, deleted: true, updatedAt: new Date().toISOString() } : undefined);
}

export async function updateOfflineTodo(
  localId: number,
  patch: Partial<Omit<OfflineTodoRecord, "clientId" | "localId" | "attachments">>,
) {
  const next = await updateRecord<OfflineTodoRecord>(TODO_STORE, localId, (current) => current ? {
    ...current, ...patch, updatedAt: new Date().toISOString(),
  } : undefined, "localId");
  if (!next) {
    const resolved = await resolveTaskId(localId);
    if (resolved !== localId) {
      const timestamp = new Date().toISOString();
      await saveOfflineTodoMutation(resolved, patch, Object.fromEntries(Object.keys(patch).map((key) => [key, timestamp])));
      const state = await loadCachedServerState<Todo>();
      const todo = state?.todos.find((item) => item.id === resolved);
      return todo ? { ...todo, localId: resolved, clientId: todo.clientId!, attachments: [] } : null;
    }
    return null;
  }
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
  if (!next) {
    const resolved = await resolveTaskId(localId);
    if (resolved !== localId) await queueTaskAttachments(resolved, attachments);
    return null;
  }
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
  todoId = await resolveTaskId(todoId);
  let record!: OfflineTodoMutation;
  await taskTransaction([MUTATION_STORE, TASK_STORE], (transaction) => {
    const mutations = transaction.objectStore(MUTATION_STORE);
    const read = mutations.get(todoId);
    read.onsuccess = () => {
      record = mergeMutation(todoId, read.result, patch, fieldTimestamps);
      mutations.put(record);
      const tasks = transaction.objectStore(TASK_STORE);
      const current = tasks.get(todoId);
      current.onsuccess = () => { if (current.result) tasks.put({ ...current.result, ...record.patch }); };
    };
  });
  notifyOfflineChange("local");
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
  await taskTransaction([ACTION_STORE, TASK_STORE, UPLOAD_STORE], (transaction) => {
    const tasks = transaction.objectStore(TASK_STORE);
    const current = tasks.getAll();
    current.onsuccess = () => {
      action.previousTodos ??= current.result.filter((todo: Todo) => action.taskIds.includes(todo.id));
      transaction.objectStore(ACTION_STORE).put(action);
      for (const todo of action.previousTodos!) {
        if (action.optimisticDeletedIds?.includes(todo.id)) tasks.delete(todo.id);
        else if (action.optimisticPatches?.[todo.id]) tasks.put({ ...todo, ...action.optimisticPatches[todo.id] });
      }
    };
  });
  notifyOfflineChange("local");
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
  let next: OfflineTaskAction | null = null;
  await taskTransaction([ACTION_STORE, TASK_STORE], (transaction) => {
    const store = transaction.objectStore(ACTION_STORE);
    const read = store.get(operationId);
    read.onsuccess = () => {
      if (!read.result) return;
      next = { ...read.result, undoRequested: true };
      store.put(next);
      for (const todo of next!.previousTodos ?? []) transaction.objectStore(TASK_STORE).put(todo);
    };
  });
  notifyOfflineChange("local");
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
  await commitRemoteTasks({ reset: true, todos: todos as Todo[], projects, revision: revision ?? 0 });
}

export async function loadCachedServerState<T>() {
  const database = await openDatabase();
  return new Promise<CachedServerState<T> | null>((resolve, reject) => {
    const transaction = database.transaction([CACHE_STORE, TASK_STORE], "readonly");
    const metadata = transaction.objectStore(CACHE_STORE).get("server");
    const tasks = transaction.objectStore(TASK_STORE).getAll();
    transaction.oncomplete = () => resolve({ key: "server", projects: [], revision: 0, savedAt: "", ...metadata.result, todos: tasks.result });
    transaction.onerror = transaction.onabort = () => reject(transaction.error);
  });
}

export async function saveOfflineAssistantMessage(record: OfflineAssistantMessage) {
  try {
    await runRequest(ASSISTANT_QUEUE_STORE, "readwrite", (store) => store.put(record));
    notifyOfflineChange("chat");
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
    notifyOfflineChange("chat");
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

// Every task change and its retry record commit together. Blob data lives in a
// separate store so updating a title never clones a video into the task cache.
export function taskTransaction(stores: string[], operation: (transaction: IDBTransaction) => void) {
  return openDatabase().then((database) => new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(stores, "readwrite");
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("The local change could not be saved."));
    try { operation(transaction); } catch (error) { transaction.abort(); reject(error); }
  }));
}

function mergeMutation(todoId: number, previous: OfflineTodoMutation | undefined, patch: Record<string, unknown>, timestamps: Record<string, string>): OfflineTodoMutation {
  const mergedPatch = { ...previous?.patch };
  const mergedTimestamps = { ...previous?.fieldTimestamps };
  const editable = new Set(["title", "notes", "status", "priority", "dueDate", "project", "context", "snoozedUntil", "recurrenceCron", "pinned"]);
  for (const [field, value] of Object.entries(patch)) {
    if (!editable.has(field)) continue;
    const timestamp = timestamps[field];
    if (timestamp && (!mergedTimestamps[field] || timestamp >= mergedTimestamps[field])) {
      mergedPatch[field] = value;
      mergedTimestamps[field] = timestamp;
    }
  }
  return { todoId, mutationId: crypto.randomUUID(), patch: mergedPatch, fieldTimestamps: mergedTimestamps, createdAt: previous?.createdAt ?? new Date().toISOString() };
}

export async function resolveTaskId(id: number) {
  if (id > 0) return id;
  const alias = await runRequest<{ localId: number; todoId: number } | undefined>(IDENTITY_STORE, "readonly", (store) => store.get(id));
  return alias?.todoId ?? id;
}

export type QueuedAttachment = OfflineStoredAttachment & {
  cancelled?: boolean;
  todoId: number;
  createdAt: string;
  attempts: number;
  nextAttemptAt: number;
  draftToken?: string;
  error?: string;
};
export async function listQueuedAttachments() {
  return runRequest<QueuedAttachment[]>(UPLOAD_STORE, "readonly", (store) => store.getAll());
}
export async function queueTaskAttachments(todoId: number, attachments: OfflineStoredAttachment[]) {
  await taskTransaction([UPLOAD_STORE], (transaction) => {
    for (const attachment of attachments) transaction.objectStore(UPLOAD_STORE).put({ ...attachment, todoId, createdAt: new Date().toISOString(), attempts: 0, nextAttemptAt: 0 });
  });
  notifyOfflineChange("uploads");
}
export async function finishQueuedAttachment(localId: string) {
  await runRequest(UPLOAD_STORE, "readwrite", (store) => store.delete(localId));
  notifyOfflineChange("remote");
}
export async function deferQueuedAttachment(localId: string, attempts: number, delayMs: number, error: string) {
  await updateRecord<QueuedAttachment>(UPLOAD_STORE, localId, (current) => current ? { ...current, attempts, nextAttemptAt: Date.now() + delayMs, error } : undefined);
}

/** Commit one server response without erasing pending local intent. */
export async function commitRemoteTasks(input: {
  todos: Todo[]; deletedIds?: number[]; reset?: boolean; revision?: number;
  projects?: string[]; settings?: SyncResponse["settings"]; captureDraft?: SyncResponse["captureDraft"];
  acknowledgeMutation?: { todoId: number; mutationId: string };
  acknowledgeAction?: { operationId: string; undoRequested: boolean };
}) {
  let acknowledged = true;
  await taskTransaction([TASK_STORE, CACHE_STORE, TODO_STORE, MUTATION_STORE, ACTION_STORE, UPLOAD_STORE], (transaction) => {
    const tasks = transaction.objectStore(TASK_STORE);
    const old = tasks.getAll();
    const pending = transaction.objectStore(TODO_STORE).getAll();
    const mutations = transaction.objectStore(MUTATION_STORE).getAll();
    const actions = transaction.objectStore(ACTION_STORE).getAll();
    const cache = transaction.objectStore(CACHE_STORE).get("server");
    const uploads = transaction.objectStore(UPLOAD_STORE).getAll();
    // All requests were queued synchronously; the last success sees their results.
    uploads.onsuccess = () => {
      const oldCache = cache.result ?? { key: "server", projects: [], revision: 0 };
      // Another tab may have already committed a newer revision.
      if (input.revision !== undefined && input.revision < oldCache.revision && !input.reset) return;
      let queuedMutations = mutations.result as OfflineTodoMutation[];
      let queuedActions = (actions.result as OfflineTaskAction[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      if (input.acknowledgeMutation) {
        const ack = input.acknowledgeMutation;
        queuedMutations = queuedMutations.filter((mutation) => {
          if (mutation.todoId !== ack.todoId || mutation.mutationId !== ack.mutationId) return true;
          transaction.objectStore(MUTATION_STORE).delete(mutation.todoId); return false;
        });
      }
      if (input.acknowledgeAction) {
        const ack = input.acknowledgeAction;
        queuedActions = queuedActions.filter((action) => {
          if (action.operationId !== ack.operationId) return true;
          if (Boolean(action.undoRequested) !== ack.undoRequested) { acknowledged = false; return true; }
          transaction.objectStore(ACTION_STORE).delete(action.operationId); return false;
        });
      }
      const remoteIds = new Set(input.todos.map((todo) => todo.id));
      const deleted = new Set(input.deletedIds ?? []);
      if (input.reset) for (const todo of old.result as Todo[]) if (todo.id > 0 && !remoteIds.has(todo.id)) deleted.add(todo.id);
      const next = new Map<number, Todo>((old.result as Todo[]).map((todo) => [todo.id, todo]));
      for (const id of deleted) {
        next.delete(id); tasks.delete(id);
        transaction.objectStore(MUTATION_STORE).delete(id);
        for (const upload of uploads.result as QueuedAttachment[]) if (upload.todoId === id) transaction.objectStore(UPLOAD_STORE).delete(upload.localId);
      }
      for (const todo of input.todos) next.set(todo.id, { ...todo, offline: false });
      for (const record of pending.result as OfflineTodoRecord[]) {
        // A create response may be visible in another tab before its acknowledgement.
        for (const [id, todo] of next) if (id > 0 && todo.clientId === record.clientId) next.delete(id);
        if (record.deleted) next.delete(record.localId);
        else next.set(record.localId, offlineRecordTodo(record));
      }
      for (const mutation of queuedMutations) {
        const todo = next.get(mutation.todoId);
        if (todo && !deleted.has(todo.id)) next.set(todo.id, { ...todo, ...mutation.patch } as Todo);
      }
      for (const action of queuedActions) {
        if (action.undoRequested) {
          for (const todo of action.previousTodos ?? []) if (!deleted.has(todo.id)) next.set(todo.id, todo);
          continue;
        }
        for (const [rawId, patch] of Object.entries(action.optimisticPatches ?? {})) {
          const todo = next.get(Number(rawId));
          if (todo) next.set(todo.id, { ...todo, ...patch });
        }
        for (const id of action.optimisticDeletedIds ?? []) next.delete(id);
      }
      const previous = new Map<number, Todo>((old.result as Todo[]).map((todo) => [todo.id, todo]));
      for (const id of previous.keys()) if (!next.has(id)) tasks.delete(id);
      for (const todo of next.values()) if (JSON.stringify(previous.get(todo.id)) !== JSON.stringify(todo)) tasks.put(todo);
      const metadata = { ...oldCache, todos: undefined, savedAt: new Date().toISOString() };
      for (const key of ["revision", "projects", "settings", "captureDraft"] as const) if (Object.hasOwn(input, key)) metadata[key] = input[key];
      transaction.objectStore(CACHE_STORE).put(metadata);
    };
  });
  notifyOfflineChange("remote");
  return acknowledged;
}

/** Move the UUID-backed local record, latest edits and attachments in one commit. */
export async function promoteOfflineTodo(sent: OfflineTodoRecord, remote: Todo) {
  let promoted: Todo | null = null;
  await taskTransaction([TODO_STORE, TASK_STORE, IDENTITY_STORE, MUTATION_STORE, ACTION_STORE, UPLOAD_STORE], (transaction) => {
    const pending = transaction.objectStore(TODO_STORE);
    const read = pending.get(sent.clientId);
    read.onsuccess = () => {
      const current = read.result as OfflineTodoRecord | undefined;
      transaction.objectStore(IDENTITY_STORE).put({ localId: sent.localId, todoId: remote.id });
      transaction.objectStore(TASK_STORE).delete(sent.localId);
      if (!current || current.deleted) {
        pending.delete(sent.clientId);
        // The user deleted the local task while POST was in flight.
        const now = new Date().toISOString();
        transaction.objectStore(ACTION_STORE).put({ operationId: crypto.randomUUID(), path: "/api/todos/bulk", method: "POST", body: { ids: [remote.id], action: "delete" }, taskIds: [remote.id], kind: "bulk", optimisticDeletedIds: [remote.id], previousTodos: [], attempts: 0, createdAt: now, nextAttemptAt: now } satisfies OfflineTaskAction);
        return;
      }
      const local = offlineRecordTodo(current);
      const patch: Record<string, unknown> = {};
      // Copy only fields this creation or subsequent local edits actually set.
      for (const field of ["title", "notes", "status", "priority", "dueDate", "project", "context", "snoozedUntil", "recurrenceCron", "pinned"] as const) {
        if (local[field] !== remote[field]) patch[field] = local[field];
      }
      if (Object.keys(patch).length) {
        const timestamp = current.updatedAt ?? current.createdAt;
        transaction.objectStore(MUTATION_STORE).put(mergeMutation(remote.id, undefined, patch, Object.fromEntries(Object.keys(patch).map((field) => [field, timestamp]))));
      }
      promoted = { ...remote, ...patch, clientId: current.clientId, offline: false } as Todo;
      transaction.objectStore(TASK_STORE).put(promoted);
      for (const attachment of current.attachments) {
        transaction.objectStore(UPLOAD_STORE).put({ ...attachment, todoId: remote.id, draftToken: current.draftToken, createdAt: current.createdAt, attempts: 0, nextAttemptAt: 0 } satisfies QueuedAttachment);
      }
      pending.delete(current.clientId);
    };
  });
  notifyOfflineChange("local");
  return promoted;
}

export async function rejectOfflineTaskAction(action: OfflineTaskAction) {
  await taskTransaction([TASK_STORE, ACTION_STORE], (transaction) => {
    for (const todo of action.previousTodos ?? []) transaction.objectStore(TASK_STORE).put(todo);
    transaction.objectStore(ACTION_STORE).delete(action.operationId);
  });
  notifyOfflineChange("local");
}

export async function retryQueuedAttachments() {
  await taskTransaction([UPLOAD_STORE], (transaction) => {
    const store = transaction.objectStore(UPLOAD_STORE);
    const read = store.getAll();
    read.onsuccess = () => { for (const upload of read.result) store.put({ ...upload, nextAttemptAt: 0, error: undefined }); };
  });
  notifyOfflineChange("uploads");
}

export async function cancelQueuedAttachment(localId: string) {
  await updateRecord<QueuedAttachment>(UPLOAD_STORE, localId, (current) => current ? { ...current, cancelled: true, nextAttemptAt: 0 } : undefined);
  notifyOfflineChange("uploads");
}
