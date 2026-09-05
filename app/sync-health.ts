export type ConnectionQuality = "online" | "degraded" | "offline" | "unavailable" | "auth";

// A browser hint is not a speed measurement. Only sustained request failures
// warrant a warning; an older failed request must not undo newer success.
export function createSyncHealth() {
  let quality: ConnectionQuality = "online";
  let lastSuccessAt = -1;
  let firstFailureAt: number | null = null;
  let failures = 0;
  return {
    success(now = Date.now()) {
      lastSuccessAt = now;
      firstFailureAt = null;
      failures = 0;
      return quality = "online" as const;
    },
    browser(online: boolean) {
      firstFailureAt = null;
      failures = 0;
      return quality = online ? "online" : "offline";
    },
    failure(error: unknown, online: boolean, now = Date.now()) {
      if (!online) return quality = "offline" as const;
      const { status, requestStartedAt = now, name } = error as {
        status?: number; requestStartedAt?: number; name?: string;
      };
      if (name === "AbortError" || requestStartedAt < lastSuccessAt) return quality;
      if (status === 401 || status === 403) return quality = "auth" as const;
      if (typeof status === "number" && status < 500 && ![408, 425, 429].includes(status)) return quality;
      firstFailureAt ??= now;
      failures += 1;
      if (failures >= 2 && now - firstFailureAt >= 10_000) {
        quality = status && status >= 500 ? "unavailable" : "degraded";
      }
      return quality;
    },
  };
}

export function liveSyncDelay(failures: number, quietPolls: number) {
  if (failures) return Math.min(60_000, 3_000 * 2 ** Math.min(failures - 1, 5));
  return quietPolls >= 10 ? 10_000 : 3_000;
}
