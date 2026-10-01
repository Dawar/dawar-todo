import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtemp,mkdir,writeFile,readFile,rm,unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadTypeScript,d1,provider } from './fixtures/bot-storage-runtime.mjs';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { BotStorageClient } from '../bot-bridge/storage.mjs';
import { copyPeerAttachments } from '../bot-bridge/peer-attachments.mjs';
const {BotStorage}=loadTypeScript('db/bot-storage.ts'),{botStorageResponse}=loadTypeScript('lib/bot-storage-api.ts'),browser=loadTypeScript('app/bots/cloud-storage.ts');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const DB=d1(),owner=`${randomUUID()}@example.test`;
  const env={DB,S3_ACCESS_KEY:'synthetic-not-a-credential',S3_ACCESS_KEY_ID:'synthetic-access',S3_BUCKET:'private-test',S3_ENDPOINT_URL:'nyc3.digitaloceanspaces.com',BOTS_OWNER_EMAIL:owner,BOTS_OWNER_USER_ID:'synthetic-owner',BOTS_MACHINE_ID:'test-machine',BOTS_STORAGE_SERVICE_SECRET:'synthetic-storage-only',BOTS_STORAGE_ENABLED:'1',BOTS_STORAGE_CATALOG_READY:'1'};
  const s3=provider(env),previous=globalThis.fetch;
  globalThis.fetch=async (input,init={})=> {
    const url=new URL(input instanceof Request?input.url:input,'https://work.example.test');
    if (url.host==='work.example.test') {
      const request=new Request(url,{...init,headers:{'oai-authenticated-user-id':env.BOTS_OWNER_USER_ID,...init.headers}});
      return botStorageResponse(request,env,url.pathname.endsWith('/service'));
    }
    return s3.fetch(input,init);
  };
  const cloud=new BotStorage(env,owner,true); await cloud.initialize();
  const root=await mkdtemp(join(tmpdir(),'bot-cloud-')),store=new Store(join(root,'state.sqlite')),codex=new EventEmitter();
  const runtime=new BotRuntime({store,codex,root}),bots=[];
  for (const id of ['alpha','archived']) { const bot={id,slug:id,name:id,color:'#123456',threadId:`thread-${id}`,cwd:join(root,id),archived:id==='archived'};await mkdir(bot.cwd);store.saveBot(bot);bots.push(bot); }
  runtime.storage=new BotStorageClient(runtime,{url:'https://work.example.test',credential:env.BOTS_STORAGE_SERVICE_SECRET,machineId:env.BOTS_MACHINE_ID});
  await runtime.storage.registerBots();
  t.after(async()=>{await runtime.storage.previewTail;await Promise.allSettled([...runtime.locks.values()]);globalThis.fetch=previous;store.close();DB.sqlite.close();await rm(root,{recursive:true,force:true});});
  const upload=async(bytes,options={})=>{
    const a={id:randomUUID(),botId:'alpha',name:'sample.bin',mimeType:'application/octet-stream',size:bytes.length,sha256:digest(bytes),...options};
    const prepared=await cloud.prepare(a);const body=new FormData();for(const [key,value]of Object.entries(prepared.upload.fields))body.set(key,value);body.set('file',new Blob([bytes]),a.name);
    assert.equal((await s3.fetch(prepared.upload.url,{method:'POST',body})).status,204);return {a,prepared};
  };
  return {DB,owner,env,s3,cloud,runtime,bots,store,upload};
}

