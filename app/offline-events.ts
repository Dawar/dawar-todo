"use client";
export type OfflineChange = "local" | "remote" | "uploads" | "chat";
const listeners = new Set<(change: OfflineChange, external: boolean) => void>();
let channel: BroadcastChannel | null = null;
function connect() {
  if (!channel && typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel("dawar-local-state-v1");
    channel.onmessage = ({ data }) => {
      if (["local", "remote", "uploads", "chat"].includes(data)) listeners.forEach((listener) => listener(data, true));
    };
  }
}
export function subscribeOfflineChanges(listener: (change: OfflineChange, external: boolean) => void) {
  connect(); listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyOfflineChange(change: OfflineChange) {
  connect();
  listeners.forEach((listener) => listener(change, false));
  channel?.postMessage(change);
}
