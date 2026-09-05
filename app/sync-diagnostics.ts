"use client";

import {
  listOfflineTaskActions,
  listOfflineTodoMutations,
  listOfflineTodos,
  loadCachedServerState,
} from "./offline-store";

type SyncDiagnosticValue = string | number | boolean | null;
type SyncDiagnosticDetails = Record<string, SyncDiagnosticValue>;

type StoredSyncDiagnosticEvent = {
  at: string;
  event: string;
  details: SyncDiagnosticDetails;
};

type ConnectionNavigator = Navigator & {
  connection?: {
    effectiveType?: string;
    type?: string;
    rtt?: number;
    downlink?: number;
    saveData?: boolean;
  };
};

const DIAGNOSTIC_STORAGE_KEY = "dawar-todo-sync-diagnostics-v1";
const DIAGNOSTIC_EVENT_LIMIT = 40;

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function readStoredSyncDiagnosticEvents() {
  try {
    const value = window.localStorage.getItem(DIAGNOSTIC_STORAGE_KEY);
    if (!value) return [] as StoredSyncDiagnosticEvent[];
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [] as StoredSyncDiagnosticEvent[];
    return parsed
      .filter((entry): entry is StoredSyncDiagnosticEvent => (
        Boolean(entry)
        && typeof entry.at === "string"
        && typeof entry.event === "string"
        && Boolean(entry.details)
        && typeof entry.details === "object"
      ))
      .slice(-DIAGNOSTIC_EVENT_LIMIT);
  } catch {
    return [] as StoredSyncDiagnosticEvent[];
  }
}

export function recordSyncDiagnostic(event: string, details: SyncDiagnosticDetails = {}) {
  try {
    const entries = readStoredSyncDiagnosticEvents();
    entries.push({
      at: new Date().toISOString(),
      event: event.slice(0, 80),
      details,
    });
    window.localStorage.setItem(
      DIAGNOSTIC_STORAGE_KEY,
      JSON.stringify(entries.slice(-DIAGNOSTIC_EVENT_LIMIT)),
    );
  } catch (error) {
    console.warn("[todo-diagnostics] sync event could not be retained", {
      event,
      error: safeError(error),
    });
  }
}

