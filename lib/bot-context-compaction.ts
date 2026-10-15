import type { Bot, BotIdleCompaction } from "./bots-types";

// Mirrors bot-bridge/context-compaction.mjs defaults and finite ranges.
export const IDLE_COMPACTION_DEFAULTS: BotIdleCompaction = { enabled: true, thresholdTokens: 200_000, idleMinutes: 54 };
export const IDLE_COMPACTION_LIMITS = { thresholdTokens: [20_000, 2_000_000], idleMinutes: [5, 1440] } as const;

export const idleCompactionPolicy = (bot: Pick<Bot, "idleCompaction">): BotIdleCompaction =>
  ({ ...IDLE_COMPACTION_DEFAULTS, ...(bot.idleCompaction ?? {}) });

const LABELS = { requested: "Requested", compacting: "Compacting…", completed: "Completed", blocked: "Blocked",
  failed: "Failed", unconfirmed: "Unconfirmed" } as const;

const tokens = (value: number) => value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);

/** One honest status line for the last compaction. */
export function compactionStatus(bot: Pick<Bot, "contextCompaction">): string | null {
  const c = bot.contextCompaction;
  if (!c?.state) return null;
  const who = c.trigger === "idle" ? "Idle compaction" : "Compaction";
  const sizes = c.state === "completed" && c.beforeTokens != null
    ? ` · ${tokens(c.beforeTokens)}${c.afterTokens != null ? ` → ${tokens(c.afterTokens)}` : ""} tokens` : "";
  return `${who}: ${LABELS[c.state]}${sizes}${c.reason && c.state !== "completed" ? ` — ${c.reason}` : ""}`;
}

/** Current context pressure and when idle compaction would run. */
export function contextSummary(bot: Pick<Bot, "contextCompaction" | "idleCompaction">, now = Date.now()): string {
  const context = bot.contextCompaction?.context, policy = idleCompactionPolicy(bot);
  if (!context) return "Current context size is not known yet; idle compaction waits for native evidence.";
  const size = `Current context ${tokens(context.tokens)}${context.window ? ` of ${tokens(context.window)}` : ""} tokens.`;
  if (!policy.enabled) return `${size} Idle compaction is off.`;
  if (context.compacted) return `${size} Compacted since this measurement; waiting for new evidence.`;
  if (context.window && policy.thresholdTokens >= context.window) return `${size} The ${tokens(policy.thresholdTokens)} threshold does not fit this model.`;
  if (context.tokens < policy.thresholdTokens) return `${size} Below the ${tokens(policy.thresholdTokens)} idle threshold.`;
  const due = Date.parse(context.lastActivityAt) + policy.idleMinutes * 60_000;
  return due <= now ? `${size} Idle compaction is due when the bot is otherwise idle.`
    : `${size} Idle compaction after ${Math.ceil((due - now) / 60_000)} more idle minutes.`;
}

export const compactionInFlight = (bot: Pick<Bot, "contextCompaction">) =>
  bot.contextCompaction?.state === "requested" || bot.contextCompaction?.state === "compacting";
