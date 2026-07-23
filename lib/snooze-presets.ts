export const QUICK_SNOOZE_OPTIONS = [
  { value: "15m", minutes: 15, label: "15 minutes" },
  { value: "30m", minutes: 30, label: "30 minutes" },
  { value: "45m", minutes: 45, label: "45 minutes" },
  { value: "1h", minutes: 60, label: "1 hour" },
  { value: "90m", minutes: 90, label: "1½ hours" },
  { value: "2h", minutes: 120, label: "2 hours" },
  { value: "3h", minutes: 180, label: "3 hours" },
  { value: "4h", minutes: 240, label: "4 hours" },
  { value: "6h", minutes: 360, label: "6 hours" },
  { value: "8h", minutes: 480, label: "8 hours" },
  { value: "12h", minutes: 720, label: "12 hours" },
] as const;

export type QuickSnoozePreset = (typeof QUICK_SNOOZE_OPTIONS)[number]["value"];

export const DEFAULT_QUICK_SNOOZE_PRESETS: QuickSnoozePreset[] = ["15m", "30m", "1h", "2h"];

const optionByValue = new Map<QuickSnoozePreset, (typeof QUICK_SNOOZE_OPTIONS)[number]>(
  QUICK_SNOOZE_OPTIONS.map((option) => [option.value, option]),
);

export function isQuickSnoozePreset(value: unknown): value is QuickSnoozePreset {
  return typeof value === "string" && optionByValue.has(value as QuickSnoozePreset);
}

export function sortQuickSnoozePresets(values: readonly QuickSnoozePreset[]) {
  return [...values].sort((left, right) => (
    quickSnoozeMinutes(left) - quickSnoozeMinutes(right)
  ));
}

export function parseQuickSnoozePresets(value: unknown): QuickSnoozePreset[] | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(isQuickSnoozePreset)) return null;
  const unique = [...new Set(value)];
  return unique.length === 4 ? sortQuickSnoozePresets(unique) : null;
}

export function quickSnoozeMinutes(value: QuickSnoozePreset) {
  return optionByValue.get(value)?.minutes ?? 0;
}

export function quickSnoozeDurationMs(value: QuickSnoozePreset) {
  return quickSnoozeMinutes(value) * 60 * 1000;
}

export function quickSnoozeLabel(value: QuickSnoozePreset) {
  return optionByValue.get(value)?.label ?? value;
}
