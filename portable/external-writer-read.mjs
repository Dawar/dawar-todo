// A configured producer authenticates a fresh observation of its OWN held
// writers. Neither the browser nor a saved JSON proof can assert quiescence.
const encode=value=>new TextEncoder().encode(JSON.stringify(value));
const failure=()=>Error('The original external writer observation was not confirmed.');
const fields=['scope','sourceId','installationId','producerSHA256','operationId','epoch','generation','expiresAt'];
const proofFields=[...fields,'version','kind','status','observedAt','controllerOperationId','releaseAuthority','automaticExpiryRelease','admittedWriters','unknownWriters','newStartsHeld','currentToolsSettled','currentVolatileStateSettled'];
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw failure();}
function decode(value,size){
  if(typeof value!=='string'||!/^[A-Za-z0-9_-]+$/.test(value))throw failure();
  const result=Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  if(result.length!==size)throw failure();return result;
}
async function body(response,signal){
  if(!response.body)throw failure();
  const reader=response.body.getReader();const chunks=[];let size=0,done=false;
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
    while(true){signal.throwIfAborted();const r=await reader.read();signal.throwIfAborted();if(r.done){done=true;break;}
      if(!(r.value instanceof Uint8Array)||(size+=r.value.length)>16*1024||chunks.length>=256)throw failure();chunks.push(r.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{signal.removeEventListener('abort',abort);if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
function abortable(task,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(failure());signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

export function createExternalWriterObserver({endpoint,publicKey,credential,controllerOperationId,binding,fetcher=fetch}){
  exact(binding,fields);const original=JSON.parse(JSON.stringify(binding));
  const url=new URL(endpoint);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/api/migration/writers/observe'||
      typeof credential!=='string'||credential.length<32||credential.length>512||/[\s\0]/.test(credential)||
      typeof controllerOperationId!=='string'||!controllerOperationId||controllerOperationId.length>1024||typeof fetcher!=='function')throw failure();
  const target=url.href,keyBytes=decode(publicKey,32),token=credential,operation=controllerOperationId;
  return async(expected,signal)=>{
    if(JSON.stringify(expected)!==JSON.stringify(original))throw failure();
    const challenge=crypto.randomUUID(),local=AbortSignal.any([signal,AbortSignal.timeout(4500)]);
    const request={version:1,kind:'dawar-external-writer-observation',challenge,controllerOperationId:operation,binding:original};
    // Workerd supports manual rather than error redirect mode. Refuse every
    // non-200 response below; credentials never follow a Location header.
    const response=await fetcher(target,{method:'POST',redirect:'manual',cache:'no-store',signal:local,
      headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','User-Agent':'DawarTodoMigration/1'},body:JSON.stringify(request)});
    local.throwIfAborted();
    if(!(response instanceof Response)||response.status!==200||response.redirected||response.url!==target||
        response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw failure();
    const result=await body(response,local);exact(result,['version','kind','challenge','controllerOperationId','binding','proof','signature']);
    if(result.version!==1||result.kind!=='dawar-external-writer-observation'||result.challenge!==challenge||
        result.controllerOperationId!==operation||JSON.stringify(result.binding)!==JSON.stringify(original))throw failure();
    const signature=decode(result.signature,64),key=await crypto.subtle.importKey('raw',keyBytes,'Ed25519',false,['verify']);
    const signed={version:1,kind:result.kind,challenge,controllerOperationId:operation,binding:original,proof:result.proof};
    if(!await crypto.subtle.verify('Ed25519',key,signature,encode(signed)))throw failure();
    local.throwIfAborted();return result.proof;
  };
}

// Producer-side adapter: observe is captured from the actual writer controller,
// receives no caller-provided state, and must freshly prove its held lifetime.
// This adapter never installs a fence or turns a caller assertion into a proof.
export function createExternalWriterObservationEndpoint({binding,controllerOperationId,credential,privateKey,observe}){
  exact(binding,fields);const original=JSON.parse(JSON.stringify(binding)),operation=controllerOperationId,token=credential;
  if(typeof operation!=='string'||!operation||operation.length>1024||typeof token!=='string'||token.length<32||token.length>512||/[\s\0]/.test(token)||
      typeof privateKey!=='string'||!/^[A-Za-z0-9_-]{48,256}$/.test(privateKey)||typeof observe!=='function')throw failure();
  const keyBytes=Uint8Array.from(atob(privateKey.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
  let active=false;
  return {async fetch(request){
    const headers={'Cache-Control':'private, no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
    if(active)return Response.json({error:'Original observation is busy.'},{status:409,headers});
    active=true;let observedTask,observationSettled=false;
    try{
      const url=new URL(request.url);
      if(request.method!=='POST'||url.pathname!=='/api/migration/writers/observe'||url.search||url.hash||request.headers.has('Origin')||
          request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json')throw failure();
      const a=new TextEncoder().encode(request.headers.get('Authorization')??''),b=new TextEncoder().encode(`Bearer ${token}`);
      const da=new Uint8Array(await crypto.subtle.digest('SHA-256',a)),db=new Uint8Array(await crypto.subtle.digest('SHA-256',b));
      let difference=0;for(let i=0;i<da.length;i++)difference|=da[i]^db[i];if(difference)throw failure();
      const signal=AbortSignal.any([request.signal,AbortSignal.timeout(4500)]),input=await body(request,signal);
      exact(input,['version','kind','challenge','controllerOperationId','binding']);
      if(input.version!==1||input.kind!=='dawar-external-writer-observation'||typeof input.challenge!=='string'||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.challenge)||input.controllerOperationId!==operation||
          JSON.stringify(input.binding)!==JSON.stringify(original))throw failure();
      observedTask=Promise.resolve().then(()=>observe(signal));
      void observedTask.then(()=>{observationSettled=true;},()=>{observationSettled=true;});
      const proof=await abortable(observedTask,signal);signal.throwIfAborted();exact(proof,proofFields);
      if(!proof||fields.some(k=>proof[k]!==original[k])||proof.version!==1||proof.kind!=='dawar-external-writer-freeze'||proof.status!=='frozen'||
          proof.controllerOperationId!==operation||proof.releaseAuthority!=='captured-controller'||proof.automaticExpiryRelease!==false||
          proof.admittedWriters!==0||proof.unknownWriters!==0||proof.newStartsHeld!==true||proof.currentToolsSettled!==true||proof.currentVolatileStateSettled!==true||
          !Number.isSafeInteger(proof.observedAt)||Math.abs(Date.now()-proof.observedAt)>5000||Date.now()>=proof.expiresAt)throw failure();
      const signed={version:1,kind:input.kind,challenge:input.challenge,controllerOperationId:operation,binding:original,proof};
      const key=await crypto.subtle.importKey('pkcs8',keyBytes,'Ed25519',false,['sign']);
      const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key,encode(signed)));
      signal.throwIfAborted();if(Date.now()>=proof.expiresAt||Math.abs(Date.now()-proof.observedAt)>5000)throw failure();
      const text=JSON.stringify({...signed,signature:btoa(String.fromCharCode(...signature)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')});
      if(new TextEncoder().encode(text).length>16*1024)throw failure();return new Response(text,{headers});
    }catch{return Response.json({error:'Original held writer observation was not confirmed.'},{status:503,headers});}
    finally{
      // Abort bounds the response, not the real controller's lifetime. A
      // cancelled reader must settle before another observation may enter.
      if(observedTask&&!observationSettled)void observedTask.then(()=>{active=false;},()=>{active=false;});
      else active=false;
    }
  }};
}
