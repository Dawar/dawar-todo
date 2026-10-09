import { encryptSecureInput, type SecureDescriptor, type SecureEnvelope, type SecurePayload, type SecureRequest } from './secure-input';
import { transferSecureInput } from '../app/bots/secure-input-transfer';
import type { TaskRequestGuestAction, TaskRequestOwnerAction, TaskRequestSecureSession } from './task-requests';

export async function taskRequestOwner<T>(action:TaskRequestOwnerAction,signal?:AbortSignal):Promise<T> {
  return formFetch<T>('/api/task-requests/owner',action,{},signal);
}
export async function taskRequestGuest<T>(action:TaskRequestGuestAction,token:string,pin?:string,signal?:AbortSignal):Promise<T> {
  // Link/PIN stay in caller RAM; never query strings, ordinary journals or storage.
  return formFetch<T>('/api/task-requests/guest',action,{Authorization:`Bearer ${token}`,...(pin===undefined?{}:{'X-Task-Request-PIN':pin})},signal);
}
async function formFetch<T>(url:string,action:unknown,headers:Record<string,string>,signal?:AbortSignal):Promise<T> {
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(action),redirect:'error',cache:'no-store',credentials:url.endsWith('/guest')?'omit':'same-origin',referrerPolicy:'no-referrer',signal});
  const value=await response.json() as {error?:string;code?:string};if(!response.ok)throw Object.assign(Error(value.error??'Protected form unavailable. Retain its original operation.'),{code:value.code,status:response.status});return value as T;
}
/** A private-only socket. It never initializes BotsClient or receives snapshots/history. */
export class TaskRequestPrivateClient {
  owner=''; private socket:WebSocket|null=null;private pending=new Map<string,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  constructor(public session:TaskRequestSecureSession,private socketFactory=(url:string)=>new WebSocket(url)) {}
  async connect() {
    if(this.socket)throw Error('Close the earlier private connection first.');
    const url=new URL(this.session.url);if(url.protocol!=='wss:'&&!(['localhost','127.0.0.1'].includes(url.hostname)&&url.protocol==='ws:'))throw Error('Private transfer requires TLS.');
    url.searchParams.set('machine',this.session.machineId);const socket=this.socketFactory(url.toString());this.socket=socket;
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.close();reject(Error('Private connection timed out. Retain the original submission.'));},30000);
      socket.addEventListener('open',()=>{if(this.socket===socket)socket.send(JSON.stringify({type:'auth',role:'task-request',ticket:this.session.ticket}));});
      socket.addEventListener('message',({data})=>{
        if(this.socket!==socket||typeof data!=='string'||data.length>420000)return;
        let m;try{m=JSON.parse(data);}catch{return;}
        if(m.type==='authenticated') {if(m.role!=='task-request'||typeof m.owner!=='string'||!m.owner){this.close();reject(Error('Invalid private transport role.'));return;}this.owner=m.owner;clearTimeout(timer);resolve();return;}
        if(m.type!=='task-request.response')return;
        const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(Error(m.error));else p.resolve(m.result);
      });
      socket.addEventListener('close',()=>{clearTimeout(timer);if(this.socket===socket){this.socket=null;this.failPending();}reject(Error('Private connection closed. Retry the same ciphertext on a fresh connection.'));});
      socket.addEventListener('error',()=>{clearTimeout(timer);this.close();reject(Error('Private connection unavailable.'));});
    });
  }
  secure<T>(frame:Record<string,unknown>):Promise<T> {
    const socket=this.socket;if(!socket||socket.readyState!==WebSocket.OPEN||this.session.expiresAt<=Date.now())return Promise.reject(Error('Reconnect the private form with its original submission.'));
    const id=crypto.randomUUID();return new Promise<T>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Private acknowledgement missing. Retain and retry the original ciphertext.'));},45000);
      this.pending.set(id,{resolve:v=>resolve(v as T),reject,timer});
      try{socket.send(JSON.stringify({...frame,type:'task-request',id}));}catch{clearTimeout(timer);this.pending.delete(id);reject(Error('Private transfer unavailable. Retain the original ciphertext.'));}
    });
  }
  async descriptor():Promise<SecureDescriptor> {
    const created=await this.secure<{handle:string;request:SecureRequest}>({action:'create'});
    const result=await this.secure<SecureDescriptor>({action:'key',requestId:created.handle});
    if(result.request?.id!==created.handle||result.owner!==this.owner||!result.publicKey||JSON.stringify(result.request.taskRequest)!==JSON.stringify(this.session.binding))throw Error('Private descriptor unavailable. Read status; do not replace the submission.');return result;
  }
  async encrypt(descriptor:SecureDescriptor,payload:SecurePayload):Promise<SecureEnvelope> {return encryptSecureInput(descriptor,this.session.binding.submissionId,payload);}
  async transfer(envelope:SecureEnvelope) {if(envelope.context.submissionId!==this.session.binding.submissionId)throw Error('Private submission changed.');return transferSecureInput(this,envelope);}
  close() {const socket=this.socket;this.socket=null;socket?.close();this.failPending();}
  private failPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('Private connection closed; retain the original ciphertext.'));}this.pending.clear();}
}
