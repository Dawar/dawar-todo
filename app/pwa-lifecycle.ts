"use client";

declare const __DAWAR_BUILD__: string;
export const documentBuild = typeof __DAWAR_BUILD__ === "string" ? __DAWAR_BUILD__ : "development";
export const offlineDatabaseVersion = 11;
type StoragePhase = "opening" | "ready" | "blocked" | "superseded" | "unavailable";
export type PwaLifecycle = { build: string; expectedDatabaseVersion: number; databaseVersion: number | null; upgradedFrom: number | null; storage: StoragePhase; workerCache: string | null; workerDatabaseVersion: number | null; workerBuild: string | null };
let state: PwaLifecycle = { build: documentBuild, expectedDatabaseVersion: offlineDatabaseVersion, databaseVersion: null, upgradedFrom: null, storage: "opening", workerCache: null, workerDatabaseVersion: null, workerBuild: null };
const listeners = new Set<() => void>();
export const getPwaLifecycle = () => state;
export function subscribePwaLifecycle(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function updatePwaLifecycle(patch: Partial<PwaLifecycle>) {
  if (Object.entries(patch).every(([key, value]) => state[key as keyof PwaLifecycle] === value)) return;
  state = { ...state, ...patch }; listeners.forEach((listener) => listener());
}
export async function inspectWorkerVersion() {
  if (typeof MessageChannel === "undefined" || !navigator.serviceWorker?.controller) return;
  const channel = new MessageChannel();
  await new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); resolve(); };
    const timer = setTimeout(done, 1000);
    channel.port1.onmessage = ({ data }) => {
      if (typeof data?.cache === "string" && /^dawar-todo-shell-v\d+$/.test(data.cache)) {
        updatePwaLifecycle({ workerCache: data.cache, workerDatabaseVersion: Number.isInteger(data.databaseVersion) ? data.databaseVersion : null,
          workerBuild: typeof data.build === "string" && /^[a-f0-9]{7,40}$/.test(data.build) ? data.build : null });
      }
      done();
    };
    navigator.serviceWorker.controller!.postMessage({ type: "PWA_VERSION" }, [channel.port2]);
  });
}
