import type { BotAttachment } from './bots-types';
import type { BotReplyReference } from './bot-replies';

/** Unsent normal composer only. Operation journals and local file bytes never
 * cross this boundary. Queue edits, PDF reviews and run drafts stay separate. */
export type ComposerDraftContent = {
  text: string; textVersion: string; reply?: BotReplyReference;
  files: { id: string; name: string; mimeType: string; size: number; remote: BotAttachment }[];
};
export type SharedComposerDraft = { revision: number; content: ComposerDraftContent };
export type ComposerDraftMutation = { operationId: string; expectedRevision: number; content: ComposerDraftContent };
export type ComposerDraftReceipt = { operationId: string; applied: boolean; draft: SharedComposerDraft };
export const draftIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(value);
export const draftContentFingerprint = (draft: ComposerDraftContent) => JSON.stringify(draft);
export const emptySharedDraft = (): SharedComposerDraft => ({ revision: 0, content: { text: '', textVersion: 'empty', files: [] } });
export function validDraftContent(value: unknown, botId: string): value is ComposerDraftContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as ComposerDraftContent;
  if (Object.keys(d).some(k => !['text', 'textVersion', 'files', 'reply'].includes(k)) || typeof d.text !== 'string' ||
      d.text.length > 200_000 || !draftIdentity(d.textVersion) || !Array.isArray(d.files) || d.files.length > 12) return false;
  if (d.reply !== undefined && (!d.reply || !draftIdentity(d.reply.id) || d.reply.botId !== botId || !draftIdentity(d.reply.threadId) ||
      !draftIdentity(d.reply.turnId) || !draftIdentity(d.reply.itemId) || (d.reply.partId !== undefined && !draftIdentity(d.reply.partId)) ||
      !['user', 'assistant'].includes(d.reply.role) || typeof d.reply.text !== 'string' || d.reply.text.length > 8192 || typeof d.reply.truncated !== 'boolean' ||
      Object.keys(d.reply).some(k => !['id','botId','threadId','turnId','itemId','partId','role','text','truncated'].includes(k)))) return false;
  return new Set(d.files.map(f => f?.id)).size === d.files.length && d.files.every(f => f &&
    Object.keys(f).every(k => ['id','name','mimeType','size','remote'].includes(k)) && draftIdentity(f.id) &&
    typeof f.name === 'string' && f.name.length <= 1024 && typeof f.mimeType === 'string' && f.mimeType.length <= 256 &&
    Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= 100 * 1024 * 1024 && f.remote &&
    Object.keys(f.remote).every(k => ['id','botId','name','mimeType','size','ready','cloudState'].includes(k)) &&
    draftIdentity(f.remote.id) && f.remote.botId === botId && f.remote.ready === true &&
    f.remote.name === f.name && f.remote.size === f.size && f.remote.mimeType === f.mimeType &&
    (f.remote.cloudState === undefined || f.remote.cloudState === 'ready'));
}
export function validSharedDraft(value: unknown, botId: string): value is SharedComposerDraft {
  const d = value as SharedComposerDraft | null;
  return Boolean(d && Number.isSafeInteger(d.revision) && d.revision >= 0 && validDraftContent(d.content, botId));
}
export function validDraftMutation(value: unknown, botId: string): value is ComposerDraftMutation {
  const d = value as ComposerDraftMutation | null;
  return Boolean(d && Object.keys(d).every(k => ['operationId','expectedRevision','content'].includes(k)) &&
    draftIdentity(d.operationId) && Number.isSafeInteger(d.expectedRevision) && d.expectedRevision >= 0 &&
    validDraftContent(d.content, botId));
}
