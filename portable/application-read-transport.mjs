import {applicationReadBinding,snapshotRecipient,sealApplicationRead,unsealApplicationRead} from './snapshot-sealing.mjs';
import {createApplicationFreezeVerifier} from './application-read-source.mjs';

const encoder=new TextEncoder(),PATH='/api/migration/application/read';
const MAXIMUM_REQUEST=112*1024,MAXIMUM_RESPONSE=6*1024*1024;
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const failure=()=>Error('The original authenticated application read could not be confirmed.');
const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
function captured({sourceOrigin,captureId,freeze}) {
  const value=applicationReadBinding({sourceOrigin,captureId,freeze,requestId:'validation-only',sequence:1,commandSHA256:'0'.repeat(64)});
  return {sourceOrigin:value.sourceOrigin,captureId:value.captureId,freeze:value.freeze};
}
function checkProof(proof,freeze) {
  if(!proof||Object.keys(freeze).some(k=>proof[k]!==freeze[k]))throw failure();
}
function safeCommand(command) {
  if(command===null)return null;
  // The source reader additionally validates the exact command fields and
  // derives columns/order from its own schema. This transport never takes SQL.
  const text=JSON.stringify(command);
  if(typeof text!=='string'||encoder.encode(text).length>100000)throw failure();
  const value=JSON.parse(text);
  if(!value||typeof value!=='object'||Array.isArray(value)||
      !['inventory','page','schema','tables','sequence-present','sequences','columns','count','sizes','rows'].includes(value.kind)||
      Object.keys(value).some(k=>!['kind','table','last','limit'].includes(k)))throw failure();
  return value;
}
async function boundedJSON(message,maximum,signal) {
  signal.throwIfAborted();
  const length=message.headers.get('Content-Length');
  if(length!==null&&(!/^(?:0|[1-9][0-9]*)$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>maximum))throw failure();
  if(!message.body)throw failure();
  const reader=message.body.getReader(),chunks=[];let total=0,done=false;
  try {
    while(true) {
      // An untrusted request/response body can stall without producing another
      // chunk. Cancellation must interrupt that await, not just check afterward.
      const next=await new Promise((resolve,reject)=>{
        const aborted=()=>reject(failure());signal.addEventListener('abort',aborted,{once:true});
        if(signal.aborted)aborted();
        reader.read().then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted));
      });signal.throwIfAborted();
      if(next.done){done=true;break;}
      if(!(next.value instanceof Uint8Array)||(total+=next.value.length)>maximum||chunks.length>=4096)throw failure();
      chunks.push(next.value.slice());
    }
    if(length!==null&&total!==Number(length))throw failure();
    const bytes=new Uint8Array(total);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function laneSignal(signal,requestSignal) {
  return AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[]),...(requestSignal?[requestSignal]:[])]);
}
function cleanRequest(request,origin) {
  const url=new URL(request.url),site=request.headers.get('Sec-Fetch-Site'),referer=request.headers.get('Referer');
  if(url.origin!==origin||url.pathname!==PATH||url.search||url.hash||request.headers.has('Authorization')||
      request.headers.get('Origin')!==origin||site&&!['none','same-origin'].includes(site)||
      request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw failure();
  if(referer&&new URL(referer).origin!==origin)throw failure();
}

// Internal connection only. The application must supply its real validated
// original-owner session callback, captured recipient and complete controller.
// There is no default owner/header authentication or freeze assertion here.
export function createApplicationReadEndpoint({capture,recipientPublicKey,expectedOwner,authorizeOwner,read,verifyFreeze,signal}) {
  const original=captured(capture),owner=JSON.parse(JSON.stringify(expectedOwner));
  if(!owner||typeof owner.ownerUserId!=='string'||!owner.ownerUserId||typeof owner.ownerKey!=='string'||!owner.ownerKey||
      Object.keys(owner).some(k=>!['ownerUserId','ownerKey'].includes(k))||typeof authorizeOwner!=='function'||
      typeof read!=='function'||typeof verifyFreeze!=='function'||typeof recipientPublicKey!=='string')throw failure();
  let closed=false,active=null;const closing=new AbortController();
  const verify=createApplicationFreezeVerifier({expectedFreeze:original.freeze,verifyFreeze,
    signal:AbortSignal.any([closing.signal,...(signal?[signal]:[])]),stillReading:()=>!closed});
  async function authorized(request) {
    const value=await authorizeOwner(request);
    if(closed||value?.ownerUserId!==owner.ownerUserId||value?.ownerKey!==owner.ownerKey)throw failure();
  }
  return {
    async stopAndWait() {closed=true;closing.abort();if(active)await active;},
    get idle(){return active===null;},
    async fetch(request) {
      if(request.method!=='POST')return Response.json({error:'Use POST for the original application read.'},{status:405,headers:{...headers,Allow:'POST'}});
      if(closed)return Response.json({error:'The original application read is closed.'},{status:503,headers});
      if(active)return Response.json({error:'An original application read is already running.'},{status:409,headers});
      let settle;active=new Promise(resolve=>{settle=resolve;});
      const requestSignal=laneSignal(AbortSignal.any([closing.signal,...(signal?[signal]:[])]),request.signal);
      try {
        cleanRequest(request,original.sourceOrigin);await authorized(request);requestSignal.throwIfAborted();
        // Invalid recipient/configuration fails before reading any source data.
        const recipient=await snapshotRecipient(recipientPublicKey);requestSignal.throwIfAborted();
        const wire=await boundedJSON(request,MAXIMUM_REQUEST,requestSignal);
        if(!wire||typeof wire!=='object'||Array.isArray(wire)||Object.keys(wire).length!==9||
            Object.keys(wire).some(k=>!['version','kind','captureId','requestId','sequence','commandSHA256','freeze','recipientFingerprint','command'].includes(k))||
            wire.version!==1||wire.kind!=='dawar-application-read'||wire.recipientFingerprint!==recipient.fingerprint)throw failure();
        const command=safeCommand(wire.command);
        const binding=applicationReadBinding({sourceOrigin:original.sourceOrigin,captureId:wire.captureId,requestId:wire.requestId,sequence:wire.sequence,commandSHA256:wire.commandSHA256,freeze:wire.freeze});
        if(binding.captureId!==original.captureId||JSON.stringify(binding.freeze)!==JSON.stringify(original.freeze)||binding.commandSHA256!==await sha(command))throw failure();
        const before=await verify();checkProof(before,original.freeze);await authorized(request);requestSignal.throwIfAborted();
        const rows=command===null?null:await read(command);
        if(rows!==null&&(!Array.isArray(rows)||rows.length>4000||encoder.encode(JSON.stringify(rows)).length>4*1024*1024))throw failure();
        const proof=await verify();checkProof(proof,original.freeze);await authorized(request);requestSignal.throwIfAborted();
        const sealed=await sealApplicationRead({rows,proof},recipientPublicKey,binding);
        // Encryption may await key operations. Do not publish after controller
        // release, owner change, expiry, cancellation or changed generation.
        const final=await verify();checkProof(final,original.freeze);await authorized(request);requestSignal.throwIfAborted();
        const body=JSON.stringify(sealed);if(encoder.encode(body).length>MAXIMUM_RESPONSE)throw failure();
        return new Response(body,{headers:{...headers,'Content-Type':'application/json'}});
      }catch {
        return Response.json({error:'The original owner, complete freeze or bounded application read could not be confirmed.'},{status:503,headers});
      }finally{settle();active=null;}
    },
  };
}

// fetchOwned must be the existing owner's authenticated HTTPS session transport.
// Cookies/credentials are never serialized into the page protocol. No redirects,
// bearer-token fallback, silent retries or replacement capture are performed.
export function createApplicationReadClient({capture,recipient,fetchOwned,signal}) {
  const original=captured(capture),key=JSON.parse(JSON.stringify(recipient));
  if(typeof fetchOwned!=='function'||key?.version!==1||key.kind!=='dawar-snapshot-recipient')throw failure();
  const endpoint=original.sourceOrigin+PATH,closing=new AbortController();let closed=false,active=false,sequence=0;
  let receivedProof;
  const verify=createApplicationFreezeVerifier({expectedFreeze:original.freeze,verifyFreeze:async()=>receivedProof,
    signal:AbortSignal.any([closing.signal,...(signal?[signal]:[])]),stillReading:()=>!closed});
  async function exchange(command) {
    command=safeCommand(command);
    if(closed||active)throw failure();active=true;
    const requestSignal=laneSignal(AbortSignal.any([closing.signal,...(signal?[signal]:[])]));
    try {
      const target=await snapshotRecipient(key.publicKey);requestSignal.throwIfAborted();
      if(target.fingerprint!==key.fingerprint)throw failure();
      const binding=applicationReadBinding({...original,requestId:crypto.randomUUID(),sequence:++sequence,commandSHA256:await sha(command)});
      const body=JSON.stringify({version:1,kind:'dawar-application-read',...Object.fromEntries(Object.entries(binding).filter(([k])=>k!=='sourceOrigin')),recipientFingerprint:key.fingerprint,command});
      if(encoder.encode(body).length>MAXIMUM_REQUEST)throw failure();
      const response=await fetchOwned(endpoint,{method:'POST',credentials:'include',redirect:'error',cache:'no-store',signal:requestSignal,
        headers:{'Content-Type':'application/json','Origin':original.sourceOrigin},body});
      requestSignal.throwIfAborted();
      if(closed||!(response instanceof Response)||response.status!==200||response.redirected||response.url!==endpoint||
          response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw failure();
      const envelope=await boundedJSON(response,MAXIMUM_RESPONSE,requestSignal);
      const {payload}=await unsealApplicationRead(envelope,key,binding);requestSignal.throwIfAborted();
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).length!==2||!Object.hasOwn(payload,'rows')||!Object.hasOwn(payload,'proof')||
          command===null&&payload.rows!==null||command!==null&&(!Array.isArray(payload.rows)||payload.rows.length>4000||encoder.encode(JSON.stringify(payload.rows)).length>4*1024*1024))throw failure();
      checkProof(payload.proof,original.freeze);
      receivedProof=payload.proof;
      await verify();return payload;
    }finally{active=false;}
  }
  return {read:async command=>(await exchange(command)).rows,verifyFreeze:async()=>(await exchange(null)).proof,
    close(){closed=true;closing.abort();},get idle(){return !active;}};
}
