"use client";
import { useState, useSyncExternalStore } from "react";
import { getPwaLifecycle, subscribePwaLifecycle } from "./pwa-lifecycle";
import { preparePwaRefresh } from "./pwa-update";

export function StorageLifecycleNotice() {
  const state = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycle, getPwaLifecycle);
  const [dismissedUpgrade, setDismissedUpgrade] = useState(false);
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState("");
  async function refresh() {
    setRefreshing(true); setError("");
    try { await preparePwaRefresh(); location.reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The update could not be prepared."); setRefreshing(false); }
  }
  if (state.workerBuild && state.workerBuild !== state.build && ["ready", "opening"].includes(state.storage)) return <aside role="status" className="border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950">
    An app update is ready. <button type="button" disabled={refreshing} className="ml-2 underline" onClick={() => void refresh()}>{refreshing ? "Preparing…" : "Refresh when ready"}</button>
    {error && <p role="alert" className="mt-1">{error}</p>}
  </aside>;
  if (state.storage === "ready" && state.upgradedFrom && !dismissedUpgrade) return <aside role="status" className="border-b border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
    Offline storage was upgraded. In older open tabs, preserve unsaved text and original files before reopening them. Already queued changes remain on this device.
    <button type="button" className="ml-2 underline" onClick={() => setDismissedUpgrade(true)}>Dismiss</button>
  </aside>;
  if (state.storage !== "blocked" && state.storage !== "superseded" && state.storage !== "unavailable") return null;
  return <aside role="alert" className="sticky top-0 z-[110] border-b border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
    <strong>{state.storage === "blocked" ? "Offline storage is waiting for another tab." : state.storage === "superseded" ? "This page needs the newer app version." : "Offline storage is unavailable."}</strong>{" "}
    Keep this page open while saving or copying any unsaved text and files. {state.storage === "blocked"
      ? "Close older Dawar Todo tabs after saving their input; this page will continue automatically."
      : "After preserving unsaved input, open Dawar Todo again to retry. Queued changes remain on this device."}
    {" "}Do not clear site data.
  </aside>;
}
