"use client";
import { useMemo, useSyncExternalStore } from 'react';
import type { Bot } from '../../lib/bots-types';
const listeners = new Set<() => void>();
const values = new Map<string, string>();
let revision = 0;
const key = (owner: string, bot: Bot) => `dawar-read:v1:${JSON.stringify([owner, bot.id, bot.threadId])}`;
const changed = () => { revision++; for (const listener of listeners) listener(); };
function read(owner: string, bot: Bot) {
  const k = key(owner, bot);
  try { const value = localStorage.getItem(k); if (value && Number.isFinite(Date.parse(value))) return value; } catch { /* Session read position remains usable. */ }
  return values.get(k) ?? '';
}
export function markLocallyRead(owner: string, bot: Bot) {
  if (!owner || !bot.threadId || !Number.isFinite(Date.parse(bot.updatedAt)) || read(owner, bot) >= bot.updatedAt) return;
  const k = key(owner, bot); values.set(k, bot.updatedAt);
  try { localStorage.setItem(k, bot.updatedAt); } catch { /* Do not prevent reading when storage is full. */ }
  changed();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key?.startsWith('dawar-read:v1:')) changed(); };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
}
/** Browser-observed read position; never a fabricated server acknowledgement. */
export function useLocallyReadBots(owner: string, bots: Bot[]) {
  const version = useSyncExternalStore(subscribe, () => revision, () => 0);
  return useMemo(() => bots.map(bot => { const at = read(owner, bot); return at > bot.lastReadAt ? { ...bot, lastReadAt: at } : bot; }), [owner, bots, version]);
}
