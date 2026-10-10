import { historyKey, type HistoryEntry, type HistoryGap } from '../../lib/bot-history-view';
import { proposedPlanParts } from '../../lib/proposed-plan';
import type { ConversationGroup } from './secure-input-timeline';

/** Explicit native phases/types only. Unknown phases and meaningful actions stay visible. */
export function activityEntry(entry: HistoryEntry): boolean {
  if (entry.activityBoundary || entry.peer || entry.peerAlias || entry.audience === 'finding' || entry.questionNotice || entry.reply || entry.replyMessages || entry.operatorSegmentId) return false;
  const item = entry.item;
  if (entry.type === 'agentMessage') return item?.type === 'agentMessage' && item.phase === 'commentary' && !item.questions?.length &&
    !item.text.includes('bot-artifact:') && !proposedPlanParts(item.text, !entry.complete || entry.status === 'inProgress').some(part => part.kind === 'plan');
  if (entry.type === 'reasoning') return item?.type === 'reasoning' && item.summary.some(text => text.trim());
  if (entry.type === 'dynamicToolCall' && (entry.label === 'Saved file' || entry.label === 'Reported finding')) return false;
  return ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration', 'collabAgentToolCall', 'contextCompaction', 'functionCallOutput'].includes(entry.type);
}
export function compactGroups(groups: ConversationGroup[], gaps: HistoryGap[]): ConversationGroup[] {
  const boundaries = new Set(gaps.map(gap => gap.before)), result: ConversationGroup[] = [];
  for (const group of groups) {
    if (group.secure || group.taskRequest) { result.push(group); continue; }
    for (const entry of group.entries) {
      const kind = activityEntry(entry) ? `activity:${entry.turnId}` : entry.audience === 'finding' && entry.runId ? `scheduled:${entry.runId}` : 'message';
      const previous = result.at(-1);
      if (kind !== 'message' && previous?.kind === kind && !boundaries.has(historyKey(entry.turnId, entry.id))) previous.entries.push(entry);
      else result.push({ kind, entries: [entry] });
    }
  }
  return result;
}
export function activityPreview(entries: HistoryEntry[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const item = entries[index].item;
    if (item?.type === 'agentMessage' && item.text.trim()) return item.text.slice(0, 512);
    if (item?.type === 'reasoning' && item.summary.some(text => text.trim())) return item.summary.join(' ').slice(0, 512);
  }
  return entries.some(entry => entry.deferredTurn) ? 'More work details available on opening' : 'Work details available on opening';
}
