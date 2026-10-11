"use client";
import { useState, useSyncExternalStore } from "react";
import { getPwaLifecycle, subscribePwaLifecycle } from "./pwa-lifecycle";
import { preparePwaRefresh } from "./pwa-update";
import { Button } from "@/components/ui/button";

export function StorageLifecycleNotice() {
  const state = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycle, getPwaLifecycle);
  const [dismissedUpgrade, setDismissedUpgrade] = useState(false);
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState("");
  async function refresh() {
    setRefreshing(true); setError("");
    try { await preparePwaRefresh(); location.reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The update could not be prepared."); setRefreshing(false); }
  }
  if (state.workerBuild && state.workerBuild !== state.build && ["ready", "opening"].includes(state.storage)) return <aside role="status" className="border-b border-border bg-accent px-4 py-3 text-sm text-accent-foreground">
    <div className="flex flex-wrap items-center gap-3"><span>An app update is ready.</span><Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Preparing…" : "Refresh when ready"}</Button></div>
    {error && <p role="alert" className="mt-2 text-destructive break-words">{error}</p>}
  </aside>;
  if (state.storage === "ready" && state.upgradedFrom && !dismissedUpgrade) return <aside role="status" className="border-b border-border bg-warning px-4 py-3 text-sm text-warning-foreground">
    <div className="flex flex-wrap items-start gap-3"><p className="min-w-0 flex-1 basis-64">Offline storage was updated. Save unsaved text and files in older tabs before reopening them. Queued changes stay on this device.</p>
    <Button type="button" variant="outline" size="sm" onClick={() => setDismissedUpgrade(true)}>Dismiss</Button></div>
  </aside>;
  if (state.storage !== "blocked" && state.storage !== "superseded" && state.storage !== "unavailable") return null;
  return <aside role="alert" className="sticky top-0 z-[110] border-b border-border bg-warning px-4 py-3 text-sm text-warning-foreground">
    <p className="font-medium">{state.storage === "blocked" ? "Waiting for another tab" : state.storage === "superseded" ? "A newer app version is required" : "Offline storage is unavailable"}</p>
    <p className="mt-1">Save unsaved text and files before {state.storage === "blocked" ? "closing older Dawar Todo tabs. This page will continue automatically." : "reopening Dawar Todo. Queued changes stay on this device."} Do not clear site data.</p>
  </aside>;
}
