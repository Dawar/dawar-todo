import type { BotReplyReference } from "./bot-replies";
import type { OperatorSegment } from './operator-types';
/** Public bridge contract. Native JSON-RPC method names never come from a browser. */
import type {
  BotTeam, BotTeamDetail, Bot, BotAvatar, BotWorkState, BotInboxItem, BotPeerRequest, BotPeerExchange, BotPeerPage, BotBurstState, BotBurstMessage, BotBurst,
  BotAttachment,
  BotHistory,
  BotSchedule,
  BotRunPage,
  BotRun,
  BotRunReceipt, BotRunFinding, BotRequest,
  BotRunTurnPage,
  BotThreadUsage,
  BotAccountQuota,
  BotSnapshot,
  BotQueuedSubmission, BotQueueList,
  BotArtifactQuery,
  BotArtifactPage,
  BotArtifactPreview,
} from "./bots-types";
import type { ThreadTurnsListResponse } from "./codex-protocol/v2/ThreadTurnsListResponse";
import type { TurnStartResponse } from "./codex-protocol/v2/TurnStartResponse";
import type { TurnSteerResponse } from "./codex-protocol/v2/TurnSteerResponse";
import type { QueuedSubmission } from "./codex-protocol/v2/QueuedSubmission";
import type { HistoryResponse, HistoryDetail } from "./bot-history-view";
export type BotDesktopState = { state: "not-created" | "running" | "stopped"; display?: string; rdpPort?: number; rdpBind?: string; shared: boolean; image?: string; width?: number; height?: number; capturedAt?: string };
export type BotOperations = {
  "secure.list": {params: Record<string, never>; result: import("./secure-input").SecureRequest[]};
  "replies.prepare": { params: { threadId: string; turnId: string; itemId: string; partId?: string; cursor?: string | null }; result: { reply: BotReplyReference | null; nextCursor: string | null; unavailable: boolean } };
  "replies.resolve": { params: { reply: BotReplyReference; cursor?: string | null }; result: { entry: import("./bot-history-view").HistoryEntry | null; nextCursor: string | null; unavailable: boolean } };
  "operator.cards": { params: { limit?: number; before?: string | null }; result: { cards: OperatorSegment[]; nextCursor: string | null } };
  "operator.segment": { params: { segmentId: string; beforeTranscript?: string | null; beforeRequest?: string | null }; result: OperatorSegment };
  "desktop.status": {params: Record<string, never>; result: BotDesktopState};
  "desktop.preview": {params: Record<string, never>; result: BotDesktopState};
  "desktop.open": {params: Record<string, never>; result: {token:string; expiresAt:number}};
  "desktop.start": {params: Record<string, never>; result: BotDesktopState};
  "desktop.stop": {params: Record<string, never>; result: BotDesktopState};
  "desktop.delete": {params: Record<string, never>; result: BotDesktopState};
  "teams.list": { params: Record<string, never>; result: BotTeam[] };
  "teams.read": { params: { id: string }; result: BotTeamDetail };
  "teams.save": { params: { id?: string; name: string; color: string; expectedRevision?: number }; result: { team: Omit<BotTeamDetail, "workspace" | "members"> } };
  "teams.assign": { params: { botId: string; teamId: string | null; expectedTeamId: string | null }; result: { bot: Bot } };
  "teams.reorder": { params: { ids: string[]; revisions: { id: string; revision: number }[] }; result: { applied: boolean } };
  "teams.orderBots": { params: { id: string; ids: string[]; expectedRevision: number }; result: { applied: boolean } };
  "teams.memory": { params: { id: string; memory: string; expectedRevision: number }; result: { team: Omit<BotTeamDetail, "workspace" | "members"> } };
  "teams.delete": { params: { id: string; expectedRevision: number }; result: { applied: boolean } };
  "work.read": { params: Record<string, never>; result: BotWorkState };
  "work.resume": { params: Record<string, never>; result: BotWorkState };
  "inbox.list": { params: { cursor?: string | null; limit?: number }; result: { items: BotInboxItem[]; nextCursor: string | null } };
  "goals.read": { params: Record<string, never>; result: { goal: import("./codex-protocol/v2/ThreadGoal").ThreadGoal | null } };
  "goals.set": { params: { objective?: string; status?: import("./codex-protocol/v2/ThreadGoalStatus").ThreadGoalStatus; tokenBudget?: number | null }; result: { goal: import("./codex-protocol/v2/ThreadGoal").ThreadGoal } };
  "goals.clear": { params: Record<string, never>; result: { cleared: boolean } };
  "peers.directory": { params: Record<string, never>; result: { bots: { id: string; name: string; purpose: string; color: string; available: boolean }[] } };
  "peers.list": { params: { cursor?: string | null; limit?: number; rootId?: string }; result: BotPeerPage };
  "peers.read": { params: { id: string }; result: { request: BotPeerRequest; exchanges: BotPeerExchange[] } };
  "peers.send": { params: { recipientBotId: string; kind: "message" | "question" | "task"; summary: string; text: string; attachmentIds?: string[]; parentId?: string }; result: { request: BotPeerRequest } };
  "peers.reply": { params: { id: string; text: string; attachmentIds?: string[]; state: "waiting" | "completed" | "failed" }; result: { request: BotPeerRequest } };
  "peers.cancel": { params: { id: string }; result: { request: BotPeerRequest } };
  "bursts.read": { params: Record<string, never>; result: BotBurstState };
  "bursts.submit": { params: { reply?: BotReplyReference; text: string; attachments?: string[] }; result: { message: BotBurstMessage; burst: BotBurst } };
  "bursts.typing": { params: { clientId: string; typing: boolean }; result: Record<string, never> };
  "bursts.start": { params: Record<string, never>; result: BotBurstState };
  "bursts.stop": { params: Record<string, never>; result: BotBurstState };
  snapshot: { params: Record<string, never>; result: BotSnapshot };
  history: { params: Record<string, never>; result: BotHistory };
  "history.view": {
    params: { runId?: string; projection?: "conversation"; cursor?: string | null; turnId?: string; revision?: string; after?: number };
    result: HistoryResponse;
  };
  "history.log": { params: { turnId: string; cursor?: string | null }; result: { entries: import('./bot-history-view').HistoryEntry[]; olderCursor: string | null; attachments: BotAttachment[] } };
  "history.attachments": { params: { cursor?: string | null }; result: { attachments: BotAttachment[]; nextCursor: string | null } };
  /** Omit request.botId for all bots authorized by this machine's owner session. */
  "artifacts.list": { params: BotArtifactQuery; result: BotArtifactPage };
  "artifacts.preview": { params: { id: string; version?: string }; result: BotArtifactPreview };
  /** Explicit, bounded native-history backfill; botId required. Never scans paths or sends a turn. */
  "artifacts.index": { params: { runId?: string; cursor?: string | null }; result: { registered: number; nextCursor: string | null; failures: { itemId: string; reason: string }[] } };
  "history.detail": {
    params: { runId?: string; projection?: "conversation"; turnId: string; itemId: string; offset?: number; version?: string; knownVersion?: string };
    result: HistoryDetail;
  };
  "history.page": {
    params: { runId?: string; cursor: string };
    result: ThreadTurnsListResponse;
  };
  "history.turn": {
    params: { runId?: string; turnId: string; cursor?: string | null };
    result: { turn: import("./codex-protocol/v2/Turn").Turn | null; nextCursor: string | null };
  };
  "bots.create": { params: { name: string; purpose?: string }; result: Bot };
  "bots.update": {
    params: Partial<Pick<Bot, "name" | "model" | "effort" | "serviceTier" | "mode" | "burstQuietSeconds">> & { avatar?: Pick<BotAvatar, "shape" | "color"> };
    result: Bot;
  };
  "bots.read": { params: Record<string, never>; result: Bot };
  "bots.recover": { params: Record<string, never>; result: Bot };
  "bots.archive": { params: Record<string, never>; result: Bot };
  "bots.delete": {params: Record<string, never>; result: Bot};
  "bots.restore": { params: Record<string, never>; result: Bot };
  "turn.send": {
    params: { reply?: BotReplyReference; text: string; attachments?: string[] };
    result: TurnStartResponse | TurnSteerResponse;
  };
  "turn.interrupt": {
    params: { scope?: "main" | "all" };
    result: Record<string, never>;
  };
  "queue.list": { params: { listId?: string | null }; result: BotQueuedSubmission[] };
  "queueLists.list": { params: Record<string, never>; result: BotQueueList[] };
  "queueLists.save": { params: { id?: string; name: string; cron: string | null; timeZone: string; enabled: boolean; expectedRevision?: number }; result: { list: BotQueueList } };
  "queueLists.delete": { params: { id: string; expectedRevision: number }; result: { applied: boolean } };
  "queueLists.flush": { params: { id: string; expectedRevision: number }; result: { applied: boolean } };
  "queue.move": { params: { items: { id: string; revision: number }[]; listId: string | null }; result: { applied: boolean } };
  "queue.merge": { params: { items: { id: string; revision: number }[] }; result: { queuedSubmission: BotQueuedSubmission } };
  "queue.add": {
    params: { reply?: BotReplyReference; text: string; attachments?: string[]; listId?: string | null };
    result: { queuedSubmission: QueuedSubmission } | { consumedTurnId: string };
  };
  "queue.update": {
    params: { reply?: BotReplyReference; id: string; text: string; attachments?: string[]; expectedRevision?: number };
    result: { queuedSubmission: QueuedSubmission };
  };
  "queue.delete": { params: { id: string; expectedRevision?: number }; result: { deleted: boolean } };
  "queue.send": { params: { id: string; expectedRevision: number }; result: TurnStartResponse | TurnSteerResponse };
  "queue.reorder": { params: { ids: string[]; listId?: string | null }; result: Record<string, never> };
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
  "runs.send": { params: { runId: string; text: string; attachments?: string[] }; result: BotRunReceipt };
  "runs.receipt": { params: { runId: string; operationId: string }; result: BotRunReceipt };
  "runs.requests": { params: { runId: string }; result: { pending: BotRequest[] } };
  "runs.interrupt": { params: { runId: string }; result: Record<string, never> };
  "runs.resume": { params: { runId: string }; result: Record<string, never> };
  "runs.findings": { params: { runId?: string; cursor?: string | null; limit?: number }; result: { findings: BotRunFinding[]; nextCursor: string | null } };
  "runs.page": { params: { cursor?: string | null; limit?: number }; result: BotRunPage };
  "runs.decisions": { params: { cursor?: string | null; limit?: number }; result: { runs: BotRun[]; nextCursor: string | null } };
  "runs.decide": { params: { runId: string; expectedRevision: number; choice: "start" | "reschedule" | "cancel"; at?: string }; result: { operationId: string; run: BotRun } };
  /** Continuation metadata in stable ID order; default 25, maximum 50. */
  "runs.turns": { params: { runId: string; cursor?: string | null; limit?: number }; result: BotRunTurnPage };
  "usage.bot": { params: Record<string, never>; result: BotThreadUsage };
  "usage.account": { params: Record<string, never>; result: BotAccountQuota };
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
