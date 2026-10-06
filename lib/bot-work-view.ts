import type { BotInboxItem, BotWorkState } from './bots-types';

// Additive display metadata. Old bridges omit it; receipt state/IDs are unchanged.
export type BotAdmissionWork = BotWorkState & {
  threadId?: string;
  activeNeedsInput?: boolean;
  admission?: { waitingCount: number; reason: string | null };
};
export type BotObservedInboxItem = BotInboxItem & { threadId?: string };
