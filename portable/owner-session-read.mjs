import {open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createApplicationReadClient} from './application-read-transport.mjs';
import {exportFrozenD1Application} from './application-export.mjs';

const MAXIMUM_SESSION=32*1024,MAXIMUM_PAGE=6*1024*1024;
const IDENTITY='/api/migration/identity',READ='/api/migration/application/read';
const failure=()=>Error('The original private owner session or authenticated application read could not be confirmed.');
const hash=b=>createHash('sha256').update(b).digest('hex');
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw failure();}
function origin(v){const u=new URL(v);if(u.protocol!=='https:'||u.origin!==v||u.username||u.password)throw failure();return v;}
function owner(v){exact(v,['ownerUserId','ownerKey']);if(Object.values(v).some(x=>typeof x!=='string'||!x||x.includes('\0')||Buffer.byteLength(x)>1024))throw failure();return {...v};}
async function session(path) {
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const s=await f.stat(),linked=await lstat(path);
    if(!s.isFile()||linked.isSymbolicLink()||s.ino!==linked.ino||s.dev!==linked.dev||s.mode&0o077||process.getuid&&s.uid!==process.getuid()||s.size<1||s.size>MAXIMUM_SESSION)throw failure();
    const b=await f.readFile();if(b.length!==s.size)throw failure();
    const after=await f.stat();if(after.size!==s.size||after.mtimeNs!==s.mtimeNs||after.mtimeMs!==s.mtimeMs)throw failure();
    const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b));
    exact(v,['version','kind','sourceOrigin','ownerUserId','ownerKey','expiresAt','cookie']);
    if(v.version!==1||v.kind!=='dawar-original-owner-session'||!Number.isSafeInteger(v.expiresAt)||v.expiresAt<=Date.now()||
        typeof v.cookie!=='string'||!v.cookie||Buffer.byteLength(v.cookie)>8192||!/^[\x20-\x7e]+$/.test(v.cookie)||
        v.cookie.split(';').some(p=>!/^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;]*$/.test(p)))throw failure();
    origin(v.sourceOrigin);owner({ownerUserId:v.ownerUserId,ownerKey:v.ownerKey});
    return {value:v,identity:JSON.stringify([s.dev,s.ino,s.uid,s.mode,s.size,s.mtimeMs,hash(b)])};
  }catch{throw failure();}finally{await f.close();}
}
async function boundedBody(response,maximum,signal) {
  const size=response.headers.get('Content-Length');
  if(size!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(size)||!Number.isSafeInteger(Number(size))||Number(size)>maximum))throw failure();
  if(!response.body)throw failure();const reader=response.body.getReader();let count=0,done=false;const chunks=[];
  try {
    for(;;){
      signal.throwIfAborted();
      const next=await new Promise((accept,reject)=>{
        const abort=()=>reject(failure());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
        reader.read().then(accept,reject).finally(()=>signal.removeEventListener('abort',abort));
      });signal.throwIfAborted();
      if(next.done){done=true;break;}
      if(!(next.value instanceof Uint8Array)||(count+=next.value.length)>maximum||chunks.length>=4096)throw failure();chunks.push(next.value);
    }
    if(size!==null&&count!==Number(size))throw failure();return Buffer.concat(chunks,count);
  }finally{if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
}

