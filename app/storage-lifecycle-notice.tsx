"use client";
import { useState, useSyncExternalStore } from "react";
import { getPwaLifecycle, subscribePwaLifecycle } from "./pwa-lifecycle";

export function StorageLifecycleNotice() {
  const state = useSyncExternalStore(subscribePwaLifecycle, getPwaLifecycle, getPwaLifecycle);
  const [dismissedUpgrade, setDismissedUpgrade] = useState(false);
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
