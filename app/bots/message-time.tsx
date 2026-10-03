"use client";
import { useSyncExternalStore } from "react";
import "./message-time.css";

// One minute clock for mounted timestamps. No chat data refresh or live region.
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function tick() {
  if (document.visibilityState === "hidden") return;
  now = Date.now();
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      clearInterval(timer); timer = undefined;
      document.removeEventListener("visibilitychange", tick);
    }
  };
}
const snapshot = () => now;
const serverSnapshot = () => 0;
export function MessageTime({ seconds, basis, user = false, inline = false }: {
  seconds?: number | null;
  basis?: "received" | "turn-start" | "turn-end" | "saved";
  user?: boolean; inline?: boolean;
}) {
  const clock = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (!clock || !seconds || !Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return null;
  const minutes = Math.max(0, Math.floor((clock - date.getTime()) / 60_000));
  const ago = minutes < 1 ? "just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  const today = new Date(clock);
  const sameDay = date.toDateString() === today.toDateString();
  const local = date.toLocaleString(undefined, { ...(sameDay ? {} : { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) }), hour: "numeric", minute: "2-digit" });
  const approximate = basis === "turn-start" || basis === "turn-end";
  const source = basis === "turn-start" ? "Approximate message time: native turn started" : basis === "turn-end" ? "Approximate reply time: native turn finished" : basis === "saved" ? "Message saved" : "Message received by the bot service";
  const title = `${source} · ${date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" })}`;
  return <div className={`bots-message-time${user ? " is-user" : ""}${inline ? " is-inline" : ""}`}>
    <time dateTime={date.toISOString()} title={title} aria-label={`${approximate ? "Approximate time, " : ""}${title}, ${ago}`}>{approximate && "≈ "}{local}<span aria-hidden="true"> · </span>{ago}</time>
  </div>;
}
