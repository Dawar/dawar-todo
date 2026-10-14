/** Structural provisioning only. IDs refer to existing catalog identities. */
export type BotAdminAction =
  | { kind: "createBot"; name: string; purpose: string }
  | { kind: "saveTeam"; name: string; color: string; id?: string; expectedRevision?: number }
  | { kind: "assignBot"; botId: string; teamId: string | null; expectedTeamId: string | null; teamRevision: number | null; sourceTeamRevision: number | null };
export type BotAdminDefaults = { model: string; effort: string; serviceTier: string | null; burstQuietSeconds: number };
export type BotAdminRequest = {
  id: string; botId: string; revision: number; specHash: string;
  executionOperationId: string; actions: BotAdminAction[]; creationDefaults: BotAdminDefaults | null;
  actionCount: number; createCount: number; createdAt: string;
  state: "pending" | "approved" | "running" | "complete" | "uncertain" | "revoked" | "expired" | "blocked";
  approval: { approvedAt: string; expiresAt: string; revokedAt: string | null } | null;
  steps: { index: number; operationId: string; state: "complete" | "uncertain"; identity: { id: string; name?: string; teamId?: string | null } | null }[];
  error: string | null; allowedCaller: boolean;
};
export type BotAdminCatalog = {
  bots: { id: string; name: string; teamId: string | null }[];
  teams: { id: string; name: string; color: string; revision: number }[];
  nextCursor: string | null;
};
