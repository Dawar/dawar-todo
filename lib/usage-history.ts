export type UsageHistoryRange = "24h" | "7d" | "30d";
export type UsageObservation<T> = { value: T | null; observedAt: string | null };
export type UsagePoint = { at: number; usedPercent: number; segment: string };
export type UsageForecast = {
  horizonHours: 6 | 24;
  state: "collecting" | "stale" | "no-consumption" | "estimate" | "reset-due";
  sampleCount: number;
  measuredHours: number;
  maximumGapHours: number;
  pointsPerDay: number | null;
  depletionHours: number | null;
  resetFirst: boolean | null;
  projectedRemainingAtReset: number | null;
};
export type UsageHistoryWindow = {
  id: string;
  limitId: string | null;
  limitName: string | null;
  model: string | null;
  slot: "primary" | "secondary";
  usedPercent: UsageObservation<number>;
  windowDurationMins: UsageObservation<number>;
  resetsAt: UsageObservation<number>;
  sustainablePointsPerDay: number | null;
  forecasts: UsageForecast[];
  points: UsagePoint[];
  coverage: { observations: number; from: number | null; to: number | null; chartLimited: boolean };
};
export type UsageHistory = {
  version: 1;
  range: UsageHistoryRange;
  accountGeneration: string;
  identity: "verified" | "connection" | "unavailable";
  collectedAt: string;
  quotaReadAt: string | null;
  tokenReadAt: string | null;
  nextAttemptAt: string | null;
  reason: string | null;
  windows: UsageHistoryWindow[];
  nextCursor: string | null;
  activity: {
    state: "available" | "unavailable" | "collecting" | "stale";
    summary: Record<"lifetimeTokens" | "peakDailyTokens" | "longestRunningTurnSec" | "currentStreakDays" | "longestStreakDays", UsageObservation<string>>;
    daily: { date: string; tokens: string; observedAt: string }[];
  };
  retentionDays: 90;
};

const HOUR = 3_600_000;
export function usageForecast(points: UsagePoint[], horizonHours: 6 | 24, now: number, resetsAt: number | null): UsageForecast {
  const recent = points.filter(point => point.at >= now - horizonHours * HOUR && point.at <= now);
  const first = recent[0], last = recent.at(-1);
  const measuredHours = first && last ? (last.at - first.at) / HOUR : 0;
  let maximumGapHours = 0;
  for (let index = 1; index < recent.length; index++) maximumGapHours = Math.max(maximumGapHours, (recent[index].at - recent[index - 1].at) / HOUR);
  const result: UsageForecast = { horizonHours, state: "collecting", sampleCount: recent.length, measuredHours,
    maximumGapHours, pointsPerDay: null, depletionHours: null, resetFirst: null, projectedRemainingAtReset: null };
  const latest = points.at(-1);
  if (latest && now - latest.at >= 90 * 60_000) return { ...result, state: "stale" };
  if (resetsAt !== null && resetsAt * 1000 <= now) return { ...result, state: "reset-due" };
  if (!first || !last || recent.length < 3 || measuredHours < horizonHours * .8 || maximumGapHours > 2 ||
      recent.some(point => point.segment !== last.segment) || !Number.isFinite(measuredHours) || measuredHours <= 0) return result;
  let consumed = 0;
  for (let index = 1; index < recent.length; index++) {
    const change = recent[index].usedPercent - recent[index - 1].usedPercent;
    if (change < 0) return result;
    consumed += change;
  }
  if (consumed === 0) return { ...result, state: "no-consumption" };
  const pointsPerHour = consumed / measuredHours;
  const remaining = Math.max(0, 100 - last.usedPercent), depletionHours = remaining / pointsPerHour;
  const resetHours = resetsAt === null ? null : (resetsAt * 1000 - now) / HOUR;
  return { ...result, state: "estimate", pointsPerDay: pointsPerHour * 24, depletionHours,
    resetFirst: resetHours === null ? null : resetHours <= depletionHours,
    projectedRemainingAtReset: resetHours === null ? null : Math.max(0, remaining - pointsPerHour * resetHours) };
}
