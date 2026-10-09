import { artifactMime } from '../lib/bot-file-metadata.mjs';
import { createHash, createHmac } from 'node:crypto';
import { BotStorage, StorageError, type BotStorageEnv } from './bot-storage';
import { taskRequestId, taskRequestSource, taskRequestSpec, taskRequestValues, TASK_REQUEST_LIMITS,
  type TaskRequest, type TaskRequestGuest, type TaskRequestSubmission, type TaskRequestFile } from '../lib/task-requests';

export type TaskRequestEnvironment = BotStorageEnv & { BOTS_OWNER_EMAIL?: string; BOTS_TICKET_SECRET?: string };
type RequestRow = { owner_key:string; id:string; bot_id:string; thread_id:string; revision:number; body:string };
type Grant = { id:string; owner_key:string; request_id:string; revision:number; token_hash:string; pin_hash:string|null; expires_at:number; revoked:number };
type UploadRow = { owner_key:string; request_id:string; grant_id:string; id:string; field_id:string; body:string; state:string };
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown)=>JSON.stringify(v);
const now=()=>new Date().toISOString();
const initialized=new WeakMap<D1Database,Promise<unknown>>();
export const TASK_REQUEST_SCHEMA=[
  'CREATE TABLE IF NOT EXISTS task_requests(owner_key TEXT NOT NULL,id TEXT NOT NULL,bot_id TEXT NOT NULL,thread_id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner_key,id))',
  'CREATE INDEX IF NOT EXISTS task_requests_bot ON task_requests(owner_key,bot_id,thread_id,id)',
  'CREATE TABLE IF NOT EXISTS task_request_grants(id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,request_id TEXT NOT NULL,revision INTEGER NOT NULL,token_hash TEXT NOT NULL,pin_hash TEXT,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0)',
  'CREATE UNIQUE INDEX IF NOT EXISTS task_request_grant_request ON task_request_grants(owner_key,request_id)',
  'CREATE TABLE IF NOT EXISTS task_request_submissions(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner_key,request_id),UNIQUE(owner_key,id))',
  'CREATE TABLE IF NOT EXISTS task_request_uploads(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,grant_id TEXT NOT NULL,id TEXT NOT NULL,field_id TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(owner_key,id))',
  'CREATE INDEX IF NOT EXISTS task_request_upload_request ON task_request_uploads(owner_key,request_id,id)',
  'CREATE TABLE IF NOT EXISTS task_request_deliveries(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,submission_id TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(owner_key,request_id))',
  'CREATE TABLE IF NOT EXISTS task_request_private_receipts(owner_key TEXT NOT NULL,request_id TEXT NOT NULL,grant_id TEXT NOT NULL,submission_id TEXT NOT NULL,handle TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(owner_key,request_id))',
  'CREATE TABLE IF NOT EXISTS task_request_operations(owner_key TEXT NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner_key,scope,id))',
  'CREATE TABLE IF NOT EXISTS task_request_guards(id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1))',
  'CREATE TABLE IF NOT EXISTS task_request_rates(id TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL)',
];
export async function ensureTaskRequests(db:D1Database) {
  let p=initialized.get(db); if(!p) {p=db.batch(TASK_REQUEST_SCHEMA.map(s=>db.prepare(s))).catch(e=>{initialized.delete(db);throw e;});initialized.set(db,p);} await p;
}
/** D1 is authoritative for guest scope; runtime input is never guest-selected. */
export class TaskRequests {
  constructor(public environment:TaskRequestEnvironment, public owner:string) {
    if(!owner || owner!==environment.BOTS_OWNER_EMAIL?.trim().toLowerCase()) throw new StorageError('Task requests require the configured owner.',403,'forbidden');
  }
  get db() {return this.environment.DB;}
  async initialize() {await ensureTaskRequests(this.db);}
  private sign(v:string) {if(!this.environment.BOTS_TICKET_SECRET)throw new StorageError('Protected forms are not configured.',503,'unavailable'); return createHmac('sha256',this.environment.BOTS_TICKET_SECRET).update(v).digest('base64url');}
  async bot(botId:string) {
    const r=await this.db.prepare('SELECT metadata FROM bot_storage_identities WHERE owner_key=? AND id=? AND machine_id=?').bind(this.owner,taskRequestId(botId),this.environment.BOTS_MACHINE_ID??'dawar-vm').first<{metadata:string}>();
    const bot=r ? JSON.parse(r.metadata):null;
    if(!bot || bot.archived || bot.deleted) throw new StorageError('The originating bot is unavailable.',404,'not_found'); return bot;
  }
  async row(id:string) {
    const r=await this.db.prepare('SELECT * FROM task_requests WHERE owner_key=? AND id=?').bind(this.owner,taskRequestId(id)).first<RequestRow>();
    if(!r)throw new StorageError('Task request unavailable.',404,'not_found');return r;
  }
  async read(id:string):Promise<TaskRequest> {
    const row=await this.row(id), request:TaskRequest=JSON.parse(row.body);
    const submission=await this.db.prepare('SELECT body FROM task_request_submissions WHERE owner_key=? AND request_id=?').bind(this.owner,id).first<{body:string}>();
    if(submission) request.submission=JSON.parse(submission.body);
    if(request.status==='published' && Date.parse(request.expiresAt??'')<=Date.now())request.status='expired';
    return request;
  }
  async list(p:Record<string,unknown>) {
    const botId=taskRequestId(p.botId),threadId=taskRequestId(p.threadId),limit=p.limit??20;
    if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>40)throw new StorageError('Invalid form page size.');
    const before=p.before===undefined?Number.MAX_SAFE_INTEGER:this.cursor(p.before);
    const r=await this.db.prepare('SELECT rowid,id FROM task_requests WHERE owner_key=? AND bot_id=? AND thread_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').bind(this.owner,botId,threadId,before,Number(limit)+1).all<{rowid:number;id:string}>();
    const requests:TaskRequest[]=[];let bytes=0;
    for(const row of r.results.slice(0,Number(limit))) {
      const request=await this.read(row.id),size=new TextEncoder().encode(json(request)).length;
      if(requests.length&&bytes+size>256*1024)break;requests.push(request);bytes+=size;
    }
    return {requests,nextCursor:r.results.length>requests.length?String(r.results[requests.length-1].rowid):null};
  }
  private cursor(v:unknown) {if(typeof v!=='string'||!/^\d{1,16}$/.test(v)||!Number.isSafeInteger(Number(v)))throw new StorageError('Invalid form cursor.');return Number(v);}
  private async prior(scope:string,operationId:string,fingerprint:string) {
    taskRequestId(operationId);
    const op=await this.db.prepare('SELECT fingerprint,result FROM task_request_operations WHERE owner_key=? AND scope=? AND id=?').bind(this.owner,scope,operationId).first<{fingerprint:string;result:string}>();
    if(op && op.fingerprint!==fingerprint)throw new StorageError('Original operation has different parameters. Retain its identity.',409,'conflict');
    return op ? JSON.parse(op.result):null;
  }
  private async commit(scope:string,operationId:string,fingerprint:string,condition:string,args:unknown[],changes:D1PreparedStatement[],result:unknown) {
    const existing=await this.prior(scope,operationId,fingerprint);if(existing)return existing;
    const guard=`${scope}:${operationId}:${crypto.randomUUID()}`;
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO task_request_guards(id,valid) SELECT ?,CASE WHEN (${condition}) AND NOT EXISTS(SELECT 1 FROM task_request_operations WHERE owner_key=? AND scope=? AND id=?) THEN 1 ELSE 0 END`).bind(guard,...args,this.owner,scope,operationId),
        ...changes,
        this.db.prepare('INSERT INTO task_request_operations VALUES(?,?,?,?,?)').bind(this.owner,scope,operationId,fingerprint,json(result)),
        this.db.prepare('DELETE FROM task_request_guards WHERE id=?').bind(guard),
      ]);return result;
    } catch {
      const accepted=await this.prior(scope,operationId,fingerprint);if(accepted)return accepted;
      throw new StorageError('The form changed or acknowledgement is unavailable. Read its status and retain the original operation.',409,'conflict_or_unknown');
    }
  }
  async draft(p:Record<string,unknown>) {
    const source=taskRequestSource(p.source),spec=taskRequestSpec(p.spec);await this.bot(source.botId);
    const op=taskRequestId(p.operationId),fingerprint=hash(json([source,spec]));
    const id=`request:${hash(json([this.owner,op]))}`,request:TaskRequest={id,revision:1,source,spec,status:'draft',createdAt:now(),updatedAt:now()};
    return this.commit('owner',op,fingerprint,'NOT EXISTS(SELECT 1 FROM task_requests WHERE owner_key=? AND id=?)',[this.owner,id],[this.db.prepare('INSERT INTO task_requests VALUES(?,?,?,?,?,?)').bind(this.owner,id,source.botId,source.threadId,1,json(request))],{request});
  }
  async edit(p:Record<string,unknown>) {
    const r=await this.read(taskRequestId(p.id)),spec=taskRequestSpec(p.spec),op=taskRequestId(p.operationId),fingerprint=hash(json(['edit',r.id,p.expectedRevision,spec]));
    const old=await this.prior('owner',op,fingerprint);if(old)return old;
    if(r.status!=='draft')throw new StorageError('A published revision is frozen. Existing links/submissions are retained.',409,'frozen');
    const next={...r,spec,revision:r.revision+1,updatedAt:now()};
    return this.commit('owner',op,fingerprint,"EXISTS(SELECT 1 FROM task_requests WHERE owner_key=? AND id=? AND revision=? AND json_extract(body,'$.status')='draft')",[this.owner,r.id,p.expectedRevision],[this.db.prepare('UPDATE task_requests SET body=?,revision=? WHERE owner_key=? AND id=?').bind(json(next),next.revision,this.owner,r.id)],{request:next});
  }
  private token(id:string,operationId:string) {return this.sign(json(['task-request-link-v1',this.owner,id,operationId]));}
  async publish(p:Record<string,unknown>) {
    const r=await this.read(taskRequestId(p.id)),op=taskRequestId(p.operationId),seconds=p.expirySeconds??TASK_REQUEST_LIMITS.defaultExpirySeconds;
    if(!Number.isSafeInteger(seconds)||Number(seconds)<60||Number(seconds)>TASK_REQUEST_LIMITS.maximumExpirySeconds)throw new StorageError('Invalid link expiry.');
    if(p.pin!==undefined && (typeof p.pin!=='string'||!/^\d{4,12}$/.test(p.pin)))throw new StorageError('PIN requires 4–12 digits.');
    const pinHash=p.pin===undefined?null:this.sign(json(['task-request-pin-v1',r.id,p.pin]));
    const fingerprint=hash(json(['publish',r.id,p.expectedRevision,seconds,pinHash]));
    const token=this.token(r.id,op),url=`/task-request#${encodeURIComponent(r.id)}/${token}`;
    const old=await this.prior('owner',op,fingerprint);if(old)return {...old,url};
    await this.bot(r.source.botId);
    if(r.status!=='draft')throw new StorageError('This revision was already published.',409,'frozen');
    const expiry=Date.now()+Number(seconds)*1000,grantId=`grant:${hash(json([this.owner,r.id,r.revision]))}`;
    const next={...r,status:'published' as const,publishedAt:now(),expiresAt:new Date(expiry).toISOString(),pinRequired:pinHash!==null,updatedAt:now()};
    const result=await this.commit('owner',op,fingerprint,"EXISTS(SELECT 1 FROM task_requests WHERE owner_key=? AND id=? AND revision=? AND json_extract(body,'$.status')='draft')",[this.owner,r.id,p.expectedRevision],[
      this.db.prepare('INSERT INTO task_request_grants VALUES(?,?,?,?,?,?,?,0)').bind(grantId,this.owner,r.id,r.revision,hash(token),pinHash,expiry),
      this.db.prepare('UPDATE task_requests SET body=? WHERE owner_key=? AND id=?').bind(json(next),this.owner,r.id),
    ],{request:next});return {...result,url};
  }
  async revoke(p:Record<string,unknown>) {
    const r=await this.read(taskRequestId(p.id)),op=taskRequestId(p.operationId),fp=hash(json(['revoke',r.id,p.expectedRevision]));
    const next={...r,status:'revoked' as const,updatedAt:now()};
    return this.commit('owner',op,fp,'EXISTS(SELECT 1 FROM task_requests WHERE owner_key=? AND id=? AND revision=?)',[this.owner,r.id,p.expectedRevision],[
      this.db.prepare('UPDATE task_request_grants SET revoked=1 WHERE owner_key=? AND request_id=?').bind(this.owner,r.id),
      this.db.prepare('UPDATE task_requests SET body=? WHERE owner_key=? AND id=?').bind(json(next),this.owner,r.id),
    ],{request:next});
  }
  async rate(id:string) {
    const window=Math.floor(Date.now()/60000),key=hash(json(['form-rate',id,window]));
    await this.db.prepare('INSERT INTO task_request_rates VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1').bind(key,Date.now()+120000).run();
    const r=await this.db.prepare('SELECT count FROM task_request_rates WHERE id=?').bind(key).first<{count:number}>();
    await this.db.prepare('DELETE FROM task_request_rates WHERE expires_at<?').bind(Date.now()).run();
    if(!r||r.count>60)throw new StorageError('Too many form requests. Wait a minute before retrying.',429,'rate_limited');
  }
  async authorize(id:string,token:string,pin?:string):Promise<Grant> {
    taskRequestId(id);
    if(!/^[A-Za-z0-9_-]{43}$/.test(token)||pin!==undefined&&!/^\d{4,12}$/.test(pin))throw new StorageError('Protected link or PIN unavailable.',401,'unauthorized');
    const g=await this.db.prepare('SELECT * FROM task_request_grants WHERE owner_key=? AND request_id=? AND token_hash=?').bind(this.owner,id,hash(token)).first<Grant>();
    if(!g||g.revoked||g.expires_at<=Date.now()||g.pin_hash && g.pin_hash!==this.sign(json(['task-request-pin-v1',id,pin??''])))throw new StorageError('Protected link expired, revoked, or requires its PIN.',401,'unauthorized');
    const r=await this.row(id);if(r.revision!==g.revision)throw new StorageError('Published form revision unavailable.',409,'revision');
    await this.bot(r.bot_id);return g;
  }
  async grantCurrent(g:Grant) {
    const r=await this.db.prepare('SELECT * FROM task_request_grants WHERE id=? AND owner_key=?').bind(g.id,this.owner).first<Grant>();
    if(!r||r.revoked||r.expires_at<=Date.now()||json(r)!==json(g))throw new StorageError('Protected scope changed. Retain submitted data.',409,'scope_changed');
    const request=await this.read(g.request_id);if(request.revision!==g.revision)throw new StorageError('Published revision changed.',409,'scope_changed');return request;
  }
  private grantCondition(g:Grant) {return {sql:'EXISTS(SELECT 1 FROM task_request_grants WHERE id=? AND owner_key=? AND request_id=? AND revision=? AND revoked=0 AND expires_at>?)',args:[g.id,this.owner,g.request_id,g.revision,Date.now()]};}
  submissionId(g:Grant) {return `submission:${hash(json([g.id,g.revision]))}`;}
  async submission(g:Grant):Promise<TaskRequestSubmission> {
    const s=await this.db.prepare('SELECT body FROM task_request_submissions WHERE owner_key=? AND request_id=?').bind(this.owner,g.request_id).first<{body:string}>();
    const body=s?JSON.parse(s.body):{id:this.submissionId(g),revision:0,contributorName:'',values:{},files:[],status:'draft'};
    const uploads=await this.db.prepare("SELECT body FROM task_request_uploads WHERE owner_key=? AND request_id=? AND grant_id=? AND state='ready' ORDER BY id LIMIT 13").bind(this.owner,g.request_id,g.id).all<{body:string}>();
    if(!body.submittedAt)body.files=uploads.results.map(r=>JSON.parse(r.body));return body;
  }
  async guest(g:Grant):Promise<TaskRequestGuest> {
    const r=await this.grantCurrent(g),bot=await this.bot(r.source.botId);
    return {...r,source:{botId:r.source.botId,threadId:r.source.threadId},botName:bot.name,submission:await this.submission(g)};
  }
  async save(g:Grant,p:Record<string,unknown>) {
    const r=await this.grantCurrent(g),s=await this.submission(g),values=taskRequestValues(r.spec,p.values);
    if(typeof p.contributorName!=='string'||p.contributorName.length>100||/[\x00-\x1f]/.test(p.contributorName))throw new StorageError('Invalid contributor name.');
    const op=taskRequestId(p.operationId),fp=hash(json(['save',g.id,p.expectedRevision,p.contributorName,values]));
    const next={...s,revision:s.revision+1,contributorName:p.contributorName,values},scope=`guest:${g.id}`,c=this.grantCondition(g);
    const result=await this.commit(scope,op,fp,`${c.sql} AND (COALESCE((SELECT revision FROM task_request_submissions WHERE owner_key=? AND request_id=?),0)=?) AND NOT EXISTS(SELECT 1 FROM task_request_deliveries WHERE owner_key=? AND request_id=?)`,[...c.args,this.owner,r.id,p.expectedRevision,this.owner,r.id],[
      this.db.prepare('INSERT INTO task_request_submissions VALUES(?,?,?,?,?) ON CONFLICT(owner_key,request_id) DO UPDATE SET revision=excluded.revision,body=excluded.body').bind(this.owner,r.id,s.id,next.revision,json(next)),
    ],{request:{...await this.guest(g),submission:next}});return result;
  }
  async upload(g:Grant,p:Record<string,unknown>) {
    if(this.environment.BOTS_STORAGE_ENABLED!=='1')throw new StorageError('Ordinary file transfers are not enabled.',503,'disabled');
    const r=await this.grantCurrent(g),s=await this.submission(g);if(s.submittedAt)throw new StorageError('Final submission is frozen.',409,'frozen');
    const f=r.spec.fields.find(f=>f.id===p.fieldId);if(!f||!['file','image'].includes(f.kind))throw new StorageError('This field cannot accept ordinary files.',403,'forbidden');
    if(!Number.isSafeInteger(p.size)||Number(p.size)<1||Number(p.size)>TASK_REQUEST_LIMITS.fileBytes || typeof p.name!=='string'||p.name.length>160||/[\x00-\x1f\\/]/.test(p.name)||typeof p.mimeType!=='string'||! /^[\w.+-]+\/[\w.+-]+$/.test(p.mimeType)||! /^[a-f0-9]{64}$/.test(String(p.sha256)))throw new StorageError('Invalid file metadata.');
    const mimeType=artifactMime(p.name,p.mimeType);
    if((f.kind==='image'||mimeType.startsWith('image/'))&&!['image/png','image/jpeg','image/webp'].includes(mimeType))throw new StorageError('Use a PNG, JPEG or WebP image.');
    const op=taskRequestId(p.operationId),hex=hash(json(['task-request-file',g.id,op])),id=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
    const file:TaskRequestFile={id,fieldId:f.id,name:p.name,size:Number(p.size),mimeType,sha256:String(p.sha256),ready:false};
    const fp=hash(json(file)),scope=`upload:${g.id}`,prior=await this.prior(scope,op,fp);
    if(!prior) {const c=this.grantCondition(g);await this.commit(scope,op,fp,`${c.sql} AND (SELECT count(*) FROM task_request_uploads WHERE owner_key=? AND request_id=?)<12 ${mimeType.startsWith('image/')?"AND (SELECT count(*) FROM task_request_uploads WHERE owner_key=? AND request_id=? AND json_extract(body,'$.mimeType') LIKE 'image/%')<6":''} AND NOT EXISTS(SELECT 1 FROM task_request_deliveries WHERE owner_key=? AND request_id=?)`,[...c.args,this.owner,r.id,...(mimeType.startsWith('image/')?[this.owner,r.id]:[]),this.owner,r.id],[this.db.prepare("INSERT INTO task_request_uploads VALUES(?,?,?,?,?,?,'pending')").bind(this.owner,r.id,g.id,id,f.id,json(file))],{file});}
    const storage=new BotStorage(this.environment,this.owner,true);await storage.initialize();
    const prepared=await storage.prepare({...file,botId:r.source.botId});await this.grantCurrent(g);
    return {file:{...file,ready:!!prepared.attachment},...('upload' in prepared?{upload:prepared.upload}:{})};
  }
  async file(g:Grant,fileId:string,finalize=false,download=false) {
    const r=await this.grantCurrent(g),u=await this.db.prepare('SELECT * FROM task_request_uploads WHERE owner_key=? AND request_id=? AND grant_id=? AND id=?').bind(this.owner,r.id,g.id,taskRequestId(fileId)).first<UploadRow>();
    if(!u)throw new StorageError('File is not part of this request.',404,'not_found');
    const storage=new BotStorage(this.environment,this.owner,true);await storage.initialize();
    if(finalize) {
      if(u.state==='ready')return {file:JSON.parse(u.body)};
      if((await this.submission(g)).submittedAt)throw new StorageError('Final submission is frozen.',409,'frozen');
      const receipt=await storage.finalize(u.id,r.source.botId);await this.grantCurrent(g);
      const old:TaskRequestFile=JSON.parse(u.body),a=receipt.attachment;
      if(a.id!==old.id||a.size!==old.size||a.sha256!==old.sha256||a.name!==old.name)throw new StorageError('File identity changed.',409,'integrity');
      const file={...old,ready:true};const c=this.grantCondition(g);
      await this.db.prepare(`UPDATE task_request_uploads SET body=?,state='ready' WHERE owner_key=? AND id=? AND ${c.sql} AND NOT EXISTS(SELECT 1 FROM task_request_deliveries WHERE owner_key=? AND request_id=?)`).bind(json(file),this.owner,u.id,...c.args,this.owner,r.id).run();
      const saved=await this.db.prepare('SELECT body,state FROM task_request_uploads WHERE owner_key=? AND id=?').bind(this.owner,u.id).first<UploadRow>();
      if(saved?.state!=='ready')throw new StorageError('File confirmation changed. Retry this same file.',409,'conflict');return {file:JSON.parse(saved.body)};
    }
    if(u.state!=='ready')throw new StorageError('File is not ready.',409,'not_ready');
    if(download) {const value=await storage.download(u.id,r.source.botId);await this.grantCurrent(g);return {file:JSON.parse(u.body),url:value.url};}
    return {file:JSON.parse(u.body)};
  }
  async secureScope(g:Grant,submissionId:string) {
    const r=await this.grantCurrent(g),s=await this.submission(g);
    if(submissionId!==s.id||!r.spec.secure)throw new StorageError('Private submission scope unavailable.',409,'scope');
    return {owner:`grant-owner:${this.sign(json(['task-request-crypto-owner-v1',this.owner,g.id]))}`,requestId:r.id,revision:r.revision,grantId:g.id,submissionId:s.id,source:r.source,spec:r.spec};
  }
  async secureAuthorize(binding:Record<string,unknown>) {
    const g=await this.db.prepare('SELECT * FROM task_request_grants WHERE id=? AND owner_key=? AND request_id=? AND revision=?').bind(taskRequestId(binding.grantId),this.owner,taskRequestId(binding.requestId),binding.revision).first<Grant>();
    if(!g)throw new StorageError('Private request scope unavailable.',403,'forbidden');
    return this.secureScope(g,taskRequestId(binding.submissionId));
  }
  async privateReceipt(p:Record<string,unknown>) {
    const scope=await this.secureAuthorize(p),handle=taskRequestId(p.handle),expiresAt=String(p.expiresAt);
    const expires=Date.parse(expiresAt);
    if(!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+3601000||typeof p.modelRead!=='boolean')throw new StorageError('Private receipt unavailable.',409,'scope');
    const receipt={handle,submissionId:scope.submissionId,expiresAt,modelRead:p.modelRead};
    const fp=hash(json([scope.requestId,scope.revision,scope.grantId,receipt])),op=`private-receipt:${hash(json([scope.requestId,handle]))}`;
    const g=await this.db.prepare('SELECT * FROM task_request_grants WHERE id=? AND owner_key=?').bind(scope.grantId,this.owner).first<Grant>();if(!g)throw new StorageError('Private grant unavailable.',409,'scope');
    const c=this.grantCondition(g);
    return this.commit(`private:${scope.grantId}`,op,fp,`${c.sql} AND NOT EXISTS(SELECT 1 FROM task_request_private_receipts WHERE owner_key=? AND request_id=?)`,[...c.args,this.owner,scope.requestId],[
      this.db.prepare('INSERT INTO task_request_private_receipts VALUES(?,?,?,?,?,?)').bind(this.owner,scope.requestId,scope.grantId,scope.submissionId,handle,json(receipt)),
    ],{receipt});
  }
  async submit(g:Grant,p:Record<string,unknown>) {
    const r=await this.grantCurrent(g),s=await this.submission(g),op=taskRequestId(p.operationId);
    if(p.submissionId!==s.id)throw new StorageError('Retain the original submission identity.',409,'scope');
    const fp=hash(json(['submit',g.id,s.id,p.expectedRevision,p.secureHandle??null]));
    const prior=await this.prior(`guest:${g.id}`,op,fp);if(prior)return prior;
    taskRequestValues(r.spec,s.values,true);
    if(s.files.length>12||s.files.filter(f=>f.mimeType.startsWith('image/')).length>6||r.spec.fields.some(f=>f.required&&['file','image'].includes(f.kind)&&!s.files.some(x=>x.fieldId===f.id&&x.ready)))throw new StorageError('Complete required file uploads.',409,'not_ready');
    if(r.spec.fields.some(f=>f.required&&f.kind.startsWith('secure-'))&&!p.secureHandle)throw new StorageError('Complete the private encrypted transfer first.',409,'private_not_ready');
    let secure:TaskRequestSubmission['secure'];
    if(p.secureHandle!==undefined) {
      if(!r.spec.secure)throw new StorageError('Unexpected private input.');taskRequestId(p.secureHandle);
      const receipt=await this.db.prepare('SELECT body FROM task_request_private_receipts WHERE owner_key=? AND request_id=? AND grant_id=? AND submission_id=? AND handle=?').bind(this.owner,r.id,g.id,s.id,p.secureHandle).first<{body:string}>();
      secure=receipt?JSON.parse(receipt.body):undefined;
      if(!secure||Date.parse(secure.expiresAt)<=Date.now())throw new StorageError('Positive private receipt unavailable. Recover the original ciphertext or re-enter after owner review.',409,'private_not_ready');
    }
    const next:TaskRequestSubmission={...s,revision:s.revision+1,status:'received',submittedAt:now(),...(secure?{secure}:{})};
    const delivery={requestId:r.id,submissionId:s.id,operationId:`task-request-delivery:${hash(json([this.owner,r.id,s.id]))}`,source:r.source,spec:r.spec,values:s.values,files:s.files,contributorName:s.contributorName,
      ...(p.secureHandle?{secureHandle:p.secureHandle,secureBinding:{requestId:r.id,revision:r.revision,grantId:g.id,submissionId:s.id}}:{}),status:'received'};
    const c=this.grantCondition(g);
    const result=await this.commit(`guest:${g.id}`,op,fp,`${c.sql} AND COALESCE((SELECT revision FROM task_request_submissions WHERE owner_key=? AND request_id=?),0)=? AND NOT EXISTS(SELECT 1 FROM task_request_deliveries WHERE owner_key=? AND request_id=?)`,[...c.args,this.owner,r.id,p.expectedRevision,this.owner,r.id],[
      this.db.prepare('INSERT INTO task_request_submissions VALUES(?,?,?,?,?) ON CONFLICT(owner_key,request_id) DO UPDATE SET revision=excluded.revision,body=excluded.body').bind(this.owner,r.id,s.id,next.revision,json(next)),
      this.db.prepare('INSERT INTO task_request_deliveries VALUES(?,?,?,?,?)').bind(this.owner,r.id,s.id,json(delivery),'received'),
    ],{request:{...await this.guest(g),submission:next}});return result;
  }
  async pending(cursor?:unknown) {
    const after=cursor===undefined?0:this.cursor(cursor);
    const r=await this.db.prepare("SELECT rowid,body FROM task_request_deliveries WHERE owner_key=? AND status IN ('received','awaiting-bot','uncertain') AND rowid>? ORDER BY rowid LIMIT 4").bind(this.owner,after).all<{rowid:number;body:string}>();
    return {deliveries:r.results.map(x=>JSON.parse(x.body)),nextCursor:r.results.length?String(r.results[r.results.length-1].rowid):null};
  }
  async delivery(id:string) {
    const d=await this.db.prepare('SELECT body FROM task_request_deliveries WHERE owner_key=? AND request_id=?').bind(this.owner,taskRequestId(id)).first<{body:string}>();
    if(!d)throw new StorageError('Submission not found.',404,'not_found');return JSON.parse(d.body);
  }
  async deliveryScope(id:string) {
    const d=await this.delivery(id),g=await this.db.prepare('SELECT revoked,expires_at FROM task_request_grants WHERE owner_key=? AND request_id=?').bind(this.owner,id).first<{revoked:number;expires_at:number}>();
    return {delivery:d,scopeActive:!!g&&!g.revoked&&g.expires_at>Date.now()};
  }
  async deliveryStatus(p:Record<string,unknown>) {
    const d=await this.delivery(taskRequestId(p.requestId));
    if(d.operationId!==p.operationId||d.submissionId!==p.submissionId||!['awaiting-bot','native-accepted','response-sent','uncertain','needs-review','private-unavailable'].includes(String(p.status)))throw new StorageError('Delivery receipt identity mismatch.',409,'scope');
    if(['native-accepted','response-sent','needs-review','private-unavailable'].includes(d.status)&&p.status!==d.status)return {delivery:d};
    const s=await this.db.prepare('SELECT body FROM task_request_submissions WHERE owner_key=? AND request_id=? AND id=?').bind(this.owner,p.requestId,p.submissionId).first<{body:string}>();
    if(!s)throw new StorageError('Original submission unavailable.',409,'scope');
    const status=String(p.status),nativeTurnId=p.nativeTurnId===undefined?undefined:taskRequestId(p.nativeTurnId),nativeQueueId=p.nativeQueueId===undefined?undefined:taskRequestId(p.nativeQueueId);
    if(d.nativeTurnId&&nativeTurnId&&d.nativeTurnId!==nativeTurnId||d.nativeQueueId&&nativeQueueId&&d.nativeQueueId!==nativeQueueId)throw new StorageError('Original native receipt changed.',409,'conflict');
    const reason=typeof p.reason==='string'?p.reason.slice(0,300):undefined;
    const receipt={operationId:d.operationId,...(nativeTurnId??d.nativeTurnId?{nativeTurnId:nativeTurnId??d.nativeTurnId}:{}),...(nativeQueueId??d.nativeQueueId?{nativeQueueId:nativeQueueId??d.nativeQueueId}:{}),...(reason?{reason}:{})};
    const next={...JSON.parse(s.body),status,delivery:receipt},body={...d,status,...receipt};
    const guard=`delivery:${d.operationId}:${crypto.randomUUID()}`;
    try {await this.db.batch([
      this.db.prepare('INSERT INTO task_request_guards SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM task_request_deliveries WHERE owner_key=? AND request_id=? AND body=?) AND EXISTS(SELECT 1 FROM task_request_submissions WHERE owner_key=? AND request_id=? AND body=?) THEN 1 ELSE 0 END').bind(guard,this.owner,p.requestId,json(d),this.owner,p.requestId,s.body),
      this.db.prepare('UPDATE task_request_submissions SET body=? WHERE owner_key=? AND request_id=? AND id=?').bind(json(next),this.owner,p.requestId,p.submissionId),
      this.db.prepare('UPDATE task_request_deliveries SET body=?,status=? WHERE owner_key=? AND request_id=? AND submission_id=?').bind(json(body),status,this.owner,p.requestId,p.submissionId),
      this.db.prepare('DELETE FROM task_request_guards WHERE id=?').bind(guard),
    ]);}catch {const current=await this.delivery(String(p.requestId));if(json(current)!==json(body))throw new StorageError('Delivery status changed or acknowledgement is unavailable; read original status.',409,'conflict_or_unknown');return {delivery:current};}
    return {delivery:body};
  }
}
