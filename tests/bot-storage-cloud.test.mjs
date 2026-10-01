import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {loadTypeScript,d1,provider} from './fixtures/bot-storage-runtime.mjs';
const {BotStorage}=loadTypeScript('db/bot-storage.ts'),{botStorageResponse}=loadTypeScript('lib/bot-storage-api.ts');
const digest=value=>createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const DB=d1(),env={DB,S3_ACCESS_KEY:'synthetic-secret',S3_ACCESS_KEY_ID:'synthetic-id',S3_BUCKET:'private-test',S3_ENDPOINT_URL:'nyc3.digitaloceanspaces.com',BOTS_OWNER_EMAIL:'owner@example.test',BOTS_OWNER_USER_ID:'owner-id',BOTS_MACHINE_ID:'machine',BOTS_STORAGE_SERVICE_SECRET:'storage-only'};
  const s3=provider(env),prior=globalThis.fetch;globalThis.fetch=s3.fetch;
  t.after(()=>{globalThis.fetch=prior;DB.sqlite.close();});
  const storage=new BotStorage(env,env.BOTS_OWNER_EMAIL,true);await storage.initialize();
  await storage.registerBots([{id:'one',name:'One',color:'#123456',archived:false},{id:'archived',name:'Archived',color:'#234567',archived:true}]);
  const upload=async(name='file.bin',bytes=Buffer.from('identical bytes'),extra={})=>{
    const metadata={id:randomUUID(),botId:'one',name,mimeType:'application/octet-stream',size:bytes.length,sha256:digest(bytes),...extra};
    const prepared=await storage.prepare(metadata),form=new FormData();for(const[key,value]of Object.entries(prepared.upload.fields))form.set(key,value);form.set('file',new Blob([bytes]),name);
    assert.equal((await s3.fetch(prepared.upload.url,{method:'POST',body:form})).status,204);return {metadata,prepared,bytes};
  };
  return {DB,env,s3,storage,upload};
}
test('cloud-only signed POST, conditional copy, signed download and replay keep bytes/receipt immutable',async t=>{
  const {storage,s3,DB,env,upload}=await fixture(t),{metadata,bytes}=await upload();
  const receipt=await storage.finalize(metadata.id,'one');assert.equal(receipt.attachment.sha256,digest(bytes));
  const target=await storage.download(metadata.id,'one');assert.deepEqual(Buffer.from(await (await s3.fetch(target.url)).arrayBuffer()),bytes);
  const copies=s3.copyCount;assert.deepEqual((await storage.prepare(metadata)).attachment,receipt.attachment);
  const restarted=new BotStorage(env,env.BOTS_OWNER_EMAIL,true);await restarted.initialize();await restarted.finalize(metadata.id,'one');assert.equal(s3.copyCount,copies);
  DB.sqlite.prepare("UPDATE bot_storage_files SET state='pending' WHERE id=?").run(metadata.id);await storage.finalize(metadata.id,'one');assert.equal(s3.copyCount,copies);
  assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM bot_storage_files').get().n,1);
  await assert.rejects(storage.prepare({...metadata,size:metadata.size+1}),/different file/);
});
test('staging tampering, copy races and corrupted unacknowledged copies never become ready; retries reuse ID',async t=>{
  const {storage,s3,DB,upload}=await fixture(t),{metadata,prepared,bytes}=await upload();
  s3.objects.set(prepared.upload.fields.key,Buffer.from('wrong'));await assert.rejects(storage.finalize(metadata.id,'one'),/checksum|size/);
  s3.objects.set(prepared.upload.fields.key,bytes);s3.mutateOnCopy=true;await assert.rejects(storage.finalize(metadata.id,'one'));
  assert.equal(DB.sqlite.prepare('SELECT state FROM bot_storage_files').get().state,'failed');
  s3.objects.set(prepared.upload.fields.key,bytes);
  const row=DB.sqlite.prepare('SELECT object_key FROM bot_storage_files').get();s3.objects.set(row.object_key,Buffer.from('wrong'));
  await storage.finalize(metadata.id,'one');assert.equal(DB.sqlite.prepare('SELECT state FROM bot_storage_files').get().state,'ready');
  assert.equal((await storage.prepare(metadata)).attachment.id,metadata.id);
});
test('owner and service scopes reject wrong credentials, cross-origin sessions, arbitrary keys and cross-bot IDs',async t=>{
  const {storage,env,upload}=await fixture(t),{metadata}=await upload();await storage.finalize(metadata.id,'one');
  await assert.rejects(storage.download(metadata.id,'archived'),/not found/);await assert.rejects(storage.download('bucket/arbitrary/key','one'),/Invalid/);
  const stranger=new BotStorage(env,'other@example.test',true);await stranger.initialize();await assert.rejects(stranger.download(metadata.id,'one'),/not found/);
  const request=(headers,input,path='/api/bots/storage')=>new Request(`https://work.example.test${path}`,{method:'POST',headers,body:JSON.stringify(input)});
  assert.equal((await botStorageResponse(request({'oai-authenticated-user-id':'other'}, {action:'list'}),env)).status,401);
  assert.equal((await botStorageResponse(request({'oai-authenticated-user-id':'owner-id',Origin:'https://evil.example.test'}, {action:'list'}),env)).status,401);
  assert.equal((await botStorageResponse(request({Authorization:'Bearer storage-only','X-Bots-Machine':'wrong'}, {action:'list'},'/api/bots/storage/service'),env,true)).status,401);
  assert.equal((await botStorageResponse(request({'oai-authenticated-user-id':'owner-id'}, {action:'prepare',...metadata}),env)).status,503);
  assert.equal((await botStorageResponse(request({'oai-authenticated-user-id':'owner-id'}, {action:'list'}),env)).status,200);
});
test('explicit grant creates recipient ID and migratable provenance without exposing object keys',async t=>{
  const {storage,upload}=await fixture(t),{metadata}=await upload();await storage.finalize(metadata.id,'one');
  const grant={id:metadata.id,botId:'one',recipientBotId:'archived',attachmentId:'peer-file:recipient-copy',exchangeId:'peer:explicit-exchange'};
  const result=await storage.share(grant);assert.equal(result.attachment.id,grant.attachmentId);assert.equal(result.attachment.peerSource.attachmentId,metadata.id);
  assert.deepEqual(await storage.share(grant),result);await storage.download(grant.attachmentId,'archived');
  await assert.rejects(storage.download(grant.attachmentId,'one'),/not found/);
  const page=await storage.list({botId:'archived'});assert.equal(page.items[0].botArchived,true);assert.equal(Object.hasOwn(page.items[0],'object_key'),false);
});
test('zero-byte files, inferred MIME, Unicode names and historical dates preserve filters and stable paging',async t=>{
  const {storage,upload}=await fixture(t);
  for(const [name,date]of [['Été.pdf','2026-01-01T00:00:00Z'],['世界.pdf','2025-01-01T00:00:00Z'],['😀.pdf',null]]){
    const {metadata}=await upload(name,Buffer.alloc(0),{botId:'archived',createdAt:date});await storage.finalize(metadata.id,'archived');
  }
  const first=await storage.list({limit:'2',type:'pdf',sort:'name'});assert.equal(first.items.length,2);assert.ok(first.nextCursor);
  const {metadata}=await upload('new.pdf',Buffer.alloc(0));await storage.finalize(metadata.id,'one');
  const second=await storage.list({limit:'2',type:'pdf',sort:'name',cursor:first.nextCursor});assert.equal(second.items.length,1);assert.ok(!second.items.some(item=>item.name==='new.pdf'));
  assert.equal((await storage.list({search:'ÉTÉ',type:'pdf'})).items.length,1);
  const oldest=await storage.list({botId:'archived',sort:'oldest'});assert.equal(oldest.items[0].name,'😀.pdf');
});
test('portable composer grants are owner scoped, replayable without provider transfer and cannot claim peer provenance',async t=>{
 const {storage,env,s3,DB,upload}=await fixture(t);await storage.registerBots([{id:'two',name:'Two',color:'#123456',archived:false}]);
 const {metadata,bytes}=await upload('portable.bin');await storage.finalize(metadata.id,'one');const copies=s3.copyCount;
 const owner=new BotStorage(env,env.BOTS_OWNER_EMAIL,false);await owner.initialize();
 const input={id:metadata.id,botId:'one',recipientBotId:'two',attachmentId:randomUUID()};const result=await owner.copy(input);
 assert.deepEqual(await owner.copy(input),result);assert.equal(s3.copyCount,copies);assert.equal(result.attachment.sha256,digest(bytes));assert.equal(result.attachment.peerSource,undefined);
 assert.equal(DB.sqlite.prepare('SELECT COUNT(*) AS n FROM bot_storage_files WHERE bot_id=?').get('two').n,1);
 await owner.download(input.attachmentId,'two');await assert.rejects(owner.download(input.attachmentId,'one'),/not found/);
 await assert.rejects(owner.copy({...input,recipientBotId:'archived',attachmentId:randomUUID()}),/unavailable/);
 const stranger=new BotStorage(env,'stranger',false);await stranger.initialize();await assert.rejects(stranger.copy(input),/not found/);
 await assert.rejects(owner.copy({...input,id:'bucket/arbitrary/key'}),/Invalid/);
 const other=await upload();await storage.finalize(other.metadata.id,'one');await assert.rejects(owner.copy({...input,id:other.metadata.id}),/conflict/);
});
