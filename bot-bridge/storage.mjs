import { replayableStorageFetch } from "../lib/storage-transfer.ts";
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, link, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { containedPath,containedHandle } from './profiles.mjs';
import { readArtifactPreview } from './artifact-previews.mjs';
import { artifactMime } from '../lib/bot-file-metadata.mjs';

export const DOWNLOAD_ATTACHMENT_TOOL = {
  name: 'bots_download_attachment',
  description: 'Download an attachment registered to this bot (including an explicit peer share), verify its size and SHA-256, and return its local path, name, size and mimeType. Use attachmentId, never a bucket key. Retry the same ID after a transfer failure; existing local files are retained.',
  inputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } }, required: ['attachmentId'], additionalProperties: false },
};
const fingerprint = a => JSON.stringify([a.id,a.botId,a.name,a.size,artifactMime(a.name,a.mimeType),a.sha256]);
export async function localFileDigest(bot, path, expectedSize) {
  await containedPath(bot.cwd,path);
  const file = await open(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await containedHandle(bot.cwd,path,file);
    const before = await file.stat();
    if (!before.isFile() || before.size !== expectedSize) throw new Error('Registered file changed; the original record was retained.');
    const hash = createHash('sha256'), buffer = Buffer.alloc(256*1024); let size=0;
    for (;;) { const {bytesRead} = await file.read(buffer,0,buffer.length,size); if (!bytesRead) break; size += bytesRead; if (size > expectedSize) throw new Error('Registered file grew during verification.'); hash.update(buffer.subarray(0,bytesRead)); }
    const after = await file.stat();
    await containedHandle(bot.cwd,path,file);
    if (size !== expectedSize || before.mtimeMs !== after.mtimeMs || after.size !== before.size) throw new Error('Registered file changed during verification.');
    return hash.digest('hex');
  } finally { await file.close(); }
}
export class BotStorageClient {
  constructor(runtime,{ url,credential,machineId='dawar-vm',fetch: transport=globalThis.fetch }) {
    this.runtime = runtime; this.fetch = transport; this.endpoint = new URL('/api/bots/storage/service',url);
    if (this.endpoint.protocol !== 'https:' && !['localhost','127.0.0.1'].includes(this.endpoint.hostname)) throw new Error('Storage service requires TLS.');
    this.headers = { 'Content-Type':'application/json', Authorization:`Bearer ${credential}`, 'X-Bots-Machine':machineId };
    this.previewTail = Promise.resolve(); this.previews = new Set();
  }
  async call(action,input={}) {
    let response;
    try { response = await replayableStorageFetch(this.fetch,this.endpoint,{ method:'POST',headers:this.headers,body:JSON.stringify({ ...input,action }),signal:AbortSignal.timeout(120000),redirect:'error' }); }
    catch { throw new Error('Cloud storage acknowledgement unavailable. Retry the same attachment ID; local bytes are retained.'); }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw Object.assign(new Error(result?.error ?? 'Cloud storage request failed. Local files are retained.'),{storageCode:result?.code});
    return result;
  }
  async registerBots() {
    return this.call('registerBots',{bots:this.runtime.store.bots({ includeDeleted:true }).map(({id,name,color,archived,deletedAt}) => ({id,name,color,archived:Boolean(archived),deleted:Boolean(deletedAt)}))});
  }
  /** Read-only typed receipt for Cody's queue admission; never accepts client snapshot text or bucket keys. */
  async resolveTaskExport(bot,taskExportId) {
    if(!bot || bot.archived || bot.deletedAt || typeof taskExportId!=='string' || !/^task-export:[a-f0-9]{64}$/.test(taskExportId)) throw new Error('Invalid task export scope.');
    const result=await this.call('taskQueueExport',{taskExportId,botId:bot.id});
    const r=result.receipt;
    if(r?.version!==1 || r.taskExportId!==taskExportId || r.botId!==bot.id || r.state!=='ready' || typeof result.sourceCurrent!=='boolean'
      || typeof r.operationId!=='string' || !Number.isSafeInteger(r.source?.todoId) || r.source.todoId<1
      || !/^[a-f0-9]{64}$/.test(r.source.revision) || typeof r.source.title!=='string' || typeof r.source.notes!=='string'
      || r.source.title.length+r.source.notes.length>190000 || !Array.isArray(r.source.files) || !Array.isArray(r.files)
      || r.files.length>12 || r.files.length!==r.source.files.length || new Set(r.files.map(f=>f.attachmentId)).size!==r.files.length
      || r.files.some((f,i)=>f.sourceAttachmentId!==r.source.files[i].id || f.size!==r.source.files[i].size || typeof f.attachmentId!=='string'
        || !/^[a-f0-9-]{36}$/i.test(f.attachmentId) || !Number.isSafeInteger(f.size) || f.size<1 || f.size>100*1024*1024
        || !/^[a-f0-9]{64}$/.test(f.sha256) || typeof f.name!=='string' || typeof f.mimeType!=='string'))
      throw new Error('Task export receipt identity mismatch. Retain the original operation.');
    return {receipt:r,sourceCurrent:result.sourceCurrent};
  }
  saveTransfer(a,fields) {
    const current=this.runtime.owned('attachment',a.id,a.botId);
    if (current.path!==a.path || current.size!==a.size || current.sha256 && a.sha256 && current.sha256!==a.sha256) throw new Error('Attachment registration changed during transfer. Original record retained.');
    return this.runtime.store.put('attachment',{...current,...fields});
  }
  async enrich(a) {
    if(a.cloudState!=='ready') return Promise.resolve();
    this.runtime.store.put('storageMetadata',{id:a.id,botId:a.botId});
    return this.runtime.lock(`storage-publish:${a.id}`,async()=>{
      const current=this.runtime.owned('attachment',a.id,a.botId);
      const result=await this.call('prepare',current);
      if(!result.attachment || fingerprint(result.attachment)!==fingerprint(current)) throw new Error('Cloud metadata receipt mismatch.');
      this.runtime.store.remove('storageMetadata',a.id);
    });
  }
  async recoverMetadata() {
    await this.registerBots();
    for(const pending of this.runtime.store.list('storageMetadata')) {
      const a=this.runtime.store.get('attachment',pending.id);
      if(a?.ready && a.cloudState==='ready') await this.enrich(a).catch(()=>{});
    }
  }
  async publish(bot,attachment) {
    return this.runtime.lock(`storage-publish:${attachment.id}`,async () => {
      let a = this.runtime.owned('attachment',attachment.id,bot.id);
      try {
        const sha256 = await localFileDigest(bot,a.path,a.size);
        if (a.sha256 && a.sha256 !== sha256) throw new Error('Registered file checksum changed. Original metadata and source retained.');
        a = this.saveTransfer(a,{sha256,cloudState:'pending'});
        await this.registerBots();
        const prepared = await this.call('prepare',a);
        if (!prepared.attachment) {
          a = this.saveTransfer(a,{cloudState:'transferring'});
          // The copied publication snapshot is private and bounded at 100 MB.
          // Hash/open through the FD; never upload a swapped symlink/path.
          const file = await open(a.path,constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await containedHandle(bot.cwd,a.path,file);
            const bytes = await file.readFile();
            await containedHandle(bot.cwd,a.path,file);
            if (bytes.length !== a.size || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Publication snapshot changed.');
            const body = new FormData(); for (const [key,value] of Object.entries(prepared.upload.fields)) body.set(key,value);
            body.set('file',new Blob([bytes],{type:a.mimeType}),a.name);
            const uploaded = await replayableStorageFetch(this.fetch,prepared.upload.url,{ method:'POST',body,signal:AbortSignal.timeout(120000),redirect:'error' });
            if (!uploaded.ok) throw new Error('Cloud upload failed. Retry the same publication; its local snapshot is retained.');
          } finally { await file.close(); }
        }
        const receipt = prepared.attachment ? prepared : await this.call('finalize',{id:a.id,botId:bot.id});
        if (fingerprint(receipt.attachment) !== fingerprint(a) || receipt.attachment.cloudState !== 'ready') throw new Error('Cloud publication receipt does not match the retained file.');
        a = this.saveTransfer(a,{cloudState:'ready',cloudError:null});
        // Persist asynchronous catalog enrichment without changing publication
        // certainty. It can be retried at startup after a lost metadata ACK.
        queueMicrotask(()=>{void this.enrich(a).catch(()=>{});});
        this.mirrorPreview(bot,a); return a;
      } catch (error) {
        this.saveTransfer(a,{cloudState:'failed',cloudError:String(error.message)});
        this.runtime.emitEvent('attachment',this.runtime.publicAttachment(this.runtime.store.get('attachment',a.id)),bot.id);
        throw error;
      }
    });
  }
  async importAttachment(bot,id) {
    const {attachment} = await this.call('download',{id,botId:bot.id});
    if (attachment.botId !== bot.id || attachment.id !== id || !attachment.ready || attachment.cloudState !== 'ready' || !/^[a-f0-9]{64}$/.test(attachment.sha256)) throw new Error('Invalid cloud attachment receipt.');
    const previous = this.runtime.store.get('attachment',id);
    if (previous && (previous.botId !== bot.id || previous.size !== attachment.size || previous.name !== attachment.name || previous.sha256 && previous.sha256 !== attachment.sha256)) throw new Error('Attachment identity conflict. Original local metadata retained.');
    const root = join(bot.cwd,'uploads',createHash('sha256').update(id).digest('hex'));
    const path = previous?.path ?? join(root,basename(attachment.name));
    const a = this.runtime.store.put('attachment',{...attachment,...previous,ready:true,sha256:attachment.sha256,cloudState:'ready',path,received:previous?.received ?? 0});
    const local=await this.ensureLocal(bot,a); this.mirrorPreview(bot,local);
    return this.runtime.publicAttachment(this.runtime.owned('attachment',id,bot.id));
  }
  async ensureLocal(bot,attachment) {
    return this.runtime.lock(`storage-local:${attachment.id}`,async () => {
      let a = this.runtime.owned('attachment',attachment.id,bot.id);
      if (!a.ready || a.size < 0 || a.size > 100*1024*1024) throw new Error('Attachment is not ready.');
      try {
        const actual = await localFileDigest(bot,a.path,a.size);
        if (a.sha256 && actual !== a.sha256) throw new Error('Local checksum mismatch; existing file retained.');
        if (!a.sha256) a = this.runtime.store.put('attachment',{...a,sha256:actual});
        return a;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const {attachment:receipt,url} = await this.call('download',{id:a.id,botId:bot.id});
      if (fingerprint(a) !== fingerprint(receipt) || !a.sha256) throw new Error('Download receipt identity mismatch.');
      const root = join(bot.cwd,'uploads',createHash('sha256').update(a.id).digest('hex'));
      await mkdir(root,{recursive:true,mode:0o700}); await containedPath(bot.cwd,root);
      const path = a.path ?? join(root,basename(a.name));
      // Existing legacy paths can be restored without replacing any file.
      const parent = path.slice(0,path.lastIndexOf('/')); await mkdir(parent,{recursive:true,mode:0o700}); await containedPath(bot.cwd,parent);
      const temporary = join(parent,`.download-${randomUUID()}`); let file;
      try {
        file = await open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
        await containedHandle(bot.cwd,temporary,file);
        let response = await replayableStorageFetch(this.fetch,url,{signal:AbortSignal.timeout(120000),redirect:'error'});
        if (response.status === 403) {
          await response.body?.cancel().catch(()=>{});
          const fresh=await this.call('download',{id:a.id,botId:bot.id});
          if (fingerprint(a)!==fingerprint(fresh.attachment)) throw new Error('Refreshed download identity mismatch.');
          response=await replayableStorageFetch(this.fetch,fresh.url,{signal:AbortSignal.timeout(120000),redirect:'error'});
        }
        if (!response.ok || !response.body) throw new Error('Cloud download failed. Retry the same attachment ID.');
        const reader = response.body.getReader(), digest = createHash('sha256'); let size=0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > a.size) throw new Error('Cloud file size mismatch.'); digest.update(next.value); let offset=0; while (offset < next.value.length) { const result = await file.write(next.value,offset,next.value.length-offset); if (!result.bytesWritten) throw new Error('Local download stalled.'); offset += result.bytesWritten; } } }
        finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        if (size !== a.size || digest.digest('hex') !== a.sha256) throw new Error('Cloud checksum mismatch. Existing local files were not replaced.');
        await containedHandle(bot.cwd,temporary,file);await file.sync(); await file.close(); file=null;
        try { await link(temporary,path); } catch (error) { if (error.code !== 'EEXIST' || await localFileDigest(bot,path,a.size) !== a.sha256) throw error; }
        const directory = await open(parent,constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
        a = this.runtime.store.put('attachment',{...a,path,received:a.size}); return a;
      } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
    });
  }
  async download(bot,id) {
    let a = this.runtime.store.get('attachment',id);
    if (!a) { await this.importAttachment(bot,id); a = this.runtime.owned('attachment',id,bot.id); }
    else a = this.runtime.owned('attachment',id,bot.id);
    const local = await this.ensureLocal(bot,a);
    return {path:local.path,name:local.name,size:local.size,mimeType:local.mimeType};
  }
  async share(sender,recipient,source,copy,exchangeId) {
    await this.publish(sender,source); await this.registerBots();
    const result = await this.call('share',{id:source.id,botId:sender.id,recipientBotId:recipient.id,attachmentId:copy.id,exchangeId,createdAt:copy.createdAt});
    if (result.attachment.id !== copy.id || result.attachment.botId !== recipient.id || result.attachment.sha256 !== copy.sha256) throw new Error('Peer cloud grant receipt mismatch.');
    return {...copy,createdAt:result.attachment.createdAt,cloudState:'ready'};
  }
  mirrorPreview(bot,a) {
    if (this.previews.has(a.id)) return; this.previews.add(a.id);
    this.previewTail = this.previewTail.catch(() => {}).then(async () => {
      const preview = await readArtifactPreview(this.runtime,bot,{id:a.id});
      if (preview.status !== 'ready') return;
      const bytes = Buffer.from(preview.data,'base64'), sha256 = createHash('sha256').update(bytes).digest('hex');
      const id = `thumbnail:${createHash('sha256').update(`${a.id}:${preview.version}`).digest('hex')}`;
      const metadata = {id,botId:bot.id,parentId:a.id,name:'thumbnail.webp',mimeType:'image/webp',size:bytes.length,sha256,createdAt:a.createdAt};
      const prepared = await this.call('prepare',metadata);
      if (!prepared.attachment) { const body = new FormData(); for (const [key,value] of Object.entries(prepared.upload.fields)) body.set(key,value); body.set('file',new Blob([bytes],{type:'image/webp'}),'thumbnail.webp');
        const response = await replayableStorageFetch(this.fetch,prepared.upload.url,{method:'POST',body,signal:AbortSignal.timeout(60000),redirect:'error'}); if (!response.ok) throw new Error('Thumbnail upload unavailable.');
        await this.call('finalize',{id,botId:bot.id}); }
    }).catch(() => { /* Derived previews never block original file publication. */ }).finally(() => this.previews.delete(a.id));
  }
}
