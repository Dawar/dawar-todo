/** Canonical v1 protected form contract. Private values never pass these serializers. */
import type { SecureRequest } from './secure-input';

export const TASK_REQUEST_VERSION = 1 as const;
export const TASK_REQUEST_LIMITS = { fields: 32, groups: 12, files: 12, fileBytes: 100 * 1024 * 1024, ordinaryBytes: 96 * 1024, defaultExpirySeconds: 7 * 86400, maximumExpirySeconds: 30 * 86400 } as const;
export type TaskRequestField = {
  id: string; label: string; kind: 'text' | 'long-text' | 'choice' | 'image' | 'file' | 'secure-text' | 'secure-image';
  required: boolean; notes?: string; groupId?: string; choices?: { id: string; label: string }[]; questionId?: string;
};
export type TaskRequestSpec = {
  version: 1; title: string; instructions: string; context: string;
  groups: { id: string; label: string; notes?: string }[]; fields: TaskRequestField[];
  secure?: { purpose: string; destination: SecureRequest['destination'] };
};
export type TaskRequestSource = {
  botId: string; threadId: string; turnId?: string; itemId?: string; taskId?: number;
  question?: { key: string; requestHash: string; turnId: string };
};
export type TaskRequestStatus = 'draft' | 'published' | 'revoked' | 'expired' | 'received' | 'awaiting-bot' | 'native-accepted' | 'response-sent' | 'needs-review' | 'uncertain' | 'private-unavailable';
export type TaskRequestFile = { id: string; fieldId: string; name: string; size: number; mimeType: string; sha256: string; ready: boolean };
export type TaskRequestValues = Record<string, string | string[]>;
export type TaskRequestSubmission = {
  id: string; revision: number; contributorName: string; values: TaskRequestValues; files: TaskRequestFile[];
  secure?: { handle: string; submissionId: string; expiresAt: string; modelRead: boolean };
  status: TaskRequestStatus; submittedAt?: string; delivery?: { operationId: string; nativeTurnId?: string; reason?: string };
};
export type TaskRequest = {
  id: string; revision: number; source: TaskRequestSource; spec: TaskRequestSpec; status: TaskRequestStatus;
  createdAt: string; updatedAt: string; publishedAt?: string; expiresAt?: string; pinRequired?: boolean;
  submission?: TaskRequestSubmission;
};
export type TaskRequestGuest = Omit<TaskRequest, 'source'> & { source: Pick<TaskRequestSource, 'botId' | 'threadId'>; botName: string };
export type TaskRequestSave = { id: string; operationId: string; expectedRevision: number; contributorName: string; values: TaskRequestValues };
export type TaskRequestPublish = { id: string; operationId: string; expectedRevision: number; expirySeconds?: number; pin?: string };
export type TaskRequestUpload = { id: string; operationId: string; fieldId: string; name: string; size: number; mimeType: string; sha256: string };
export type TaskRequestSecureBinding = { requestId: string; revision: number; submissionId: string; grantId: string };
export type TaskRequestSecureSession = { ticket: string; url: string; machineId: string; binding: TaskRequestSecureBinding; expiresAt: number };
export type TaskRequestOwnerAction =
  | { action: 'list'; botId: string; threadId: string; before?: string; limit?: number }
  | { action: 'read'; id: string }
  | { action: 'draft'; operationId: string; source: TaskRequestSource; spec: TaskRequestSpec }
  | { action: 'edit'; id: string; operationId: string; expectedRevision: number; spec: TaskRequestSpec }
  | ({ action: 'publish' } & TaskRequestPublish)
  | { action: 'revoke'; id: string; operationId: string; expectedRevision: number };
