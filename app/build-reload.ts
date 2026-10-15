"use client";
import type { PwaLifecycle } from "./pwa-lifecycle";

// Build-change handling. After a deploy, a long-open tab keeps running the
// old client against the new server and its data (2026-10-15: an old cached
// client crashed after a deploy). When the published build differs from this
// document's build, the page reloads by itself at a safe moment:
//   - the tab is hidden, or the person has been idle and is not typing;
//   - always through preparePwaRefresh(): its guards flush and check drafts,
//     the capture, the task editor and live calls, and refuse while any is
//     unsafe; the service worker caches the new document before the reload,
//     so the reload cannot land on the old cached shell.
// A chunk-load failure (the old build's code is gone from the server) or a
// screen crash on a stale build makes it urgent: no idle wait, same guards.
// One automatic reload per target build per session prevents loops; after
// that the "Refresh when ready" banner stays the way forward.

const BUILD = /^[a-f0-9]{7,40}$/;
const GUARD_KEY = "dawar-build-reload";
export const RELOAD_GUARD_MS = 10 * 60_000;

type Timer = ReturnType<typeof setTimeout>;
export type BuildReloadDeps = {
  getLifecycle: () => PwaLifecycle;
  subscribe: (listener: () => void) => () => void;
  /** preparePwaRefresh: throws while a guard (draft, call, storage) is unsafe. */
  prepare: () => Promise<void>;
  reload: () => void;
  /** inspectPublishedVersion: coalesced, skips hidden tabs and offline. */
  inspect: () => Promise<void>;
  window: Pick<Window, "addEventListener" | "removeEventListener">;
  document: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> & { activeElement?: Element | null };
  session?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  idleMs?: number;
  retryMs?: number;
  pollMs?: number;
  log?: (message: string, detail?: Record<string, unknown>) => void;
};

/** The build to move to, or null when this document is current (or unversioned, e.g. development). */
export function staleBuild(state: PwaLifecycle): string | null {
  if (!BUILD.test(state.build)) return null;
  const target = state.publishedBuild ?? state.workerBuild;
  if (!target || !BUILD.test(target) || target === state.build) return null;
  // Storage that is blocked or superseded has its own notice and must not
  // be reloaded under it; an open-in-progress database is fine to leave.
  return ["ready", "opening"].includes(state.storage) ? target : null;
}

/** The old build's code was removed from the server. */
export function isChunkLoadError(reason: unknown): boolean {
  const error = reason as { name?: unknown; message?: unknown } | null;
  const name = typeof error?.name === "string" ? error.name : "";
  const message = typeof error?.message === "string" ? error.message : typeof reason === "string" ? reason : "";
  return name === "ChunkLoadError" || /Loading (CSS )?chunk [\w-]+ failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

function editing(element: Element | null | undefined) {
  if (!element) return false;
  const tag = element.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || (element as HTMLElement).isContentEditable === true;
}

export type BuildReloadController = { stop: () => void; /** A screen crashed: reload now if the build is stale. */ failure: (error?: unknown) => void };

export function startBuildReload(deps: BuildReloadDeps): BuildReloadController {
  const now = deps.now ?? Date.now, setTimer = deps.setTimer ?? setTimeout, clearTimer = deps.clearTimer ?? clearTimeout;
  const idleMs = deps.idleMs ?? 60_000, retryMs = deps.retryMs ?? 30_000, pollMs = deps.pollMs ?? 5 * 60_000;
  const log = deps.log ?? ((message, detail) => console.info(`[todo-pwa] ${message}`, detail ?? {}));
  let lastActivity = now(), activityCount = 0, urgent = false, attempting = false, stopped = false;
  let timer: Timer | undefined, poll: Timer | undefined;

  const reloadedFor = (target: string) => {
    try {
      const value = JSON.parse(deps.session?.getItem(GUARD_KEY) ?? "null") as { target?: string; at?: number } | null;
      return value?.target === target && typeof value.at === "number" && now() - value.at < RELOAD_GUARD_MS;
    } catch { return false; }
  };
  const remember = (target: string) => { try { deps.session?.setItem(GUARD_KEY, JSON.stringify({ target, at: now() })); } catch { /* Private mode: the banner still works. */ } };
  const safe = () => deps.document.visibilityState === "hidden" || (now() - lastActivity >= idleMs && !editing(deps.document.activeElement));
  const schedule = (ms: number) => { if (stopped) return; if (timer) clearTimer(timer); timer = setTimer(() => { timer = undefined; void attempt(); }, ms); };

  async function attempt() {
    if (stopped || attempting) return;
    // A chunk failure proves this build's code is gone even before the
    // published build was read; its loop guard is keyed on this document.
    const state = deps.getLifecycle(), target = staleBuild(state) ?? (urgent && BUILD.test(state.build) ? `missing:${state.build}` : null);
    if (!target) return;
    if (reloadedFor(target)) return;
    if (!urgent && !safe()) { schedule(Math.max(1000, idleMs - (now() - lastActivity))); return; }
    attempting = true;
    const startedAt = activityCount, visible = deps.document.visibilityState !== "hidden";
    try {
      await deps.prepare();
      // Typing resumed while the new build was fetched: keep the page.
      if (!urgent && visible && activityCount !== startedAt && deps.document.visibilityState !== "hidden") { schedule(idleMs); return; }
      remember(target);
      log("reloading for a new build", { from: state.build, to: target, urgent });
      deps.reload();
    } catch (error) {
      log("build reload deferred", { reason: error instanceof Error ? error.message : String(error) });
      schedule(retryMs);
    } finally { attempting = false; }
  }

  const activity = () => { lastActivity = now(); activityCount++; };
  const changed = () => { if (staleBuild(deps.getLifecycle())) void attempt(); };
  const visibility = () => { if (deps.document.visibilityState === "hidden") void attempt(); else void deps.inspect(); };
  const chunk = (event: Event) => {
    const reason = (event as ErrorEvent).error ?? (event as PromiseRejectionEvent).reason ?? (event as ErrorEvent).message;
    if (!isChunkLoadError(reason)) return;
    urgent = true; void deps.inspect().finally(() => void attempt());
  };
  const tick = () => { poll = setTimer(tick, pollMs); if (deps.document.visibilityState !== "hidden") void deps.inspect(); };

  const unsubscribe = deps.subscribe(changed);
  const activityEvents = ["pointerdown", "keydown", "input", "wheel", "touchstart"] as const;
  for (const name of activityEvents) deps.window.addEventListener(name, activity, { capture: true, passive: true });
  deps.window.addEventListener("error", chunk);
  deps.window.addEventListener("unhandledrejection", chunk);
  deps.document.addEventListener("visibilitychange", visibility);
  // Foreground events alone never re-check a tab left open and visible.
  poll = setTimer(tick, pollMs);
  changed();

  return {
    stop() {
      stopped = true; unsubscribe(); if (timer) clearTimer(timer); if (poll) clearTimer(poll);
      for (const name of activityEvents) deps.window.removeEventListener(name, activity, { capture: true });
      deps.window.removeEventListener("error", chunk);
      deps.window.removeEventListener("unhandledrejection", chunk);
      deps.document.removeEventListener("visibilitychange", visibility);
    },
    failure(error) {
      if (!staleBuild(deps.getLifecycle()) && !isChunkLoadError(error)) return;
      urgent = true; void attempt();
    },
  };
}

// The running controller, for error boundaries outside PwaRegister's effect.
let active: BuildReloadController | null = null;
export function setActiveBuildReload(controller: BuildReloadController | null) { active = controller; }
export function reportClientFailure(error?: unknown) { active?.failure(error); }
