export type BadgeTodo = {
  status: "open" | "completed";
  snoozedUntil: string | null;
};

type BadgeNavigator = Navigator & {
  setAppBadge?: (contents?: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

let unsupportedLogged = false;

export function currentOpenTaskCount(todos: BadgeTodo[], now = Date.now()) {
  return todos.filter((todo) => {
    if (todo.status !== "open") return false;
    if (!todo.snoozedUntil) return true;
    const wakeAt = new Date(todo.snoozedUntil).valueOf();
    return Number.isNaN(wakeAt) || wakeAt <= now;
  }).length;
}

export function supportsNativeAppBadge() {
  return typeof navigator !== "undefined" && typeof (navigator as BadgeNavigator).setAppBadge === "function";
}

export function appleMobileBadgeRequiresNotificationPermission() {
  if (typeof navigator === "undefined") return false;
  const iPhoneOrIPad = /iPad|iPhone|iPod/i.test(navigator.userAgent);
  const desktopClassIPad = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iPhoneOrIPad || desktopClassIPad;
}

export async function updateNativeAppBadge(count: number, source: string) {
  const badgeNavigator = navigator as BadgeNavigator;
  if (typeof badgeNavigator.setAppBadge !== "function") {
    if (!unsupportedLogged) {
      unsupportedLogged = true;
      console.info("[todo-pwa] native app badge unavailable", { source });
    }
    return { supported: false, updated: false } as const;
  }

  const normalizedCount = Math.max(0, Math.floor(count));
  try {
    if (normalizedCount > 0) await badgeNavigator.setAppBadge(normalizedCount);
    else if (typeof badgeNavigator.clearAppBadge === "function") await badgeNavigator.clearAppBadge();
    else await badgeNavigator.setAppBadge(0);
    console.info("[todo-pwa] native app badge updated", { count: normalizedCount, source });
    return { supported: true, updated: true } as const;
  } catch (error) {
    console.warn("[todo-pwa] native app badge update failed", { count: normalizedCount, source, error });
    return { supported: true, updated: false, error } as const;
  }
}
