"use client";
import { useState, useSyncExternalStore } from "react";
import { getPwaLifecycle, subscribePwaLifecycle } from "./pwa-lifecycle";
import { preparePwaRefresh } from "./pwa-update";
import { Button } from "@/components/ui/button";

export function StorageLifecycleNotice() {
  const state = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycle, getPwaLifecycle);
  const [dismissedUpgrade, setDismissedUpgrade] = useState(false);
  const [dismissedBuild, setDismissedBuild] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState("");
  async function refresh() {
    setRefreshing(true); setError("");
    try { await preparePwaRefresh(); location.reload(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The update could not be prepared."); setRefreshing(false); }
  }
  const availableBuild = state.publishedBuild ?? state.workerBuild;
  if (availableBuild && availableBuild !== state.build && availableBuild !== dismissedBuild && ["ready", "opening"].includes(state.storage)) return <aside role="status" className="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-[150] mx-auto max-w-xl rounded-lg border border-border bg-accent p-3 text-sm text-accent-foreground shadow-lg">
    <div className="flex flex-wrap items-center gap-3"><span>An app update is available.</span><Button type="button" variant="outline" size="sm" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? "Preparing…" : "Refresh when ready"}</Button><Button type="button" variant="ghost" size="sm" disabled={refreshing} onClick={() => setDismissedBuild(availableBuild)}>Later</Button></div>
    {error && <p role="alert" className="mt-2 text-destructive break-words">{error}</p>}
  </aside>;
  if (state.storage === "ready" && state.upgradedFrom && !dismissedUpgrade) return <aside role="status" className="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-[150] mx-auto max-w-xl rounded-lg border border-border bg-warning p-3 text-sm text-warning-foreground shadow-lg">
    <div className="flex flex-wrap items-start gap-3"><p className="min-w-0 flex-1 basis-64">Offline storage was updated. Save unsaved text and files in older tabs before reopening them. Queued changes stay on this device.</p>
    <Button type="button" variant="outline" size="sm" onClick={() => setDismissedUpgrade(true)}>Dismiss</Button></div>
  </aside>;
  if (state.storage !== "blocked" && state.storage !== "superseded" && state.storage !== "unavailable") return null;
  return <aside role="alert" className="fixed inset-x-3 top-[max(12px,env(safe-area-inset-top))] z-[150] mx-auto max-w-xl rounded-lg border border-border bg-warning p-3 text-sm text-warning-foreground shadow-lg">
    <p className="font-medium">{state.storage === "blocked" ? "Waiting for another tab" : state.storage === "superseded" ? "A newer app version is required" : "Offline storage is unavailable"}</p>
    <p className="mt-1">Save unsaved text and files before {state.storage === "blocked" ? "closing older Dawar Todo tabs. This page will continue automatically." : "reopening Dawar Todo. Queued changes stay on this device."} Do not clear site data.</p>
  </aside>;
}
