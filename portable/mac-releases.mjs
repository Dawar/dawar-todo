import { readFile,stat,realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { compatible,signature,verifySignature,secret,PROTOCOL_VERSION,RUNTIME_VERSION } from './protocol.mjs';
import { boundedJSON } from './bounded-json.mjs';

// Mac Agent.app releases. The owner signs each release record offline with an
// Ed25519 release key; the app embeds only the public key. The hub stores and
// serves already-signed records to enrolled, unrevoked nodes; it never holds a
// signing secret and never accepts an install URL or command from anyone.
export const RELEASE_KIND='dawartodo-mac-agent-release';
export const CHECK_PURPOSE='mac-release-check',DOWNLOAD_PURPOSE='mac-release-download';
export const ARCHIVE_NAME=/^DawarTodoAgent-\d{1,4}\.\d{1,4}\.\d{1,4}-\d{1,9}\.zip$/;
export const MAX_ARCHIVE_BYTES=1536*1024*1024;
const hex=(n,v)=>typeof v==='string'&&new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const integer=v=>Number.isSafeInteger(v)&&v>0;

export function validateRelease(r) {
  if(r?.kind!==RELEASE_KIND||r.version!==1||!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(r.appVersion??'')||!integer(r.build)||!hex(40,r.agentSource)
    ||!integer(r.protocol)||typeof r.runtime!=='string'||!/^24\.\d+\.\d+$/.test(r.nodeVersion??'')||r.platform!=='darwin'||!['arm64','x64'].includes(r.arch)
    ||!/^\d+\.\d+$/.test(r.minimumMacOS??'')||!hex(64,r.bundleManifestSHA256)||typeof r.publishedAt!=='string'
    ||!ARCHIVE_NAME.test(r.archive?.name??'')||!integer(r.archive.bytes)||r.archive.bytes>MAX_ARCHIVE_BYTES||!hex(64,r.archive.sha256)
    ||typeof r.archive.edSignature!=='string'||!/^[A-Za-z0-9+/]{86}==$/.test(r.archive.edSignature)
    ||!Array.isArray(r.hub?.protocols)||!r.hub.protocols.every(integer)||!Array.isArray(r.hub.runtimes)||!r.hub.runtimes.every(v=>typeof v==='string'))
    throw Error('Invalid Mac agent release record.');
  return r;
}
export const signRelease=(privateKey,release)=>({release:validateRelease(release),signature:signature(privateKey,release)});
export function verifyRelease(publicKey,envelope) {
  validateRelease(envelope?.release);
  if(!verifySignature(publicKey,envelope.release,envelope.signature))throw Error('Mac agent release signature is invalid.');
  return envelope.release;
}
// Newest release this hub can serve for the client's platform. The client is
// compatible when the hub still accepts its hello, so older compatible apps
// keep running through a staged rollout; incompatible ones get a concrete path.
export function selectRelease(releases,{hubProtocol=PROTOCOL_VERSION,hubRuntime=RUNTIME_VERSION,platform,arch}) {
  return releases.filter(e=>{const r=e.release;return r.platform===platform&&r.arch===arch&&r.hub.protocols.includes(hubProtocol)&&r.hub.runtimes.includes(hubRuntime)&&r.protocol===hubProtocol&&r.runtime===hubRuntime;})
    .sort((a,b)=>b.release.build-a.release.build)[0]??null;
}

const FRESH_MS=5*60*1000;
// Hub half. nodeLookup(id) → {public_key,revoked_at}|undefined.
export class MacReleaseService {
  constructor({directory,nodeLookup,now=()=>Date.now()}){Object.assign(this,{directory:join(directory,'mac'),nodeLookup,now});this.nonces=new Map();}
  authenticate(body,purpose,fields) {
    const now=this.now();
    for(const [n,at] of this.nonces)if(at<now-FRESH_MS)this.nonces.delete(n);
    if(typeof body?.nodeId!=='string'||typeof body.nonce!=='string'||body.nonce.length<20||body.nonce.length>100||!Number.isSafeInteger(body.issuedAt)||Math.abs(now-body.issuedAt)>FRESH_MS)throw Error('Release request is stale or malformed.');
    const node=this.nodeLookup(body.nodeId);
    const value={purpose,nodeId:body.nodeId,nonce:body.nonce,issuedAt:body.issuedAt,...Object.fromEntries(fields.map(k=>[k,body[k]]))};
    if(!node||node.revoked_at||!verifySignature(node.public_key,value,body.proof))throw Error('Release request is not from an enrolled node.');
    if(this.nonces.has(body.nonce)||this.nonces.size>10000)throw Error('Release request was already used.');
    this.nonces.set(body.nonce,now);
  }
  async releases() {
    let list;try{list=JSON.parse(await readFile(join(this.directory,'releases.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;}
    if(!Array.isArray(list)||list.length>100)throw Error('Mac release list is invalid.');
    return list.filter(e=>{try{validateRelease(e.release);return typeof e.signature==='string';}catch{return false;}});
  }
  async check(body) {
    this.authenticate(body,CHECK_PURPOSE,['hello','client']);
    let reason=null;try{compatible(body.hello);}catch(e){reason=e.message;}
    if(!integer(body.client?.build))throw Error('Client build is required.');
    const current=selectRelease(await this.releases(),{platform:body.hello?.platform,arch:body.hello?.arch});
    return {hub:{protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION},compatible:reason===null,reason,release:current,
      updateAvailable:!!current&&current.release.build>body.client.build};
  }
  async archive(body) {
    this.authenticate(body,DOWNLOAD_PURPOSE,['name']);
    if(!ARCHIVE_NAME.test(body.name??''))throw Error('Release archive name is invalid.');
    const entry=(await this.releases()).find(e=>e.release.archive.name===body.name);
    if(!entry)throw Error('Release archive is not approved.');
    const path=join(this.directory,body.name),s=await stat(path);
    if(!s.isFile()||s.size!==entry.release.archive.bytes||await realpath(path)!==path)throw Error('Release archive file is invalid.');
    return {path,bytes:s.size,name:body.name};
  }
}

// Node half: signed requests with the enrolled node key.
export function nodeHello(platform=process.platform,arch=process.arch) {
  return {protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION,platform,arch,capabilities:{text:true,localStdio:true,desktop:false,voice:false,secureTransfer:false}};
}
export function signedRequest(key,nodeId,purpose,fields,now=Date.now()) {
  const value={purpose,nodeId,nonce:secret(),issuedAt:now,...fields};
  const {purpose:_,...body}=value;return {...body,proof:signature(key.privateKey,value)};
}
export async function checkForRelease({hub,key,nodeId,client,publicKey,hello=nodeHello(),fetcher=fetch,now=Date.now()}) {
  const origin=new URL(hub);if(origin.protocol!=='https:'||origin.pathname!=='/'||origin.username||origin.search)throw Error('Release checks use the fixed HTTPS hub only.');
  const r=await fetcher(new URL('/nodes/releases/mac',origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json'},
    body:JSON.stringify(signedRequest(key,nodeId,CHECK_PURPOSE,{hello,client},now))});
  if(!r.ok){await r.body?.cancel();throw Error(`Release check failed with HTTP ${r.status}.`);}
  const answer=await boundedJSON(r,64*1024);
  const release=answer.release?verifyRelease(publicKey,answer.release):null;
  if(release&&(release.platform!==hello.platform||release.arch!==hello.arch))throw Error('Hub offered a release for another platform.');
  return {compatible:answer.compatible===true,reason:answer.reason??null,hub:answer.hub,envelope:answer.release??null,release,
    updateAvailable:!!release&&release.build>client.build};
}
