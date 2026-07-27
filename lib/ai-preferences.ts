export const REALTIME_VOICES = [
  "marin",
  "cedar",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
] as const;

export type RealtimeVoice = typeof REALTIME_VOICES[number];

export const DEFAULT_REALTIME_VOICE: RealtimeVoice = "marin";

export const REALTIME_VOICE_OPTIONS: Array<{
  value: RealtimeVoice;
  label: string;
  recommended?: boolean;
}> = REALTIME_VOICES.map((value) => ({
  value,
  label: value[0].toUpperCase() + value.slice(1),
  recommended: value === "marin" || value === "cedar",
}));

export function normalizeRealtimeVoice(value: unknown): RealtimeVoice | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  return REALTIME_VOICES.includes(normalized as RealtimeVoice)
    ? normalized as RealtimeVoice
    : null;
}
