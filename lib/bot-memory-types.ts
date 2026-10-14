/** Own-bot file memory only. Native Goals/history and all other profiles stay separate. */
export type BotMemoryReview = {
  constraints: string; approvals: string; unfinishedWork: string; uncertainOperations: string; references: string;
};
export type BotMemoryReceipt = {
  version: 1; operationId: string; botId: string; threadId: string;
  state: "prepared" | "verified" | "committing" | "done" | "stale";
  sourceHash: string; sourceBytes: number; resultHash: string | null; resultBytes: number | null;
  archive: string; candidate: string; reviewedAt: string | null; completedAt: string | null;
};
export type BotMemoryOperation =
  | { operation: "inspect" | "prepare"; operationId?: string }
  | { operation: "verify"; operationId: string; candidateHash: string; review: BotMemoryReview }
  | { operation: "commit"; operationId: string; candidateHash: string }
  | { operation: "nightlyCheck" };
export type BotMemoryInspection = { botId: string; threadId: string; version: 1; bytes: number; sourceHash: string;
  thresholdBytes: 32768; maintenanceNeeded: boolean; status: import("./bots-types").BotProfilePreparation | null };
