const MAX_DATE_MS = 8_640_000_000_000_000;
export const UNKNOWN_DATE_KEY = -MAX_DATE_MS - 1;

/** Legacy metadata is interpreted without rewriting the original record. */
export function artifactDateMillis(value) {
  if (typeof value !== 'string') return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}
export function artifactDate(value) {
  const millis = artifactDateMillis(value);
  return millis === null ? null : new Date(millis).toISOString();
}

/** Turn.startedAt/completedAt are nullable Unix seconds in the native schema. */
export function historicalArtifactDate(turn) {
  for (const seconds of [turn.completedAt, turn.startedAt]) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || Math.abs(seconds) > MAX_DATE_MS / 1000) continue;
    return new Date(seconds * 1000).toISOString();
  }
  return null;
}
