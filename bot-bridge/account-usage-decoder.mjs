/** Lossless projection only for the matched native account-usage result. Other envelopes keep JSON semantics. */
export function parseAccountUsageMessage(line, pendingMethod) {
  if (pendingMethod !== "account/usage/read") return JSON.parse(line);
  const sources = new WeakMap();
  const message = JSON.parse(line, function (key, value, context) {
    if (typeof value === "number") {
      let fields = sources.get(this);
      if (!fields) sources.set(this, fields = new Map());
      fields.set(key, context?.source);
    }
    return value;
  });
  if (message.method || message.error || !message.result || typeof message.result !== "object") return message;
  let unavailable = false;
  const project = (container, keys) => {
    if (!container || typeof container !== "object" || Array.isArray(container)) return;
    for (const key of keys) {
      const value = container[key];
      if (typeof value !== "number") continue;
      if (Number.isSafeInteger(value) && value >= 0) continue;
      const raw = sources.get(container)?.get(key);
      if (typeof raw === "string" && /^(0|[1-9]\d*)$/.test(raw)) container[key] = raw;
      else { container[key] = null; unavailable = true; }
    }
  };
  const result = message.result;
  project(result.summary, ["lifetimeTokens", "peakDailyTokens", "longestRunningTurnSec", "currentStreakDays", "longestStreakDays"]);
  if (Array.isArray(result.dailyUsageBuckets)) for (const bucket of result.dailyUsageBuckets) project(bucket, ["tokens"]);
  project(result.threadUsage, ["estimatedUsageCreditsMicros", "estimatedUsageUsdMicros"]);
  if (Array.isArray(result.threadUsage?.groups)) for (const group of result.threadUsage.groups)
    project(group, ["estimatedUsageCreditsMicros", "netNewInputTokens", "cachedInputTokens", "inputTokens", "outputTokens", "totalTokens"]);
  if (unavailable) result.usagePrecisionUnavailable = true;
  return message;
}
