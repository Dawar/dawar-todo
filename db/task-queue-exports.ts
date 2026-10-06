import { createHash, randomUUID } from "node:crypto";
import { BotStorage, StorageError, type BotStorageEnv } from "./bot-storage";
import type { AttachmentRow } from "./attachments";
import type { TaskQueueExportInput, TaskQueueExportReceipt, TaskQueueExportResolution, TaskQueueSource } from "../lib/task-queue-export";

type Environment = BotStorageEnv & { BOTS_OWNER_EMAIL?:string };
type Row = { id:string; operation_id:string; fingerprint:string; bot_id:string; todo_id:number; source_revision:string;
  snapshot:string; originals:string; receipt:string|null; state:string; created_at:string; lease_token:string|null; lease_until:number };
type Task = { id:number; title:string; notes:string; updated_at:string; [key:string]:unknown };
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const initialized=new WeakMap<D1Database,Promise<unknown>>();
export const TASK_QUEUE_EXPORT_SCHEMA = `CREATE TABLE IF NOT EXISTS todo_bot_exports (
  owner_key TEXT NOT NULL, id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  bot_id TEXT NOT NULL, todo_id INTEGER NOT NULL, source_revision TEXT NOT NULL, snapshot TEXT NOT NULL,
  originals TEXT NOT NULL, receipt TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL,
  lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_key,id))`;
