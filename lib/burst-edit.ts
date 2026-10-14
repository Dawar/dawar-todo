import type { BotAttachment, BotBurstMessage } from './bots-types';

export type BurstEditParams = { threadId: string; controlRevision: number; destinationId: string; batches: { id: string; revision: number }[] };
export type BurstEditReceipt = { operationId: string; botId: string; params: BurstEditParams; messages: BotBurstMessage[]; attachments: BotAttachment[] };
export type BurstEditBlocked = {operationId:string;botId:string;params:BurstEditParams;held:true;reason:string};
export function validBurstEditBlocked(value:unknown,id:string,botId:string,params:BurstEditParams):value is BurstEditBlocked {
  if(!value||typeof value!=='object')return false;const r=value as BurstEditBlocked;
  return r.operationId===id&&r.botId===botId&&r.held===true&&JSON.stringify(r.params)===JSON.stringify(params)&&typeof r.reason==='string'&&r.reason.length<=300;
}
export type BlastEditIntent = { id: string; params: BurstEditParams; receipt?: BurstEditReceipt; saved?: boolean; complete?: boolean; rejected?: string; quoteConflict?: boolean; recoveryOnly?: string };
export function validBurstEditReceipt(value: unknown, id: string, botId: string, params: BurstEditParams): value is BurstEditReceipt {
  if (!value || typeof value !== 'object') return false;
  const r = value as BurstEditReceipt;
  if (r.operationId !== id || r.botId !== botId || JSON.stringify(r.params) !== JSON.stringify(params) ||
      !Array.isArray(r.messages) || !r.messages.length || r.messages.length > 200 || !Array.isArray(r.attachments) || r.attachments.length > 2400 ||
      new Set(r.messages.map(m => m?.id)).size !== r.messages.length || new Set(r.attachments.map(f => f?.id)).size !== r.attachments.length) return false;
  const batchIds = new Set(params.batches.map(b => b.id)), fileIds = new Set(r.attachments.map(f => f?.id));
  return r.messages.every(m => m && typeof m.id === 'string' && m.botId === botId && batchIds.has(m.batchId ?? '') &&
    typeof m.text === 'string' && m.text.length <= 1024 * 1024 && Number.isFinite(Date.parse(m.createdAt)) &&
    Array.isArray(m.attachmentIds) && m.attachmentIds.every(f => typeof f === 'string' && fileIds.has(f))) &&
    r.messages.reduce((n, m) => n + m.text.length, 0) <= 1024 * 1024 &&
    r.attachments.every(f => f && typeof f.id === 'string' && f.botId === botId && f.ready &&
      typeof f.name === 'string' && typeof f.mimeType === 'string' && Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= 100 * 1024 * 1024);
}
export const blastText = (messages: Pick<BotBurstMessage, 'text'>[]) => messages.map(m => m.text).filter(text => text.length > 0).join('\n');
