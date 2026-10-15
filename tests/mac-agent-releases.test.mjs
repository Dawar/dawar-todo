import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,writeFileSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync,createHash } from 'node:crypto';
import { MacReleaseService,signRelease,verifyRelease,selectRelease,checkForRelease,signedRequest,nodeHello,CHECK_PURPOSE,DOWNLOAD_PURPOSE } from '../portable/mac-releases.mjs';
import { nodeKey,RUNTIME_VERSION } from '../portable/protocol.mjs';
import { agentStatusSnapshot,startStatusReporter } from '../portable/agent-status.mjs';
import { readPrivate } from '../portable/private-file.mjs';
import { temp,SOURCE_A,SOURCE_B } from './helpers/mac-agent-fixture.mjs';

const pair=()=>{const {privateKey,publicKey}=generateKeyPairSync('ed25519');return {privateKey:privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey:publicKey.export({format:'pem',type:'spki'}).toString()};};
const record=(build,over={})=>({kind:'dawartodo-mac-agent-release',version:1,appVersion:`1.0.${build}`,build,agentSource:build%2?SOURCE_A:SOURCE_B,protocol:1,runtime:RUNTIME_VERSION,
  nodeVersion:'24.21.0',platform:'darwin',arch:'arm64',minimumMacOS:'13.0',bundleManifestSHA256:'c'.repeat(64),publishedAt:'2026-10-15T00:00:00.000Z',
  archive:{name:`DawarTodoAgent-1.0.${build}-${build}.zip`,bytes:5,sha256:createHash('sha256').update(`zip-${build}`).digest('hex'),edSignature:'A'.repeat(86)+'=='},
  hub:{protocols:[1],runtimes:[RUNTIME_VERSION]},...over});
const NODE_ID='node:'+'n'.repeat(24),MAC=nodeHello('darwin','arm64');

function hub({releases,revoked=false,now=Date.now()}) {
  const directory=temp('hub-downloads-'),nodeDir=temp('node-');
  mkdirSync(join(directory,'mac'));writeFileSync(join(directory,'mac/releases.json'),JSON.stringify(releases));
  for(const e of releases)writeFileSync(join(directory,'mac',e.release.archive.name),`zip-${e.release.build}`);
  const key=nodeKey(join(nodeDir,'node-key.pem'));
  const service=new MacReleaseService({directory,nodeLookup:id=>id===NODE_ID?{public_key:key.publicKey,revoked_at:revoked?1:null}:undefined,now:()=>now});
  // Stand-in for the gateway route: JSON in, JSON out.
  const fetcher=async(url,init)=>{
    assert.equal(init.redirect,'error');
    try{return new Response(JSON.stringify(await service.check(JSON.parse(init.body))),{status:200,headers:{'content-type':'application/json'}});}
    catch(e){return new Response(JSON.stringify({error:e.message}),{status:400});}
  };
  return {service,key,fetcher,directory};
}

test('release records verify only with the owner release key and pick the newest hub-compatible build',()=>{
  const owner=pair(),other=pair(),env=signRelease(owner.privateKey,record(3));
  assert.equal(verifyRelease(owner.publicKey,env).build,3);
  assert.throws(()=>verifyRelease(other.publicKey,env),/signature is invalid/);
  assert.throws(()=>verifyRelease(owner.publicKey,{...env,release:{...env.release,build:4}}),/signature is invalid/);
  assert.throws(()=>signRelease(owner.privateKey,record(3,{platform:'linux'})),/Invalid/);
  const list=[signRelease(owner.privateKey,record(2)),signRelease(owner.privateKey,record(5,{hub:{protocols:[2],runtimes:[RUNTIME_VERSION]}})),env,signRelease(owner.privateKey,record(4,{arch:'x64'}))];
  assert.equal(selectRelease(list,{platform:'darwin',arch:'arm64'}).release.build,3,'protocol-2 build 5 waits for a protocol-2 hub');
  assert.equal(selectRelease(list,{platform:'darwin',arch:'x64'}).release.build,4);
  assert.equal(selectRelease(list,{platform:'darwin',arch:'arm64',hubRuntime:'0.170.0'}),null);
});

test('an enrolled node gets a signed compatible release; older compatible clients keep running',async()=>{
  const owner=pair(),h=hub({releases:[signRelease(owner.privateKey,record(3))]});
  const answer=await checkForRelease({hub:'https://work.dawar.ca',key:h.key,nodeId:NODE_ID,client:{build:2},publicKey:owner.publicKey,fetcher:h.fetcher,hello:MAC});
  assert.equal(answer.compatible,true);assert.equal(answer.updateAvailable,true);assert.equal(answer.release.build,3);
  const current=await checkForRelease({hub:'https://work.dawar.ca',key:h.key,nodeId:NODE_ID,client:{build:3},publicKey:owner.publicKey,fetcher:h.fetcher,hello:MAC});
  assert.equal(current.updateAvailable,false);
});

test('an incompatible client is told so with the update that fixes it',async()=>{
  const owner=pair(),h=hub({releases:[signRelease(owner.privateKey,record(3))]});
  const answer=await checkForRelease({hub:'https://work.dawar.ca',key:h.key,nodeId:NODE_ID,client:{build:1},publicKey:owner.publicKey,fetcher:h.fetcher,
    hello:{...nodeHello('darwin','arm64'),runtime:'0.150.0'}});
  assert.equal(answer.compatible,false);assert.match(answer.reason,/Incompatible/);assert.equal(answer.release.build,3);
});

