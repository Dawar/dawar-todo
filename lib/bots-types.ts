import type { ServerRequest } from "./codex-protocol/ServerRequest";
import type { Thread } from "./codex-protocol/v2/Thread";
import type { Model } from "./codex-protocol/v2/Model";
import type { QueuedSubmission } from "./codex-protocol/v2/QueuedSubmission";

export type Bot = {
  id: string;
  name: string;
  purpose: string;
  slug: string;
  cwd: string;
  threadId: string | null;
  color: string;
  status: string;
  archived: boolean;
  model: string | null;
  effort: string | null;
  serviceTier?: string | null;
  mode: "default" | "plan";
  preview: string;
  updatedAt: string;
  lastReadAt: string;
  activeTurnId: string | null;
  workerTasks?: { active: number; waiting: number };
  managerPaused?: boolean;
  queuePaused?: boolean;
  error?: string | null;
};
export type BotSchedule = {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  cron: string | null;
  at: string | null;
  timeZone: string;
  enabled: boolean;
  nextRunAt: string | null;
  createdAt: string;
};
export type BotRun = {
  id: string;
  botId: string;
  scheduleId: string;
  title: string;
  status: string;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  turnId?: string | null;
};
export type BotRunPage = { runs: BotRun[]; nextCursor: string | null; latestBySchedule: BotRun[] };
/** Metadata for a scheduled-context continuation; the primary run.turnId stays unchanged. */
export type BotRunTurn = {
  id: string;
  botId: string;
  runId: string;
  operationId: string;
  turnId: string | null;
  status: string;
  error: string | null;
  createdAt: string | null;
  finishedAt: string | null;
};
export type BotRunTurnPage = { turns: BotRunTurn[]; nextCursor: string | null };
export type BotScheduledTurn = {
  botId: string;
  runId: string;
  turnId: string;
  operationId: string;
  continuation: boolean;
};
/** Additive data on bot-scoped schedules events. Missing fields mean older service. */
export type BotScheduledEventData = {
  runTurn?: BotRunTurn | null;
  activeScheduledTurn?: BotScheduledTurn | null;
};
export type BotUsageMetric = { value: string | null; reportedGroups: number };
export type BotThreadUsage = {
  botId: string;
  threadId: string | null;
  estimatedCreditsMicros: string | null;
  groupCount?: number;
  tokens?: {
    total: BotUsageMetric;
    input: BotUsageMetric;
    output: BotUsageMetric;
    cachedInput: BotUsageMetric;
    netNewInput: BotUsageMetric;
  };
  reason?: string;
};
export type BotAccountQuotaWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};
export type BotAccountQuotaLimit = {
  limitId: string | null;
  limitName: string | null;
  model: string | null;
  windows: BotAccountQuotaWindow[];
};
export type BotAccountQuota = {
  accountType: "chatgpt" | "apiKey" | "amazonBedrock" | null;
  ordinaryUsageAllowed: boolean | null;
  availableResetCredits: string | null;
  limits: BotAccountQuotaLimit[];
  readAt: string;
  reason?: string;
};
export type BotAttachment = {
  id: string;
  botId: string;
  name: string;
  mimeType: string;
  size: number;
  ready: boolean;
  path?: string;
  /** Present on delivered history/output metadata; previews remain lazy. */
  createdAt?: string | null;
  artifact?: boolean;
  direction?: "input" | "output";
  source?: "upload" | "published" | "native";
  provenance?: { threadId?: string; turnId?: string; itemId?: string; operationId?: string };
  preview?: { kind: "image" | "pdf" | "none"; version: string };
};
export type BotArtifactKind = "image" | "pdf" | "document" | "audio" | "video" | "other";
/** Metadata only. Original bytes remain behind bot-scoped attachments.read. */
export type BotArtifact = Omit<BotAttachment, "path"> & {
  botName: string;
  botColor: string;
  botArchived: boolean;
  createdAt: string | null;
  direction: "input" | "output";
  source: "upload" | "published" | "native";
  kind: BotArtifactKind;
  provenance: { threadId?: string; turnId?: string; itemId?: string; operationId?: string };
  preview: { kind: "image" | "pdf" | "none"; version: string };
};
export type BotArtifactQuery = {
  cursor?: string | null;
  limit?: number;
  search?: string;
  type?: BotArtifactKind | "all";
  direction?: "input" | "output" | "all";
  sort?: "newest" | "oldest" | "name";
};
export type BotArtifactPage = { items: BotArtifact[]; nextCursor: string | null };
export type BotArtifactPreview =
  | { status: "ready"; version: string; mimeType: "image/webp"; data: string; width: number; height: number }
  | { status: "unavailable"; version: string; reason: string };
export type BotRequest = {
  key: string;
  botId: string;
  request: ServerRequest;
  createdAt: string;
};
export type BotSnapshot = {
  bots: Bot[];
  pending: BotRequest[];
  cursor: number;
  ready: boolean;
  account: { authenticated: boolean };
  defaults: { model: string; effort: string | null; serviceTier: string };
  models: Model[];
  schedules: BotSchedule[];
  runs: BotRun[];
  activeScheduledTurns?: BotScheduledTurn[];
};
export type BotHistory = {
  nextCursor: string | null;
  thread: Thread;
  attachments: BotAttachment[];
  pending: BotRequest[];
};
export type BotQueuedSubmission = QueuedSubmission & {
  attachments: BotAttachment[];
};
export type BotEvent = {
  seq: number;
  type: string;
  botId?: string;
  data: unknown;
};
export type BridgeRequest = {
  type: "request";
  id: string;
  operationId: string;
  method: string;
  botId?: string;
  params: Record<string, unknown>;
};

/** Reserved error-only result envelope, preserved by older deployed relays. */
export type BridgeFailureResult = {
  __dawarBotFailure: {
    version: 1;
    operationId: string;
    outcome: "rejected" | "uncertain";
  };
};

/** An error without explicit certainty always leaves a mutation unconfirmed.
 * Error replies may carry BridgeFailureResult in result; success stays native. */
export type BridgeResponse = {
  type: "response";
  id: string;
  result?: unknown;
  error?: string;
  outcome?: "rejected" | "uncertain";
};
