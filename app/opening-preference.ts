"use client";

import { parseOpeningTab, type OpeningTab } from "../lib/app-preferences";

const CACHE_KEY = "dawar-todo:opening-tab:v1";
type CachedPreference = { tab: OpeningTab; updatedAt: string };

function cachedPreference(): CachedPreference | null {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null");
    const tab = parseOpeningTab(saved?.tab);
    return tab && typeof saved.updatedAt === "string" ? { tab, updatedAt: saved.updatedAt } : null;
  } catch { return null; }
}

/** Only confirmed server preferences belong here, never an unsaved form choice. */
export function cachedOpeningTab(): OpeningTab | null {
  return cachedPreference()?.tab ?? null;
}

export function cacheOpeningTab(value: unknown, updatedAt?: string | null): boolean {
  const tab = parseOpeningTab(value);
  // Old API/cache records have no field. They must not erase a newer choice.
  if (!tab) return false;
  try {
    const saved = cachedPreference();
    const version = updatedAt ?? "";
    // An in-flight bootstrap from before a successful Save must not roll the
    // offline launch choice back. Older servers have no timestamp or field.
    if (saved && saved.updatedAt > version) return true;
    if (saved?.tab !== tab || saved.updatedAt !== version) {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ tab, updatedAt: version }));
    }
    return true;
  } catch { return false; }
}
