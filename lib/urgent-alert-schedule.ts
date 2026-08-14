export const URGENT_WAVE_DELAYS_MS = [
  2 * 60 * 1_000,
  3 * 60 * 1_000,
  5 * 60 * 1_000,
  10 * 60 * 1_000,
  10 * 60 * 1_000,
  30 * 60 * 1_000,
  60 * 60 * 1_000,
  2 * 60 * 60 * 1_000,
  4 * 60 * 60 * 1_000,
  16 * 60 * 60 * 1_000,
  24 * 60 * 60 * 1_000,
] as const;

const RAPID_WAVE_LAST_INDEX = 6;

function localHour(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { hour: Number(values.hour), minute: Number(values.minute) };
}

export function urgentWaveDelayMs(completedWaveIndex: number) {
  return URGENT_WAVE_DELAYS_MS[completedWaveIndex] ?? 24 * 60 * 60 * 1_000;
}

export function nextUrgentAttemptAt(
  completedWaveIndex: number,
  attemptedAt: Date,
  input: { timeZone: string; callWindowStart: number; callWindowEnd: number },
) {
  let candidate = new Date(attemptedAt.valueOf() + urgentWaveDelayMs(completedWaveIndex));
  const nextWaveIndex = completedWaveIndex + 1;
  if (nextWaveIndex <= RAPID_WAVE_LAST_INDEX) return candidate;
  for (let minute = 0; minute <= 26 * 60; minute += 1) {
    const local = localHour(candidate, input.timeZone);
    if (local.hour >= input.callWindowStart && local.hour < input.callWindowEnd) return candidate;
    candidate = new Date(candidate.valueOf() + 60_000);
  }
  return candidate;
}
