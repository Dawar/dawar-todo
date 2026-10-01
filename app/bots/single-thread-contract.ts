/** UI adapter for the manager-approved SINGLE_THREAD_CONTRACT_20260929.
 * Additive optional fields keep released services/caches compatible. The bridge
 * owns shared types; this adapter can be removed when that type commit lands. */
import type { Bot as LegacyBot, BotSnapshot as LegacySnapshot, BotWorkState } from '../../lib/bots-types';
import type { BotOperations as LegacyOperations } from '../../lib/bots-operations';
import type { BotAttachment } from '../../lib/bots-types';
import type { Shape } from './avatar-engine';
export type AvatarIdentity = { version: 1; shape: Shape; color: string; seed: string };
export type Bot = LegacyBot & { executionMode?: 'legacy' | 'single-thread'; migrationReason?: string | null; avatar?: AvatarIdentity; burstQuietSeconds?: 0 | 2.5 | 3 | 8 | 15 };
export type WorkState = BotWorkState;
export type InboxItem = { id: string; botId: string; kind: 'schedule' | 'peer'; sourceId: string; state: 'queued' | 'dispatching' | 'accepted' | 'uncertain' | 'cancelled' | 'failed'; summary: string; createdAt: string; turnId: string | null; waitReason: string | null };
export type PeerRequest = { id: string; rootId: string; parentId: string | null; senderBotId: string; recipientBotId: string; kind: 'message' | 'question' | 'task'; summary: string; state: 'queued' | 'working' | 'waiting' | 'completed' | 'cancelled' | 'failed' | 'delivery-unconfirmed'; round: number; roundLimit: number; createdAt: string; updatedAt: string; turnId: string | null; result: string | null; cancelRequested: boolean; executions?: { botId: string; turnId: string; needsInput: boolean }[] };
export type PeerExchange = { id: string; requestId: string; botId: string; kind: 'request' | 'reply' | 'cancel'; text: string; attachmentIds: string[]; createdAt: string; round: number };
export type BurstMessage = { id: string; botId: string; text: string; attachmentIds: string[]; createdAt: string; state: 'pending' | 'dispatching' | 'sent' | 'uncertain' | 'failed' | 'discarded'; dismissed?: boolean; batchId: string | null; turnId: string | null };
export type Burst = { id: string; botId: string; state: 'pending' | 'paused' | 'dispatching' | 'sent' | 'uncertain' | 'failed' | 'discarded'; messageIds: string[]; dueAt: string | null; operationId: string | null; turnId: string | null; error: string | null };
export type BurstState = { messages: BurstMessage[]; burst: Burst | null; batches?: Burst[]; attachments?: BotAttachment[] };
export type BotSnapshot = Omit<LegacySnapshot, 'bots' | 'capabilities'> & { bots: Bot[]; workByBot?: WorkState[]; capabilities?: LegacySnapshot['capabilities'] & { singleThreadExecution?: 1; peerInbox?: 1; nativeGoals?: 1; messageBursts?: 1 } };
export type BotOperations = Omit<LegacyOperations, 'bots.update'> & {
  'bots.update': { params: LegacyOperations['bots.update']['params'] & { avatar?: Pick<AvatarIdentity, 'shape' | 'color'>; burstQuietSeconds?: 0 | 2.5 | 3 | 8 | 15 }; result: Bot };
  'work.read': { params: Record<string, never>; result: WorkState };
  'work.resume': { params: Record<string, never>; result: unknown };
  'inbox.list': { params: { cursor?: string; limit?: number }; result: { items: InboxItem[]; nextCursor: string | null } };
  'peers.directory': { params: Record<string, never>; result: { bots: { id: string; name: string; purpose: string; color: string; available: boolean }[] } };
  'peers.list': { params: { cursor?: string; limit?: number; rootId?: string }; result: { requests: PeerRequest[]; nextCursor: string | null } };
  'peers.read': { params: { id: string }; result: { request: PeerRequest; exchanges: PeerExchange[] } };
  'peers.cancel': { params: { id: string }; result: { request: PeerRequest } };
  'bursts.submit': { params: { text: string; attachments?: string[] }; result: { message: BurstMessage; burst: Burst } };
  'bursts.read': { params: Record<string, never>; result: BurstState };
  'bursts.typing': { params: { clientId: string; typing: boolean }; result: unknown };
  'bursts.start': { params: Record<string, never>; result: BurstState };
  'bursts.discard': { params: { messageIds: string[] }; result: BurstState & { discardedIds: string[]; hiddenIds: string[] } };
  'bursts.stop': { params: Record<string, never>; result: BurstState };
};
