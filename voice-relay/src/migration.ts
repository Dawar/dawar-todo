import {createVoiceMigrationLedger,type VoiceBinding} from './migration-ledger.mjs';

type Configuration=VoiceBinding & {version:1;credential:string;cutoverId:string;releaseId:string};
export type VoiceMigrationEnvironment={VOICE_WRITER_CONTROL?:string;VOICE_WRITER_ADMISSION?:string;VOICE_WRITER_COORDINATOR?:DurableObjectNamespace;VOICE_EFFECT_SCOPE?:VoiceEffectScope;VOICE_RUNTIME?:unknown};
const bad=()=>Error('Original voice work is held or unconfirmed.');
const headers={'Cache-Control':'private, no-store','Content-Type':'application/json','X-Content-Type-Options':'nosniff'};
function exact(v:unknown,fields:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==fields.length||Object.keys(v).some(k=>!fields.includes(k)))throw bad();}
function configuration(env:VoiceMigrationEnvironment){
  if(!env.VOICE_WRITER_CONTROL)return null;
  if(env.VOICE_RUNTIME||!env.VOICE_WRITER_COORDINATOR||new TextEncoder().encode(env.VOICE_WRITER_CONTROL).length>4096)throw bad();
  const c=JSON.parse(env.VOICE_WRITER_CONTROL) as Configuration;exact(c,['version','sourceId','installationId','producerSHA256','credential','cutoverId','releaseId']);
  if(c.version!==1||!/^[a-f0-9]{40}$/.test(c.sourceId)||!/^[a-f0-9]{64}$/.test(c.producerSHA256)||
    [c.installationId,c.cutoverId,c.releaseId].some(v=>typeof v!=='string'||!v||v.length>512||/[\s\0]/.test(v))||
    new Set([c.installationId,c.cutoverId,c.releaseId]).size!==3||typeof c.credential!=='string'||!/^[-_A-Za-z0-9]{32,512}$/.test(c.credential))throw bad();
  return c;
}
const binding=(c:Configuration)=>({sourceId:c.sourceId,installationId:c.installationId,producerSHA256:c.producerSHA256});
// Installing the original controller and enabling its admission are separate
// deployment actions. The private control remains available with admission off.
// An enabled binding must match the already installed original exactly.
export function voiceAdmissionEnabled(env:VoiceMigrationEnvironment){
  if(env.VOICE_WRITER_ADMISSION===undefined)return false;
  const raw=env.VOICE_WRITER_ADMISSION,c=configuration(env);
  if(!c||typeof raw!=='string'||!raw||new TextEncoder().encode(raw).length>2048)throw bad();
  const expected=JSON.parse(raw);exact(expected,['sourceId','installationId','producerSHA256']);
  if(Object.entries(binding(c)).some(([key,value])=>expected[key]!==value))throw bad();
  return true;
}
async function body(request:Request){
  const reader=request.body?.getReader();if(!reader)throw bad();let size=0,parts=0;const values:Uint8Array[]=[];
  const deadline=AbortSignal.timeout(4500);
  const next=()=>new Promise<ReadableStreamReadResult<Uint8Array>>((resolve,reject)=>{
    const abort=()=>reject(bad());deadline.addEventListener('abort',abort,{once:true});if(deadline.aborted)abort();
    reader.read().then(resolve,reject).finally(()=>deadline.removeEventListener('abort',abort));
  });
  try{for(;;){deadline.throwIfAborted();const r=await next();if(r.done)break;size+=r.value.length;if(size>4096||++parts>64)throw bad();values.push(r.value);}
    const bytes=new Uint8Array(size);let at=0;for(const value of values){bytes.set(value,at);at+=value.length;}return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as Record<string,unknown>;
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function authorize(request:Request,c:Configuration){
  if(request.headers.has('Origin')||request.method!=='POST'||request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw bad();
  const a=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.headers.get('Authorization')??'')));
  const b=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`Bearer ${c.credential}`)));let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];if(mismatch)throw bad();
}
async function command(env:VoiceMigrationEnvironment,c:Configuration,action:string,args:Record<string,unknown>){
  const stub=env.VOICE_WRITER_COORDINATOR!.get(env.VOICE_WRITER_COORDINATOR!.idFromName(c.installationId));
  const response=await stub.fetch('https://voice-coordinator/command',{method:'POST',headers:{Authorization:`Bearer ${c.credential}`,'Content-Type':'application/json'},body:JSON.stringify({binding:binding(c),action,args}),signal:AbortSignal.timeout(4500)});
  if(response.status!==200)throw bad();return await response.json() as Record<string,unknown>;
}
export class VoiceMigrationCoordinator{
  constructor(private readonly state:DurableObjectState,private readonly env:VoiceMigrationEnvironment){}
  async fetch(request:Request){try{const c=configuration(this.env);if(!c)throw bad();const u=new URL(request.url);if(u.pathname!=='/command'||u.search)throw bad();await authorize(request,c);
    const input=await body(request);const result=await createVoiceMigrationLedger(this.state.storage,binding(c)).command(input as Parameters<ReturnType<typeof createVoiceMigrationLedger>['command']>[0]);return Response.json(result,{headers});
  }catch{return Response.json({error:'Voice admission or original receipt is unavailable.'},{status:503,headers});}}
}
export async function voiceMigrationControl(request:Request,env:VoiceMigrationEnvironment){
  if(!env.VOICE_WRITER_CONTROL)return Response.json({error:'Voice migration control is not enabled.'},{status:404,headers});
  try{const c=configuration(env);if(!c)throw bad();const u=new URL(request.url);if(u.pathname!=='/api/migration/voice/control'||u.search)throw bad();await authorize(request,c);const input=await body(request);
    if(input.action==='install'||input.action==='read'){exact(input,['action']);return Response.json(await command(env,c,input.action,{}),{headers});}
    if(input.action==='drain'){exact(input,['action','expiresAt']);return Response.json(await command(env,c,'drain',{operationId:c.cutoverId,expiresAt:input.expiresAt}),{headers});}
    if(input.action==='release'){exact(input,['action','generation']);return Response.json(await command(env,c,'release',{operationId:c.releaseId,drainId:c.cutoverId,generation:input.generation}),{headers});}
    if(input.action==='receipt'){exact(input,['action','receipt']);const ids={install:c.installationId,drain:c.cutoverId,release:c.releaseId};if(!Object.hasOwn(ids,String(input.receipt)))throw bad();return Response.json(await command(env,c,'receipt',{operationId:ids[input.receipt as keyof typeof ids]}),{headers});}
    throw bad();
  }catch{return Response.json({error:'Voice control or original receipt is unavailable.'},{status:503,headers});}
}

