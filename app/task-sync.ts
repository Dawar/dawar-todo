"use client";
import { taskStore } from "./task-store";
import { type Todo, type TodoSettings, type CaptureDraft, type SyncResponse, type BootstrapResponse } from "./task-model";
import { request, retryableSyncError, syncRetryDelay } from "./sync-request";
import { createSyncHealth, liveSyncDelay, type ConnectionQuality } from "./sync-health";
import { subscribeOfflineChanges } from "./offline-events";
import {
  listOfflineTodos, listOfflineTodoMutations, listOfflineTaskActions, loadCachedServerState,
  commitRemoteTasks, promoteOfflineTodo, deferOfflineTaskAction, rejectOfflineTaskAction,
  listQueuedAttachments, rejectOfflineTaskIntent,
  type OfflineTodoMutation, type OfflineTaskAction, type OfflineTodoRecord,
} from "./offline-store";
import { taskActionRetryDelay, uploadWaitingForTaskAction } from "./task-queue-order";
import { syncQueuedAttachment } from "./attachment-sync";
import { attachmentQueueState } from "./attachment-queue";
import { recordSyncDiagnostic } from "./sync-diagnostics";

export type SyncSnapshot = {
  loading: boolean; quality: ConnectionQuality; creates: number; edits: number; actions: number; uploads: number;
  uploadStates: Record<string, number>;
  rejectedCreates: OfflineTodoRecord[];
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
  let snapshot: SyncSnapshot = { loading: true, quality: "online", creates: 0, edits: 0, actions: 0, uploads: 0, uploadStates: {}, rejectedCreates: [], revision: 0, projects: [], mutations: [], pendingActions: [] };
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
  let timerIsPoll = false;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  let uploading = false;
  let uploadAgain = false;
  let stopped = false;
  let readController: AbortController | null = null;
  let unsubscribe: (() => void) | undefined;
  let reloadRunning: Promise<void> | null = null;
  let reloadAgain = false;
  let cacheDirty = true;
  let lastLifecycleWake = -Infinity;
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
    if (Object.keys(patch).every((key) => Object.is(next[key as keyof SyncSnapshot], snapshot[key as keyof SyncSnapshot]))) return;
    snapshot = next; listeners.forEach((listener) => listener());
  };
  async function reload() {
    if (reloadRunning) { reloadAgain = true; return reloadRunning; }
    reloadRunning = (async () => {
      do {
        reloadAgain = false; cacheDirty = false;
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
          uploadStates: uploads.reduce<Record<string, number>>((counts, upload) => { const state = attachmentQueueState(upload); counts[state] = (counts[state] ?? 0) + 1; return counts; }, {}),
          rejectedCreates: creates.filter((record) => record.rejected), mutations, pendingActions: actions, revision: cache?.revision ?? 0, projects: cache?.projects ?? [],
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
  function wake(delay = 0, polling = false) {
    if (!started || stopped) return;
    if (running) { again = true; return; }
    if (timer !== undefined) clearTimeout(timer);
    timerIsPoll = polling;
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
    const blocked = new Set<number>();
    for (const mutation of mutations) {
      if (!available()) return;
      if (mutation.rejected) { blocked.add(mutation.todoId); continue; }
      try {
        const result = await request<{ todo: Todo; appliedFields: string[] }>(`/api/todos/${mutation.todoId}`, {
          method: "PATCH", body: JSON.stringify({ ...mutation.patch, autosave: true, mutation: { mutationId: mutation.mutationId, fieldTimestamps: mutation.fieldTimestamps } }),
        });
        await commitRemoteTasks({ todos: [result.todo], acknowledgeMutation: mutation });
        success(); emit({ type: "edit", mutation, ...result });
      } catch (error) {
        if (retryableSyncError(error)) throw error;
        await rejectOfflineTaskIntent(mutation, (error as { status: number }).status);
        blocked.add(mutation.todoId);
        recordSyncDiagnostic("task-intent-rejected", { kind: "edit", status: (error as { status: number }).status });
      }
    }
    for (const action of actions) {
      if (!available()) return;
      if (action.taskIds.some((id) => blocked.has(id)) || Date.parse(action.nextAttemptAt) > Date.now()) { action.taskIds.forEach((id) => blocked.add(id)); continue; }
      try {
        const result = await request<ActionResult>(action.path, { method: action.method, body: JSON.stringify({ ...action.body, operationId: action.operationId }) });
        if (action.undoRequested && result.undoToken) await request("/api/todos/undo", { method: "POST", body: JSON.stringify({ undoToken: result.undoToken }) });
        const acknowledged = await commitRemoteTasks({
          todos: action.undoRequested ? [] : result.todo ? [result.todo] : result.todos ?? [],
          deletedIds: action.undoRequested ? [] : action.optimisticDeletedIds ?? (result.todo ? (result.ids ?? []).filter((id) => id !== result.todo?.id) : []),
          ...(action.body.action === "merge" && result.todo && !action.undoRequested
            ? { attachmentTarget: { fromIds: action.taskIds, todoId: result.todo.id } } : {}),
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
      if (record.rejected) continue;
      // Create the task immediately; queued files use a separate transport lane.
      try {
        const result = await request<{ todo: Todo }>("/api/todos", { method: "POST", body: JSON.stringify({
          clientId: record.clientId, title: record.title, notes: record.notes, priority: record.priority ?? 3,
          dueDate: record.dueDate, project: record.project, context: record.context, recurrenceCron: record.recurrenceCron,
        }) });
        const todo = await promoteOfflineTodo(record, result.todo);
        success(); if (todo) emit({ type: "promoted", localId: record.localId, todo });
        again = true;
      } catch (error) {
        if (retryableSyncError(error)) throw error;
        await rejectOfflineTaskIntent(record, (error as { status: number }).status);
        recordSyncDiagnostic("task-intent-rejected", { kind: "create", status: (error as { status: number }).status });
      }
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
      if (result.reset || result.todos.length || (!result.reset && result.deletedIds.length)) cacheDirty = true;
      publish({ revision: Math.max(snapshot.revision, result.revision) });
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
      await withLock("dawar-task-sync", async () => {
        if (cacheDirty) await reload();
        if (snapshot.creates || snapshot.edits || snapshot.actions) await flushTasks();
        await read();
      });
      if (cacheDirty) await reload();
      connectStream();
    } catch (error) {
      if ((error as { name?: string }).name !== "AbortError") failure(error);
    } finally {
      running = false;
      recordSyncDiagnostic("sync-finished", { remainingCreates: snapshot.creates, remainingEdits: snapshot.edits, remainingActions: snapshot.actions, durationMs: Date.now() - startedAt });
      wakeLanes();
      const deferred = taskActionRetryDelay(snapshot.pendingActions, snapshot.mutations, Date.now());
      const poll = streamHealthy ? 30_000 : liveSyncDelay(failures, quiet);
      wake(failures ? Math.max(2_000, poll) : again ? 150 : Math.min(poll, deferred), !failures && !again && deferred >= poll);
    }
  }
  async function wakeUploads() {
    if (!available()) return;
    if (uploading) { uploadAgain = true; return; }
    if (uploadTimer !== undefined) { clearTimeout(uploadTimer); uploadTimer = undefined; }
    uploading = true; uploadAgain = false;
    let nextDelay = Infinity;
    try {
      await withLock("dawar-attachment-sync", async () => {
        for (const upload of await listQueuedAttachments()) {
          if (!available()) break;
          if (upload.nextAttemptAt > Date.now() || (upload.leaseUntil ?? 0) > Date.now()) continue;
          const pending = await listOfflineTaskActions();
          // Wait for a merge/deletion result before deciding this file's target.
          if (uploadWaitingForTaskAction(upload, pending)) continue;
          const todoId = await syncQueuedAttachment(upload.localId);
          if (todoId !== null) { emit({ type: "attachment", todoId }); wake(); }
        }
      });
      await reload();
      const pending = await listOfflineTaskActions();
      for (const row of await listQueuedAttachments()) {
        // Target actions wake this lane through local/remote notifications.
        if (uploadWaitingForTaskAction(row, pending)) continue;
        const eligibleAt = Math.max(row.nextAttemptAt, row.leaseUntil ?? 0);
        nextDelay = Math.min(nextDelay, Math.max(2_000, eligibleAt - Date.now()));
      }
    } catch {
      recordSyncDiagnostic("attachment-storage-failed");
      nextDelay = 10_000;
    } finally {
      uploading = false;
      if (available() && (Number.isFinite(nextDelay) || uploadAgain)) {
        uploadTimer = setTimeout(() => void wakeUploads(), uploadAgain ? 100 : nextDelay);
      }
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
        const becameHealthy = !streamHealthy;
        streamLastSignal = Date.now(); streamHealthy = true;
        // Replace a provisional fallback poll after the first healthy signal.
        // Heartbeats must not postpone the periodic safety read indefinitely.
        if (becameHealthy && !running && timerIsPoll) wake(30_000, true);
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
      lastLifecycleWake = -Infinity;
      return;
    }
    if (Date.now() - lastLifecycleWake < 500) return;
    lastLifecycleWake = Date.now();
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
        if (change !== "chat") cacheDirty = true;
        if ((external || change === "uploads" || change === "remote") && !running && !uploading) void reload().catch((error) => emit({ type: "error", message: String(error) }));
        if (change === "local") { if (reloadRunning) reloadAgain = true; wake(250); }
        if (change === "uploads" || ((change === "remote" || change === "local") && snapshot.uploads > 0)) void wakeUploads();
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
