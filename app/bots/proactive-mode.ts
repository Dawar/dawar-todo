// Proactive bots: the owner-facing mode and per-bot switch, mapped onto the
// stored initiative settings (`enabled`, `coverage`, `bots[id].enabled`).
//   Off   — enabled false (coverage is kept, so switching back restores it)
//   Pilot — enabled true, coverage "selected": only bots switched on take part
//   All   — enabled true, coverage "all": every bot except ones switched off

export type ProactiveMode = "off" | "pilot" | "all";
export type ModeSettings = { enabled: boolean; coverage: "all" | "selected"; bots: Record<string, { enabled?: boolean; priorities?: string }> };
export type SettingsPatch = { enabled?: boolean; coverage?: "all" | "selected"; bots?: Record<string, { enabled: boolean | null }> };

export const PROACTIVE_VIEW_HREF = "/bots?view=proactive";

export function modeOf(settings: Pick<ModeSettings, "enabled" | "coverage">): ProactiveMode {
  if (!settings.enabled) return "off";
  return settings.coverage === "selected" ? "pilot" : "all";
}

/** The settings patch that selects `mode`. Off leaves coverage alone. */
export function modePatch(mode: ProactiveMode): SettingsPatch {
  if (mode === "off") return { enabled: false };
  return { enabled: true, coverage: mode === "pilot" ? "selected" : "all" };
}

/**
 * Whether a bot takes part. In Pilot it must be switched on explicitly; in
 * All it takes part unless switched off. Off: no bot does.
 */
export function botIncluded(settings: ModeSettings, botId: string): boolean {
  const mode = modeOf(settings), override = settings.bots[botId]?.enabled;
  if (mode === "off") return false;
  return mode === "pilot" ? override === true : override !== false;
}

/**
 * The patch for a bot's switch. Only the non-default state is stored: in
 * Pilot "on" is stored and "off" clears it; in All "off" is stored and "on"
 * clears it. Off mode has no per-bot switch.
 */
export function botPatch(mode: ProactiveMode, botId: string, on: boolean): SettingsPatch | null {
  if (mode === "off") return null;
  const enabled = mode === "pilot" ? (on ? true : null) : (on ? null : false);
  return { bots: { [botId]: { enabled } } };
}

export const MODE_COPY: Record<ProactiveMode, { label: string; detail: string }> = {
  off: { label: "Off", detail: "Bots never bring things up on their own." },
  pilot: { label: "Pilot", detail: "Only the bots you pick can bring things up." },
  all: { label: "All bots", detail: "Every bot can bring things up, except ones you switch off." },
};

/** One line under a bot's switch, saying what it means in the current mode. */
export function botSwitchCopy(mode: ProactiveMode, name: string, on: boolean): string {
  if (mode === "pilot") return on ? `${name} is in the pilot and may bring things up on its own.` : `${name} is not in the pilot. Switch on to include it.`;
  return on ? `${name} may bring things up on its own. Switch off to leave it out.` : `${name} is left out while every other bot takes part.`;
}
