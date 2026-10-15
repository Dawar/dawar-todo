/** Bot details information architecture. Callers keep linking to the
 * original section ids (`openDetails("queues")`, activity targets, the
 * context meter); each id maps to one of five top-level tabs and, where a
 * tab has subsections, to the subsection that shows it. */
export type BotDetailsSection = "navigation" | "next" | "goals" | "team" | "queues" | "schedules" | "files" | "desktop" | "calls" | "history" | "settings";
export type BotDetailsTab = "overview" | "work" | "files" | "tools" | "settings";
/** Sections that render their own panel content. `team` lives inside Settings. */
export type BotDetailsLeaf = Exclude<BotDetailsSection, "team">;
/** Generic opening shows Overview (chapters); targeted shortcuts keep their section. */
export const DEFAULT_DETAILS_SECTION: BotDetailsSection = "navigation";

export const DETAILS_TABS: readonly { id: BotDetailsTab; label: string; sections: readonly BotDetailsLeaf[] }[] = [
  { id: "overview", label: "Overview", sections: ["navigation"] },
  { id: "work", label: "Work", sections: ["next", "queues", "schedules", "goals", "history"] },
  { id: "files", label: "Files", sections: ["files"] },
  { id: "tools", label: "Tools", sections: ["desktop", "calls"] },
  { id: "settings", label: "Settings", sections: ["settings"] },
];
export const SECTION_LABELS: Record<BotDetailsLeaf, string> = {
  navigation: "Overview", next: "Up next", queues: "Queues", schedules: "Schedules", goals: "Goals", history: "History",
  files: "Files", desktop: "Desktop", calls: "Calls", settings: "Settings",
};
/** Settings groups, in order. Anchors let a section id open a specific group. */
export const SETTINGS_GROUPS = [
  { id: "conversation", label: "Conversation" },
  { id: "behaviour", label: "Behaviour" },
  { id: "access", label: "Access" },
  { id: "manage", label: "Manage" },
] as const;
export type SettingsGroup = typeof SETTINGS_GROUPS[number]["id"];

export type DetailsLocation = { tab: BotDetailsTab; leaf: BotDetailsLeaf; anchor?: SettingsGroup | "team" };
/** Where an original section id now lives. Unknown ids fall back to Overview. */
export function detailsLocation(section: BotDetailsSection | string): DetailsLocation {
  if (section === "team") return { tab: "settings", leaf: "settings", anchor: "team" };
  const tab = DETAILS_TABS.find(value => (value.sections as readonly string[]).includes(section));
  return tab ? { tab: tab.id, leaf: section as BotDetailsLeaf } : { tab: "overview", leaf: "navigation" };
}
/** The section to show when a tab is chosen: the last subsection visited in
 * that tab during this panel's life, otherwise its first subsection. */
export function tabSection(tab: BotDetailsTab, remembered: Partial<Record<BotDetailsTab, BotDetailsLeaf>> = {}): BotDetailsLeaf {
  const sections = DETAILS_TABS.find(value => value.id === tab)!.sections;
  const last = remembered[tab];
  return last && sections.includes(last) ? last : sections[0];
}
