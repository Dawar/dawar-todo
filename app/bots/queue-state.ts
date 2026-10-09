import type { BotQueuedSubmission } from '../../lib/bots-types';

export const stagedPrompt = (item: BotQueuedSubmission) => item.state !== undefined || item.revision !== undefined;
export const queueEditable = (item: BotQueuedSubmission) =>
  (item.revision === undefined || Number.isSafeInteger(item.revision) && item.revision > 0) && (item.state === undefined || item.state === 'queued' || item.state === 'failed') && item.waitReason !== 'delivery-unconfirmed';
export const queueResumeBlocked = (items: BotQueuedSubmission[]) => items.some(item =>
  !queueEditable(item) || item.state === 'failed' || item.waitReason === 'rejected' || item.waitReason === 'plan-reconciliation');
export function canMoveQueued(items: BotQueuedSubmission[], index: number, direction: number) {
  const other = index + direction;
  if (other < 0 || other >= items.length || items.some(item => !queueEditable(item))) return false;
  // Candidate runtime drains the whole native prefix unchanged before staged
  // items. Old native-only services retain their existing reorder behavior.
  return !items.some(stagedPrompt) || stagedPrompt(items[index]) && stagedPrompt(items[other]);
}
export function queueStatus(item: BotQueuedSubmission, paused = false) {
  if (item.configuration?.confirmation === "pending-unsupported") return {label: "Intended settings unsupported", description: item.configuration.reason, attention: true};
  if (item.state === 'dispatching') return { label: 'Confirming delivery', description: 'Waiting for confirmation. This message cannot be changed while it may be starting.', attention: true };
  if (item.state === 'uncertain' || item.waitReason === 'delivery-unconfirmed') return { label: 'Delivery unconfirmed', description: 'This message may have started. It will not be sent again automatically; refresh to check its status.', attention: true };
  if (item.state === 'failed' || item.waitReason === 'rejected') return { label: 'Not sent', description: 'Use Send now to retry, edit this message, or remove it.', attention: true };
  if (!queueEditable(item)) return { label: 'Status needs review', description: 'Refresh the queue before changing this message.', attention: true };
  switch (item.waitReason ?? (paused ? 'paused' : null)) {
    case 'needs-input': return { label: 'Waiting for your answer', description: 'Answer the bot’s question before this message can start.' };
    case 'main-turn-running': return { label: 'After the current turn', description: 'Starts when this conversation is free. Other workers do not hold it up.' };
    case 'paused': return { label: 'Paused', description: 'Kept in the queue until you resume it.' };
    case 'plan-reconciliation': return { label: 'Checking Plan settings', description: 'Waiting for the previous Plan settings to be confirmed. This message has not started.', attention: true };
    default: return { label: 'Queued', description: stagedPrompt(item) ? 'Saved for the next available turn in this conversation.' : 'Waiting in the bot’s queue.' };
  }
}
