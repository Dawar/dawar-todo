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
export type BotThreadUsage = {
  botId: string;
  threadId: string | null;
  estimatedCreditsMicros: string | null;
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
};
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
