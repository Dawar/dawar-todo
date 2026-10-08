'use client';
import { createContext, useContext, useCallback, useSyncExternalStore, useMemo } from 'react';
import type { Bot } from '../../lib/bots-types';
import type { BotAdmissionWork } from '../../lib/bot-work-view';
import type { HistoryEntry } from '../../lib/bot-history-view';
import type { NativeTiming } from "../../lib/bot-timing";
import { durationLabel, validTiming } from '../../lib/bot-timing';

export const NativeTimingContext = createContext<{ owner: string; botId: string; threadId: string | null; entries: HistoryEntry[]; current?: NativeTiming & { threadId: string; turnId: string; turnStatus?: string } } | null>(null);
let clock = 0, timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
function tick() { clock = Date.now(); for (const listener of listeners) listener(); }
function visibility() {
  clearInterval(timer); timer = undefined;
  if (listeners.size && !document.hidden) { tick(); timer = setInterval(tick, 1000); }
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); visibility(); }
  return () => { listeners.delete(listener); if (!listeners.size) { clearInterval(timer); timer = undefined; document.removeEventListener('visibilitychange', visibility); } };
}
const snapshot = () => clock, server = () => 0, idleSubscribe = () => () => {};
function elapsedObserver(scope: string) {
  let observed = 0;
  return { scope, read: () => observed, listen(enabled: boolean, listener: () => void) {
    if (!enabled) return idleSubscribe();
    const unsubscribe = subscribe(() => { observed = snapshot(); listener(); });
    observed = snapshot(); return unsubscribe;
  } };
}
export function confirmedTurnStart(bot: Bot, work: BotAdmissionWork | undefined, entries: HistoryEntry[], current?: NativeTiming & { threadId: string; turnId: string; turnStatus?: string }): number | null {
  if (!work || work.botId !== bot.id || !bot.threadId || work.threadId !== bot.threadId || !bot.activeTurnId ||
    work.activeTurnId !== bot.activeTurnId || typeof work.activeNeedsInput !== 'boolean' || !['working', 'needs-input'].includes(work.state)) return null;
  const matching = entries.filter(entry => entry.turnId === bot.activeTurnId);
  if (matching.some(entry => entry.turnStatus && entry.turnStatus !== 'inProgress')) return null;
  const bound = current?.turnId === bot.activeTurnId && current.threadId === bot.threadId ? current : undefined;
  if (bound?.turnStatus && bound.turnStatus !== 'inProgress') return null;
  const nativeStart = bound?.turnStartedAt;
  const start = nativeStart ?? matching.find(entry => entry.turnStatus === 'inProgress' && validTiming(entry.turnStartedAt))?.turnStartedAt;
  return validTiming(start) ? start * 1000 : null;
}
/** Display clock only; offline freezes, unknown/queued never become stopwatch authority. */
export function ActiveTurnElapsed({ owner, bot, work, online }: { owner: string; bot: Bot; work?: BotAdmissionWork; online: boolean }) {
  const native = useContext(NativeTimingContext);
  const start = native?.owner === owner && native.botId === bot.id && native.threadId === bot.threadId ? confirmedTurnStart(bot, work, native.entries, native.current) : null;
  const enabled = online && start !== null;
  const scope = JSON.stringify([owner, bot.id, bot.threadId, bot.activeTurnId, start]);
  const observer = useMemo(() => elapsedObserver(scope), [scope]);
  const subscribeClock = useCallback((listener: () => void) => observer.listen(enabled, listener), [enabled, observer]);
  const now = useSyncExternalStore(subscribeClock, observer.read, server);
  const value = now && start !== null && now >= start ? now - start : null;
  if (start === null || value === null) return null;
  return <span className="bots-elapsed" title="Wall time since the confirmed native turn started; includes waiting, not compute time">· {durationLabel(value)} elapsed{!online && ' · stale'}</span>;
}
