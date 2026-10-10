/** Optional fixed native display metadata. Never execution or clock authority. */
export type NativeTiming = {
  turnStartedAt?: number | null; turnCompletedAt?: number | null; turnDurationMs?: number | null;
  itemStartedAtMs?: number | null; itemCompletedAtMs?: number | null; itemDurationMs?: number | null;
};
export const validTiming = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function turnTiming(turn: { startedAt?: number | null; completedAt?: number | null; durationMs?: number | null }): NativeTiming {
  return { ...(Object.hasOwn(turn, 'startedAt') ? { turnStartedAt: validTiming(turn.startedAt) ? turn.startedAt : null } : {}),
    ...(Object.hasOwn(turn, 'completedAt') ? { turnCompletedAt: validTiming(turn.completedAt) ? turn.completedAt : null } : {}),
    ...(Object.hasOwn(turn, 'durationMs') ? { turnDurationMs: validTiming(turn.durationMs) ? turn.durationMs : null } : {}) };
}
export function itemTiming(item: { durationMs?: unknown }, endpoints?: { startedAtMs?: number | null; completedAtMs?: number | null }): NativeTiming {
  return { ...(Object.hasOwn(item, 'durationMs') ? { itemDurationMs: validTiming(item.durationMs) ? item.durationMs : null } : {}),
    ...(endpoints && Object.hasOwn(endpoints, 'startedAtMs') ? { itemStartedAtMs: validTiming(endpoints.startedAtMs) ? endpoints.startedAtMs : null } : {}),
    ...(endpoints && Object.hasOwn(endpoints, 'completedAtMs') ? { itemCompletedAtMs: validTiming(endpoints.completedAtMs) ? endpoints.completedAtMs : null } : {}) };
}
export type Elapsed = { ms: number; approximate: boolean };
export function elapsed(timing: NativeTiming, scope: 'turn' | 'item'): Elapsed | null {
  const duration = scope === 'turn' ? timing.turnDurationMs : timing.itemDurationMs;
  if (validTiming(duration)) return { ms: duration, approximate: false };
  const start = scope === 'turn' ? timing.turnStartedAt : timing.itemStartedAtMs;
  const end = scope === 'turn' ? timing.turnCompletedAt : timing.itemCompletedAtMs;
  return validTiming(start) && validTiming(end) && end >= start ? { ms: (end - start) * (scope === 'turn' ? 1000 : 1), approximate: true } : null;
}
export function durationLabel(ms: number): string {
  if (ms === 0) return '0s';
  if (ms < 1000) return '<1s';
  const seconds = Math.floor(ms / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m ${seconds % 60}s` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}