// A private, explicitly supplied existing-owner session is the only credential.
// No desktop cookie extraction, bearer fallback, identity-header impersonation,
// login, redirect, source write, credential renewal or automatic retry occurs.
export async function createOwnerSessionApplicationReader({capture,recipient,expectedOwner,sessionPath,signal}) {
  const fixedOwner=owner(expectedOwner),source=origin(capture?.sourceOrigin),path=resolve(sessionPath),first=await session(path);
  if(first.value.sourceOrigin!==source||Object.keys(fixedOwner).some(k=>first.value[k]!==fixedOwner[k]))throw failure();
  const closing=new AbortController();let closed=false,lastWall=Date.now(),pending=null;
  const monotonicExpiry=performance.now()+first.value.expiresAt-lastWall;
  function clock(){const now=Date.now();if(now<lastWall||now>=first.value.expiresAt||performance.now()>=monotonicExpiry)throw failure();lastWall=now;}
  async function current() {
    if(closed)throw failure();closing.signal.throwIfAborted();signal?.throwIfAborted();
    clock();
    if((await session(path)).identity!==first.identity)throw failure();
    if(closed)throw failure();closing.signal.throwIfAborted();signal?.throwIfAborted();
    clock();
  }
  async function request(url,init,maximum,abort) {
    await current();const response=await fetch(url,{...init,redirect:'error',cache:'no-store',signal:abort.signal,
      headers:{...init.headers,Cookie:first.value.cookie,'Accept-Encoding':'identity','User-Agent':'DawarTodo/1.0 (private application migration)'}});
    if(response.status!==200||response.redirected||response.url!==url||response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw failure();
    if(response.headers.has('Content-Encoding')&&response.headers.get('Content-Encoding')!=='identity')throw failure();
    const body=await boundedBody(response,maximum,abort.signal);await current();abort.signal.throwIfAborted();return {response,body};
  }
  const client=createApplicationReadClient({capture,recipient,signal:AbortSignal.any([closing.signal,...(signal?[signal]:[])]),
    fetchOwned:async(url,init)=>{
      const h=new Headers(init.headers);
      if(url!==source+READ||init.method!=='POST'||init.redirect!=='error'||init.credentials!=='include'||init.cache!=='no-store'||
          h.get('Origin')!==source||h.get('Content-Type')!=='application/json'||[...h.keys()].some(k=>!['origin','content-type'].includes(k))||
          typeof init.body!=='string'||Buffer.byteLength(init.body)>112*1024)throw failure();
      const abort=new AbortController(),all=AbortSignal.any([closing.signal,AbortSignal.timeout(30000),init.signal,...(signal?[signal]:[])]);
      const cancelled=()=>abort.abort();all.addEventListener('abort',cancelled,{once:true});if(all.aborted)cancelled();
      try {
        const identity=await request(source+IDENTITY,{method:'GET',headers:{Accept:'application/json'}},16*1024,abort);
        const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(identity.body));
        exact(value,['version','ownerKey','ownerUserId','sourceOrigin','evidenceKind','identityChanged']);
        if(value.version!==1||value.sourceOrigin!==source||value.evidenceKind!=='configured-owner-matched-to-authenticated-request'||
            value.identityChanged!==false||Object.keys(fixedOwner).some(k=>value[k]!==fixedOwner[k]))throw failure();
        const result=await request(url,{method:'POST',headers:{Origin:source,'Content-Type':'application/json'},body:init.body},MAXIMUM_PAGE,abort);
        // Buffer only this bounded page. Preserve the actual validated network
        // URL for the encryption client's independent redirect/origin check.
        const response=new Response(result.body,{status:200,headers:result.response.headers});
        Object.defineProperty(response,'url',{value:result.response.url});return response;
      }finally{abort.abort();all.removeEventListener('abort',cancelled);}
    },
  });
  async function run(fn) {
    if(closed||pending)throw failure();const task=(async()=>{await current();const v=await fn();await current();return v;})();pending=task;
    try{return await task;}catch{throw failure();}finally{if(pending===task)pending=null;}
  }
  return {read:command=>run(()=>client.read(command)),verifyFreeze:()=>run(()=>client.verifyFreeze()),
    async stopAndWait(){closed=true;closing.abort();client.close();if(pending)await pending.catch(()=>{});},get idle(){return pending===null;}};
}

export async function exportOwnerSessionApplication({capture,recipient,expectedOwner,sessionPath,destination,signal,pageRows}) {
  destination=resolve(destination);
  // Refuse an existing destination before any source contact. The exporter's
  // exclusive final link still guards a competing creation after this check.
  try{await lstat(destination);throw failure();}catch(error){if(error.code!=='ENOENT')throw failure();}
  const reader=await createOwnerSessionApplicationReader({capture,recipient,expectedOwner,sessionPath,signal});
  try {
    return await exportFrozenD1Application({destination,signal,pageRows,expectedFreeze:capture.freeze,
      withFrozenSource:callback=>callback({read:reader.read,verifyFreeze:reader.verifyFreeze})});
  }finally{await reader.stopAndWait();}
}
