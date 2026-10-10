import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import WebSocket from 'ws';
import worker,{SipCallController} from '../voice-relay/src/index.ts';
import {VoiceStore} from './voice-store.mjs';
import {signGateway} from './gateway-proof.ts';
import {stripIdentity} from './identity.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const refused=()=>Error('Voice admission or original effect confirmation is unavailable; retain the original call.');
const MAX_BODY=1024*1024,MAX_BUFFER=2*1024*1024;
async function bytes(response,limit=MAX_BODY) {
  const reader=response.body?.getReader();if(!reader)return Buffer.alloc(0);
  const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw refused();parts.push(Buffer.from(value));}return Buffer.concat(parts);}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

// This adapter is installed only by the hub constructor. A request cannot
// select transports, storage, credentials, an object ID or a release fence.
export function createVoiceRuntime(config,{assertWriter:assertControlWriter,writer,network={fetch:globalThis.fetch,Socket:WebSocket}}) {
  if(config.voice?.enabled!==true||typeof assertControlWriter!=='function'||!writer||['assertWriter','runSync','startWork','runWork','keepWork','bindWork','unknownWork'].some(k=>typeof writer[k]!=='function')||!/^[a-f0-9]{40}$/.test(config.hub?.source))throw refused();
  const assertWriter=()=>{assertControlWriter();writer.assertWriter();};
  const origin=new URL(config.publicOrigin);if(origin.protocol!=='https:'||origin.origin!==config.publicOrigin||origin.username||origin.password)throw refused();
  assertWriter();
  const store=new VoiceStore(join(config.dataDirectory,'voice.sqlite'),{source:config.hub.source,assertWriter,writeSync:fn=>writer.runSync(fn)});
  const scopes=new AsyncLocalStorage(),contexts=new WeakMap(),controllers=new Map(),pending=new Map(),sockets=new Set();
  let draining=false,closed=false,tickRunning=false,lastFault=null,minute=null,faults=0;
  const fault=()=>{faults++;lastFault={at:Date.now(),reason:'Original voice effect is not confirmed.'};};
  const scope=()=>{const s=scopes.getStore();if(!s||closed)throw refused();assertWriter();return s;};
  const begin=(kind,payload,operationId,objectId=scope().objectId,alarm)=>store.begin({objectId,kind,payload,operationId,alarm});
  const settle=(r,state,result=null)=>{try{if(state==='unknown')writer.unknownWork();store.settle(r.operationId,r.fingerprint,state,result);}catch{fault();throw refused();}};
  const run=(objectId,fn)=>scopes.run({objectId},fn);
  const track=async(kind,payload,fn,options={})=>{
    const r=begin(kind,payload,options.operationId,options.objectId,options.alarm);
    if(r.reconciled)return r.response;
    try{const result=await fn();settle(r,'terminal',options.result?options.result(result):{completed:true});return result;}
    catch{try{settle(r,'unknown');}catch{/* Original active row is retained. */}fault();throw refused();}
  };
  class SocketEndpoint {
    constructor(bound){this.bound=bound;this.listeners=new Map();this.queue=[];this.queuedBytes=0;this.wire=null;this.state=0;this.receipt=null;this.closedEvent=false;
      this.inside=writer.bindWork(fn=>scopes.run(bound,fn));
      writer.keepWork(new Promise(resolve=>{this.release=resolve;}));}
    get readyState(){return this.wire?.readyState??this.state;}
    accept(){if(this.state===0)this.state=1;}
    addEventListener(type,fn,options){if(!['open','message','close','error'].includes(type)||typeof fn!=='function')throw refused();const list=this.listeners.get(type)??[];if(!list.some(v=>v.fn===fn))list.push({fn,once:options?.once===true});this.listeners.set(type,list);}
    removeEventListener(type,fn){this.listeners.set(type,(this.listeners.get(type)??[]).filter(v=>v.fn!==fn));}
    dispatch(type,event){return this.inside(()=>{for(const l of [...this.listeners.get(type)??[]]){if(l.once)this.removeEventListener(type,l.fn);try{const p=l.fn.call(this,event);if(p&&typeof p.then==='function')writer.keepWork(Promise.resolve(p).catch(()=>{writer.unknownWork();fault();}));}catch{writer.unknownWork();fault();}}});}
    send(value){if(scope().objectId!==this.bound.objectId)throw refused();const size=Buffer.byteLength(value);if(size>MAX_BODY||this.readyState!==1)throw refused();
      if(this.wire){if(this.wire.bufferedAmount+size>MAX_BUFFER)throw refused();this.wire.send(value);}
      else{if(this.queuedBytes+size>MAX_BODY)throw refused();this.queue.push(value);this.queuedBytes+=size;}}
    finish(code,reason){if(this.closedEvent)return;this.closedEvent=true;this.state=3;this.queue=[];this.queuedBytes=0;
      this.dispatch('close',{code,reason:reason.toString(),wasClean:code!==1006});sockets.delete(this);
      try{if(this.receipt)settle(this.receipt,code===1006?'unknown':'terminal',{transportClosed:true,code});}
      finally{this.release();}}
    close(code=1000,reason='complete'){if(Buffer.byteLength(reason)>120)throw refused();return this.inside(()=>{if(this.wire)this.wire.close(code,reason);else this.finish(code,reason);});}
    attach(wire,receipt){return this.inside(()=>{if(this.wire||this.closedEvent)throw refused();this.wire=wire;this.receipt=receipt;sockets.add(this);
      wire.on('open',()=>{try{this.inside(()=>{this.dispatch('open',{});for(const v of this.queue)wire.send(v);this.queue=[];this.queuedBytes=0;});}catch{fault();}});
      wire.on('message',(data,binary)=>{try{this.dispatch('message',{data:binary?data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength):data.toString()});}catch{fault();}});
      wire.on('error',()=>{try{this.dispatch('error',{message:'Voice socket failed.'});}catch{fault();}});
      wire.on('close',(code,reason)=>{try{this.inside(()=>this.finish(code,reason));}catch{fault();}});
      if(wire.readyState===1){for(const v of this.queue)wire.send(v);this.queue=[];this.queuedBytes=0;}
    });}
  }
  const openSocket=(url,protocols=[],headers)=>{
    if(sockets.size>=64)throw refused();
    const u=new URL(url);if(u.protocol!=='wss:'||u.hostname!=='api.openai.com'||u.port||u.pathname!=='/v1/realtime'||u.username||u.password||u.hash||[...u.searchParams.keys()].some(k=>!['model','call_id'].includes(k)))throw refused();
    const r=begin('provider-socket',{url:u.href,protocolHash:digest(JSON.stringify(protocols)),headerHash:digest(JSON.stringify(headers??{}))});
    const endpoint=new SocketEndpoint(scope());
    try{const wire=new network.Socket(u,protocols,{headers,followRedirects:false,perMessageDeflate:false,maxPayload:MAX_BODY,handshakeTimeout:15000});endpoint.attach(wire,r);return endpoint;}
    catch{try{settle(r,'unknown');}finally{endpoint.close(1000,'connect-refused');}throw refused();}
  };
  const runtime={
    async fetch(input,init) {
      scope();const request=new Request(input,init),u=new URL(request.url),headers=new Headers(request.headers);stripIdentity(headers);
      if(u.username||u.password||u.hash)throw refused();
      const local=u.origin===origin.origin&&['/api/talk/phone/bridge/start','/api/talk/phone/bridge/events','/api/talk/phone/bridge/sip/start','/api/internal/minute'].includes(u.pathname)&&!u.search;
      const provider=u.protocol==='https:'&&u.hostname==='api.openai.com'&&!u.port&&(/^\/v1\/realtime\/calls\/rtc_[A-Za-z0-9_-]{8,200}\/(accept|reject|hangup)$/.test(u.pathname)||u.pathname==='/v1/realtime');
      if(!local&&!provider)throw refused();
      if(headers.get('upgrade')?.toLowerCase()==='websocket'){
        if(!provider||u.pathname!=='/v1/realtime'||request.method!=='GET')throw refused();
        headers.delete('upgrade');u.protocol='wss:';
        const socket=openSocket(u,[],Object.fromEntries(headers));
        await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.close(1000,'connect-timeout');reject(refused());},15000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);reject(refused());},{once:true});socket.addEventListener('close',()=>{clearTimeout(timer);reject(refused());},{once:true});});
        return {status:101,webSocket:socket};
      }
      if(request.method!=='POST'||headers.has('upgrade')||provider&&u.search)throw refused();
      const body=await bytes(request,128*1024),requestHash=digest(body);
      return track('outbound-http',{path:u.origin+u.pathname,method:request.method,bodyHash:requestHash,authorizationHash:digest(headers.get('authorization')??'')},async()=>{
        let target=u;if(local){signGateway(config.gatewaySecret,request.method,u.pathname,headers);target=new URL(`http://127.0.0.1:${config.sitePort??3211}${u.pathname}`);}
        const signal=AbortSignal.any([request.signal,AbortSignal.timeout(20000)]);
        const response=await network.fetch(target,{method:request.method,headers,body,redirect:'manual',signal});
        if(response.status>=300&&response.status<400)throw refused();
        const responseBody=await bytes(response),h=new Headers(response.headers);h.delete('content-encoding');h.delete('content-length');
        return new Response(response.status===204?null:responseBody,{status:response.status,headers:h});
      },{result:r=>({status:r.status})});
    },
    socket:(url,protocols)=>openSocket(url,protocols),
    pair(){const s=scope(),server=new SocketEndpoint(s),client=Object.freeze({server,scope:s});return {0:client,1:server};},
    upgrade(client){if(!client?.server||client.scope!==scope())throw refused();return {status:101,webSocket:client};},
    background(context,factory){const objectId=contexts.get(context);if(!objectId||typeof factory!=='function')throw refused();
      if(pending.size>=128)throw refused();
      run(objectId,()=>{const r=begin('background',{context:objectId});
        // Admission is durable before the original factory starts any work.
        const p=Promise.resolve().then(()=>run(objectId,factory));pending.set(r.operationId,p);
        const lifetime=p.then(()=>settle(r,'terminal',{completed:true}),()=>settle(r,'unknown')).catch(fault).finally(async()=>{pending.delete(r.operationId);await releaseEndedCall(controllers.get(objectId));});
        writer.keepWork(lifetime);});},
  };
  const environment={SITE_BASE_URL:config.publicOrigin,OPENAI_API_KEY:config.applicationEnvironment?.OPENAI_API_KEY,
    OPENAI_PROJECT_ID:config.applicationEnvironment?.OPENAI_PROJECT_ID,TODO_MAINTENANCE_SECRET:config.applicationEnvironment?.TODO_MAINTENANCE_SECRET,
    VOICE_RUNTIME:runtime,SIP_CONTROLLERS:{
      idFromName(name){if(!/^rtc_[A-Za-z0-9_-]{8,200}$/.test(name))throw refused();return `sip:${digest(name)}`;},
      get(id){if(!/^sip:[a-f0-9]{64}$/.test(id))throw refused();return {fetch:(input,init)=>controllerRequest(id,new Request(input,init))};},
    }};
  function controller(id) {
    let entry=controllers.get(id);if(entry)return entry;
    store.object(id);const state={storage:store.storage(id)};contexts.set(state,id);
    entry={state,call:new SipCallController(state,environment),chain:Promise.resolve()};controllers.set(id,entry);return entry;
  }
  function retainCall(entry,id){
    if(entry.lease?.active)return;
    const lease={active:true,inside:writer.bindWork(fn=>run(id,fn)),release:null};
    writer.keepWork(new Promise(resolve=>{lease.release=resolve;}));entry.lease=lease;
  }
  async function releaseEndedCall(entry){
    if(!entry?.lease?.active)return;
    const lease=entry.lease;
    await lease.inside(async()=>{const state=await entry.state.storage.get('sip-call');
      if(!state||state.ended===true){lease.active=false;lease.release();}});
  }
  function serialized(entry,fn){
    const p=entry.chain.catch(()=>{}).then(()=>entry.lease?.active?entry.lease.inside(fn):fn()).finally(()=>releaseEndedCall(entry));entry.chain=p;return p;
  }
  async function controllerRequest(id,request) {
    const entry=controller(id),u=new URL(request.url);
    if(u.pathname==='/status'&&request.method==='GET')return run(id,()=>serialized(entry,()=>entry.call.fetch(request)));
    if(u.pathname!=='/start'||request.method!=='POST')throw refused();
    const raw=await bytes(request,128*1024),payload=JSON.parse(raw.toString());
    if(environment.SIP_CONTROLLERS.idFromName(payload.providerCallId)!==id)throw refused();
    return serialized(entry,()=>run(id,async()=>{
      // Re-read inside the object's serialized boundary. A second start may
      // have waited while the first one established its immutable identity.
      const original=await entry.state.storage.get('sip-call');
      if(original&&['callSid','providerCallId','token','talkSessionId'].some(k=>original[k]!==payload[k]))throw refused();
      // A persisted active call without its original live scope cannot be
      // resumed by a timer or another webhook after a host restart.
      if(original&&original.ended!==true&&!entry.lease?.active)throw refused();
      if(!original)retainCall(entry,id);
      const response=await track('sip-start',{bodyHash:digest(raw)},async()=>{
        const response=await entry.call.fetch(new Request(request.url,{method:'POST',headers:request.headers,body:raw}));
        return {status:response.status,body:await response.text()};
      },{operationId:`sip-start:${id}:${digest(raw)}`,result:r=>r});
      return new Response(response.body,{status:response.status,headers:{'content-type':'application/json'}});
    }));
  }
  async function tick() {
    if(tickRunning||closed)return;tickRunning=true;
    try{for(const row of store.due()){
      // Old active/unknown effects are blockers, not timer retry candidates.
      const entry=controllers.get(row.id);if(!store.admissible(row.id)||!entry?.lease?.active)continue;
      await entry.lease.inside(()=>serialized(entry,()=>run(row.id,()=>track('sip-alarm',{generation:row.alarm_generation,at:row.alarm_at},()=>entry.call.alarm(),{
        operationId:`sip-alarm:${row.id}:${row.alarm_generation}`,alarm:{at:row.alarm_at,generation:row.alarm_generation},
      }))));
    }
    if(!draining&&config.voice.scheduleMinute===true&&store.admissible('minute')){const at=Math.floor(Date.now()/60000)*60000,previous=store.lastMinute();if(minute!==at&&(previous===null||at>previous)){const objectId='minute',context={};contexts.set(context,objectId);
      await writer.runWork('voice-tick',()=>{minute=at;return run(objectId,()=>track('minute',{scheduledAt:at},()=>worker.scheduled({scheduledTime:at},environment,context),{operationId:`minute:${at}`}));});}}
    }catch(error){if(error?.outcome!=='not-sent')fault();}finally{tickRunning=false;}
  }
  const timer=setInterval(()=>void tick(),1000);timer.unref();
  const activeRoots=new Set();let closing=null;
  const status=()=>({...store.counts(),sockets:sockets.size,background:pending.size,requests:activeRoots.size,tickRunning,draining,source:config.hub.source,faults,lastFault});
  function idle(){const v=status();return !v.activeEffects&&!v.unknownEffects&&!v.activeCalls&&!v.sockets&&!v.background&&!v.requests&&!v.tickRunning&&!v.dueAlarms&&!v.faults;}
  async function fetch(request) {
    if(closed)throw refused();const u=new URL(request.url);
    if(u.origin!==origin.origin)throw refused();
    if(u.pathname==='/health'&&request.method==='GET'){const r=await worker.fetch(request,environment,{});const body=await r.json();return Response.json({...body,node:{enabled:!draining,source:config.hub.source}},{headers:{'cache-control':'no-store'}});}
    if(draining||activeRoots.size>=32||sockets.size+activeRoots.size>=64)throw refused();assertWriter();
    if(!['/openai/webhook','/stream'].includes(u.pathname)||u.search||u.pathname==='/openai/webhook'&&request.method!=='POST'||u.pathname==='/stream'&&request.method!=='GET')return new Response('Not found.',{status:404});
    let raw=null,objectId;
    if(u.pathname==='/openai/webhook'){
      raw=await bytes(request,128*1024);const value=JSON.parse(raw.toString());
      if(value.type!=='realtime.call.incoming')return Response.json({received:true});
      const hs=value.data?.sip_headers;
      if(!Array.isArray(hs)||hs.length>64)throw refused();
      const header=name=>hs.find(h=>h?.name?.trim().toLowerCase()===name)?.value?.trim();
      if(!/^rtc_[A-Za-z0-9_-]{8,200}$/.test(value.data?.call_id)||!/^CA[0-9a-f]{32}$/i.test(header('x-dawar-call-sid'))||typeof header('x-dawar-token')!=='string'||header('x-dawar-token').length<32||header('x-dawar-token').length>512)throw refused();
      objectId=environment.SIP_CONTROLLERS.idFromName(value.data.call_id);
      const original=await store.storage(objectId).get('sip-call');
      if(original&&(original.providerCallId!==value.data.call_id||original.callSid!==header('x-dawar-call-sid')||original.token!==header('x-dawar-token')))return Response.json({error:'Original call identity does not match.'},{status:403});
      if(original?.ended===true)return Response.json({received:true,ended:true});
      if(original&&!controllers.get(objectId)?.lease?.active)throw refused();
    }else{if(request.headers.get('upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket upgrade required.',{status:426});objectId=`stream:${randomUUID()}`;}
    const context={};contexts.set(context,objectId);
    return run(objectId,async()=>{
      const r=begin('incoming',{path:u.pathname,bodyHash:raw?digest(raw):null},raw?`incoming:${objectId}`:undefined);
      if(r.reconciled)return Response.json({received:true},{status:r.response.status});activeRoots.add(r.operationId);
      try{const response=await worker.fetch(raw?new Request(request.url,{method:request.method,headers:request.headers,body:raw}):request,environment,context);
        if(response.status===101){const client=response.webSocket;if(!client?.server||client.scope!==scope())throw refused();let attached=false,abandoned=false;
          const inside=writer.bindWork(fn=>run(objectId,fn));
          return {status:101,attach:wire=>inside(()=>{if(attached||abandoned)throw refused();client.server.attach(wire,r);attached=true;activeRoots.delete(r.operationId);}),abandon:()=>{
            if(attached||abandoned)return;return inside(()=>{abandoned=true;client.server.close(1000,'upgrade-abandoned');activeRoots.delete(r.operationId);settle(r,'terminal',{upgradeAbandoned:true});});}};}
        settle(r,'terminal',{status:response.status});activeRoots.delete(r.operationId);return response;
      }catch{activeRoots.delete(r.operationId);try{settle(r,'unknown');}catch{fault();}throw refused();}
    });
  }
  async function drain({deadline=Date.now()+60000}={}) {
    if(!Number.isSafeInteger(deadline)||deadline<=Date.now()||deadline>Date.now()+900000)throw refused();draining=true;const began=performance.now(),duration=deadline-Date.now();
    while(!idle()){if(Date.now()>=deadline||performance.now()-began>=duration)throw refused();await new Promise(resolve=>setTimeout(resolve,50));}
    return {source:config.hub.source,heldStarts:true,sealed:false,...status()};
  }
  async function admittedFetch(request){
    const u=new URL(request.url);
    if(u.pathname==='/health'&&request.method==='GET')return fetch(request);
    const outcome=await writer.startWork('voice-request',()=>fetch(request));
    void outcome.settled.catch(fault);
    if(outcome.failed)throw outcome.error;return outcome.value;
  }
  return {fetch:admittedFetch,status,drain,store,close:()=>closing??=(async()=>{await drain();clearInterval(timer);store.close();closed=true;})()};
}
