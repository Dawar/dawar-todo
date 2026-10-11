import type { HistoryEntry } from '../../lib/bot-history-view';

/** Rendering is per native item. Grouping never owns item identity or storage. */
export function nativeWorkItem(entry: HistoryEntry): boolean {
  return Boolean(entry.workPlan || entry.deferredTurn || !['userMessage', 'agentMessage', 'plan'].includes(entry.type));
}
export function nativeWorkLabel(entry: HistoryEntry): string {
  if (entry.workPlan) return 'Work plan';
  if (entry.deferredTurn) return 'Work details';
  if (entry.type === 'reasoning') return 'Thinking';
  if (entry.type === 'contextCompaction') return 'Context compacted';
  if (entry.type === 'commandExecution') return entry.label || 'Command';
  const names: Record<string, string> = { fileChange: 'File changes', webSearch: 'Search', imageView: 'View image', imageGeneration: 'Generate image', collabAgentToolCall: 'Agent work', functionCallOutput: 'Tool result' };
  return names[entry.type] ? `${names[entry.type]}${['fileChange','webSearch'].includes(entry.type) && entry.label ? ` · ${entry.label}` : ''}` : entry.label;
}
