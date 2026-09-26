/** Public bridge contract. Native JSON-RPC method names never come from a browser. */
import type {
  Bot,
  BotAttachment,
  BotHistory,
  BotSchedule,
  BotSnapshot,
  BotQueuedSubmission,
} from "./bots-types";
import type { ThreadTurnsListResponse } from "./codex-protocol/v2/ThreadTurnsListResponse";
import type { TurnStartResponse } from "./codex-protocol/v2/TurnStartResponse";
import type { TurnSteerResponse } from "./codex-protocol/v2/TurnSteerResponse";
import type { QueuedSubmission } from "./codex-protocol/v2/QueuedSubmission";
export type BotOperations = {
  snapshot: { params: Record<string, never>; result: BotSnapshot };
  history: { params: Record<string, never>; result: BotHistory };
  "history.page": {
    params: { cursor: string };
    result: ThreadTurnsListResponse;
  };
  "bots.create": { params: { name: string; purpose?: string }; result: Bot };
  "bots.update": {
    params: Partial<Pick<Bot, "name" | "model" | "effort" | "mode">>;
    result: Bot;
  };
  "bots.read": { params: Record<string, never>; result: Bot };
  "bots.recover": { params: Record<string, never>; result: Bot };
  "bots.archive": { params: Record<string, never>; result: Bot };
  "bots.restore": { params: Record<string, never>; result: Bot };
  "turn.send": {
    params: { text: string; attachments?: string[] };
    result: TurnStartResponse | TurnSteerResponse;
  };
  "turn.interrupt": {
    params: Record<string, never>;
    result: Record<string, never>;
  };
  "queue.list": { params: Record<string, never>; result: BotQueuedSubmission[] };
  "queue.add": {
    params: { text: string; attachments?: string[] };
    result: { queuedSubmission: QueuedSubmission };
  };
  "queue.update": {
    params: { id: string; text: string; attachments?: string[] };
    result: { queuedSubmission: QueuedSubmission };
  };
  "queue.delete": { params: { id: string }; result: { deleted: boolean } };
  "queue.reorder": { params: { ids: string[] }; result: Record<string, never> };
  "queue.resume": { params: Record<string, never>; result: Record<string, never> };
  "thread.compact": {
    params: Record<string, never>;
    result: Record<string, never>;
  };
  "requests.respond": {
    params: { key: string; result: unknown };
    result: Record<string, never>;
  };
  "schedules.save": {
    params: Partial<Omit<BotSchedule, "botId" | "createdAt" | "nextRunAt">>;
    result: BotSchedule;
  };
  "schedules.delete": { params: { id: string }; result: Record<string, never> };
  "schedules.run": { params: { id: string }; result: unknown };
  "schedules.list": { params: Record<string, never>; result: unknown };
  "runs.acknowledge": { params: { id: string }; result: Record<string, never> };
  "attachments.begin": {
    params: { name: string; size: number; mimeType: string };
    result: BotAttachment;
  };
  "attachments.chunk": {
    params: { id: string; offset: number; data: string };
    result: { received: number };
  };
  "attachments.finish": {
    params: { id: string; sha256?: string };
    result: BotAttachment;
  };
  "attachments.read": {
    params: { id: string; offset?: number };
    result: {
      data: string;
      nextOffset: number;
      size: number;
      name: string;
      mimeType: string;
    };
  };
  "settings.timeZone": {
    params: { timeZone: string };
    result: Record<string, never>;
  };
  events: { params: { after: number }; result: unknown };
  "runtime.info": { params: Record<string, never>; result: unknown };
};
export type BotOperation = {
  [Method in keyof BotOperations]: {
    method: Method;
    params: BotOperations[Method]["params"];
    botId?: string;
    operationId: string;
  };
}[keyof BotOperations];
