"use client";
import { getPwaLifecycle } from "./pwa-lifecycle";

const guards = new Map<string, () => Promise<void>>();
export function registerPwaUpdateGuard(key: string, guard: () => Promise<void>) {
  guards.set(key, guard);
  return () => { if (guards.get(key) === guard) guards.delete(key); };
}

/** Explicit human adoption only. No auth, IDB, drafts or outboxes are cleared. */
export async function preparePwaRefresh() {
  if (!navigator.onLine) throw Error("Reconnect before refreshing the app.");
  if (["blocked", "superseded", "unavailable"].includes(getPwaLifecycle().storage))
    throw Error("Preserve your input and resolve offline storage before refreshing.");
  // Operator registers an exact live-call guard; adoption never interrupts audio.
  window.dispatchEvent(new Event("dawar-before-navigation"));
  await Promise.all([...guards.values()].map(guard => guard()));
  const worker = navigator.serviceWorker?.controller;
  if (!worker) throw Error("The app update is not ready. Try again shortly.");
  const channel = new MessageChannel();
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); if (error) reject(error); else resolve(); };
    const timer = setTimeout(() => finish(Error("The new app could not be prepared. Your current page remains open.")), 30_000);
    channel.port1.onmessage = ({ data }) => finish(data?.ok === true ? undefined : Error("The new app could not be prepared. Retry when connected."));
    worker.postMessage({ type: "PWA_REFRESH_DOCUMENT", url: location.href }, [channel.port2]);
  });
  // Save again after the network walk: typing may have continued meanwhile.
  await Promise.all([...guards.values()].map(guard => guard()));
}
