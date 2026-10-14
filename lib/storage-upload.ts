import { replayableStorageFetch } from './storage-transfer';

export type StoragePostTarget={url:string;fields:Record<string,string>;resumable?:{version:1;chunkBytes:number}};
type Status={version:number;uploadId:string;state:string;size:number;sha256:string|null;chunkBytes:number;parts:{part:number;hash:string;size:number}[]};
const CHUNK=4*1024*1024,MAX=250*1024*1024;
const hash=async(blob:Blob)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
const failure=()=>Error('Upload confirmation is unavailable. Retain the original attachment and bytes; retry to reconcile its receipt.');
async function readStatus(response:Response):Promise<Status>{
  if(!response.ok||!response.body)throw failure();const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>16384)throw failure();chunks.push(r.value);}return JSON.parse(await new Blob(chunks as BlobPart[]).text()) as Status;}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}

/** Additive portable target only; legacy provider transport is unchanged.
 * The full chunk manifest binds retries to exact bytes before any write.
 * No mutation is automatically replayed after a timeout or ambiguous status.
 */
export async function uploadStorageBlob(transport:typeof fetch,target:StoragePostTarget,body:Blob,options:{name?:string;signal?:AbortSignal;sha256?:string;validate?:()=>void;progress?:(n:number)=>void;legacyMode?:RequestMode;legacyReplay?:boolean;legacyCredentials?:RequestCredentials;legacyReferrerPolicy?:ReferrerPolicy}={}){
  const check=()=>{options.signal?.throwIfAborted();options.validate?.();};check();
  if(!target.resumable){
    const form=new FormData();for(const [k,v]of Object.entries(target.fields))form.set(k,v);form.set('file',body,options.name??'upload');
    const init:RequestInit={method:'POST',body:form,redirect:'error',signal:options.signal,...(options.legacyMode?{mode:options.legacyMode}:{}),...(options.legacyCredentials?{credentials:options.legacyCredentials}:{}),...(options.legacyReferrerPolicy?{referrerPolicy:options.legacyReferrerPolicy}:{})};
    return options.legacyReplay?replayableStorageFetch(transport,target.url,init):transport(target.url,init);
  }
  const original=new URL(target.url);
  if(target.resumable.version!==1||target.resumable.chunkBytes!==CHUNK||Object.keys(target.resumable).length!==2||original.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(original.hostname)||typeof window!=='undefined'&&original.origin!==window.location.origin||original.pathname!=='/storage/object'||original.username||original.password||original.hash||original.searchParams.size!==1||!original.searchParams.get('grant')||body.size>MAX||options.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(options.sha256))throw failure();
  const hashes:string[]=[];
  for(let offset=0;offset<body.size;offset+=CHUNK){check();hashes.push(await hash(body.slice(offset,offset+CHUNK)));check();}
  const url=(action:string,part?:number)=>{const u=new URL(original);u.searchParams.set('action',action);if(part!==undefined)u.searchParams.set('part',String(part));return u;};
  const request=async(input:URL,init:RequestInit)=>{
    check();const abort=new AbortController(),timer=setTimeout(()=>abort.abort(failure()),120000),signal=options.signal?AbortSignal.any([options.signal,abort.signal]):abort.signal;
    try{const result=await readStatus(await transport(input,{...init,signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'}));signal.throwIfAborted();check();return result;}
    finally{clearTimeout(timer);}
  };
  const status=(action:string,init:RequestInit)=>request(url(action),init);
  const validate=(s:Status,identity?:string)=>{
    if(!s||s.version!==1||!/^[a-f0-9]{64}$/.test(s.uploadId)||identity&&s.uploadId!==identity||s.size!==body.size||s.chunkBytes!==CHUNK||!['uploading','assembling','done'].includes(s.state)||!Array.isArray(s.parts)||s.parts.length>hashes.length||new Set(s.parts.map(p=>p.part)).size!==s.parts.length||s.parts.some(p=>!Number.isSafeInteger(p.part)||p.part<0||p.part>=hashes.length||p.hash!==hashes[p.part]||p.size!==Math.min(CHUNK,body.size-p.part*CHUNK))||s.state==='done'&&(!/^[a-f0-9]{64}$/.test(s.sha256??'')||options.sha256&&s.sha256!==options.sha256))throw failure();
    return s;
  };
  let current=validate(await status('begin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({size:body.size,hash:options.sha256??null,chunks:hashes})}));const identity=current.uploadId;
  if(current.state==='done')return new Response(null,{status:204});
  if(current.state==='assembling'){current=validate(await status('finish',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),identity);if(current.state!=='done')throw failure();return new Response(null,{status:204});}
  for(let i=0;i<hashes.length;i++){
    check();if(current.parts.some(p=>p.part===i))continue;
    try{
      current=validate(await request(url('chunk',i),{method:'PUT',headers:{'content-type':'application/octet-stream','x-dawar-chunk-sha256':hashes[i]},body:body.slice(i*CHUNK,(i+1)*CHUNK)}),identity);check();
    }catch(error){
      check();current=validate(await status('status',{method:'GET'}),identity);
      if(!current.parts.some(p=>p.part===i))throw error;
    }
    options.progress?.(Math.floor((i+1)*95/hashes.length));
  }
  try{current=validate(await status('finish',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),identity);}
  catch(error){check();current=validate(await status('status',{method:'GET'}),identity);if(current.state!=='done')throw error;}
  if(current.state!=='done')throw failure();check();return new Response(null,{status:204});
}
