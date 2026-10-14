import {randomUUID} from 'node:crypto';
import {secureBrowserFrame} from '../lib/secure-relay.ts';
import {taskRequestFrame} from '../lib/task-request-relay.ts';
import {boundedFrame,id,fingerprint} from './protocol.mjs';

const failure=sent=>Object.assign(Error('Private form delivery is unavailable or unconfirmed. Retain the original encrypted submission and inspect its status.'),{outcome:sent?'uncertain':'not-sent',sent});
const plain=v=>v&&Object.getPrototypeOf(v)===Object.prototype;
export function secureCapable(node,socket){
  const h=JSON.parse(node.hello);
  return h.platform==='linux'&&h.capabilities?.secureTransfer===true&&socket?.readyState===1&&
    socket.portableHello?.platform==='linux'&&socket.portableHello.capabilities?.secureTransfer===true;
}
function resultFor(result,c){
  if(!plain(result)||Buffer.byteLength(boundedFrame(result))>32*1024)throw failure(true);
  if(Object.keys(result).some(k=>!['request','owner','publicKey','received','nextOffset','deleted',...(c.taskRequest?['handle']:[])].includes(k)))throw failure(true);
  if(result.request&&((c.action==='create'?result.request.id!==result.handle:result.request.id!==c.requestId)||result.request.botId!==c.botId||result.request.threadId!==c.threadId))throw failure(true);
  if(c.taskRequest&&(result.request&&fingerprint(result.request.taskRequest)!==fingerprint(c.binding)||c.action==='create'&&(!id(result.handle)||!result.request)))throw failure(true);
  if(result.owner!==undefined&&result.owner!==(c.privateOwner??c.owner))throw failure(true);
  if(result.publicKey&&(c.action!=='key'||result.publicKey.kty!=='EC'||result.publicKey.crv!=='P-256'||result.publicKey.d!==undefined))throw failure(true);
  if(c.action==='delete'&&result.deleted!==true||c.action==='status'&&!result.request||
    c.action==='key'&&!result.request||c.action==='chunk'&&typeof result.received!=='boolean')throw failure(true);
  return result;
}

// Only routing metadata is retained in RAM. Ciphertext, form keys and results
// never enter the mailbox, RPC cache, event journal or control-work records.
export class HubSecureTransport{
  constructor({store,connections,parent,timeoutMs=15000}){Object.assign(this,{store,connections,parent,timeoutMs});this.pending=new Map();}
  scope(c){
    const p=this.store.placement(c.owner,c.botId),n=this.store.node(p.node_id),ws=this.connections.get(p.node_id);
    if(p.node_id!==c.nodeId||p.epoch!==c.epoch||ws!==c.nodeSocket||!secureCapable(n,ws)||!this.parent(c.owner,c.clientId)||ws.bufferedAmount>8*1024*1024)throw failure(c.sent);
    return ws;
  }
  request(owner,clientId,message){
    return this.requestFrame(owner,clientId,secureBrowserFrame(message,owner,clientId));
  }
  requestGuest(owner,clientId,message,ticket){return this.requestFrame(owner,clientId,taskRequestFrame(message,ticket,clientId),ticket);}
  requestFrame(owner,clientId,frame,ticket=null){
    const p=this.store.placement(owner,frame.botId),nodeSocket=this.connections.get(p.node_id);
    if(!id(clientId)||this.pending.size>=64||[...this.pending.values()].filter(c=>c.clientId===clientId).length>=4||
      [...this.pending.values()].some(c=>c.clientId===clientId&&c.id===frame.id))throw failure(false);
    const requestId=`secure:${randomUUID()}`,c={owner,clientId,id:frame.id,requestId:frame.requestId,threadId:frame.threadId,botId:frame.botId,action:frame.action,nodeId:p.node_id,epoch:p.epoch,nodeSocket,sent:false,...(ticket?{taskRequest:true,binding:ticket.binding,privateOwner:ticket.owner}:{})};
    this.scope(c);
    return new Promise((resolve,reject)=>{
      c.resolve=resolve;c.reject=reject;
      c.timer=setTimeout(()=>this.fail(requestId),this.timeoutMs);c.timer.unref?.();this.pending.set(requestId,c);
      try{
        const message={type:'secure-request',transportId:requestId,epoch:c.epoch,frame};boundedFrame(message);
        const wire=ticket?JSON.stringify(message):boundedFrame(message);
        // Once send is invoked a thrown exception is not proof that no bytes
        // escaped. Preserve uncertainty even for a synchronous send failure.
        c.sent=true;nodeSocket.send(wire);
      }
      catch{this.fail(requestId);}
    });
  }
  fail(requestId){const c=this.pending.get(requestId);if(!c)return;clearTimeout(c.timer);this.pending.delete(requestId);c.reject(failure(c.sent));}
  receive(nodeId,socket,message){
    const c=this.pending.get(message.transportId);if(!c)return;
    if(c.nodeId!==nodeId||c.nodeSocket!==socket||c.botId!==message.botId||c.epoch!==message.epoch)throw failure(true);
    try{
      this.scope(c);if(message.error!==undefined)throw failure(true);
      const result=resultFor(message.result,c);clearTimeout(c.timer);this.pending.delete(message.transportId);c.resolve(result);
    }catch{this.fail(message.transportId);}
  }
  disconnectNode(socket){for(const [key,c] of this.pending)if(c.nodeSocket===socket)this.fail(key);}
  disconnectParent(clientId){for(const [key,c] of this.pending)if(c.clientId===clientId)this.fail(key);}
  close(){for(const key of [...this.pending.keys()])this.fail(key);}
}

