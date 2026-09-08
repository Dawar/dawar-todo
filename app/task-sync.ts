"use client";
import { taskStore } from "./task-store";
import { type Todo, type TodoSettings, type CaptureDraft, type SyncResponse, type BootstrapResponse } from "./task-model";
import { request, retryableSyncError, syncRetryDelay } from "./sync-request";
import { createSyncHealth, liveSyncDelay, type ConnectionQuality } from "./sync-health";
import { subscribeOfflineChanges } from "./offline-events";
import {
  listOfflineTodos, listOfflineTodoMutations, listOfflineTaskActions, loadCachedServerState,
  commitRemoteTasks, promoteOfflineTodo, deferOfflineTaskAction, rejectOfflineTaskAction,
  listQueuedAttachments, finishQueuedAttachment, deferQueuedAttachment,
  type OfflineTodoMutation, type OfflineTaskAction,
} from "./offline-store";
import { uploadTaskAttachmentMultipart } from "./attachment-upload-client";
import { recordSyncDiagnostic } from "./sync-diagnostics";

export type SyncSnapshot = {
  loading: boolean; quality: ConnectionQuality; creates: number; edits: number; actions: number; uploads: number;
  revision: number; projects: string[]; settings?: TodoSettings; captureDraft?: CaptureDraft | null;
  mutations: OfflineTodoMutation[]; pendingActions: OfflineTaskAction[];
};
type ActionResult = { todo?: Todo; todos?: Todo[]; ids?: number[]; undoToken?: string; snoozedUntil?: string };
export type TaskSyncEvent =
  | { type: "remote"; result: SyncResponse }
  | { type: "edit"; mutation: OfflineTodoMutation; todo: Todo; appliedFields: string[] }
  | { type: "action"; action: OfflineTaskAction; result: ActionResult }
  | { type: "promoted"; localId: number; todo: Todo }
  | { type: "error"; message: string; action?: OfflineTaskAction }
  | { type: "attachment"; todoId: number };

