import { TaskRequests, type TaskRequestEnvironment } from '../db/task-requests';
import { botsOwner, secretMatches, signTaskRequestTicket } from './bots-auth';
import { StorageError } from '../db/bot-storage';
import { taskRequestId } from './task-requests';

const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
export async function taskRequestBody(request:Request):Promise<Record<string,unknown>> {
  if(!request.body)throw new StorageError('Missing form operation.');
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>192*1024)throw new StorageError('Form operation too large.',413,'limit');chunks.push(r.value);}}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}
  try {const p=JSON.parse(new TextDecoder().decode(bytes));if(!p||typeof p!=='object'||Array.isArray(p))throw Error();return p;}catch{throw new StorageError('Invalid form operation.');}
}
export async function taskRequestResponse(request:Request,env:TaskRequestEnvironment & Cloudflare.Env,role:'owner'|'guest'|'service') {
  try {
    if(request.method!=='POST')throw new StorageError('Use POST for form operations.',405,'method');
    const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)throw new StorageError('Invalid form origin.',403,'origin');
    let owner:string;
    if(role==='owner') {try{owner=botsOwner(request,env);}catch{throw new StorageError('This form operation requires the authenticated owner.',403,'forbidden');}}
    else {
      owner=env.BOTS_OWNER_EMAIL?.trim().toLowerCase()??'';
      if(role==='service'&&(!env.BOTS_STORAGE_SERVICE_SECRET||!await secretMatches(request.headers.get('Authorization')?.replace(/^Bearer\s+/i,'')??'',env.BOTS_STORAGE_SERVICE_SECRET)||request.headers.get('X-Bots-Machine')!==(env.BOTS_MACHINE_ID??'dawar-vm')))throw new StorageError('Unauthorized service.',401,'unauthorized');
    }
    const forms=new TaskRequests(env,owner);await forms.initialize();
    const p=await taskRequestBody(request),action=String(p.action??'');let result:unknown;
    if(role==='owner') {
      switch(action) {
        case 'list':result=await forms.list(p);break;
        case 'read':result={request:await forms.read(taskRequestId(p.id))};break;
        case 'draft':result=await forms.draft(p);break;
        case 'edit':result=await forms.edit(p);break;
        case 'publish':result=await forms.publish(p);break;
        case 'revoke':result=await forms.revoke(p);break;
        default:throw new StorageError('Unknown owner form operation.');
      }
    } else if(role==='service') {
      switch(action) {
        case 'draft':result=await forms.draft(p);break;
        case 'pending':result=await forms.pending(p.cursor);break;
        case 'delivery':result=await forms.deliveryScope(taskRequestId(p.requestId));break;
        case 'delivery-status':result=await forms.deliveryStatus(p);break;
        case 'secure-authorize':result=await forms.secureAuthorize(p);break;
        case 'private-receipt':result=await forms.privateReceipt(p);break;
        default:throw new StorageError('Unknown private form operation.');
      }
    } else {
      const id=taskRequestId(p.id);await forms.rate(`guest:${request.headers.get('CF-Connecting-IP')??'unknown'}`);await forms.rate(`${id}:${request.headers.get('CF-Connecting-IP')??'unknown'}`);
      const token=request.headers.get('Authorization')?.replace(/^Bearer\s+/i,'')??'',pin=request.headers.get('X-Task-Request-PIN')??undefined;
      const g=await forms.authorize(id,token,pin);
      switch(action) {
        case 'read':result={request:await forms.guest(g)};break;
        case 'save':result=await forms.save(g,p);break;
        case 'upload':result=await forms.upload(g,p);break;
        case 'finalize':result=await forms.file(g,taskRequestId(p.fileId),true);break;
        case 'download':result=await forms.file(g,taskRequestId(p.fileId),false,true);break;
        case 'submit':result=await forms.submit(g,p);break;
        case 'secure-session': {
          if(!env.BOTS_TICKET_SECRET||!env.BOTS_RELAY_URL)throw new StorageError('Private transfer service unavailable.',503,'unavailable');
          const scope=await forms.secureScope(g,taskRequestId(p.submissionId)),current=Math.floor(Date.now()/1000);
          const binding={requestId:id,revision:g.revision,grantId:g.id,submissionId:scope.submissionId};
          const ticket=await signTaskRequestTicket({role:'task-request',owner,machineId:env.BOTS_MACHINE_ID??'dawar-vm',jti:crypto.randomUUID(),exp:current+60,sessionExp:current+900,binding,botId:scope.source.botId,threadId:scope.source.threadId},env.BOTS_TICKET_SECRET);
          result={ticket,url:env.BOTS_RELAY_URL,machineId:env.BOTS_MACHINE_ID??'dawar-vm',binding,expiresAt:(current+900)*1000};break;
        }
        default:throw new StorageError('Unknown guest form operation.');
      }
    }
    return Response.json(result,{headers});
  } catch(e) {
    // Database/provider errors may contain signed URLs, PINs or payloads. Never echo them.
    return Response.json({error:e instanceof StorageError?e.message:'Protected form operation unavailable. Retain the original ID and read its status.',code:e instanceof StorageError?e.code:'unavailable'}, {status:e instanceof StorageError?e.status:503,headers});
  }
}