export class AgentSecureTransport{
  constructor({runtime,journal,owner,currentSocket,ready}){Object.assign(this,{runtime,journal,owner,currentSocket,ready});this.pending=new Map();}
  scope(socket,m){
    if(!this.ready()||!this.runtime.secure||process.platform!=='linux'||this.currentSocket()!==socket||socket.readyState!==1||
      socket.bufferedAmount>8*1024*1024||!id(m.transportId)||!Number.isSafeInteger(m.epoch))throw failure(false);
    const f=m.frame,c=this.journal.currentControl({bot_id:f?.botId,epoch:m.epoch});
    const guest=f?.type==='task-request';
    if(!c||!this.owner||!guest&&this.owner!==f.owner)throw failure(false);
    const frame=guest?taskRequestFrame(f,{owner:f.owner,botId:f.botId,threadId:f.threadId,binding:f.binding},f.clientId):secureBrowserFrame(f,this.owner,f.clientId),bot=this.runtime.store.bot(frame.botId),row=frame.requestId?this.runtime.store.get('secureInput',frame.requestId):null;
    if(!bot||bot.archived||bot.archiving||bot.deletedAt||bot.threadId!==frame.threadId||!id(frame.clientId)||
      !guest&&(!row||row.botId!==bot.id||row.threadId!==bot.threadId||row.taskRequest))throw failure(false);
    return frame;
  }
  async message(socket,m){
    const frame=this.scope(socket,m);
    if(this.pending.size>=32||this.pending.has(m.transportId))throw failure(false);
    const key={socket,botId:frame.botId,epoch:m.epoch};this.pending.set(m.transportId,key);
    const answer=value=>{
      if(this.pending.get(m.transportId)!==key)return;
      this.scope(socket,m);
      const response={type:'secure-response',transportId:m.transportId,botId:frame.botId,epoch:m.epoch,...value};boundedFrame(response);
      socket.send(frame.type==='task-request'?JSON.stringify(response):boundedFrame(response));
    };
    try{
      const result=await this.runtime.maintenance.track(()=>{this.scope(socket,m);return frame.type==='task-request'?this.runtime.taskRequests.channel(frame):this.runtime.secure.channel(frame);});
      answer({result:resultFor(result,{...frame,requestId:frame.requestId,...(frame.type==='task-request'?{taskRequest:true,binding:frame.binding,privateOwner:frame.owner}:{})})});
    }catch{try{answer({error:'Private form transfer unconfirmed; retain its original submission identity.'});}catch{/* A replaced scope never receives the result. */}}
    finally{if(this.pending.get(m.transportId)===key)this.pending.delete(m.transportId);}
  }
  disconnect(socket){for(const [key,p] of this.pending)if(p.socket===socket)this.pending.delete(key);}
}