export class VoiceEffectScope{
  private pending=new Set<Promise<unknown>>();private sockets=new Set<WebSocket>();private uncertain=false;private ending=false;private closed=false;
  constructor(readonly operationId:string,private readonly fingerprint:string,private readonly env:VoiceMigrationEnvironment,private readonly c:Configuration,private readonly context:ExecutionContext|DurableObjectState){}
  assertOpen(){if(this.closed)throw bad();}
  track<T>(factory:()=>Promise<T>):Promise<T>{
    if(this.closed||this.pending.size>=1024){this.uncertain=true;throw bad();}
    const task=Promise.resolve().then(factory);this.pending.add(task);
    void task.then(()=>{this.pending.delete(task);this.finish();},()=>{this.uncertain=true;this.pending.delete(task);this.finish();});return task;
  }
  socket(socket:WebSocket){if(this.closed||this.sockets.size>=64){this.uncertain=true;throw bad();}this.sockets.add(socket);
    socket.addEventListener('error',()=>{this.uncertain=true;});socket.addEventListener('close',()=>{this.sockets.delete(socket);this.finish();},{once:true});return socket;
  }
  response(response:Response){
    const socket=(response as Response & {webSocket?:WebSocket}).webSocket;if(socket){this.socket(socket);return response;}
    if(!response.body)return response;this.assertOpen();const reader=response.body.getReader();let done!:()=>void;
    const lifetime=new Promise<void>(resolve=>{done=resolve;});this.track(()=>lifetime);let ended=false;
    const end=()=>{if(!ended){ended=true;reader.releaseLock();done();}};
    return new Response(new ReadableStream<Uint8Array>({
      pull:async controller=>{try{const r=await reader.read();if(r.done){end();controller.close();}else controller.enqueue(r.value);}catch(error){this.unknown();end();controller.error(error);}},
      cancel:async reason=>{this.unknown();try{await reader.cancel(reason);}finally{end();}},
    }),{status:response.status,statusText:response.statusText,headers:response.headers});
  }
  unknown(){this.uncertain=true;}
  end(){this.ending=true;this.finish();}
  private finish(){if(this.closed||!this.ending||this.pending.size||this.sockets.size)return;this.closed=true;
    this.context.waitUntil(command(this.env,this.c,'settle',{operationId:this.operationId,fingerprint:this.fingerprint,outcome:this.uncertain?'unknown':'finished'}).catch(()=>{/* Durable active original remains blocking; no retry. */}));
  }
}
export async function voiceAdmit(env:VoiceMigrationEnvironment,context:ExecutionContext|DurableObjectState,kind:'http'|'scheduled'|'stream'|'sip',parentId:string|null=null){
  if(!voiceAdmissionEnabled(env))return null;
  const c=configuration(env);if(!c)throw bad();const operationId=crypto.randomUUID();const r=await command(env,c,'admit',{operationId,kind,parentId});
  if(r.admitted!==true||r.operationId!==operationId||typeof r.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(r.fingerprint))throw bad();
  return new VoiceEffectScope(operationId,r.fingerprint,env,c,context);
}
