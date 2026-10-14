import type { Bot, BotProvider, BotSnapshot } from "./bots-types";

type CatalogModel = BotSnapshot["models"][number] & { provider?: BotProvider };

export const botProvider = (bot: Pick<Bot, "provider"> | null | undefined): BotProvider =>
  bot?.provider === "claude" ? "claude" : "codex";
export const providerName = (provider: BotProvider) => (provider === "claude" ? "Claude" : "Codex");

/** The model catalog a bot can choose from: Claude rows carry `provider: "claude"`. */
export function providerModels(snapshot: BotSnapshot, bot: Pick<Bot, "provider">) {
  const claude = botProvider(bot) === "claude";
  return snapshot.models.filter(model => ((model as CatalogModel).provider === "claude") === claude);
}

/** Defaults a bot falls back to; Claude has no Fast/service tier. */
export function providerDefaults(snapshot: BotSnapshot, bot: Pick<Bot, "provider">): BotSnapshot["defaults"] {
  return botProvider(bot) === "claude"
    ? { model: snapshot.claudeDefaults?.model ?? "opus", effort: snapshot.claudeDefaults?.effort ?? "high", serviceTier: "default" }
    : snapshot.defaults;
}