async function probeSettingsApi() {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("/api/settings", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    return {
      reachable: true,
      status: response.status,
      durationMs: Math.round(performance.now() - startedAt),
    };
  } catch (error) {
    return {
      reachable: false,
      durationMs: Math.round(performance.now() - startedAt),
      error: safeError(error),
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function settledValue<T>(result: PromiseSettledResult<T>, fallback: T) {
  return result.status === "fulfilled" ? result.value : fallback;
}

function settledError(result: PromiseSettledResult<unknown>) {
  return result.status === "rejected" ? safeError(result.reason) : null;
}

function ageMs(value: string, now: number) {
  const timestamp = new Date(value).valueOf();
  return Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null;
}

export async function buildSyncDiagnosticsReport(
  source: "settings" | "settings-error",
  extra: SyncDiagnosticDetails = {},
) {
  const now = Date.now();
  const cacheKeysPromise = "caches" in window ? caches.keys() : Promise.resolve([] as string[]);
  const registrationPromise = "serviceWorker" in navigator
    ? navigator.serviceWorker.getRegistration()
    : Promise.resolve(undefined);
  const estimatePromise = navigator.storage?.estimate
    ? navigator.storage.estimate()
    : Promise.resolve({} as StorageEstimate);
  const persistedPromise = navigator.storage?.persisted
    ? navigator.storage.persisted()
    : Promise.resolve(false);
  const [
    pendingTodosResult,
    pendingMutationsResult,
    pendingActionsResult,
    cachedStateResult,
    cacheKeysResult,
    registrationResult,
    estimateResult,
    persistedResult,
    apiProbeResult,
  ] = await Promise.allSettled([
    listOfflineTodos(),
    listOfflineTodoMutations(),
    listOfflineTaskActions(),
    loadCachedServerState<unknown>(),
    cacheKeysPromise,
    registrationPromise,
    estimatePromise,
    persistedPromise,
    probeSettingsApi(),
  ]);

  const pendingTodos = settledValue(pendingTodosResult, []);
  const pendingMutations = settledValue(pendingMutationsResult, []);
  const pendingActions = settledValue(pendingActionsResult, []);
  const cachedState = settledValue(cachedStateResult, null);
  const cacheKeys = settledValue(cacheKeysResult, []);
  const registration = settledValue(registrationResult, undefined);
  const estimate = settledValue(estimateResult, {} as StorageEstimate);
  const persisted = settledValue(persistedResult, false);
  const connection = (navigator as ConnectionNavigator).connection;
  const controller = "serviceWorker" in navigator ? navigator.serviceWorker.controller : null;
  const storageErrors = {
    pendingCreates: settledError(pendingTodosResult),
    pendingEdits: settledError(pendingMutationsResult),
    pendingActions: settledError(pendingActionsResult),
    cachedState: settledError(cachedStateResult),
    cacheKeys: settledError(cacheKeysResult),
    serviceWorkerRegistration: settledError(registrationResult),
    storageEstimate: settledError(estimateResult),
    persistedStorage: settledError(persistedResult),
  };

  const report = {
    report: "Dawar Todo privacy-safe sync diagnostics",
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    source,
    privacy: "Task text, notes, task IDs, operation IDs, attachment names, API tokens, credentials, and device IDs are omitted.",
    page: {
      path: window.location.pathname,
      visibility: document.visibilityState,
      onlineHint: navigator.onLine,
      secureContext: window.isSecureContext,
    },
    browser: {
      userAgent: navigator.userAgent,
      language: navigator.language,
      connection: connection ? {
        type: connection.type ?? null,
        effectiveType: connection.effectiveType ?? null,
        rttMs: connection.rtt ?? null,
        downlinkMbps: connection.downlink ?? null,
        saveData: connection.saveData ?? null,
      } : null,
    },
    apiProbe: settledValue(apiProbeResult, {
      reachable: false,
      durationMs: 0,
      error: settledError(apiProbeResult) ?? "Probe unavailable.",
    }),
    serviceWorker: {
      supported: "serviceWorker" in navigator,
      controller: controller ? {
        state: controller.state,
        scriptPath: new URL(controller.scriptURL).pathname,
      } : null,
      registration: registration ? {
        scopePath: new URL(registration.scope).pathname,
        activeState: registration.active?.state ?? null,
        waitingState: registration.waiting?.state ?? null,
        installingState: registration.installing?.state ?? null,
        updateViaCache: registration.updateViaCache,
      } : null,
      appShellCaches: cacheKeys.filter((key) => key.startsWith("dawar-todo-shell-")),
    },
    storage: {
      persisted,
      usageBytes: estimate.usage ?? null,
      quotaBytes: estimate.quota ?? null,
      errors: Object.fromEntries(Object.entries(storageErrors).filter(([, value]) => value !== null)),
    },
    queue: {
      counts: {
        creates: pendingTodos.length,
        edits: pendingMutations.length,
        actions: pendingActions.length,
      },
      creates: pendingTodos.map((todo) => ({
        ageMs: ageMs(todo.createdAt, now),
        attachmentCount: todo.attachments.length,
        uploadedAttachmentCount: todo.attachments.filter((attachment) => Boolean(attachment.remoteAttachmentId)).length,
        attachmentBytes: todo.attachments.reduce((total, attachment) => total + attachment.blob.size, 0),
      })),
      edits: pendingMutations.map((mutation) => ({
        ageMs: ageMs(mutation.createdAt, now),
        fields: Object.keys(mutation.patch).sort(),
      })),
      actions: pendingActions.map((action) => ({
        kind: action.kind,
        method: action.method,
        path: action.path.split("?")[0],
        ageMs: ageMs(action.createdAt, now),
        attempts: action.attempts,
        retryInMs: Math.max(0, new Date(action.nextAttemptAt).valueOf() - now),
        taskCount: action.taskIds.length,
        undoRequested: Boolean(action.undoRequested),
      })),
    },
    cachedServerState: cachedState ? {
      ageMs: ageMs(cachedState.savedAt, now),
      todoCount: cachedState.todos.length,
      projectCount: cachedState.projects.length,
      revision: cachedState.revision ?? null,
    } : null,
    recentSyncEvents: readStoredSyncDiagnosticEvents(),
    extra,
  };

  return `Dawar Todo sync diagnostics\n\n${JSON.stringify(report, null, 2)}`;
}