/** Browser-session engine. No component owns its network requests or timers. */
export function createTaskSyncEngine() {
  let snapshot: SyncSnapshot = { loading: true, quality: "online", creates: 0, edits: 0, actions: 0, uploads: 0, revision: 0, projects: [], mutations: [], pendingActions: [] };
  const listeners = new Set<() => void>();
  const events = new Set<(event: TaskSyncEvent) => void>();
  const health = createSyncHealth();
  let started = false;
  let running = false;
  let again = false;
  let initialized = false;
  let failures = 0;
  let quiet = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  let uploading = false;
  let uploadAgain = false;
  let stopped = false;
  let readController: AbortController | null = null;
  let unsubscribe: (() => void) | undefined;
  let reloadRunning: Promise<void> | null = null;
  let reloadAgain = false;
  let stream: EventSource | null = null;
  let streamHealthy = false;
  let streamLastSignal = 0;
  let streamRetryAt = 0;
  let releaseStream: (() => void) | undefined;
  let streamClaiming = false;
  const lanes = new Map<string, { run: (signal: AbortSignal) => Promise<void>; controller?: AbortController; failures: number; timer?: ReturnType<typeof setTimeout> }>();
  function wakeLanes() {
    if (!available()) return;
    for (const [name, lane] of lanes) {
      if (lane.controller || lane.timer) continue;
      const controller = new AbortController(); lane.controller = controller;
      void withLock(`dawar-lane:${name}`, async () => {
        if (!controller.signal.aborted) await lane.run(controller.signal);
      }).then(() => { lane.failures = 0; }).catch(() => { lane.failures++; }).finally(() => {
        lane.controller = undefined;
        if (lanes.get(name) === lane && !stopped) lane.timer = setTimeout(() => { lane.timer = undefined; wakeLanes(); }, lane.failures ? syncRetryDelay(lane.failures) : 10_000);
      });
    }
  }
  const available = () => !stopped && navigator.onLine && document.visibilityState !== "hidden";
  const emit = (event: TaskSyncEvent) => events.forEach((listener) => listener(event));
  const publish = (patch: Partial<SyncSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next; listeners.forEach((listener) => listener());
  };
  async function reload() {
    if (reloadRunning) { reloadAgain = true; return reloadRunning; }
    reloadRunning = (async () => {
      do {
        reloadAgain = false;
        const localVersion = taskStore.getVersion();
        const [cache, creates, mutations, actions, uploads] = await Promise.all([
          loadCachedServerState<Todo>(), listOfflineTodos(), listOfflineTodoMutations(), listOfflineTaskActions(), listQueuedAttachments(),
        ]);
        if (reloadAgain || taskStore.getVersion() !== localVersion) { reloadAgain = true; continue; }
        // Reconcile persisted intent as well as rows when upgrading an older cache.
        const deleted = new Set(actions.flatMap((action) => action.undoRequested ? [] : action.optimisticDeletedIds ?? []));
        const patches = new Map(mutations.map((mutation) => [mutation.todoId, mutation.patch]));
        for (const action of actions) if (!action.undoRequested) for (const [id, patch] of Object.entries(action.optimisticPatches ?? {})) patches.set(Number(id), { ...patches.get(Number(id)), ...patch });
        const tasks = (cache?.todos ?? []).filter((todo) => !deleted.has(todo.id)).map((todo) => ({ ...todo, ...patches.get(todo.id) } as Todo));
        taskStore.setAll(tasks);
        publish({ loading: false, creates: creates.length, edits: mutations.length, actions: actions.length, uploads: uploads.length,
          mutations, pendingActions: actions, revision: cache?.revision ?? 0, projects: cache?.projects ?? [],
          ...(cache?.settings ? { settings: cache.settings } : {}),
          ...(cache && Object.hasOwn(cache, "captureDraft") ? { captureDraft: cache.captureDraft } : {}),
        });
      } while (reloadAgain);
    })().finally(() => { reloadRunning = null; });
    return reloadRunning;
  }
  async function withLock(name: string, operation: () => Promise<void>) {
    if (navigator.locks?.request) {
      await navigator.locks.request(name, { ifAvailable: true }, async (lock) => { if (lock) await operation(); });
    } else await operation(); // Server operation IDs and conditional acknowledgements still protect retries.
  }
  function wake(delay = 0) {
    if (!started || stopped) return;
    if (running) { again = true; return; }
    if (timer !== undefined) clearTimeout(timer);
    timer = available() ? setTimeout(() => { timer = undefined; void tick(); }, delay) : undefined;
  }
  function success() { failures = 0; publish({ quality: health.success() }); }
  function failure(error: unknown) {
    failures += 1;
    publish({ quality: health.failure(error, navigator.onLine) });
    recordSyncDiagnostic("sync-backed-off", { attempts: failures, status: (error as { status?: number }).status ?? null });
  }
  async function flushTasks() {
    const [mutations, actions, records] = await Promise.all([listOfflineTodoMutations(), listOfflineTaskActions(), listOfflineTodos()]);
    for (const mutation of mutations) {
      if (!available()) return;
      try {
        const result = await request<{ todo: Todo; appliedFields: string[] }>(`/api/todos/${mutation.todoId}`, {
          method: "PATCH", body: JSON.stringify({ ...mutation.patch, autosave: true, mutation: { mutationId: mutation.mutationId, fieldTimestamps: mutation.fieldTimestamps } }),
        });
        await commitRemoteTasks({ todos: [result.todo], acknowledgeMutation: mutation });
        success(); emit({ type: "edit", mutation, ...result });
      } catch (error) {
        if ((error as { status?: number }).status === 404) { await commitRemoteTasks({ todos: [], deletedIds: [mutation.todoId] }); continue; }
        throw error;
      }
    }
    const blocked = new Set<number>();
    for (const action of actions) {
      if (!available()) return;
      if (action.taskIds.some((id) => blocked.has(id)) || Date.parse(action.nextAttemptAt) > Date.now()) { action.taskIds.forEach((id) => blocked.add(id)); continue; }
      try {
        const result = await request<ActionResult>(action.path, { method: action.method, body: JSON.stringify({ ...action.body, operationId: action.operationId }) });
        if (action.undoRequested && result.undoToken) await request("/api/todos/undo", { method: "POST", body: JSON.stringify({ undoToken: result.undoToken }) });
        const acknowledged = await commitRemoteTasks({
          todos: action.undoRequested ? [] : result.todo ? [result.todo] : result.todos ?? [],
          deletedIds: action.undoRequested ? [] : action.optimisticDeletedIds ?? (result.todo ? (result.ids ?? []).filter((id) => id !== result.todo?.id) : []),
          acknowledgeAction: { operationId: action.operationId, undoRequested: Boolean(action.undoRequested) },
        });
        if (!acknowledged) { again = true; action.taskIds.forEach((id) => blocked.add(id)); continue; }
        success(); emit({ type: "action", action, result });
      } catch (error) {
        if (retryableSyncError(error)) {
          const delayMs = syncRetryDelay(action.attempts + 1);
          await deferOfflineTaskAction(action.operationId, action.attempts + 1, delayMs);
          recordSyncDiagnostic("action-deferred", { kind: action.kind, attempts: action.attempts + 1, delayMs });
          action.taskIds.forEach((id) => blocked.add(id));
          const status = (error as { status?: number }).status;
          if (status && status >= 500) { failure(error); continue; }
          throw error;
        }
        await rejectOfflineTaskAction(action);
        emit({ type: "error", action, message: error instanceof Error ? error.message : "A task change could not be synced." });
      }
    }
    for (const record of records) {
      if (!available()) return;
      // Create the task immediately; queued files use a separate transport lane.
      const result = await request<{ todo: Todo }>("/api/todos", { method: "POST", body: JSON.stringify({
        clientId: record.clientId, title: record.title, notes: record.notes, priority: record.priority ?? 3,
        dueDate: record.dueDate, project: record.project, context: record.context, recurrenceCron: record.recurrenceCron,
      }) });
      const todo = await promoteOfflineTodo(record, result.todo);
      success(); if (todo) emit({ type: "promoted", localId: record.localId, todo });
      again = true;
    }
  }
  async function read() {
    if (!available()) return;
    readController = new AbortController();
    try {
      const result: SyncResponse = initialized
        ? await request<SyncResponse>(`/api/sync?after=${snapshot.revision}`, { cache: "no-store", timeoutMs: 15_000, signal: readController.signal })
        : { ...await request<BootstrapResponse>("/api/bootstrap", { cache: "no-store", timeoutMs: 15_000, signal: readController.signal }), reset: true, reason: "initial" };
      if (readController.signal.aborted) return;
      await commitRemoteTasks(result);
      initialized = true;
      quiet = result.todos.length || (!result.reset && result.deletedIds.length) ? 0 : quiet + 1;
      success(); emit({ type: "remote", result });
    } finally { readController = null; }
  }
  async function tick() {
    if (!available()) return;
    if (running) { again = true; return; }
    running = true; again = false;
    const startedAt = Date.now();
    try {
      await withLock("dawar-task-sync", async () => { await reload(); await flushTasks(); await read(); });
      await reload();
      connectStream();
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") failure(error);
    } finally {
      running = false;
      recordSyncDiagnostic("sync-finished", { remainingCreates: snapshot.creates, remainingEdits: snapshot.edits, remainingActions: snapshot.actions, durationMs: Date.now() - startedAt });
      void wakeUploads(); wakeLanes();
      const deferred = snapshot.pendingActions.reduce((delay, action) => Math.min(delay, Math.max(500, Date.parse(action.nextAttemptAt) - Date.now())), Infinity);
      const poll = streamHealthy ? 30_000 : liveSyncDelay(failures, quiet);
      wake(failures ? Math.max(2_000, poll) : again ? 150 : Math.min(poll, deferred));
    }
  }
  async function discardQueuedFile(upload: { todoId: number; localId: string; remoteAttachmentId?: string }) {
    const endpoint = `/api/todos/${upload.todoId}/attachments/${upload.remoteAttachmentId ?? upload.localId}`;
    try { await request(endpoint, { method: "DELETE" }); }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    await request(`${endpoint}?discard=1`, { method: "DELETE" });
    await finishQueuedAttachment(upload.localId);
  }
  async function wakeUploads() {
    if (!available()) return;
    if (uploading) { uploadAgain = true; return; }
    if (uploadTimer !== undefined) { clearTimeout(uploadTimer); uploadTimer = undefined; }
    uploading = true; uploadAgain = false;
    try {
      await withLock("dawar-attachment-sync", async () => {
        for (const upload of await listQueuedAttachments()) {
          if (!available()) break;
          if (upload.nextAttemptAt > Date.now()) continue;
          // Deletions cancel uploads; a deletion racing an upload is checked by the server too.
          const pending = await listOfflineTaskActions();
          if (pending.some((action) => action.optimisticDeletedIds?.includes(upload.todoId))) continue;
          try {
            if (upload.cancelled) { await discardQueuedFile(upload); continue; }
            let claimed = false;
            if (upload.remoteAttachmentId && upload.draftToken) {
              try {
                await request(`/api/todos/${upload.todoId}/attachments/claim`, { method: "POST", body: JSON.stringify({ draftToken: upload.draftToken, attachmentIds: [upload.remoteAttachmentId] }) });
                claimed = true;
              } catch (error) { if ((error as { status?: number }).status !== 400) throw error; }
            }
            if (!claimed) {
              await uploadTaskAttachmentMultipart({ file: new File([upload.blob], upload.fileName, { type: upload.mimeType }), kind: upload.kind, durationMs: upload.durationMs,
                endpoint: `/api/todos/${upload.todoId}/attachments`, request, clientUploadId: upload.localId });
            }
            const current = (await listQueuedAttachments()).find((item) => item.localId === upload.localId);
            if (current?.cancelled) await discardQueuedFile({ ...upload, remoteAttachmentId: claimed ? upload.remoteAttachmentId : undefined });
            else await finishQueuedAttachment(upload.localId);
            emit({ type: "attachment", todoId: upload.todoId }); wake();
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 404) { await finishQueuedAttachment(upload.localId); continue; }
            const delay = syncRetryDelay(upload.attempts + 1);
            await deferQueuedAttachment(upload.localId, upload.attempts + 1, retryableSyncError(error) ? delay : Infinity, error instanceof Error ? error.message : "Upload deferred");
            // A slow file never marks task sync as a slow connection.
            if (!retryableSyncError(error)) emit({ type: "error", message: `Attachment saved on this device. ${error instanceof Error ? error.message : "Upload could not finish."}` });
          }
        }
      });
      await reload();
    } catch (error) { console.warn("[todo-sync] upload lane deferred", error); }
    finally {
      uploading = false;
      if (available() && (snapshot.uploads || uploadAgain)) uploadTimer = setTimeout(() => void wakeUploads(), uploadAgain ? 100 : 2_000);
    }
  }
  function closeStream() {
    stream?.close(); stream = null; streamHealthy = false;
    releaseStream?.(); releaseStream = undefined;
  }
  function connectStream() {
    if (stream && Date.now() - streamLastSignal > 40_000) closeStream();
    if (!available() || stream || streamClaiming || Date.now() < streamRetryAt || typeof EventSource === "undefined") return;
    const open = () => new Promise<void>((resolve) => {
      if (!available()) { resolve(); return; }
      releaseStream = resolve;
      stream = new EventSource(`/api/sync/events?after=${snapshot.revision}`);
      streamLastSignal = Date.now();
      const signal = (event: MessageEvent) => {
        streamLastSignal = Date.now(); streamHealthy = true;
        if (event.type === "revision") { const revision = Number(event.data); if (Number.isInteger(revision) && revision !== snapshot.revision) wake(); }
      };
      stream.addEventListener("revision", signal as EventListener);
      stream.addEventListener("heartbeat", signal as EventListener);
      stream.addEventListener("reconnect", () => { closeStream(); streamRetryAt = 0; wake(100); });
      stream.onerror = () => { closeStream(); streamRetryAt = Date.now() + 15_000; wake(500); };
    });
    streamClaiming = true;
    const claim = navigator.locks?.request
      ? navigator.locks.request("dawar-revision-stream", { ifAvailable: true }, async (lock) => { if (lock) await open(); })
      : open();
    void claim.finally(() => { streamClaiming = false; });
  }
  function lifecycle() {
    publish({ quality: health.browser(navigator.onLine) });
    if (!available()) {
      readController?.abort(); closeStream();
      if (timer !== undefined) clearTimeout(timer);
      if (uploadTimer !== undefined) clearTimeout(uploadTimer);
      return;
    }
    failures = 0; quiet = 0; streamRetryAt = 0;
    wake(); void wakeUploads(); wakeLanes();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onEvent(listener: (event: TaskSyncEvent) => void) { events.add(listener); return () => { events.delete(listener); }; },
    wake,
    registerLane(name: string, run: (signal: AbortSignal) => Promise<void>) {
      const lane = { run, failures: 0 } as { run: typeof run; failures: number; controller?: AbortController; timer?: ReturnType<typeof setTimeout> };
      lanes.set(name, lane); wakeLanes();
      return () => { if (lanes.get(name) === lane) lanes.delete(name); lane.controller?.abort(); if (lane.timer) clearTimeout(lane.timer); };
    },
    async refresh() { wake(); },
    start() {
      if (started) return;
      started = true; stopped = false;
      unsubscribe = subscribeOfflineChanges((change, external) => {
        if (external || change === "uploads") void reload().catch((error) => emit({ type: "error", message: String(error) }));
        if (change === "local") { if (reloadRunning) reloadAgain = true; wake(250); }
        if (change === "uploads") void wakeUploads();
        if (change === "chat") wakeLanes();
      });
      window.addEventListener("online", lifecycle); window.addEventListener("offline", lifecycle);
      window.addEventListener("focus", lifecycle); document.addEventListener("visibilitychange", lifecycle);
      void reload().then(lifecycle).catch((error) => { publish({ loading: false }); emit({ type: "error", message: String(error) }); });
    },
    stop() {
      for (const lane of lanes.values()) { lane.controller?.abort(); if (lane.timer) clearTimeout(lane.timer); }
      stopped = true; started = false; unsubscribe?.(); closeStream(); readController?.abort();
      if (timer !== undefined) clearTimeout(timer); if (uploadTimer !== undefined) clearTimeout(uploadTimer);
      window.removeEventListener("online", lifecycle); window.removeEventListener("offline", lifecycle);
      window.removeEventListener("focus", lifecycle); document.removeEventListener("visibilitychange", lifecycle);
    },
  };
}
export const taskSync = createTaskSyncEngine();