test('unsigned, foreign-key or tampered hub answers are refused by the node',async()=>{
  const owner=pair(),rogue=pair(),h=hub({releases:[signRelease(rogue.privateKey,record(3))]});
  await assert.rejects(checkForRelease({hub:'https://work.dawar.ca',key:h.key,nodeId:NODE_ID,client:{build:1},publicKey:owner.publicKey,fetcher:h.fetcher,hello:MAC}),/signature is invalid/);
  await assert.rejects(checkForRelease({hub:'http://work.dawar.ca',key:h.key,nodeId:NODE_ID,client:{build:1},publicKey:owner.publicKey,fetcher:h.fetcher,hello:MAC}),/fixed HTTPS/);
});

test('the hub serves releases only to enrolled, unrevoked nodes with fresh single-use proofs',async()=>{
  const owner=pair(),env=signRelease(owner.privateKey,record(3)),now=Date.now(),h=hub({releases:[env],now});
  const body=signedRequest(h.key,NODE_ID,CHECK_PURPOSE,{hello:nodeHello('darwin','arm64'),client:{build:1}},now);
  assert.equal((await h.service.check(body)).release.release.build,3);
  await assert.rejects(h.service.check(body),/already used/);
  await assert.rejects(h.service.check(signedRequest(h.key,NODE_ID,CHECK_PURPOSE,{hello:nodeHello('darwin','arm64'),client:{build:1}},now-10*60*1000)),/stale/);
  const stranger=nodeKey(join(temp('stranger-'),'k.pem'));
  await assert.rejects(h.service.check(signedRequest(stranger,NODE_ID,CHECK_PURPOSE,{hello:nodeHello('darwin','arm64'),client:{build:1}},now)),/enrolled node/);
  const forged={...signedRequest(h.key,NODE_ID,CHECK_PURPOSE,{hello:nodeHello('darwin','arm64'),client:{build:1}},now),client:{build:9}};
  await assert.rejects(h.service.check(forged),/enrolled node/);
  const revoked=hub({releases:[env],revoked:true,now});
  await assert.rejects(revoked.service.check(signedRequest(revoked.key,NODE_ID,CHECK_PURPOSE,{hello:nodeHello('darwin','arm64'),client:{build:1}},now)),/enrolled node/);
});

test('archive downloads are limited to listed, size-matching files; no other path or URL is accepted',async()=>{
  const owner=pair(),env=signRelease(owner.privateKey,record(3)),now=Date.now(),h=hub({releases:[env],now});
  const a=await h.service.archive(signedRequest(h.key,NODE_ID,DOWNLOAD_PURPOSE,{name:env.release.archive.name},now));
  assert.equal(readFileSync(a.path,'utf8'),'zip-3');
  await assert.rejects(h.service.archive(signedRequest(h.key,NODE_ID,DOWNLOAD_PURPOSE,{name:'../releases.json'},now)),/name is invalid/);
  await assert.rejects(h.service.archive(signedRequest(h.key,NODE_ID,DOWNLOAD_PURPOSE,{name:'DawarTodoAgent-9.9.9-99.zip'},now)),/not approved/);
  writeFileSync(join(h.directory,'mac',env.release.archive.name),'changed size');
  await assert.rejects(h.service.archive(signedRequest(h.key,NODE_ID,DOWNLOAD_PURPOSE,{name:env.release.archive.name},now)),/file is invalid/);
  const gateway=readFileSync(new URL('../portable/gateway.mjs',import.meta.url),'utf8');
  assert.match(gateway,/'\/nodes\/releases\/mac' && req\.method === 'POST'.*macReleases\.check/);
  assert.match(gateway,/'\/nodes\/releases\/mac\/download' && req\.method === 'POST'/);
});

test('the agent status feed is private, credential-free and reports connection and active bots',()=>{
  const bots=[{id:'bot-1',name:'Dwight',activeTurnId:'turn-1',status:'idle',threadId:'t'},{id:'bot-2',name:'Jim',status:'idle'},{id:'bot-3',name:'Old',archived:true,activeTurnId:'x'}];
  const runtime={store:{bots:()=>bots},relayOnline:true,ready:true,activityUnresolved:id=>id==='bot-2'};
  const snap=agentStatusSnapshot({runtime,source:{source:SOURCE_A,runtime:RUNTIME_VERSION},now:5});
  assert.deepEqual(snap.bots,{total:2,working:1,settling:1,active:[{id:'bot-1',name:'Dwight',status:'working'}]});
  assert.equal(snap.connected,true);assert.equal(snap.source,SOURCE_A);
  const path=join(temp('status-'),'status.json'),reporter=startStatusReporter({runtime,source:{source:SOURCE_A},path,intervalMs:60000});
  assert.equal(JSON.parse(readPrivate(path)).bots.working,1);
  reporter.stop();assert.equal(JSON.parse(readPrivate(path)).stopping,true);
  assert.doesNotMatch(readFileSync(path,'utf8'),/threadId|token|secret/);
});