export type TaskRequestGuestAction =
  | { action: 'read'; id: string }
  | ({ action: 'save' } & TaskRequestSave)
  | ({ action: 'upload' } & TaskRequestUpload)
  | { action: 'finalize' | 'download'; id: string; fileId: string }
  | { action: 'secure-session'; id: string; submissionId: string }
  | { action: 'submit'; id: string; operationId: string; expectedRevision: number; submissionId: string; secureHandle?: string };

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
export function taskRequestId(v: unknown): string {
  if (typeof v !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(v)) throw Error('Invalid request identity.');
  return v;
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw Error('Unsupported form property.');
}
function text(v: unknown, max: number, empty = false): string {
  if (typeof v !== 'string' || v.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v) || !empty && !v.trim()) throw Error('Invalid form text.');
  return v;
}
/** Reconstruct an allowlisted shape; no arbitrary markup/actions or secret defaults. */
export function taskRequestSpec(input: unknown): TaskRequestSpec {
  if (!plain(input)) throw Error('Invalid form specification.');
  keys(input, ['version','title','instructions','context','groups','fields','secure']);
  if (input.version !== 1 || !Array.isArray(input.fields) || !input.fields.length || input.fields.length > 32 || !Array.isArray(input.groups) || input.groups.length > 12) throw Error('Unsupported form version or field count.');
  const groupIds = new Set<string>(), fieldIds = new Set<string>();
  const groups = input.groups.map(g => {
    if (!plain(g)) throw Error('Invalid group.'); keys(g,['id','label','notes']);
    const id = taskRequestId(g.id); if(groupIds.has(id)) throw Error('Duplicate group.'); groupIds.add(id);
    return { id,label:text(g.label,200),...(g.notes === undefined ? {} : {notes:text(g.notes,2000,true)}) };
  });
  const fields = input.fields.map(f => {
    if (!plain(f)) throw Error('Invalid field.'); keys(f,['id','kind','label','required','notes','groupId','choices','questionId']);
    const id=taskRequestId(f.id); if(!/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(id) || id==='allow-model' || fieldIds.has(id)) throw Error('Invalid or duplicate field identity.'); fieldIds.add(id);
    if (!['text','long-text','choice','image','file','secure-text','secure-image'].includes(String(f.kind)) || typeof f.required !== 'boolean') throw Error('Invalid field type.');
    if(f.groupId !== undefined && !groupIds.has(taskRequestId(f.groupId))) throw Error('Unknown field group.');
    let choices: TaskRequestField['choices'];
    if(f.kind === 'choice') {
      if(!Array.isArray(f.choices) || !f.choices.length || f.choices.length>20) throw Error('Choices required.');
      choices=f.choices.map(c=>{if(!plain(c)) throw Error('Invalid choice.');keys(c,['id','label']);return {id:taskRequestId(c.id),label:text(c.label,200)};});
      if(new Set(choices.map(c=>c.id)).size!==choices.length) throw Error('Duplicate choice.');
    } else if(f.choices !== undefined) throw Error('Choices belong to choice fields.');
    return { id,kind:f.kind as TaskRequestField['kind'],label:text(f.label,200),required:f.required,
      ...(f.notes === undefined ? {} : {notes:text(f.notes,2000,true)}),...(f.groupId === undefined ? {} : {groupId:String(f.groupId)}),
      ...(choices ? {choices}:{}),...(f.questionId === undefined ? {} : {questionId:taskRequestId(f.questionId)}) };
  });
  if(fields.filter(f=>f.kind==='secure-text').length>6 || fields.filter(f=>f.kind==='secure-image').length>2) throw Error('Private field bounds exceeded.');
  let secure: TaskRequestSpec['secure'];
  if(fields.some(f=>f.kind.startsWith('secure-'))) {
    if(!plain(input.secure) || !plain(input.secure.destination)) throw Error('Private purpose/destination required.');
    keys(input.secure,['purpose','destination']); const d=input.secure.destination;keys(d,['kind','label','origin']);
    if(!['https','desktop'].includes(String(d.kind))) throw Error('Unsupported private destination.');
    let origin: string|undefined;
    if(d.kind==='https') { const u=new URL(String(d.origin)); if(u.protocol!=='https:' || u.username || u.password || u.hash || u.pathname!=='/' || u.search) throw Error('Private HTTPS origin required.'); origin=u.origin; }
    else if(d.origin !== undefined) throw Error('Desktop has no network origin.');
    secure={purpose:text(input.secure.purpose,500),destination:{kind:d.kind as 'https'|'desktop',label:text(d.label,200),...(origin ? {origin}:{})}};
  } else if(input.secure !== undefined) throw Error('Private destination requires a private field.');
  const spec:TaskRequestSpec={version:1,title:text(input.title,100),instructions:text(input.instructions,12000,true),context:text(input.context,12000,true),groups,fields,...(secure ? {secure}:{})};
  if(new TextEncoder().encode(JSON.stringify(spec)).length>48*1024) throw Error('Form specification too large.');
  return spec;
}
export function taskRequestSource(input: unknown): TaskRequestSource {
  if(!plain(input)) throw Error('Invalid form source.'); keys(input,['botId','threadId','turnId','itemId','taskId','question']);
  const source:TaskRequestSource={botId:taskRequestId(input.botId),threadId:taskRequestId(input.threadId)};
  for(const k of ['turnId','itemId'] as const) if(input[k]!==undefined) source[k]=taskRequestId(input[k]);
  if(input.taskId!==undefined) { if(!Number.isSafeInteger(input.taskId) || Number(input.taskId)<1) throw Error('Invalid task reference.'); source.taskId=Number(input.taskId); }
  if(input.question!==undefined) { if(!plain(input.question)) throw Error('Invalid question reference.');keys(input.question,['key','requestHash','turnId']);
    if(!/^[a-f0-9]{64}$/.test(String(input.question.requestHash))) throw Error('Question fingerprint required.');
    source.question={key:taskRequestId(input.question.key),requestHash:String(input.question.requestHash),turnId:taskRequestId(input.question.turnId)}; }
  return source;
}
/** Called before ordinary persistence. Explicitly reject secure values rather than dropping them. */
export function taskRequestValues(spec: TaskRequestSpec, input: unknown, final = false): TaskRequestValues {
  if(!plain(input)) throw Error('Invalid ordinary answers.'); const values:TaskRequestValues={};
  for(const [id,v] of Object.entries(input)) {
    const f=spec.fields.find(f=>f.id===id);
    if(!f || !['text','long-text','choice'].includes(f.kind)) throw Error('Private values and file bytes cannot be saved as ordinary answers.');
    if(f.kind==='choice') { if(!Array.isArray(v) || v.length>1 || v.some(x=>typeof x!=='string'||!f.choices?.some(c=>c.id===x))) throw Error('Invalid selected choice.'); values[id]=v as string[]; }
    else values[id]=text(v,f.kind==='text'?4096:16000,true);
  }
  if(final && spec.fields.some(f=>f.required && ['text','long-text','choice'].includes(f.kind) && !(typeof values[f.id]==='string' ? String(values[f.id]).trim() : values[f.id]?.length))) throw Error('Complete the required answers.');
  if(new TextEncoder().encode(JSON.stringify(values)).length>TASK_REQUEST_LIMITS.ordinaryBytes) throw Error('Ordinary answers too large.');
  return values;
}
