import {AsyncLocalStorage} from 'node:async_hooks';
import {Collaboration} from '../bot-bridge/collaboration.mjs';
import {HUB_ROOM_READS,HUB_ROOM_MUTATIONS,roomDeliverySource} from './control-protocol.mjs';
import {fingerprint,boundedFrame,originalNativeProof} from './protocol.mjs';

const now=()=>new Date().toISOString();

// Canonical room/post/delivery identities belong to the hub control store.
// Native provisioning, questions and acceptance belong to the assigned agent.
// Never run the original local collaboration scheduler on this facade.
export class HubCollaboration extends Collaboration {
  constructor(runtime){
    const facade=Object.assign(Object.create(runtime),{maintenance:{holding:()=>{
      try{runtime.assertWriter();return false;}catch{return true;}
    }}});
    super(facade,[],null,new Set());this.owners=new AsyncLocalStorage();
  }
  ownedBot(botId){
    const owner=this.owners.getStore();
    if(!owner)throw Error('Authenticated hub room scope required.');
    this.runtime.scope(owner,botId);return this.store.bot(botId);
  }
  author(botId,origin,owner){
    this.ownedBot(botId);
    // Node identity alone is neither human nor captured native tool authority.
    if(!owner||origin)throw Error('This room route requires the authenticated owner.');
    return {kind:'owner'};
  }
  members(value){
    const members=super.members(value);
    for(const botId of members)this.ownedBot(botId);
    return members;
  }
  room(botId,roomId){
    this.ownedBot(botId);const room=super.room(botId,roomId);
    this.ownedRoom(roomId);
    return room;
  }
  ownedRoom(roomId){
    const room=this.store.get('collaborationRoom',roomId);
    if(!room||!Array.isArray(room.members)||room.members.length<2)throw Error('Original central room is unavailable.');
    for(const member of room.members)this.ownedBot(member);
    return room;
  }
  publicDelivery(delivery){
    // Removed members' old deliveries remain visible to the same owner; they
    // cannot borrow current membership to execute, but history is retained.
    this.ownedBot(delivery.botId);this.ownedRoom(delivery.roomId);
    const value=super.publicDelivery(delivery);
    // Queued is local persistence, not node receipt or native acceptance.
    if(value.state==='queued'&&!value.waitReason)value.waitReason='routing-pending';
    return value;
  }
  page(kind,botId,params,predicate,args,project=value=>value){
    return super.page(kind,botId,params,predicate,args,value=>{
      if(kind==='collaborationRoom'){
        for(const member of value.members)this.ownedBot(member);
      }else if(value.roomId){
        this.ownedRoom(value.roomId);
        if(value.author?.kind==='bot')this.ownedBot(value.author.botId);
        for(const recipient of value.recipients??[])this.ownedBot(recipient);
        if(value.sourceBotId)this.ownedBot(value.sourceBotId);
      }
      return project(value);
    });
  }
  publish(roomId,data={}){
    if(!roomId)return;
    const room=this.store.get('collaborationRoom',roomId);
    if(!room)return;
    // One owner-scoped invalidation, with no model turn or courtesy fan-out.
    for(const member of room.members)this.ownedBot(member);
    this.runtime.emitEvent('collaboration',{version:1,roomId,...data},room.members[0]);
  }
  request(owner,request,caller){
    if(!HUB_ROOM_READS.has(request.method)&&!HUB_ROOM_MUTATIONS.has(request.method))throw Error('Unsupported central room control.');
    if(caller.kind!=='owner')throw Error('Central room owner controls cannot be granted by node prose.');
    return this.owners.run(owner,()=>{
      this.ownedBot(request.botId);
      if(HUB_ROOM_MUTATIONS.has(request.method))this.runtime.assertWriter();
      return super.handle({...request,clientId:'authenticated-hub-owner'},null);
    });
  }
  nodeState(owner,nodeId,botId,epoch,operationId,hash){
    const {p}=this.runtime.scope(owner,botId),row=this.runtime.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
    if(p.node_id!==nodeId||p.epoch!==epoch||!row||row.owner!==owner||row.bot_id!==botId||row.node_id!==nodeId||row.epoch!==epoch||row.fingerprint!==hash)throw Error('Foreign original room command.');
    const payload=JSON.parse(row.payload);
    if(payload.method!=='portable.roomDispatch')throw Error('This command is not a registered room delivery.');
    return this.owners.run(owner,()=>{
      const delivery=this.store.get('collaborationDelivery',operationId),post=delivery&&this.store.get('collaborationPost',delivery.postId);
      if(!delivery||delivery.botId!==botId||fingerprint(roomDeliverySource(delivery))!==fingerprint(roomDeliverySource(payload.params.delivery))||fingerprint(post)!==fingerprint(payload.params.post))throw Error('Original canonical room source changed.');
      const room=this.ownedRoom(delivery.roomId);
      return {operationId,fingerprint:hash,botId,epoch,controlRevision:p.control_revision,room,post,delivery,
        canDispatch:!p.stopped&&this.runtime.router.connection(p)?.portableHello?.capabilities?.centralRoomDispatch===true&&delivery.state==='queued'&&this.allowed(delivery)};
    });
  }
  async pump(){
    const rows=this.store.db.prepare("SELECT json FROM records WHERE kind='collaborationDelivery' AND json_extract(json,'$.state')='queued' AND NOT EXISTS (SELECT 1 FROM portable_mailbox WHERE operation_id=records.id) ORDER BY rowid LIMIT 8").all();
    for(const row of rows){
      const delivery=JSON.parse(row.json),p=this.runtime.hub.db.prepare('SELECT * FROM portable_placements WHERE bot_id=?').get(delivery.botId);
      const connection=p&&this.runtime.router.connection(p);
      if(!p||p.stopped||!connection||connection.portableHello?.capabilities?.centralRoomDispatch!==true)continue;
      await this.runtime.lock(`room:${delivery.botId}`,()=>this.owners.run(p.owner,()=>this.store.transaction(()=>{
        const current=this.runtime.hub.placement(p.owner,p.bot_id),d=this.store.get('collaborationDelivery',delivery.id);
        if(fingerprint(p)!==fingerprint(current)||this.runtime.router.connection(current)!==connection||connection.portableHello?.capabilities?.centralRoomDispatch!==true||fingerprint(d)!==fingerprint(delivery)||!this.allowed(d))return;
        this.ownedBot(d.botId);const room=this.ownedRoom(d.roomId),post=this.store.get('collaborationPost',d.postId);
        if(!post||!['task','question'].includes(post.kind)||!post.recipients.includes(d.botId)||this.store.operation(d.id))return;
        if(this.runtime.hub.db.prepare("SELECT 1 FROM portable_mailbox WHERE bot_id=? AND state IN ('queued','received','unknown') LIMIT 1").get(d.botId))return;
        const command=this.runtime.hub.enqueueOn(this.store.db,p.owner,d.botId,d.id,{method:'portable.roomDispatch',params:{room,post,delivery:d}});
        this.store.saveOperation(d.id,command.fingerprint,'dispatching',{method:'collaboration.dispatch',botId:d.botId,portableFingerprint:command.fingerprint,deliveryId:d.id,contextId:d.contextId,createdAt:now()});
        this.publish(d.roomId,{delivery:this.publicDelivery(d)});
        this.store.afterCommit(()=>this.runtime.router.connection(current)?.send(boundedFrame({type:'sync',...this.runtime.hub.sync(current.node_id)})));
      })));
    }
  }
  receipt(row){
    const payload=JSON.parse(row.payload),r=row.receipt&&JSON.parse(row.receipt);
    if(payload.method!=='portable.roomDispatch'||!r)return;
    this.owners.run(row.owner,()=>this.store.transaction(()=>{
      const {p,b}=this.runtime.scope(row.owner,row.bot_id),d=this.store.get('collaborationDelivery',row.operation_id),op=this.store.operation(row.operation_id);
      if(p.node_id!==row.node_id||p.epoch!==row.epoch||!d||d.botId!==row.bot_id||op?.portableFingerprint!==row.fingerprint||fingerprint(roomDeliverySource(d))!==fingerprint(roomDeliverySource(payload.params.delivery))||fingerprint(this.store.get('collaborationPost',d.postId))!==fingerprint(payload.params.post))throw Error('Original room receipt or placement changed.');
      if(row.state==='unknown'||r.outcome==='rejected'){
        if(d.turnId)throw Error('A later ambiguous receipt cannot remove confirmed native acceptance.');
        const state=row.state==='unknown'?'uncertain':'rejected';
        this.store.put('collaborationDelivery',{...d,state,error:r.error??'Original native acceptance is unconfirmed.'});
        this.store.saveOperation(op.id,op.fingerprint,state==='uncertain'?'uncertain':'failed',{...op,error:r.error??'Original native acceptance is unconfirmed.'});
      }else if(['native-accepted','running','terminal'].includes(row.state)&&originalNativeProof(r,row.operation_id)){
        const result=r.result,c=result.context,delivery=result.delivery,prior=this.store.get('collaborationContext',d.contextId);
        if(result.deliveryId!==d.id||delivery?.id!==d.id||delivery.botId!==d.botId||delivery.contextId!==d.contextId||delivery.roomId!==d.roomId||delivery.postId!==d.postId||delivery.turnId!==r.turnId||result.threadId!==r.threadId||!c||c.id!==d.contextId||c.botId!==d.botId||c.roomId!==d.roomId||c.threadId!==r.threadId||c.provisioning!=='bound'||!Number.isSafeInteger(c.revision)||c.revision<0||r.threadId===b.threadId||prior?.threadId&&prior.threadId!==r.threadId||this.store.bots().some(bot=>bot.threadId===r.threadId)||this.store.list('collaborationContext').some(context=>context.id!==c.id&&context.threadId===r.threadId)||d.turnId&&d.turnId!==r.turnId)throw Error('Native receipt lacks its unique original registered room identity.');
        const status=r.nativeStatus??result.nativeStatus,terminal=['completed','failed','interrupted'].includes(status);
        if(row.state==='terminal'&&!terminal)throw Error('Terminal room receipt lacks a terminal native outcome.');
        this.store.put('collaborationContext',{...prior,...c,generation:c.revision,status:terminal?'idle':c.status,activeTurnId:terminal?null:r.turnId});
        this.store.put('collaborationDelivery',{...d,state:terminal?'completed':'accepted',threadId:r.threadId,turnId:r.turnId,terminalStatus:terminal?status:null,evidence:'assigned-agent-original-client',error:null});
        this.store.saveOperation(op.id,op.fingerprint,'done',{...op,result,error:null});
      }else return;
      this.publish(d.roomId,{delivery:this.publicDelivery(this.store.get('collaborationDelivery',d.id))});
      this.store.db.prepare('INSERT INTO portable_control_receipts VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET receipt_hash=excluded.receipt_hash').run(row.operation_id,row.receipt_hash);
    }));
  }
}
