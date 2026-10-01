import type { BotAttachment, BotArtifactPage } from "../../lib/bots-types";

export class CloudStorageError extends Error { constructor(message: string,public code: string,public status: number) { super(message); } }
type Receipt = BotAttachment & {sha256:string;cloudState:"ready"};
type SignedDownload = {attachment:Receipt;url:string;expiresAt:string};
type Preparation = {attachment?:Receipt;upload?:{url:string;fields:Record<string,string>}};
type CheckOwner = () => string;
export async function cloudRequest<T>(owner:string,currentOwner:CheckOwner,action:string,input:Record<string,unknown>={},signal?:AbortSignal):Promise<T> {
  if (!owner || currentOwner() !== owner) throw new Error("The account changed. Your draft is retained.");
  const response = await fetch("/api/bots/storage",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...input,action}),credentials:"same-origin",cache:"no-store",signal});
  const result = await response.json().catch(() => null) as Record<string,unknown> | null;
  if (!response.ok) throw new CloudStorageError(String(result?.error ?? "Cloud transfer failed. Your local draft and files are retained."),String(result?.code ?? "unavailable"),response.status);
  if (result?.owner !== owner || currentOwner() !== owner) throw new Error("The account changed. Your draft is retained.");
  return result as T;
}
const statuses = new Map<string,{expires:number;value:{enabled:boolean;catalogReady:boolean}}>();
export async function cloudStatus(owner:string,current:CheckOwner) {
  const cached=statuses.get(owner); if (cached && cached.expires>Date.now() && current()===owner) return cached.value;
  let value;
  try { value = await cloudRequest<{enabled:boolean;catalogReady:boolean}>(owner,current,"status"); }
  catch (error) { if (!(error instanceof CloudStorageError) || error.status !== 404) throw error; value={enabled:false,catalogReady:false}; }
  statuses.set(owner,{expires:Date.now()+5000,value}); return value;
}
export async function fileSha256(file:Blob) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",await file.arrayBuffer()))].map(n=>n.toString(16).padStart(2,"0")).join("");
}
export async function cloudUpload(owner:string,current:CheckOwner,botId:string,file:File,id:string,progress:(n:number)=>void) {
  const sha256=await fileSha256(file), metadata={id,botId,name:file.name,size:file.size,mimeType:file.type||"application/octet-stream",sha256};
  for (let attempt=0;attempt<2;attempt++) {
    const prepared = await cloudRequest<Preparation>(owner,current,"prepare",metadata);
    if (prepared.attachment) { validateReceipt(prepared.attachment,metadata); progress(100); return prepared.attachment; }
    if (!prepared.upload) throw new Error("Cloud upload preparation is incomplete. Your files are retained.");
    const body=new FormData(); for (const [key,value] of Object.entries(prepared.upload.fields)) body.set(key,value); body.set("file",file,file.name);
    const response=await fetch(prepared.upload.url,{method:"POST",body,redirect:"error",signal:AbortSignal.timeout(120000)});
    if (current()!==owner) throw new Error("The account changed. Your draft is retained.");
    if (response.status===403 && attempt===0) continue; // Fresh URL, original ID.
    if (!response.ok) throw new Error("Cloud upload failed. Your draft and file bytes are retained; retry this upload.");
    progress(95);
    const result=await cloudRequest<{attachment:Receipt}>(owner,current,"finalize",{id,botId});
    validateReceipt(result.attachment,metadata); progress(100); return result.attachment;
  }
  throw new Error("Upload URL expired. Retry this upload; your files are retained.");
}
function validateReceipt(receipt:Receipt,expected:{id:string;botId:string;size:number;sha256:string}) {
  if (!receipt || receipt.id!==expected.id || receipt.botId!==expected.botId || receipt.size!==expected.size || receipt.sha256!==expected.sha256 || receipt.cloudState!=="ready" || !receipt.ready) throw new Error("Cloud receipt does not match the retained attachment.");
}
export async function cloudDownload(owner:string,current:CheckOwner,botId:string,id:string,signal?:AbortSignal,preview=false) {
  for (let attempt=0;attempt<2;attempt++) {
    signal?.throwIfAborted();
    const result=await cloudRequest<SignedDownload>(owner,current,preview?"preview":"download",{botId,id},signal);
    if (result.attachment.botId!==botId || (!preview && result.attachment.id!==id)) throw new Error("Cloud download identity mismatch.");
    if (!Number.isSafeInteger(result.attachment.size) || result.attachment.size<0 || result.attachment.size>(preview?128*1024:100*1024*1024) || !/^[a-f0-9]{64}$/.test(result.attachment.sha256)) throw new Error("Invalid cloud file metadata.");
    const response=await fetch(result.url,{signal,redirect:"error"});
    if (response.status===403 && attempt===0) continue;
    if (!response.ok) throw new Error("Cloud download failed. Please retry.");
    if (!response.body) throw new Error("Cloud download returned no bytes.");
    const reader=response.body.getReader(),parts:Uint8Array[]=[]; let size=0;
    try { for (;;) { const next=await reader.read(); if(next.done) break; size+=next.value.length; if(size>result.attachment.size) throw new Error("Cloud download size mismatch."); parts.push(next.value); } }
    finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
    const blob=new Blob(parts as BlobPart[]);
    if (blob.size!==result.attachment.size || await fileSha256(blob)!==result.attachment.sha256) throw new Error("Cloud download checksum mismatch.");
    if (current()!==owner) throw new Error("The account changed.");
    return {blob:new Blob([blob],{type:result.attachment.mimeType}),name:result.attachment.name};
  }
  throw new Error("Download URL expired. Please retry.");
}
export function cloudList(owner:string,current:CheckOwner,query:Record<string,unknown>) { return cloudRequest<BotArtifactPage>(owner,current,"list",query); }
