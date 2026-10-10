"use client";

import { useEffect } from "react";
import Link from "next/link";
import { DEFAULT_OPENING_TAB, openingTabPath, parseOpeningTab } from "../../lib/app-preferences";
import { cacheOpeningTab, cachedOpeningTab } from "../opening-preference";
import { loadCachedSettings } from "../offline-store";

/** Shared resolver for `/open` and eligible fresh legacy-root launches. */
export default function OpenAppPage() {
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => { controller.abort(); resolve(undefined); }, 2_000);
    });
    void (async () => {
      let tab = cachedOpeningTab();
      if (!tab) {
        const settings = await Promise.race([loadCachedSettings().catch(() => undefined), deadline]);
        tab = parseOpeningTab(settings?.openAppTo);
        if (tab && active) cacheOpeningTab(tab, settings?.openAppToUpdatedAt);
      }
      // A saved choice routes immediately, including offline. First use may
      // read the account preference without ever mounting the Tasks screen.
      if (!tab && navigator.onLine) {
        try {
          const response = await fetch("/api/settings", { cache: "no-store", signal: controller.signal });
          if (response.ok) {
            const payload = await response.json() as { settings?: { openAppTo?: unknown; openAppToUpdatedAt?: string | null } };
            tab = parseOpeningTab(payload.settings?.openAppTo);
            if (tab && active) cacheOpeningTab(tab, payload.settings?.openAppToUpdatedAt);
          }
        } catch { /* First-use/offline fallback is Tasks. */ }
      }
      clearTimeout(timeout);
      if (active) window.location.replace(openingTabPath(cachedOpeningTab() ?? tab ?? DEFAULT_OPENING_TAB));
    })();
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, []);
  return <main className="mx-auto max-w-lg p-6 text-sm text-[#69716c]">
    <p role="status">Opening Dawar Todo…</p>
    <noscript><p><Link href="/tasks" prefetch={false}>Open Tasks</Link> · <Link href="/bots" prefetch={false}>Open Bots</Link></p></noscript>
  </main>;
}
