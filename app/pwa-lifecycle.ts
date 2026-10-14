"use client";

declare const __DAWAR_BUILD__: string;
export const documentBuild = typeof __DAWAR_BUILD__ === "string" ? __DAWAR_BUILD__ : "development";
export const offlineDatabaseVersion = 11;
type StoragePhase = "opening" | "ready" | "blocked" | "superseded" | "unavailable";
export type PwaLifecycle = { build: string; expectedDatabaseVersion: number; databaseVersion: number | null; upgradedFrom: number | null; storage: StoragePhase; workerCache: string | null; workerDatabaseVersion: number | null; workerBuild: string | null; publishedBuild: string | null; publishedCheck: "unknown" | "current" | "unavailable" };
let state: PwaLifecycle = { build: documentBuild, expectedDatabaseVersion: offlineDatabaseVersion, databaseVersion: null, upgradedFrom: null, storage: "opening", workerCache: null, workerDatabaseVersion: null, workerBuild: null, publishedBuild: null, publishedCheck: "unknown" };
const listeners = new Set<() => void>();
export const getPwaLifecycle = () => state;
export function subscribePwaLifecycle(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function updatePwaLifecycle(patch: Partial<PwaLifecycle>) {
  if (Object.entries(patch).every(([key, value]) => state[key as keyof PwaLifecycle] === value)) return;
  state = { ...state, ...patch }; listeners.forEach((listener) => listener());
}
let publishedRequest: Promise<void> | undefined;
let publishedCheckedAt = 0;
/** Public, same-origin discovery only. A cached worker is not publication proof.
 * Coalesce foreground events; failures never imply the loaded page is current. */
export function inspectPublishedVersion(): Promise<void> {
  if (publishedRequest) return publishedRequest;
  if (!navigator.onLine || document.hidden || Date.now() - publishedCheckedAt < 60_000) return Promise.resolve();
  publishedCheckedAt = Date.now();
  const pending = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch("/pwa-build.json", { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
      if (!response.ok || !response.headers.get("content-type")?.includes("application/json") || !response.body) throw Error("Version unavailable");
      reader = response.body.getReader();
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw Error("Invalid version response");
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof value.build !== "string" || !/^[a-f0-9]{7,40}$/.test(value.build)
        || !Number.isSafeInteger(value.databaseVersion) || value.databaseVersion < 1) throw Error("Invalid version response");
      updatePwaLifecycle({ publishedBuild: value.build, publishedCheck: "current" });
    } catch { updatePwaLifecycle({ publishedCheck: "unavailable" }); }
    finally { clearTimeout(timer); void reader?.cancel().catch(() => {}); }
  })().finally(() => { if (publishedRequest === pending) publishedRequest = undefined; });
  publishedRequest = pending;
  return pending;
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
