// Temporary original-source upload transport. The browser receives no provider
// signing fields: every new write must enter the source's durable admission.
const encoder=new TextEncoder();
const failure=()=>Error('The original storage upload could not be confirmed. Retain its original attachment and local bytes.');
const encode=bytes=>btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
function decode(text){if(typeof text!=='string'||!/^[A-Za-z0-9_-]+$/.test(text)||text.length>16384)throw failure();return Uint8Array.from(atob(text.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));}
function origin(text){const u=new URL(text);if(u.protocol!=='https:'||u.username||u.password||u.origin!==text)throw failure();return text;}
function fields(value){
  const names=['key','Content-Type','success_action_status','x-amz-algorithm','x-amz-credential','x-amz-date','policy','x-amz-signature'];
  if(!value||Object.keys(value).length!==names.length||names.some(n=>!Object.hasOwn(value,n))||
      Object.entries(value).some(([n,v])=>!names.includes(n)||typeof v!=='string'||!v||encoder.encode(v).length>8192||/[\r\n\0]/.test(v))||
      value.success_action_status!=='204'||value['x-amz-algorithm']!=='AWS4-HMAC-SHA256')throw failure();
  return value;
}
export function createStorageUploadProxy({sourceId,publicOrigin,providerOrigin,secret,transport=globalThis.fetch}){
  if(!/^[a-f0-9]{12}$/.test(sourceId)||typeof secret!=='string'||secret.length<16||typeof transport!=='function')throw failure();
  origin(publicOrigin);origin(providerOrigin);
  const path='/api/migration/storage-upload';
  const aad=encoder.encode(JSON.stringify({version:1,sourceId,publicOrigin,path,providerOrigin}));
  const key=crypto.subtle.digest('SHA-256',encoder.encode('dawar-original-upload-proxy\0'+secret))
    .then(bytes=>crypto.subtle.importKey('raw',bytes,'AES-GCM',false,['encrypt','decrypt']));
  async function target(provider,{minimumBytes,maximumBytes}){
    const now=Date.now();
    if(provider?.url!==providerOrigin+'/'||!Number.isSafeInteger(minimumBytes)||minimumBytes<0||
        !Number.isSafeInteger(maximumBytes)||maximumBytes<minimumBytes||maximumBytes>250*1024*1024)throw failure();
    const captured=fields(provider.fields),policy=JSON.parse(atob(captured.policy)),expires=Date.parse(policy.expiration);
    if(!Number.isSafeInteger(expires)||expires<=now||expires>now+900000||
        !Array.isArray(policy.conditions)||!policy.conditions.some(c=>Array.isArray(c)&&c.length===3&&c[0]==='content-length-range'&&c[1]===minimumBytes&&c[2]===maximumBytes))throw failure();
    const body=encoder.encode(JSON.stringify({version:1,sourceId,url:provider.url,fields:captured,minimumBytes,maximumBytes,expires}));
    if(body.length>10000)throw failure();
    const iv=crypto.getRandomValues(new Uint8Array(12));
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},await key,body);
    const u=new URL(path,publicOrigin);u.searchParams.set('grant',encode(iv)+'.'+encode(new Uint8Array(encrypted)));
    return {url:u.toString(),fields:{}};
  }
  async function handle(request){
    let reader,settled=false,providerStarted=false;
    try{
      const u=new URL(request.url),requestOrigin=request.headers.get('origin');
      if(request.method!=='POST'||u.origin!==publicOrigin||u.pathname!==path||u.searchParams.size!==1||
          !u.searchParams.has('grant')||requestOrigin&&requestOrigin!==publicOrigin)throw failure();
      const parts=u.searchParams.get('grant').split('.');if(parts.length!==2)throw failure();
      const iv=decode(parts[0]);if(iv.length!==12)throw failure();
      const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad},await key,decode(parts[1]))));
      const now=Date.now();
      if(!value||Object.keys(value).length!==7||value.version!==1||value.sourceId!==sourceId||value.url!==providerOrigin+'/'||
          !Number.isSafeInteger(value.expires)||value.expires<=now||value.expires>now+900000||
          !Number.isSafeInteger(value.minimumBytes)||value.minimumBytes<0||!Number.isSafeInteger(value.maximumBytes)||
          value.maximumBytes<value.minimumBytes||value.maximumBytes>250*1024*1024)throw failure();
      const captured=fields(value.fields),type=request.headers.get('content-type');
      const match=type?.match(/^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))$/i);
      const lengthText=request.headers.get('content-length'),length=Number(lengthText);
      if(!match||!lengthText||!/^\d+$/.test(lengthText)||!Number.isSafeInteger(length)||length<1||length>value.maximumBytes+65536||!request.body)throw failure();
      request.signal.throwIfAborted();
      const boundary=match[1]??match[2];
      const prefix=encoder.encode(Object.entries(captured).map(([name,text])=>`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`).join(''));
      reader=request.body.getReader();let bytes=0,prefixed=false;
      const body=new ReadableStream({
        async pull(controller){
          if(!prefixed){prefixed=true;controller.enqueue(prefix);return;}
          try{
            request.signal.throwIfAborted();if(Date.now()>=value.expires)throw failure();
            const part=await reader.read();
            if(part.done){if(bytes!==length)throw failure();settled=true;reader.releaseLock();controller.close();return;}
            bytes+=part.value.length;if(bytes>length)throw failure();controller.enqueue(part.value);
          }catch(error){controller.error(error);await reader.cancel().catch(()=>{});}
        },
        async cancel(){await reader.cancel().catch(()=>{});},
      });
      // Exactly one provider attempt. No cookies, bearer credentials, incoming
      // identity headers, redirects or provider response bodies reach callers.
      providerStarted=true;
      const response=await transport(value.url,{method:'POST',headers:{'content-type':type,'content-length':String(prefix.length+length)},
        body,duplex:'half',redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(Math.min(900000,value.expires-now))])});
      if(response.status!==204||!settled){await response.body?.cancel().catch(()=>{});throw failure();}
      await response.body?.cancel();
      return new Response(null,{status:204,headers:{'Cache-Control':'private, no-store'}});
    }catch{
      if(reader&&!settled)await reader.cancel().catch(()=>{});
      if(!providerStarted)return Response.json({error:'The original upload capability is invalid or unavailable. Retain local bytes.'},
        {status:403,headers:{'Cache-Control':'private, no-store'}});
      // The enclosing source-writer scope retains an unknown outcome on any
      // ambiguous provider failure; a response alone is not file freeze proof.
      throw failure();
    }
  }
  return {target,handle};
}
