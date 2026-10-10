import { randomUUID } from 'node:crypto';
import { fingerprint, boundedFrame, id } from './protocol.mjs';
import { HUB_READS,HUB_MUTATIONS,ROOM_NATIVE_READS,ROOM_QUESTION_LOOKUP } from './control-protocol.mjs';
import { DESKTOP_READS, DESKTOP_MUTATIONS, desktopCapable } from './desktop-transport.mjs';
import {secureCapable} from './secure-transport.mjs';

// Explicit method sets keep an arbitrary browser method from becoming remote
// shell/native RPC authority. The real runtime still validates every request.
export const AGENT_READS=new Set(['snapshot','runtime.info','work.read','goals.read','history','history.page','history.turn','history.view','history.log','history.detail','history.attachments','replies.prepare','replies.resolve','artifacts.list','artifacts.preview','events','usage.bot','usage.account','usage.history','attachments.read','inbox.list','runs.page','runs.turns','runs.receipt','runs.requests','runs.findings','runs.decisions','execution.config','secure.list','portable.roomQuestion',...ROOM_NATIVE_READS,...DESKTOP_READS]);
export const AGENT_MUTATIONS=new Set(['turn.send','turn.interrupt','requests.respond','bots.update','goals.set','goals.clear','artifacts.index',...DESKTOP_MUTATIONS]);
const NATIVE_SNAPSHOT=Symbol('assigned-native-snapshot');
export class HubRpc {
  constructor(store,connections){this.store=store;this.connections=connections;this.reads=new Map();this.writes=new Map();}
  connection(placement){const ws=this.connections.get(placement.node_id);return ws?.readyState===1?ws:null;}
  async request(owner,request,clientId,internal=null){
    if(!id(request.id)||typeof request.method!=='string'||!id(clientId))throw Error('Invalid owner request.');
    // Browser snapshots always use the hub's owner/placement and capability
    // projection. A supplied bot ID cannot expose a raw node-wide snapshot.
    if(request.method==='snapshot'&&internal!==NATIVE_SNAPSHOT)return this.snapshot(owner,clientId);
    if(request.method==='events')return {result:this.store.events(owner,request.params?.after??0,request.params?.limit??40).events};
    if(request.method==='portable.roomQuestion'&&internal!==ROOM_QUESTION_LOOKUP)throw Object.assign(Error('Question lookup is an authenticated original-answer preparation only.'),{outcome:'not-sent'});
    // Existing room cards journal requests.respond. Only a canonical original
    // room question/answer selects this alias; other native requests retain
    // their assigned-agent path. The owner/bot scope is checked by controls.
    if(request.method==='requests.respond'&&typeof request.params?.key==='string'&&this.controls&&(this.controls.store.get('collaborationPending',request.params.key)||this.controls.store.get('collaborationAnswer',request.params.key)))return {result:await this.controls.request(owner,{...request,method:'conversations.respond'})};
    if(HUB_READS.has(request.method)||HUB_MUTATIONS.has(request.method)){
      if(!this.controls)throw Object.assign(Error('Hub logical controls are unavailable.'),{outcome:'not-sent'});
      return {result:await this.controls.request(owner,request.method==='bursts.typing'?{...request,params:{...request.params,clientId}}:request)};
    }
    const p=this.store.placement(owner,request.botId),ws=this.connection(p);
    const roomScope=ROOM_NATIVE_READS.has(request.method)||request.method==='portable.roomQuestion'||request.method==='execution.config'&&request.params?.contextId?
      this.controls?.collaboration.nativeScope(owner,request.botId,request.params?.contextId):null;
    if((ROOM_NATIVE_READS.has(request.method)||request.method==='portable.roomQuestion')&&!roomScope)throw Object.assign(Error('Original hub room scope is unavailable.'),{outcome:'not-sent'});
    if(request.method==='secure.list'&&!secureCapable(this.store.node(p.node_id),ws))throw Object.assign(Error('Private form state requires the live assigned Linux node.'),{outcome:'not-sent'});
    if((DESKTOP_READS.has(request.method)||DESKTOP_MUTATIONS.has(request.method))&&!desktopCapable(this.store.node(p.node_id),ws))
      throw Object.assign(Error('The assigned Linux desktop is offline or unavailable.'),{outcome:'not-sent'});
    if(AGENT_READS.has(request.method)){
      const binding=fingerprint(roomScope?{params:request.params??{},roomScope}:request.params??{}),cached=this.store.db.prepare('SELECT result,observed_at FROM portable_rpc_cache WHERE owner=? AND bot_id=? AND epoch=? AND method=? AND params_hash=?').get(owner,p.bot_id,p.epoch,request.method,binding);
      if(!ws){
        if(request.method==='portable.roomQuestion')throw Object.assign(Error('Answer preparation requires its live assigned question source.'),{outcome:'not-sent'});
        if(!cached)throw Object.assign(Error('Assigned node is offline; no matching cached history is available.'),{outcome:'not-sent'});
        return {result:JSON.parse(cached.result),cache:{observedAt:cached.observed_at,stale:true,nodeId:p.node_id,epoch:p.epoch}};
      }
      const rpcId=`rpc:${randomUUID()}`;
      const promise=new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{this.reads.delete(rpcId);reject(Object.assign(Error('Node read timed out; the conversation was not changed.'),{outcome:'not-sent'}));},15000);
        this.reads.set(rpcId,{nodeId:p.node_id,botId:p.bot_id,epoch:p.epoch,owner,method:request.method,binding,socket:ws,roomScope,resolve,reject,timer});
      });
      ws.send(boundedFrame({type:'rpc',rpcId,botId:p.bot_id,epoch:p.epoch,method:request.method,params:request.params??{},clientId,...(roomScope?{roomScope}:{})}));
      return promise;
    }
    if(!AGENT_MUTATIONS.has(request.method))throw Object.assign(Error('This portable control has not yet passed compatibility validation.'),{outcome:'not-sent'});
    if(!id(request.operationId))throw Error('Original operation identity required.');
    // Ephemeral socket identity is routing, not an operation fingerprint. A
    // reconnect must reconcile the SAME operation from another socket.
    const row=this.store.enqueue(owner,p.bot_id,request.operationId,{method:request.method,params:request.params??{}});
    if(row.receipt){
      const r=JSON.parse(row.receipt);
      if(r.result!==undefined&&['native-accepted','running','terminal'].includes(row.state))return {result:r.result,delivery:{state:row.state,nodeId:p.node_id,epoch:p.epoch}};
      if(row.state==='unknown')throw Object.assign(Error('Original native acceptance is unknown. It has not been resubmitted.'),{outcome:'uncertain'});
      if(r.outcome==='rejected')throw Object.assign(Error(r.error??'Original operation rejected.'),{outcome:'rejected'});
    }
    return this.wait(row);
  }
  wait(row){
    const p=this.store.placement(row.owner,row.bot_id),ws=this.connection(p);
    if(p.node_id!==row.node_id||p.epoch!==row.epoch)throw Object.assign(Error('Original placement changed; no new delivery was made.'),{outcome:'uncertain'});
    if(row.receipt){
      const r=JSON.parse(row.receipt);
      if(r.outcome==='rejected')throw Object.assign(Error(r.error??'Original operation rejected.'),{outcome:'rejected'});
      if(r.result!==undefined&&['native-accepted','running','terminal'].includes(row.state))return Promise.resolve({result:r.result,delivery:{state:row.state,nodeId:row.node_id,epoch:row.epoch}});
      if(row.state==='unknown')throw Object.assign(Error('Original outcome remains unconfirmed; it was not resubmitted.'),{outcome:'uncertain'});
    }
    if(!ws)throw Object.assign(Error('Original input is saved at the hub, waiting for its assigned node. Native acceptance is not confirmed.'),{outcome:'uncertain',delivery:{state:row.state}});
    let item;
    const waiting=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{const values=this.writes.get(row.operation_id);values?.delete(item);if(!values?.size)this.writes.delete(row.operation_id);reject(Object.assign(Error('Original input remains in delivery; reconcile the same operation before any retry.'),{outcome:'uncertain'}));},30000);
      item={owner:row.owner,resolve,reject,timer};const values=this.writes.get(row.operation_id)??new Set();values.add(item);this.writes.set(row.operation_id,values);
    });
    try{ws.send(boundedFrame({type:'sync',...this.store.sync(p.node_id)}));}
    catch(error){clearTimeout(item.timer);const values=this.writes.get(row.operation_id);values?.delete(item);if(!values?.size)this.writes.delete(row.operation_id);item.reject(Object.assign(error,{outcome:'uncertain'}));}
    return waiting;
  }
  readResult(nodeId,m){
    const r=this.reads.get(m.rpcId);if(!r)return;
    const n=this.store.node(nodeId),p=this.store.placement(n.owner,r.botId);
    if(r.nodeId!==nodeId||p.node_id!==nodeId||p.epoch!==r.epoch||m.epoch!==r.epoch||m.botId!==r.botId||this.connections.get(nodeId)!==r.socket)throw Error('Foreign or stale node response.');
    clearTimeout(r.timer);this.reads.delete(m.rpcId);
    if(m.error)return r.reject(Object.assign(Error(m.error),{outcome:'not-sent'}));
    try{
      if(r.roomScope){
        if(fingerprint(m.roomScope)!==fingerprint(r.roomScope)||fingerprint(this.controls.collaboration.nativeScope(r.owner,r.botId,r.roomScope.contextId))!==fingerprint(r.roomScope))throw Error('Room identity or membership changed during native read.');
        this.controls.collaboration.captureRead(r.owner,r.nodeId,r.botId,r.epoch,r.method,r.roomScope,m.result);
      }
      this.controls?.projectRead(r.botId,r.method,m.result);
    }catch(error){return r.reject(Object.assign(error,{outcome:'not-sent'}));}
    let text;try{text=boundedFrame(m.result);}catch(error){return r.reject(Object.assign(error,{outcome:'not-sent'}));}
    // RAM tickets and screenshots must not become durable history/cache or
    // remain usable after reconnect. The browser gets this one live response.
    if(DESKTOP_READS.has(r.method)||r.method==='secure.list')return r.resolve({result:m.result});
    try{this.store.transaction(()=>{
      const current=this.store.placement(r.owner,r.botId);
      if(current.node_id!==nodeId||current.epoch!==r.epoch)throw Error('Native read placement changed before persistence.');
      this.store.db.prepare('INSERT INTO portable_rpc_cache VALUES(?,?,?,?,?,?,?) ON CONFLICT(owner,bot_id,epoch,method,params_hash) DO UPDATE SET result=excluded.result,observed_at=excluded.observed_at').run(r.owner,r.botId,r.epoch,r.method,r.binding,text,Date.now());
      // Bounded cache: history lives on the node, not an unbounded hub duplicate.
      this.store.db.prepare('DELETE FROM portable_rpc_cache WHERE rowid IN (SELECT rowid FROM portable_rpc_cache ORDER BY observed_at DESC LIMIT -1 OFFSET 256)').run();
    });}catch(error){return r.reject(Object.assign(error,{outcome:'not-sent'}));}
    r.resolve({result:m.result,cache:{observedAt:Date.now(),stale:false,nodeId,epoch:r.epoch}});
  }
  receipt(row){
    const waits=this.writes.get(row.operation_id);if(!waits||!row.receipt||!['native-accepted','running','terminal','unknown'].includes(row.state))return;
    this.writes.delete(row.operation_id);const r=JSON.parse(row.receipt);
    for(const w of waits){clearTimeout(w.timer);
      if(w.owner!==row.owner||r.outcome==='rejected'||r.result===undefined||row.state==='unknown')w.reject(Object.assign(Error(r.error??'Original outcome is not confirmed.'),{outcome:r.outcome==='rejected'?'rejected':'uncertain'}));
      else w.resolve({result:r.result,delivery:{state:row.state,nodeId:row.node_id,epoch:row.epoch}});
    }
  }
  async snapshot(owner,clientId){
    const cursor=this.store.eventCursor(),placements=this.store.db.prepare('SELECT * FROM portable_placements WHERE owner=? ORDER BY bot_id').all(owner),snapshots=[],bots=[];
    let index=0;
    const worker=async()=>{while(index<placements.length){const p=placements[index++];
      try{
        const response=await this.request(owner,{id:`snapshot:${randomUUID()}`,method:'snapshot',botId:p.bot_id,params:{}},clientId,NATIVE_SNAPSHOT),s=response.result;
        const current=this.store.placement(owner,p.bot_id);
        if(current.node_id!==p.node_id||current.epoch!==p.epoch)continue;
        const b=s.bots?.find(b=>b.id===p.bot_id);if(!b)continue;
        bots.push({...b,nodeId:p.node_id,placementEpoch:p.epoch,nodeOnline:!!this.connection(p),historyObservedAt:response.cache.observedAt});snapshots.push({p,s});
      }catch{/* Unavailable uncached nodes do not become fictitious ready bots. */}
    }};
    await Promise.all(Array.from({length:Math.min(4,placements.length)},worker));
    bots.sort((a,b)=>a.id.localeCompare(b.id));
    const first=snapshots[0]?.s??{},scoped=field=>snapshots.flatMap(({p,s})=>(s[field]??[]).filter(value=>value.botId===p.bot_id));
    const common={};
    // Advertise only actual shared capabilities. The node platform gate is
    // independent of the native runtime's generic Goals capability.
    for(const [key,value] of Object.entries(first.capabilities??{}))if(value===1&&snapshots.length===placements.length&&snapshots.every(({s})=>s.capabilities?.[key]===1))common[key]=1;
    // A runtime's generic capability is not evidence that the hub transport
    // has implemented its consumer. Keep unfinished portable controls hidden.
    for(const key of ['taskRequests','backgroundRunLanes','scheduleDecisions','peerInbox','peerRootControls','peerBodyPaging','collaborationRooms','operatorCalls','operatorInputQuestions','secureInputs','secureResponseLifecycle','messageBursts','burstDiscard','burstControls','burstQueue','taskQueues','teams','botAdministration'])delete common[key];
    if(this.controls?.authority)for(const key of ['messageBursts','burstDiscard','burstControls','burstQueue'])common[key]=1;
    if(placements.length&&snapshots.length===placements.length&&placements.every(p=>secureCapable(this.store.node(p.node_id),this.connection(p))))
      for(const key of ['secureInputs','secureResponseLifecycle'])if(snapshots.every(({s})=>s.capabilities?.[key]===1))common[key]=1;
    if(placements.some(p=>!desktopCapable(this.store.node(p.node_id),this.connection(p))))for(const key of ['botDesktops','botBrowserRetention'])delete common[key];
    if(placements.some(p=>JSON.parse(this.store.node(p.node_id).hello).capabilities.autonomousGoals!==true))delete common.nativeGoals;
    const schedules=this.controls?placements.flatMap(p=>this.controls.store.list('schedule',p.bot_id)):[],runs=this.controls?placements.flatMap(p=>this.controls.store.list('run',p.bot_id)).sort((a,b)=>b.scheduledAt.localeCompare(a.scheduledAt)).slice(0,100):scoped('runs');
    return {result:{...first,cursor,bots,workByBot:scoped('workByBot'),pending:scoped('pending'),secureInputs:scoped('secureInputs'),schedules,runs,activeScheduledTurns:scoped('activeScheduledTurns'),ready:snapshots.length===placements.length&&placements.every(p=>!!this.connection(p)),
      capabilities:{...common,portableAgents:1}},cache:{observedAt:Date.now(),stale:snapshots.length<placements.length}};
  }
  close(){for(const r of this.reads.values()){clearTimeout(r.timer);r.reject(Error('Hub connection ended.'));}for(const values of this.writes.values())for(const w of values){clearTimeout(w.timer);w.reject(Object.assign(Error('Hub connection ended; retain original operation.'),{outcome:'uncertain'}));}this.reads.clear();this.writes.clear();}
}