const EXPORT_OPERATION_INDEX="CREATE UNIQUE INDEX IF NOT EXISTS todo_bot_export_operation ON todo_bot_exports(owner_key,operation_id)";
export function ensureTaskQueueExports(db:D1Database) {
  let task=initialized.get(db);
  if(!task) { task=db.batch([db.prepare(TASK_QUEUE_EXPORT_SCHEMA),db.prepare(EXPORT_OPERATION_INDEX)]).catch(error=>{initialized.delete(db);throw error;}); initialized.set(db,task); }
  return task;
}
const validId=(value:unknown)=>typeof value==='string' && /^[\w:.-]{1,200}$/.test(value);
function destinationFileId(exportId:string,sourceId:string) {
  const hex=hash(JSON.stringify([exportId,sourceId]));
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
/** Existing tasks are a single-owner catalog (no per-task user column). Enforce that configured owner, never guest/token auth. */
export class TaskQueueExports {
  constructor(private environment:Environment, private owner:string) {
    if(!owner || owner!==environment.BOTS_OWNER_EMAIL?.trim().toLowerCase()) throw new StorageError("Task export requires the configured owner.",403,"forbidden");
  }
  async initialize() { await ensureTaskQueueExports(this.environment.DB); }
  private async bot(botId:string) {
    if(!validId(botId)) throw new StorageError("Invalid destination bot.");
    const row=await this.environment.DB.prepare("SELECT metadata FROM bot_storage_identities WHERE owner_key=? AND id=? AND machine_id=?")
      .bind(this.owner,botId,this.environment.BOTS_MACHINE_ID ?? 'dawar-vm').first<{metadata:string}>();
    if(!row || JSON.parse(row.metadata).archived || JSON.parse(row.metadata).deleted) throw new StorageError("Destination bot is unavailable.",404,"not_found");
  }
  private async capture(todoId:number) {
    if(!Number.isSafeInteger(todoId) || todoId<1) throw new StorageError("Invalid source task.");
    // One transactional read includes pending originals; never silently drop them from an export.
    const result=await this.environment.DB.batch([
      this.environment.DB.prepare("SELECT * FROM todos WHERE id=?").bind(todoId),
      this.environment.DB.prepare("SELECT * FROM todo_attachments WHERE todo_id=? AND deleted_at IS NULL ORDER BY sort_order,id LIMIT 13").bind(todoId),
    ]);
    const task=result[0].results[0] as Task|undefined, originals=result[1].results as AttachmentRow[];
    if(!task) throw new StorageError("Source task is unavailable.",404,"not_found");
    if(originals.length>12 || task.title.length+task.notes.length>190000) throw new StorageError("This task exceeds normal bot message/file limits. Retain it and reduce the selection.",413,"limit");
    if(originals.some(a=>a.upload_state!=='ready')) throw new StorageError("Wait for every task file to finish uploading before queueing.",409,"source_not_ready");
    if(originals.some(a=>!a.original_key || !Number.isSafeInteger(a.byte_size) || a.byte_size<1 || a.byte_size>100*1024*1024))
      throw new StorageError("A task file exceeds normal bot file limits or is unavailable. Original files are retained.",413,"limit");
    // Avoid new delegation-only columns invalidating the original snapshot after confirmed queue acceptance.
    const fields=['id','title','notes','updated_at','status','priority','due_date','project','context','source_kind','source_id','client_id','completed_at','snoozed_until','recurrence_cron','recurrence_last_fired_at','pinned','sort_order','created_at'];
    const revision=hash(JSON.stringify([fields.map(k=>[k,task[k]??null]),originals]));
    const source:TaskQueueSource={todoId,revision,updatedAt:task.updated_at,title:task.title,notes:task.notes,
      files:originals.map(a=>({id:a.id,name:a.file_name,size:a.byte_size,mimeType:a.mime_type,updatedAt:a.updated_at,sortOrder:a.sort_order}))};
    return {source,originals};
  }
  async source(todoId:number,botId:string) { await this.bot(botId); return (await this.capture(todoId)).source; }
  private async current(row:Row) {
    const current=await this.capture(row.todo_id);
    return current.source.revision===row.source_revision;
  }
  async prepare(todoId:number,input:TaskQueueExportInput,caller?:AbortSignal):Promise<TaskQueueExportReceipt> {
    if(!validId(input.operationId) || !/^[a-f0-9]{64}$/.test(input.sourceRevision ?? '')) throw new StorageError("Invalid original task export operation or source revision.");
    await this.bot(input.botId); await this.initialize();
    const id=`task-export:${hash(JSON.stringify([this.owner,input.operationId]))}`;
    const fingerprint=hash(JSON.stringify([todoId,input.botId,input.sourceRevision]));
    const captured=await this.capture(todoId);
    if(captured.source.revision!==input.sourceRevision) throw new StorageError("Task changed. Save/reload the current task before preparing a new transfer; retain any uncertain operation.",409,"source_changed");
    await this.environment.DB.prepare("INSERT OR IGNORE INTO todo_bot_exports(owner_key,id,operation_id,fingerprint,bot_id,todo_id,source_revision,snapshot,originals,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'pending',?)")
      .bind(this.owner,id,input.operationId,fingerprint,input.botId,todoId,input.sourceRevision,JSON.stringify(captured.source),JSON.stringify(captured.originals),new Date().toISOString()).run();
    const read=()=>this.environment.DB.prepare("SELECT * FROM todo_bot_exports WHERE owner_key=? AND id=?").bind(this.owner,id).first<Row>();
    let row=(await read())!;
    if(row.fingerprint!==fingerprint) throw new StorageError("Original export operation describes a different task, version or bot. Reconcile it instead of replacing it.",409,"conflict");
    if(row.state==='ready') return JSON.parse(row.receipt!);
    const token=randomUUID(), until=Date.now()+10*60*1000;
    await this.environment.DB.prepare("UPDATE todo_bot_exports SET lease_token=?,lease_until=? WHERE owner_key=? AND id=? AND state='pending' AND lease_until<=?")
      .bind(token,until,this.owner,id,Date.now()).run();
    row=(await read())!;
    if(row.state==='ready') return JSON.parse(row.receipt!);
    if(row.lease_token!==token) throw new StorageError("This original export is still preparing. Retry the same operation after it settles; do not queue a replacement.",409,"export_pending");
    const signal=caller ? AbortSignal.any([caller,AbortSignal.timeout(10*60*1000)]) : AbortSignal.timeout(10*60*1000);
    try {
      signal.throwIfAborted();
      const storage=new BotStorage(this.environment,this.owner,true); await storage.initialize();
      const source:TaskQueueSource=JSON.parse(row.snapshot), originals:AttachmentRow[]=JSON.parse(row.originals);
      const files:TaskQueueExportReceipt['files']=[];
      for(const a of originals) {
        signal.throwIfAborted();
        const attachment=await storage.importTaskOriginal({id:destinationFileId(id,a.id),botId:row.bot_id,name:a.file_name,size:a.byte_size,mimeType:a.mime_type,
          exportId:id,todoId,sourceRevision:row.source_revision,sourceAttachmentId:a.id,sourceKey:a.original_key},signal);
        files.push({sourceAttachmentId:a.id,attachmentId:attachment.id,name:attachment.name,size:attachment.size,mimeType:attachment.mimeType,sha256:attachment.sha256});
      }
      await this.bot(row.bot_id);
      if(!await this.current(row)) throw new StorageError("Source task changed during export. Copies are retained; reconcile the original transfer before queueing.",409,"source_changed");
      const receipt:TaskQueueExportReceipt={version:1,taskExportId:id,operationId:row.operation_id,botId:row.bot_id,source,files,state:'ready',createdAt:row.created_at,readyAt:new Date().toISOString()};
      signal.throwIfAborted();
      await this.environment.DB.prepare("UPDATE todo_bot_exports SET state='ready',receipt=?,lease_token=NULL,lease_until=0 WHERE owner_key=? AND id=? AND lease_token=?")
        .bind(JSON.stringify(receipt),this.owner,id,token).run();
      const saved=(await read())!;
      if(saved.state!=='ready') throw new StorageError("Export confirmation is uncertain. Retry the same original operation.",502,"uncertain");
      return JSON.parse(saved.receipt!);
    } finally {
      await this.environment.DB.prepare("UPDATE todo_bot_exports SET lease_token=NULL,lease_until=0 WHERE owner_key=? AND id=? AND lease_token=? AND state='pending'")
        .bind(this.owner,id,token).run().catch(()=>{});
    }
  }
  /** Private service resolves immutable identity/content; Cody checks current=true before NEW acceptance. */
  async resolve(taskExportId:string,botId:string):Promise<TaskQueueExportResolution> {
    await this.bot(botId); await this.initialize();
    if(!validId(taskExportId)) throw new StorageError("Invalid task export receipt.");
    const row=await this.environment.DB.prepare("SELECT * FROM todo_bot_exports WHERE owner_key=? AND id=? AND bot_id=?").bind(this.owner,taskExportId,botId).first<Row>();
    if(!row) throw new StorageError("Task export not found for this bot.",404,"not_found");
    if(row.state!=='ready' || !row.receipt) throw new StorageError("Task export is not confirmed. Retry the original owner export operation.",409,"not_ready");
    const receipt:TaskQueueExportReceipt=JSON.parse(row.receipt);
    for(const file of receipt.files) {
      const registered=await this.environment.DB.prepare("SELECT metadata,state FROM bot_storage_files WHERE owner_key=? AND id=? AND bot_id=?")
        .bind(this.owner,file.attachmentId,botId).first<{metadata:string;state:string}>();
      const metadata=registered ? JSON.parse(registered.metadata) : null;
      if(registered?.state!=='ready' || metadata?.sha256!==file.sha256 || metadata?.size!==file.size
        || metadata?.taskSource?.exportId!==row.id || metadata?.taskSource?.attachmentId!==file.sourceAttachmentId)
        throw new StorageError("Exported file registration is unavailable or changed. Retain the original receipt.",409,"integrity");
    }
    return {receipt,sourceCurrent:await this.current(row)};
  }
}
