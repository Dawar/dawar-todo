import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { IDBKeyRange } from 'fake-indexeddb';
import { runtime } from './helpers/load-ts.mjs';
const delay = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const plain = (value) => JSON.parse(JSON.stringify(value));
function setup(rpc = async () => ({})) {
  const client = { owner: 'owner-a', rpc };
  const env = runtime({ IDBKeyRange, atob, Error, Uint8Array }, { [resolve('app/bots/client.ts')]: { botsClient: client } });
  return { client, source: env.load('app/bots/artifact-source.ts'), cache: env.load('app/bots/artifact-cache.ts'), env };
}
const query = { botId: 'a', search: '', type: 'all', cursor: null };
const item = (id = 'one', botId = 'a') => ({ id, botId, name: `${id}.pdf`, mimeType: 'application/pdf', size: 9, ready: true, createdAt: null, botName: 'Synthetic', version: 'v1' });

test('remaining quota clamps used percentages and countdown handles reset/unknown time', () => {
  const { remainingQuota, quotaCountdown } = runtime().load('app/bots/quota-window.tsx');
  for (const [used, left] of [[0,100],[12,88],[100,0],[-20,100],[130,0],[NaN,null],[Infinity,null]]) assert.equal(remainingQuota(used), left);
  const now = 1_000_000;
  assert.equal(quotaCountdown(null, now), null); assert.equal(quotaCountdown(NaN, now), null);
  assert.equal(quotaCountdown((now - 1) / 1000, now), 'Reset due');
  assert.equal(quotaCountdown((now + 59_000) / 1000, now), '1m left');
  assert.equal(quotaCountdown((now + 61 * 60_000) / 1000, now), '1h 1m left');
  assert.equal(quotaCountdown((now + 2 * 86400_000 + 3 * 3600_000) / 1000, now), '2d 3h left');
});

test('real list adapter sends bounded typed query, captures owner and keeps unknown dates honest', async () => {
  const calls = [];
  const { source } = setup(async (...args) => { calls.push(args); return { items: [{ ...item(), preview: { kind: 'pdf', version: 'native-v1' } }], nextCursor: 'opaque' }; });
  const page = await source.galleryPage(query, 'owner-a');
  assert.deepEqual(plain(calls[0]), ['artifacts.list','a',{ limit:36,cursor:null,search:'',type:'all',direction:'all',sort:'newest' },null,{ owner:'owner-a' }]);
  assert.equal(page.items[0].createdAt, null); assert.equal(page.items[0].version, 'native-v1'); assert.equal(page.nextCursor, 'opaque'); assert.equal(page.total, null);
});

test('same-owner identical list requests coalesce while cursor/bot requests stay distinct', async () => {
  const calls = [], finish = [];
  const { source } = setup((...args) => { calls.push(args); return new Promise((resolve) => finish.push(() => resolve({ items: [], nextCursor: null }))); });
  const reads = [source.galleryPage(query,'owner-a'), source.galleryPage(query,'owner-a'), source.galleryPage({ ...query,botId:'b' },'owner-a')];
  assert.equal(calls.length,2); finish.forEach((resolve)=>resolve()); await Promise.all(reads);
});

test('post-index refresh waits out prior stale list then performs a new read', async () => {
  const finish = []; let count = 0;
  const { source } = setup(() => { count++; return new Promise((resolve) => finish.push(() => resolve({ items: [], nextCursor: null }))); });
  const before = source.galleryPage(query, 'owner-a'), after = source.galleryPage(query, 'owner-a', true);
  assert.equal(count,1); finish.shift()(); await before; await delay(); assert.equal(count,2); finish.shift()(); await after;
});

test('account switch discards late metadata instead of caching it for the new owner', async () => {
  let finish; const { source, client, cache } = setup(() => new Promise((resolve) => { finish = resolve; }));
  const read = source.galleryPage(query, 'owner-a'); client.owner = 'owner-b'; finish({ items: [], nextCursor: null });
  await assert.rejects(read, /account changed/); assert.equal(await cache.readArtifactCache('owner-b','page',source.galleryKey(query)),null);
});

