"use client";
import { useSyncExternalStore } from 'react';
import type { Bot } from '../../lib/bots-types';
import { newerReadAt, readAt, type BotReadPosition } from '../../lib/bot-read-position';
const listeners = new Set<() => void>();
const values = new Map<string, string>();
let revision = 0;
type ReadBot = Pick<Bot, 'id' | 'threadId' | 'updatedAt'>;
const key = (owner: string, bot: ReadBot) => `dawar-read:v1:${JSON.stringify([owner, bot.id, bot.threadId])}`;
const changed = () => { revision++; for (const listener of listeners) listener(); };
export function localReadAt(owner: string, bot: ReadBot) {
  const k = key(owner, bot);
  let disk = '';
  try { disk = localStorage.getItem(k) ?? ''; } catch { /* Session read position remains usable. */ }
  const at = newerReadAt(disk, values.get(k));
  if (at) values.set(k, at);
  return at;
}
export function markLocallyRead(owner: string, bot: ReadBot) {
  const at = readAt(bot.updatedAt);
  if (owner && bot.threadId && at) mergeReadPosition(owner, { botId: bot.id, threadId: bot.threadId, at });
}
export function mergeReadPosition(owner: string, position: BotReadPosition) {
  const bot = { id: position.botId, threadId: position.threadId, updatedAt: position.at };
  const prior = localReadAt(owner, bot), at = newerReadAt(prior, position.at);
  if (!owner || !at) return;
  const k = key(owner, bot); values.set(k, at);
  try { if (readAt(localStorage.getItem(k)) !== at) localStorage.setItem(k, at); } catch { /* Do not prevent reading when storage is full. */ }
  if (at > prior) changed();
}
export function subscribeReadPositions(listener: () => void) {
  listeners.add(listener);
  const storage = (event: StorageEvent) => { if (event.key?.startsWith('dawar-read:v1:')) changed(); };
  window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
}
/** Browser-observed read position; never a fabricated server acknowledgement. */
export function useLocallyReadBots(owner: string, bots: Bot[]) {
  useSyncExternalStore(subscribeReadPositions, () => revision, () => 0);
  return bots.map(bot => { const at = localReadAt(owner, bot); return at > readAt(bot.lastReadAt) ? { ...bot, lastReadAt: at } : bot; });
}
