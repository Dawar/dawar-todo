import { portableHeaders } from "../../lib/portable-csrf";
import { replayableStorageFetch } from "../../lib/storage-transfer";
import { uploadStorageBlob, type StoragePostTarget } from '../../lib/storage-upload';
import type { BotAttachment, BotArtifactPage } from "../../lib/bots-types";
import { CloudTransferDeadline, cloudRetryDelay, CLOUD_METADATA_DEADLINE_MS, CLOUD_UPLOAD_DEADLINE_MS, CLOUD_DOWNLOAD_IDLE_MS, CLOUD_DOWNLOAD_DEADLINE_MS } from "./cloud-transfer-deadline";

export class CloudStorageError extends Error { constructor(message: string,public code: string,public status: number) { super(message); } }
type Receipt = BotAttachment & {sha256:string;cloudState:"ready"};
type SignedDownload = {attachment:Receipt;url:string;expiresAt:string};
type Preparation = {attachment?:Receipt;upload?:StoragePostTarget};
type CheckOwner = () => string;
const requestTimeout = (action: string) => new CloudStorageError(
  action === "finalize" || action === "copy"
    ? "Cloud transfer confirmation timed out. Your files are retained; retry to check the original transfer."
    : "Cloud request timed out. Your draft and files are retained; retry when ready.",
  "transfer_timeout", 0);
const downloadTimeout = () => new CloudStorageError("Cloud download stalled or exceeded its time limit. Retry to download the complete file.", "transfer_timeout", 0);

// Do not await cancellation: a stalled cancel handler must not hold recovery.
function cancelBody(body: ReadableStream<Uint8Array> | null) { void body?.cancel().catch(() => {}); }
function releaseReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  void reader.cancel().catch(() => {});
  reader.releaseLock();
}
async function cloudJson(response: Response, deadline: CloudTransferDeadline) {
  if (!response.body) return null;
  const reader = response.body.getReader(), decoder = new TextDecoder(), parts: string[] = [];
  try {
    for (;;) {
      const next = await deadline.run(() => reader.read());
      if (next.done) break;
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join("")) as Record<string, unknown> | null;
  } finally { releaseReader(reader); }
}
export async function cloudRequest<T>(owner:string,currentOwner:CheckOwner,action:string,input:Record<string,unknown>={},signal?:AbortSignal):Promise<T> {
  if (!owner || currentOwner() !== owner) throw new Error("The account changed. Your draft is retained.");
  const body = JSON.stringify({...input,action});
  for (let attempt=0;attempt<3;attempt++) {
    signal?.throwIfAborted();
    if (currentOwner() !== owner) throw Error("The account changed. Your draft is retained.");
    const deadline = new CloudTransferDeadline(CLOUD_METADATA_DEADLINE_MS, () => requestTimeout(action), signal);
    let response: Response | undefined;
    try {
      try { response = await deadline.run(() => fetch("/api/bots/storage", { method:"POST", headers:portableHeaders({"Content-Type":"application/json"}), body, credentials:"same-origin", cache:"no-store", signal:deadline.signal })); }
      catch (error) { deadline.signal.throwIfAborted(); if (attempt === 2) throw error; }
      if (response && (attempt === 2 || ![429,500,502,503,504].includes(response.status))) {
        let result: Record<string, unknown> | null;
        try { result = await cloudJson(response, deadline); }
        catch { deadline.signal.throwIfAborted(); result = null; }
        deadline.signal.throwIfAborted();
        if (!response.ok) throw new CloudStorageError(String(result?.error ?? "Cloud transfer failed. Your local draft and files are retained."), String(result?.code ?? "unavailable"), response.status);
        if (result?.owner !== owner || currentOwner() !== owner) throw new Error("The account changed. Your draft is retained.");
        return result as T;
      }
      cancelBody(response?.body ?? null);
      await cloudRetryDelay(deadline.signal, 200 * (attempt + 1));
    } finally { if (response && !response.bodyUsed) cancelBody(response.body); deadline.dispose(); }
  }
  throw Error("Cloud storage is temporarily unavailable. Try again.");
}
const statuses = new Map<string,{expires:number;value:{enabled:boolean;catalogReady:boolean;portableCopy?:boolean}}>();
export async function cloudStatus(owner:string,current:CheckOwner) {
  const cached=statuses.get(owner); if (cached && cached.expires>Date.now() && current()===owner) return cached.value;
  let value;
  try { value = await cloudRequest<{enabled:boolean;catalogReady:boolean;portableCopy?:boolean}>(owner,current,"status"); }
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
    const deadline = new CloudTransferDeadline(CLOUD_UPLOAD_DEADLINE_MS,
      () => new CloudStorageError("Cloud upload timed out. Your draft and file bytes are retained; retry this upload.", "transfer_timeout", 0));
    let response: Response;
    try { response = await deadline.run(() => uploadStorageBlob(fetch, prepared.upload!, file,{name:file.name,sha256,signal:deadline.signal,validate:()=>{if(current()!==owner)throw Error('The account changed. Your draft is retained.');},progress,legacyReplay:true})); }
    finally { deadline.dispose(); }
    cancelBody(response.body);
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
  const deadline = new CloudTransferDeadline(CLOUD_DOWNLOAD_DEADLINE_MS, downloadTimeout, signal, CLOUD_DOWNLOAD_IDLE_MS);
  try {
  for (let attempt=0;attempt<2;attempt++) {
    deadline.signal.throwIfAborted();
    const result=await cloudRequest<SignedDownload>(owner,current,preview?"preview":"download",{botId,id},deadline.signal);
    if (result.attachment.botId!==botId || (!preview && result.attachment.id!==id)) throw new Error("Cloud download identity mismatch.");
    if (!Number.isSafeInteger(result.attachment.size) || result.attachment.size<0 || result.attachment.size>(preview?128*1024:100*1024*1024) || !/^[a-f0-9]{64}$/.test(result.attachment.sha256)) throw new Error("Invalid cloud file metadata.");
    deadline.progress();
    const response=await deadline.run(() => replayableStorageFetch(fetch,result.url,{signal:deadline.signal,redirect:"error"}));
    if (response.status===403 && attempt===0) { cancelBody(response.body); continue; }
    if (!response.ok) { cancelBody(response.body); throw new Error("Cloud download failed. Please retry."); }
    if (!response.body) throw new Error("Cloud download returned no bytes.");
    const reader=response.body.getReader(),parts:Uint8Array[]=[]; let size=0;
    try { for (;;) { const next=await deadline.run(() => reader.read()); if(next.done) break; size+=next.value.length; if(size>result.attachment.size) throw new Error("Cloud download size mismatch."); if (next.value.length) deadline.progress(); parts.push(next.value); } }
    finally { releaseReader(reader); }
    const blob=new Blob(parts as BlobPart[]);
    if (blob.size!==result.attachment.size || await deadline.run(() => fileSha256(blob))!==result.attachment.sha256) throw new Error("Cloud download checksum mismatch.");
    deadline.signal.throwIfAborted();
    if (current()!==owner) throw new Error("The account changed.");
    return {blob:new Blob([blob],{type:result.attachment.mimeType}),name:result.attachment.name};
  }
  throw new Error("Download URL expired. Please retry.");
  } finally { deadline.dispose(); }
}
export function cloudList(owner:string,current:CheckOwner,query:Record<string,unknown>) { return cloudRequest<BotArtifactPage>(owner,current,"list",query); }