test('gallery cache is owner-isolated and prunes only disposable metadata/previews', async () => {
  const { cache, env } = setup();
  await cache.writeArtifactCache('owner-a','page','view',{ secret:'synthetic' });
  assert.equal(await cache.readArtifactCache('owner-b','page','view'),null);
  assert.equal((await cache.readArtifactCache('owner-a','page','view')).secret,'synthetic');
  for (let i=0;i<60;i++) await cache.writeArtifactCache('owner-a','preview',String(i),new Blob([String(i)]));
  const remaining = await Promise.all(Array.from({length:60},(_,i)=>cache.readArtifactCache('owner-a','preview',String(i))));
  assert.equal(remaining.filter(Boolean).length,48); assert.ok(remaining[59]);
  assert.deepEqual((await env.indexedDB.databases()).map((db)=>db.name), ['dawar-bot-artifact-gallery-v1']);
});

test('native WebP previews are lazy/deduplicated, at most three requests run at once, cached previews work offline', async () => {
  let active=0, maximum=0, total=0; const finish=[];
  const { source } = setup(async (method,_bot,params,_operation,options) => {
    assert.equal(method,'artifacts.preview'); assert.equal(options.owner,'owner-a'); assert.equal(params.version,'v1');
    active++;total++;maximum=Math.max(maximum,active); await new Promise((r)=>finish.push(r)); active--;
    return { status:'ready',version:'v1',mimeType:'image/webp',data:btoa('webp fixture') };
  });
  const reads = [...Array.from({length:7},(_,i)=>source.artifactPreview(item(String(i)),'owner-a',true)),source.artifactPreview(item('0'),'owner-a',true)];
  await delay(30); assert.equal(active,3);
  for(let i=0;i<7;i++){ while(!finish.length) await delay(1); finish.shift()(); await delay(2); }
  const blobs=await Promise.all(reads); assert.equal(maximum,3);assert.equal(total,7);assert.equal(blobs[0].type,'image/webp');
  const cached=await source.artifactPreview(item('0'),'owner-a',false);assert.equal(await cached.text(),'webp fixture');assert.equal(total,7);
  await assert.rejects(source.artifactPreview(item('uncached'),'owner-a',false),/connection/);
});

test('originals are explicit chunk reads, abort prevents further transfer, owner change rejects late bytes', async () => {
  let calls=0; const controller=new AbortController();
  const { source, client }=setup(async()=>{ calls++;controller.abort();return {data:btoa('abc'),nextOffset:3,size:6,mimeType:'application/pdf'}; });
  await assert.rejects(source.readArtifactOriginal(item(),'owner-a',controller.signal),/abort/i);assert.equal(calls,1);
  client.rpc=async()=>{client.owner='owner-b';return {data:btoa('abc'),nextOffset:3,size:3,mimeType:'application/pdf'};};
  await assert.rejects(source.readArtifactOriginal(item(),'owner-a',new AbortController().signal),/account changed/);
});

test('original PDF bytes remain exact across chunks and indexing deduplicates by owner/bot/cursor', async () => {
  const calls=[];
  const {source}=setup(async(method,bot,params)=>{calls.push({method,bot,params});return method==='attachments.read' ? { data:btoa(params.offset ? 'DEF' : 'abc'), nextOffset:params.offset ? 6 : 3,size:6,mimeType:'application/pdf',name:'Authoritative.pdf' } : {registered:0,nextCursor:null,failures:[]};});
  const blob=await source.readArtifactOriginal(item(),'owner-a',new AbortController().signal); assert.equal(await blob.text(),'abcDEF');assert.equal(blob.type,'application/pdf'); assert.equal(blob.name,'Authoritative.pdf');
  await Promise.all([source.indexArtifacts('a',null,'owner-a'),source.indexArtifacts('a',null,'owner-a')]);
  assert.equal(calls.filter((c)=>c.method==='artifacts.index').length,1);
});


test('malformed oversized gallery/preview responses cannot create an unbounded UI or image allocation', async () => {
  const {source,client}=setup(async()=>({items:Array.from({length:37},()=>({...item(),preview:{version:'v'}})),nextCursor:null}));
  await assert.rejects(source.galleryPage(query,'owner-a'),/too large/);
  client.rpc=async()=>({status:'ready',version:'v1',mimeType:'image/webp',data:'x'.repeat(175000)});
  await assert.rejects(source.artifactPreview(item(),'owner-a',true),/Preview unavailable/);
});
