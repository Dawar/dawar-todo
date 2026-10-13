import type { BotInboxItem, BotWorkState } from './bots-types';
import type { NativeRecoveryObservation } from './native-recovery';

// Additive display metadata. Old bridges omit it; receipt state/IDs are unchanged.
export type BotAdmissionWork = BotWorkState & {
  threadId?: string;
  activeNeedsInput?: boolean;
  admission?: { waitingCount: number; reason: string | null };
  recovery?: NativeRecoveryObservation;
};
export type BotObservedInboxItem = BotInboxItem & { threadId?: string };
