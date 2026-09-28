export type OpeningTab = "tasks" | "bots";
export const DEFAULT_OPENING_TAB: OpeningTab = "tasks";

export function parseOpeningTab(value: unknown): OpeningTab | null {
  return value === "tasks" || value === "bots" ? value : null;
}

export function openingTabPath(tab: OpeningTab) {
  return tab === "bots" ? "/bots" : "/";
}