test('browser -> verified bot read -> cloud publication -> browser download preserves bytes, links and offline catalog',async t=>{
  const {owner,cloud,runtime,bots,store}=await fixture(t),bytes=Buffer.from('roundtrip\0 exact bytes 💾'),id=randomUUID();
  const a=await browser.cloudUpload(owner,()=>owner,'alpha',new File([bytes],'input.bin',{type:'application/octet-stream'}),id,()=>{});
  assert.equal(a.id,id);assert.equal(store.get('attachment',id),null);
  const input=await runtime.messageInput(bots[0],{text:'read this',attachments:[id]});
  assert.match(input[1].text,/Local path:/);assert.deepEqual(await readFile(store.get('attachment',id).path),bytes);
  const result=await runtime.publishArtifact(bots[0],{path:store.get('attachment',id).path},{key:'publication-original-call'});
  assert.equal(result.markdown,`[input.bin](bot-artifact:${result.attachmentId})`);
  const published=store.get('attachment',result.attachmentId);assert.equal(published.cloudState,'ready');
  assert.deepEqual(await readFile(published.path),bytes);
  assert.deepEqual(Buffer.from(await (await browser.cloudDownload(owner,()=>owner,'alpha',result.attachmentId)).blob.arrayBuffer()),bytes);
  // No bridge is invoked by the owner's catalog/download endpoints.
  runtime.storage.call=()=>{throw new Error('machine offline');};
  const page=await browser.cloudList(owner,()=>owner,{limit:36});assert.equal(page.items.length,2);
  assert.equal(page.items.find(item=>item.id===id).direction,'input');
  assert.deepEqual(Buffer.from(await (await browser.cloudDownload(owner,()=>owner,'alpha',id)).blob.arrayBuffer()),bytes);
  assert.equal((await cloud.list({type:'other',direction:'output'})).items.length,1);
});
test('interruption, expired URLs, lost receipt and service restart reuse ID and immutable copy',async t=>{
  const {owner,cloud,s3,env,DB}=await fixture(t),bytes=Buffer.from('recover'),id=randomUUID(),file=new File([bytes],'resume.bin');
  s3.interruptUpload=true;await assert.rejects(browser.cloudUpload(owner,()=>owner,'alpha',file,id,()=>{}));
  const resumed=await browser.cloudUpload(owner,()=>owner,'alpha',file,id,()=>{});assert.equal(resumed.id,id);
  const count=s3.copyCount;const restarted=new BotStorage(env,owner,true);await restarted.initialize();
  assert.equal((await restarted.finalize(id,'alpha')).attachment.id,id);assert.equal(s3.copyCount,count);
  DB.sqlite.prepare("UPDATE bot_storage_files SET state='pending' WHERE id=?").run(id);
  assert.equal((await cloud.finalize(id,'alpha')).attachment.id,id);assert.equal(s3.copyCount,count);
  s3.failDownload=1;assert.deepEqual(Buffer.from(await (await browser.cloudDownload(owner,()=>owner,'alpha',id)).blob.arrayBuffer()),bytes);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM bot_storage_files').get().n,1);
});
test('wrong size/checksum and changed staging fail, repeated prepare keeps ID and bytes immutable',async t=>{
  const {cloud,s3,upload,DB}=await fixture(t),bytes=Buffer.from('valid'),{a,prepared}=await upload(bytes);
  s3.objects.set(prepared.upload.fields.key,Buffer.from('wrong'));await assert.rejects(cloud.finalize(a.id,a.botId),/checksum/);
  assert.equal(DB.sqlite.prepare('SELECT state FROM bot_storage_files WHERE id=?').get(a.id).state,'failed');
  const fresh=await cloud.prepare(a);assert.equal(fresh.uploadId,a.id);
  s3.objects.set(fresh.upload.fields.key,bytes);s3.mutateOnCopy=true;await assert.rejects(cloud.finalize(a.id,a.botId));
  s3.objects.set(fresh.upload.fields.key,bytes);await cloud.finalize(a.id,a.botId);
  assert.equal((await cloud.prepare(a)).attachment.id,a.id);
  await assert.rejects(cloud.prepare({...a,sha256:digest('different')}),/different file/);
});
test('cross-bot, other owner, arbitrary keys and wrong storage credential are rejected; explicit peer share grants only recipient ID',async t=>{
  const {owner,env,cloud,upload,runtime,bots,store}=await fixture(t),{a}=await upload(Buffer.from('selected share'));
  await cloud.finalize(a.id,'alpha');await assert.rejects(cloud.download(a.id,'archived'),/not found/);
  const other=new BotStorage(env,'different-owner@example.test',true);await other.initialize();await assert.rejects(other.download(a.id,'alpha'),/not found/);
  await assert.rejects(cloud.download('bots/arbitrary/key','alpha'),/Invalid/);
  const bad=await botStorageResponse(new Request('https://work.example.test/api/bots/storage/service',{method:'POST',headers:{Authorization:'Bearer wrong','X-Bots-Machine':'test-machine'},body:JSON.stringify({action:'list'})}),env,true);assert.equal(bad.status,401);
  const cross=await botStorageResponse(new Request('https://work.example.test/api/bots/storage',{method:'POST',headers:{'oai-authenticated-user-id':'someone-else'},body:'{"action":"list"}'}),env);assert.equal(cross.status,401);
  await runtime.storage.importAttachment(bots[0],a.id);
  const copies=await copyPeerAttachments(runtime,bots[0],bots[1],[a.id],'peer-exchange-stable');store.put('attachment',copies[0]);
  assert.notEqual(copies[0].id,a.id);assert.equal(copies[0].cloudState,'ready');
  await cloud.download(copies[0].id,'archived');await assert.rejects(cloud.download(copies[0].id,'alpha'),/not found/);
  assert.deepEqual(await readFile((await runtime.downloadAttachment(bots[1],copies[0].id)).path),Buffer.from('selected share'));
  assert.equal((await cloud.list({botId:'archived'})).items[0].botArchived,true);
  assert.equal(owner,env.BOTS_OWNER_EMAIL);
});
test('corrupt downloads never replace valid local files and failed publication retains original and copied snapshot',async t=>{
  const {cloud,upload,runtime,bots,store,s3}=await fixture(t),bytes=Buffer.from('retained'),{a}=await upload(bytes);await cloud.finalize(a.id,'alpha');
  await runtime.storage.importAttachment(bots[0],a.id);const path=store.get('attachment',a.id).path;
  s3.corruptDownload=true;assert.equal((await runtime.downloadAttachment(bots[0],a.id)).path,path);assert.deepEqual(await readFile(path),bytes);
  await unlink(path);await assert.rejects(runtime.downloadAttachment(bots[0],a.id),/checksum|size mismatch/);await assert.rejects(readFile(path),{code:'ENOENT'});
  s3.corruptDownload=false;await runtime.downloadAttachment(bots[0],a.id);assert.deepEqual(await readFile(path),bytes);
  const source=join(bots[0].cwd,'finished.bin');await writeFile(source,bytes);s3.interruptUpload=true;
  await assert.rejects(runtime.publishArtifact(bots[0],{path:source},{key:'retain-on-failure'}));
  assert.deepEqual(await readFile(source),bytes);const pending=store.list('attachment','alpha').find(a=>a.artifact);assert.equal(pending.cloudState,'failed');assert.deepEqual(await readFile(pending.path),bytes);
  const result=await runtime.publishArtifact(bots[0],{path:source},{key:'retain-on-failure'});assert.equal(result.attachmentId,pending.id);assert.equal(store.get('attachment',pending.id).cloudState,'ready');
});
test('zero-byte files and stable pagination include archived registered files without new ready files shifting later pages',async t=>{
  const {cloud,upload}=await fixture(t);
  for(const name of ['a','b','c']){const {a}=await upload(Buffer.alloc(0),{name,botId:'archived',createdAt:'2026-01-01T00:00:00Z'});await cloud.finalize(a.id,'archived');}
  const first=await cloud.list({limit:'2',sort:'name'});assert.deepEqual(first.items.map(a=>a.name),['a','b']);
  const {a}=await upload(Buffer.alloc(0),{name:'bb',createdAt:'2026-01-01T00:00:00Z'});await cloud.finalize(a.id,'alpha');
  const second=await cloud.list({limit:'2',sort:'name',cursor:first.nextCursor});assert.deepEqual(second.items.map(a=>a.name),['c']);
  await assert.rejects(cloud.list({limit:'2',sort:'newest',cursor:first.nextCursor}),/cursor/);
});
test('registered legacy IDs, provenance, local paths and queued attachment references survive backfill',async t=>{
  const {runtime,bots,store,cloud}=await fixture(t),bot=bots[1],bytes=Buffer.from('legacy registered file'),id='original-registered-id',path=join(bot.cwd,'legacy.txt');
  await writeFile(path,bytes);
  const a=store.put('attachment',{id,botId:bot.id,name:'legacy.txt',mimeType:'text/plain',size:bytes.length,path,ready:true,createdAt:'2025-01-01T00:00:00Z',provenance:{threadId:bot.threadId,turnId:'original-turn',itemId:'original-item'}});
  store.put('queuedAttachments',{id:'original-queue-client',botId:bot.id,attachmentIds:[id]});
  await runtime.storage.publish(bot,a);
  const saved=store.get('attachment',id);assert.equal(saved.path,path);assert.equal(saved.id,id);assert.deepEqual(saved.provenance,a.provenance);assert.deepEqual(await readFile(path),bytes);
  const queued=runtime.publicQueued(bot,{id:'original-queue-item',clientUserMessageId:'original-queue-client',input:[{type:'text',text:'later'}],state:'queued'});assert.equal(queued.attachments[0].id,id);
  const page=await cloud.list({botId:bot.id});assert.equal(page.items[0].id,id);assert.deepEqual(JSON.parse(JSON.stringify(page.items[0].provenance)),a.provenance);assert.equal(page.items[0].botArchived,true);
});
test('migration inventory includes archived registered files only, retains baseline across restart and reports changed/missing files individually',async t=>{
  const {store,bots}=await fixture(t);const stateDirectory=join(bots[0].cwd,'..');
  for(const bot of bots) {
    const path=join(bot.cwd,'registered.txt');await writeFile(path,'first');await writeFile(join(bot.cwd,'unregistered.txt'),'not in inventory');
    store.put('attachment',{id:`legacy-${bot.id}`,botId:bot.id,name:'registered.txt',mimeType:'text/plain',size:5,path,ready:true});
  }
  const run=()=>promisify(execFile)(process.execPath,['bot-bridge/storage-migrate.mjs'],{env:{...process.env,BOTS_STATE_DIR:stateDirectory},maxBuffer:1024*1024});
  const first=await run(),lines=first.stdout.trim().split('\n').map(line=>JSON.parse(line));assert.equal(lines.at(-1).registered,2);assert.equal(lines.at(-1).failed,0);
  await writeFile(join(bots[0].cwd,'registered.txt'),'other');await unlink(join(bots[1].cwd,'registered.txt'));
  let second;try {await run();assert.fail('expected changed and missing files');}catch(error){second=error.stdout.trim().split('\n').map(line=>JSON.parse(line));}
  assert.equal(second.at(-1).registered,2);assert.equal(second.at(-1).failed,2);
  assert.match(second[0].error,/changed since/);assert.match(second[1].error,/ENOENT/);
  const checkpoint=JSON.parse(await readFile(join(stateDirectory,'storage-migration-checkpoint.json'),'utf8'));
  assert.equal(checkpoint.inventory.length,2);assert.equal(checkpoint.inventory[0].sha256,digest('first'));
  assert.equal(store.get('attachment','legacy-alpha').ready,true);assert.equal(store.get('attachment','legacy-archived').ready,true);
});
