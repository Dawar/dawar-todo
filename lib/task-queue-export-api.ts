import { botsOwner } from "./bots-auth";
import { ensureBotStorage, StorageError, type BotStorageEnv } from "../db/bot-storage";
import { TaskQueueExports } from "../db/task-queue-exports";
import type { TaskQueueExportInput } from "./task-queue-export";

type Environment=BotStorageEnv & Cloudflare.Env;
export async function taskQueueExportResponse(request:Request,environment:Environment,todoId:number) {
  const headers={'Cache-Control':'no-store'};
  try {
    let owner:string;
    try { owner=botsOwner(request,environment); }
    catch { throw new StorageError("Task export requires the owner's signed-in session.",401,"unauthorized"); }
    if(!['GET','POST'].includes(request.method)) throw new StorageError("Use GET to inspect and POST to prepare the original export.",405);
    await ensureBotStorage(environment.DB);
    const exports=new TaskQueueExports(environment,owner);
    if(request.method==='GET') {
      const botId=new URL(request.url).searchParams.get('botId') ?? '';
      return Response.json({source:await exports.source(todoId,botId),taskQueueExports:1},{headers});
    }
    const reader=request.body?.getReader(); if(!reader) throw new StorageError("Missing task export intent.");
    const timeout=new AbortController();
    const timer=setTimeout(()=>timeout.abort(new StorageError("Task export intent timed out. Retain and retry the original operation.",408,"request_timeout")),60000);
    const signal=AbortSignal.any([request.signal,timeout.signal]);
    const chunks:Uint8Array[]=[];let size=0;
    try { for(;;) { signal.throwIfAborted();
      let aborted:()=>void=()=>{};
      const next=await Promise.race([reader.read(),new Promise<ReadableStreamReadResult<Uint8Array>>((_,reject)=>{
        aborted=()=>reject(signal.reason); signal.addEventListener('abort',aborted,{once:true});
      })]).finally(()=>signal.removeEventListener('abort',aborted));
      if(next.done) break;size+=next.value.length;
      if(size>16384) throw new StorageError("Task export intent is too large.",413);chunks.push(next.value); } }
    finally { clearTimeout(timer);void reader.cancel().catch(()=>{});reader.releaseLock(); }
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    let input:TaskQueueExportInput;
    try {input=JSON.parse(new TextDecoder().decode(bytes));if(!input || typeof input!=='object' || Array.isArray(input)) throw Error();}
    catch {throw new StorageError("Invalid task export intent.");}
    const receipt=await exports.prepare(todoId,input,request.signal);
    return Response.json({receipt},{headers});
  } catch(error) {
    const known=error instanceof StorageError;
    // No keys, signed targets or provider payloads in browser errors/logs.
    return Response.json({error:known ? error.message : "Task export confirmation is unavailable. Retain the original operation and retry to reconcile it.",code:known ? error.code : 'uncertain'},
      {status:known ? error.status : 502,headers});
  }
}
