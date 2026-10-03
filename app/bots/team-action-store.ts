export const teamActionPrefix = (owner: string, botId = "") =>
  `dawar:bot:team-action:${JSON.stringify([owner, botId])}:`;
export type TeamActionMethod =
  | "teams.save"
  | "teams.assign"
  | "teams.reorder"
  | "teams.orderBots"
  | "teams.memory"
  | "teams.delete";
export type PendingTeamAction = {
  id: string;
  method: TeamActionMethod;
  params: Record<string, unknown>;
  owner: string;
  botId: string;
};
export function readTeamAction(
  owner: string,
  botId = "",
): { pending: PendingTeamAction | null; error: string } {
  try {
    if (typeof localStorage === "undefined")
      return { pending: null, error: "" };
    const prefix = teamActionPrefix(owner, botId);
    const keys = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.key(i),
    )
      .filter((k): k is string => Boolean(k?.startsWith(prefix)))
      .sort();
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const value = JSON.parse(raw) as PendingTeamAction,
        p = value.params;
      const valid =
        p &&
        typeof p === "object" &&
        !Array.isArray(p) &&
        (value.method === "teams.save"
          ? typeof p.name === "string" && typeof p.color === "string"
          : value.method === "teams.assign"
            ? typeof p.botId === "string" &&
              (p.teamId === null || typeof p.teamId === "string") &&
              (p.expectedTeamId === null ||
                typeof p.expectedTeamId === "string")
            : value.method === "teams.reorder"
              ? Array.isArray(p.ids) && Array.isArray(p.revisions)
              : value.method === "teams.orderBots"
                ? typeof p.id === "string" &&
                  Array.isArray(p.ids) &&
                  Number.isSafeInteger(p.expectedRevision)
                : value.method === "teams.memory"
                  ? typeof p.id === "string" &&
                    typeof p.memory === "string" &&
                    Number.isSafeInteger(p.expectedRevision)
                  : value.method === "teams.delete" &&
                    typeof p.id === "string" &&
                    Number.isSafeInteger(p.expectedRevision));
      if (
        !valid ||
        value.owner !== owner ||
        value.botId !== botId ||
        typeof value.id !== "string" ||
        !/^[a-zA-Z0-9:_-]{10,180}$/.test(value.id) ||
        key !== prefix + value.id
      )
        throw Error(
          "A saved team change cannot be read. Keep site storage for recovery.",
        );
      return { pending: value, error: "" };
    }
    return { pending: null, error: "" };
  } catch (error) {
    return {
      pending: null,
      error:
        error instanceof Error
          ? error.message
          : "Team change could not be read.",
    };
  }
}
