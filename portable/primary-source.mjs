import {createHash} from 'node:crypto';
import {fingerprint,id} from './protocol.mjs';

export const primarySource=q=>({id:q.id,botId:q.botId,threadId:q.threadId,kind:q.kind,sourceId:q.sourceId,
  text:q.text,attachmentIds:q.attachmentIds??[],fingerprint:q.fingerprint,createdAt:q.createdAt});
export function validatePrimary(source,botId,threadId,operationId){
  const hash=createHash('sha256').update(JSON.stringify({botId,kind:source?.kind,sourceId:source?.sourceId,text:source?.text,attachments:source?.attachmentIds??[]})).digest('hex');
  if(!source||source.id!==operationId||!id(source.id)||source.botId!==botId||source.threadId!==threadId||
      source.kind!=='task-request'||!id(source.sourceId)||typeof source.text!=='string'||!source.text.trim()||
      Buffer.byteLength(source.text)>800*1024||!Array.isArray(source.attachmentIds)||
      source.attachmentIds.length>12||new Set(source.attachmentIds).size!==source.attachmentIds.length||source.attachmentIds.some(value=>!id(value))||
      source.fingerprint!==hash||!Number.isFinite(Date.parse(source.createdAt)))throw Error('Original primary intake is outside its exact source, text or scope.');
  return fingerprint(primarySource(source));
}
