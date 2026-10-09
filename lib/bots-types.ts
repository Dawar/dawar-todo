export type { CollaborationRoom, CollaborationPost, CollaborationContext, CollaborationDelivery, CollaborationResult, CollaborationPage, CollaborationRecentParams, TurnConfiguration, ExecutionConfiguration } from './bot-collaboration';
import type { ServerRequest } from "./codex-protocol/ServerRequest";
import type { Thread } from "./codex-protocol/v2/Thread";
import type { Model } from "./codex-protocol/v2/Model";
import type { QueuedSubmission } from "./codex-protocol/v2/QueuedSubmission";

export type BotAvatar = { version: 1; shape: "circle" | "square" | "triangle" | "cloud" | "star" | "hexagon"; color: string; seed: string };
export type BotBurstQuietSeconds = 0 | 2.5 | 3 | 8 | 15;
export type BotProfilePreparation = { botId: string; threadId: string | null; state: "warning" | "fallback" | "blocked"; file: string;
  message: string; bytes?: number; sourceHash?: string; operationId?: string; observedAt: string };
export type BotTeam = { id: string; name: string; color: string; position: number; revision: number; memberCount: number; createdAt: string; updatedAt: string };
export type BotTeamDetail = Omit<BotTeam, "memberCount"> & { memory: string; workspace: string; members: { id: string; name: string; archived: boolean }[] };
export type Bot = {
  profilePreparation?: BotProfilePreparation | null;
  extension?: number;
  deletedAt?: string;
  teamId?: string | null;
  teamOrder?: number;
  executionMode?: "legacy" | "single-thread";
  migrationReason?: string | null;
  avatar?: BotAvatar;
  burstQuietSeconds?: BotBurstQuietSeconds;
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
export type BotRunContext = { laneId: string; runId: string; threadId: string };
export type BotBackground = { botId: string; running: number; needsInput: number; unconfirmed: number };
export type BotRunReceipt = { operationId: string; runId: string; laneId: string; state: "queued" | "accepted" | "uncertain" | "rejected"; turnId: string | null; waitReason: string | null };
export type BotRunFinding = BotRunContext & { id: string; botId: string; turnId: string; key: string; summary: string; createdAt: string; conversation?: boolean };
export type BotRunStateEvent = { runId: string; laneId?: string | null; threadId?: string | null; run: BotRun; background: Omit<BotBackground, "botId"> & { botId?: string }; historyRefresh?: unknown };
export type BotRun = {
  decision?: BotRunDecision;
  executionLane?: "main-legacy" | "main-single" | "run-v1";
  laneId?: string | null; threadId?: string | null;
  activity?: { state: "provisioning" | "queued" | "running" | "waiting-input" | "waiting-workers" | "idle" | "uncertain" | "paused"; activeTurnId: string | null; waitReason: string | null; queuedCount?: number; pendingCount?: number };
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
export type BotRunDecision = {
  id: string; revision: number; state: "required" | "start-approved" | "rescheduled" | "cancelled";
  reason: "missed-start"; scheduledAt: string; requestedAt: string; graceMs: number;
  notBefore: string | null; decidedAt: string | null; operationId: string | null;
};
export type BotRunPage = { runs: BotRun[]; nextCursor: string | null; latestBySchedule: BotRun[] };
/** Metadata for a scheduled-context continuation; the primary run.turnId stays unchanged. */
export type BotRunTurn = {
  laneId?: string; threadId?: string; source?: string;
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
  conversation?: boolean;
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
  ordinaryUsageAllowedObservedAt?: string | null;
  availableResetCreditsObservedAt?: string | null;
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
  /** Verified native output aliases; these never authorize arbitrary path reads. */
  visualizationReferences?: string[];
  sha256?: string;
  cloudState?: "pending" | "transferring" | "ready" | "failed";
  /** Present on delivered history/output metadata; previews remain lazy. */
  createdAt?: string | null;
  artifact?: boolean;
  direction?: "input" | "output";
  source?: "upload" | "published" | "native";
  provenance?: { runId?: string; laneId?: string; threadId?: string; turnId?: string; itemId?: string; operationId?: string };
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
  provenance: { runId?: string; laneId?: string; threadId?: string; turnId?: string; itemId?: string; operationId?: string };
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
  runId?: string; laneId?: string; threadId?: string;
  key: string;
  botId: string;
  request: ServerRequest;
  createdAt: string;
};
export type BotRunRequestEvent = BotRequest & BotRunContext;
export type BotRunRequestResolvedEvent = BotRunContext & { key: string };
export type BotQueueList = { id: string; botId: string; name: string; cron: string | null; timeZone: string; enabled: boolean; nextRunAt: string | null; revision: number; count: number; createdAt: string; lastFlushedAt?: string; lastFlushedCount?: number };
export type BotSnapshot = {
  secureInputs?: import("./secure-input").SecureRequest[];
  botAdminLeadIds?: string[];
  capabilities?: { collaborationRooms?: 1; executionConfiguration?: 1; accountUsageHistory?: 1; botAdministration?: 1; botMemoryMaintenance?: 1; botDesktops?: 1; backgroundRunLanes?: 1; scheduleDecisions?: 1; singleThreadExecution?: 1; peerInbox?: 1; peerRootControls?: 1; peerBodyPaging?: 1; nativeGoals?: 1; nativeConversation?: 1; messageReplies?: 1; secureInputs?: 1; secureResponseLifecycle?: 1; operatorCalls?: 1; messageBursts?: 1; burstDiscard?: 1; burstControls?: 1; burstQueue?: 1; queueLists?: 1; queueRelativeMoves?: 1; queueSendNow?: 1; taskQueues?: 1; teams?: 1 };
  teams?: BotTeam[];
  workByBot?: BotWorkState[];
  backgroundByBot?: BotBackground[];
  /** Existing runtime metadata prioritizes unfinished runs over recent history. */
  backgroundRuns?: BotRun[];
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
  configuration?: {requested:import('./bot-collaboration').ExecutionSettings;settingsRevision:number;confirmation:'pending-unsupported';reason:string} | null;
  source?: import("./task-queue-delegation").TaskQueueBinding | { kind: string; operationId?: string; members?: unknown[] };
  reply?: import("./bot-replies").BotReplyReference;
  listId?: string | null;
  attachments: BotAttachment[];
  /** Optional bridge-staged fields; legacy native queues omit these. */
  state?: "queued" | "dispatching" | "uncertain" | "failed";
  revision?: number;
  operationId?: string | null;
  waitReason?: "main-turn-running" | "needs-input" | "paused" | "delivery-unconfirmed" | "rejected" | "plan-reconciliation" | "configuration-unsupported" | null;
  error?: string | null;
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

export type BotWorkState = {
  botId: string; executionMode: "legacy" | "single-thread";
  state: "ready" | "working" | "waiting" | "needs-input" | "paused" | "unconfirmed" | "starting";
  activeTurnId: string | null; paused: boolean; summary: string | null; remaining: string | null; waitingFor: string[];
  goal: import("./codex-protocol/v2/ThreadGoal").ThreadGoal | null; goalObservedAt: string | null; migrationReason: string | null;
};
export type BotInboxItem = { id: string; botId: string; kind: "schedule" | "peer" | "secure-input" | "memory-maintenance"; sourceId: string; summary: string;
  state: "queued" | "dispatching" | "accepted" | "uncertain" | "cancelled" | "failed"; createdAt: string; turnId: string | null; waitReason: string | null };
export type BotPeerRoot = {
  id: string; version: 1; revision: number; state: "active" | "paused" | "stopped";
  reason: "legacy-limit" | "work-budget" | "selected-bytes" | "traffic" | "repeated-context" | "owner-stopped" | null;
  reasonText: string | null; pausedAt: string | null;
  allowance: { number: number; contributions: number; selectedBytes: number; exchanges: number; startedAt: string };
  lifetimeContributions: number; lifetimeExchanges: number; lifetimeSelectedBytes: number;
  limits: { contributions: number; selectedBytes: number; trafficExchanges: number; trafficWindowMs: number; duplicateOccurrences: number; duplicateWindowExchanges: number };
  participants: string[]; participantCount: number; participantsComplete: boolean; heldOperations: number; reservedReplies: number; observationSeq: number; ownerControls: { authority: "owner"; canContinue: boolean; canStop: boolean }; queuedIntakes: number; committedIntakes: number;
  stopScope: "discussion-admission"; nativeInterruption: false;
};
export type BotPeerRequest = { id: string; rootId: string; parentId: string | null; senderBotId: string; recipientBotId: string;
  kind: "message" | "question" | "task"; summary: string; state: "queued" | "working" | "waiting" | "completed" | "cancelled" | "failed" | "delivery-unconfirmed";
  // Legacy fields retain lifetime count/current allowance ceiling. Use root for controls.
  round: number; roundLimit: number; root?: BotPeerRoot; hasResult?: boolean;
  createdAt: string; updatedAt: string; turnId: string | null; result: string | null; cancelRequested: boolean;
  executions?: { botId: string; turnId: string; needsInput: boolean }[] };
// Bodies stay request/bot scoped and bounded to 12 rows / 256 KiB per page.
export type BotPeerExchange = { id: string; requestId: string; botId: string; kind: "request" | "reply" | "cancel"; text: string; attachmentIds: string[]; createdAt: string; round: number; heldAtAcceptance?: boolean };
export type BotPeerBodyPage = { request: BotPeerRequest; exchanges: BotPeerExchange[]; nextCursor?: string | null; bodyBytes?: number; pageLimit?: number };
export type BotPeerPage = { requests: BotPeerRequest[]; nextCursor: string | null };
export type BotPeerStatus = BotPeerPage & { totals: { openRequests: number; visibleRequests: number; pausedRoots: number; stoppedRoots: number } };
export type BotPeerExchangeMeta = Omit<BotPeerExchange,"text"> & {
  rootId: string; senderBotId: string; recipientBotId: string; arrivalSequence: string; summary: string; bodyBytes: number; intakeAlias: string;
  intake: { id: string; botId: string; threadId: string; turnId: string | null; nativeQueueId: string | null; clientUserMessageId: string;
    state: BotInboxItem["state"]; terminalStatus: string | null; waitReason: string | null } | null;
};
export type BotPeerHeldPage = { operations: { operationId: string; rootId: string; method: "peers.send" | "peers.reply" | "peers.cancel";
  params: Record<string, unknown>; createdAt: string }[]; nextCursor: string | null; bodyBytes: number };
export type BotPeerFeed = { exchanges: BotPeerExchangeMeta[]; nextCursor: string | null; highWater: string; direction: "older" | "newer"; pageLimit: number; complete: boolean };
export type BotPeerControl = { root: BotPeerRoot; previous: { revision: number; state: BotPeerRoot["state"]; reason: BotPeerRoot["reason"]; allowance: BotPeerRoot["allowance"] }; control: { operationId: string; rootId: string; botId: string; expectedRevision: number; action: "continue" | "stop"; appliedRevision: number; scope: "discussion-admission"; nativeInterruption: false } };
export type BotBurstMessage = { reply?: import("./bot-replies").BotReplyReference; id: string; botId: string; text: string; attachmentIds: string[]; createdAt: string;
  state: "pending" | "dispatching" | "sent" | "uncertain" | "failed"; batchId: string | null; turnId: string | null };
export type BotBurst = { id: string; botId: string; revision?: number; state: "pending" | "preparing" | "paused" | "dispatching" | "sent" | "uncertain" | "failed" | "discarded";
  messageIds: string[]; dueAt: string | null; operationId: string | null; turnId: string | null; error: string | null };
export type BotBurstState = { threadId?: string | null; controlRevision?: number; paused?: boolean; control?: { operationId: string; method: string; botId: string }; heldIds?: string[]; inFlightIds?: string[]; messages: BotBurstMessage[]; burst: BotBurst | null; batches?: BotBurst[]; attachments?: BotAttachment[] };
