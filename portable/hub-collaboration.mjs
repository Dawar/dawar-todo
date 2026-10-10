import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {Collaboration} from '../bot-bridge/collaboration.mjs';
import {HUB_ROOM_READS,HUB_ROOM_MUTATIONS,HUB_ROOM_TOOL_METHODS,roomDeliverySource,roomQuestionSource,ROOM_QUESTION_LOOKUP} from './control-protocol.mjs';
import {fingerprint,boundedFrame,originalNativeProof,originalLocalControlProof,id} from './protocol.mjs';
import {validateResponse} from '../bot-bridge/runtime.mjs';

const now=()=>new Date().toISOString();
const legacyHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Canonical room/post/delivery identities belong to the hub control store.
// Native provisioning, questions and acceptance belong to the assigned agent.
// Never run the original local collaboration scheduler on this facade.
export class HubCollaboration extends Collaboration {
  constructor(runtime){
    const facade=Object.assign(Object.create(runtime),{maintenance:{holding:()=>{
      try{runtime.assertWriter();return false;}catch{return true;}
    }}});
    super(facade,[],validateResponse,new Set());this.owners=new AsyncLocalStorage();this.callers=new AsyncLocalStorage();this.answerScopes=new AsyncLocalStorage();
    // Add the exact checked source inside the original answer transaction,
    // before its ACK. A crash cannot leave an acknowledged answer without the
    // source required for agent admission. Other Store operations are inherited.
    this.store=Object.create(runtime.store);
    this.store.put=(kind,value)=>{
      const captured=this.answerScopes.getStore();
      if(kind==='collaborationAnswer'&&captured&&value.id===captured.key&&value.operationId===captured.operationId)value={...value,portableAnswer:captured.value};
      return runtime.store.put(kind,value);
    };
  }
  ownedBot(botId){
    const owner=this.owners.getStore();
    if(!owner)throw Error('Authenticated hub room scope required.');
    this.runtime.scope(owner,botId);return this.store.bot(botId);
  }
  author(botId,origin,owner){
    this.ownedBot(botId);
    if(owner&&!origin)return {kind:'owner'};
    // Only the authenticated node broker can capture a native caller. A model
    // argument, owner RPC or old successful receipt cannot impersonate it.
    const captured=this.callers.getStore();
    if(owner||!captured||fingerprint(captured)!==fingerprint(origin))throw Error('A captured assigned native room caller is required.');
    return super.author(botId,origin,false);
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
    if(!HUB_ROOM_READS.has(request.method)&&!HUB_ROOM_MUTATIONS.has(request.method)&&request.method!=='conversations.respond')throw Error('Unsupported central room control.');
    if(caller.kind!=='owner')throw Error('Central room owner controls cannot be granted by node prose.');
    return this.owners.run(owner,()=>{
      this.ownedBot(request.botId);
      if(request.method==='conversations.respond'){this.runtime.assertWriter();return this.ownerRespond({...request,clientId:'authenticated-hub-owner'});}
      if(HUB_ROOM_MUTATIONS.has(request.method))this.runtime.assertWriter();
      return super.handle({...request,clientId:'authenticated-hub-owner'},null);
    });
  }
  nativeScope(owner,botId,contextId){
    return this.owners.run(owner,()=>{
      const {p}=this.runtime.scope(owner,botId),c=this.context(botId,contextId),room=this.ownedRoom(c.roomId);
      if(c.provisioning!=='bound'||!id(c.threadId))throw Error('Original registered native room is not bound.');
      return {botId,contextId:c.id,roomId:c.roomId,threadId:c.threadId,roomRevision:room.revision,nodeId:p.node_id,placementEpoch:p.epoch};
    });
  }
  captureRead(owner,nodeId,botId,epoch,method,scope,result){
    this.runtime.assertWriter();
    return this.owners.run(owner,()=>this.store.transaction(()=>{
      const current=this.nativeScope(owner,botId,scope.contextId),c=result?.context,prior=this.context(botId,scope.contextId);
      if(current.nodeId!==nodeId||current.placementEpoch!==epoch||fingerprint(current)!==fingerprint(scope)||
          !c||c.id!==scope.contextId||c.botId!==botId||c.roomId!==scope.roomId||c.threadId!==scope.threadId||c.provisioning!=='bound'||!Number.isSafeInteger(c.revision)||c.revision<0||!['running','idle','unknown'].includes(c.status))throw Error('Native room read is outside its original current scope.');
      if(c.revision>prior.generation)this.store.put('collaborationContext',{...prior,...c,generation:c.revision});
      if(!['conversations.requests','portable.roomQuestion'].includes(method))return;
      if(typeof result.agentEpoch!=='string'||!id(result.agentEpoch))throw Error('Question source lacks its actual agent lifetime.');
      const rows=method==='portable.roomQuestion'?(result.pending?[result.pending]:[]):result.items;
      if(!Array.isArray(rows)||rows.length>40||Buffer.byteLength(JSON.stringify(rows))>96*1024)throw Error('Native question page exceeds its original bound.');
      for(const pending of rows){
        const p=pending.request?.params;
        if(!pending||pending.botId!==botId||pending.contextId!==scope.contextId||pending.roomId!==scope.roomId||pending.threadId!==scope.threadId||pending.id!==pending.key||
            typeof pending.key!=='string'||pending.key.length>1000||p?.threadId!==scope.threadId||p.turnId!==pending.turnId||!id(pending.turnId)||
            p.questions?.some(q=>q.isSecret)||pending.async===true&&(pending.request.method!=='item/tool/requestUserInput'||p.isBlocking!==false||pending.key!==`${scope.contextId}:async:${p.itemId}`))throw Error('Question does not belong to this original public room context.');
        const stable=fingerprint(roomQuestionSource(pending)),old=this.store.get('collaborationPending',pending.key);
        if(old?.portableQuestionSource&&old.portableQuestionSource.fingerprint!==stable)throw Error('Original question source changed; its records were retained.');
        if(this.store.get('collaborationAnswer',pending.key)?.state==='accepted')continue;
        this.store.put('collaborationPending',{...pending,portableQuestionSource:{fingerprint:stable,nodeId,epoch,agentEpoch:result.agentEpoch,original:pending,scope,observedAt:now()}});
      }
    }));
  }
  async ownerRespond(request){
    const {botId,params:p}=request;
    if(!p||typeof p.key!=='string'||Object.keys(p).some(k=>!['key','result'].includes(k))||typeof request.operationId!=='string'||!/^[a-zA-Z0-9:_-]{10,180}$/.test(request.operationId))throw Error('Use the original question key, stable operation ID and bounded answer.');
    const previous=this.store.get('collaborationAnswer',p.key),retained=this.store.get('collaborationPending',p.key)??previous?.pending;
    if(!retained?.portableQuestionSource)throw Error('Read this original context question before answering.');
    const scope=this.nativeScope(this.owners.getStore(),botId,retained.contextId);
    if(retained.botId!==botId||retained.threadId!==scope.threadId||retained.portableQuestionSource.nodeId!==scope.nodeId||retained.portableQuestionSource.epoch!==scope.placementEpoch)throw Error('Question belongs to a different original placement.');
    if(!retained.async)return this.ownerSyncAnswer(request,retained,scope,previous);
    if(previous)return super.respond(request);
    const response=await this.runtime.router.request(this.owners.getStore(),{id:`room-question:${fingerprint(request.operationId)}`,method:'portable.roomQuestion',botId,params:{contextId:scope.contextId,key:p.key}},'authenticated-hub-owner',ROOM_QUESTION_LOOKUP);
    const actual=response.result?.pending;
    if(!actual||actual.unavailable||fingerprint(roomQuestionSource(actual))!==retained.portableQuestionSource.fingerprint||fingerprint(this.nativeScope(this.owners.getStore(),botId,scope.contextId))!==fingerprint(scope))throw Error('Original native question changed or is unavailable. No answer was queued.');
    const result=await this.answerScopes.run({key:p.key,operationId:request.operationId,value:{result:validateResponse(actual.request,p.result),question:actual}},()=>super.respond(request)),d=this.store.get('collaborationDelivery',result.delivery.id);
    if(d.answerKey!==p.key)throw Error('Original answer delivery identity changed.');
    return result;
  }
  async ownerSyncAnswer(request,retained,scope,previous){
    const owner=this.owners.getStore(),{botId,operationId,params:p}=request,result=validateResponse(retained.request,p.result),hash=legacyHash({method:request.method,botId,key:p.key,result});
    const old=this.store.operation(operationId);
    if(previous||old){
      if(!previous||previous.botId!==botId||previous.operationId!==operationId||previous.fingerprint!==hash||old?.botId!==botId||old.method!==request.method||old.fingerprint!==hash)throw Error('The original answer/input owns this question. No replacement was sent.');
      const row=this.runtime.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
      if(!row||row.owner!==owner||row.bot_id!==botId||row.node_id!==scope.nodeId||row.epoch!==scope.placementEpoch||row.fingerprint!==old.portableFingerprint)throw Error('Original answer transport requires reconciliation.');
      return (await this.runtime.router.wait(row)).result;
    }
    const response=await this.runtime.router.request(owner,{id:`room-question:${fingerprint(operationId)}`,method:'portable.roomQuestion',botId,params:{contextId:scope.contextId,key:p.key}},'authenticated-hub-owner',ROOM_QUESTION_LOOKUP),q=response.result?.pending;
    if(!q||q.async===true||q.unavailable||q.epoch!==response.result.agentEpoch||q.epoch!==retained.portableQuestionSource.agentEpoch||fingerprint(roomQuestionSource(q))!==retained.portableQuestionSource.fingerprint||fingerprint(this.nativeScope(owner,botId,scope.contextId))!==fingerprint(scope))throw Error('Original synchronous question or agent lifetime changed. No answer was queued.');
    const row=this.store.transaction(()=>{
      const {p:placement,b}=this.runtime.scope(owner,botId),c=this.context(botId,q.contextId),room=this.ownedRoom(q.roomId),pending=this.store.get('collaborationPending',p.key);
      if(this.store.operation(operationId)||this.store.get('collaborationAnswer',p.key)||!pending||pending.unavailable||fingerprint(roomQuestionSource(pending))!==retained.portableQuestionSource.fingerprint||placement.stopped||b.queuePaused||b.archived||b.archiving||c.paused||c.activeTurnId!==q.turnId||room.held||!room.members.includes(botId)||fingerprint(this.nativeScope(owner,botId,scope.contextId))!==fingerprint(scope))throw Error('Original question, room or placement changed before answer persistence.');
      const immutableScope={botId,nodeId:scope.nodeId,placementEpoch:scope.placementEpoch,contextId:q.contextId,roomId:q.roomId,threadId:q.threadId};
      const params={question:q,questionFingerprint:retained.portableQuestionSource.fingerprint,agentEpoch:q.epoch,result,scope:immutableScope};
      const command=this.runtime.hub.enqueueOn(this.store.db,owner,botId,operationId,{method:'portable.roomRespond',params});
      this.store.put('collaborationAnswer',{id:p.key,botId,contextId:q.contextId,pending,operationId,fingerprint:hash,state:'queued',portableAnswer:{synchronous:true,params}});
      this.store.saveOperation(operationId,hash,'dispatching',{method:request.method,botId,params:p,contextId:q.contextId,portableFingerprint:command.fingerprint});
      this.publish(q.roomId,{contextId:q.contextId,questionKey:q.key,operationId});
      return command;
    });
    return (await this.runtime.router.wait(row)).result;
  }
  answerState(owner,nodeId,botId,epoch,row,payload){
    const {p,b}=this.runtime.scope(owner,botId),params=payload.params,q=params?.question,a=q&&this.store.get('collaborationAnswer',q.key),op=this.store.operation(row.operation_id);
    if(!q||q.async===true||q.botId!==botId||q.epoch!==params.agentEpoch||fingerprint(roomQuestionSource(q))!==params.questionFingerprint||a?.botId!==botId||a.operationId!==row.operation_id||a.fingerprint!==legacyHash({method:'conversations.respond',botId,key:q.key,result:params.result})||fingerprint(a.portableAnswer?.params)!==fingerprint(params)||op?.portableFingerprint!==row.fingerprint||params.scope.nodeId!==nodeId||params.scope.placementEpoch!==epoch||params.scope.botId!==botId||params.scope.contextId!==q.contextId||params.scope.roomId!==q.roomId||params.scope.threadId!==q.threadId)throw Error('Original synchronous answer source changed.');
    const c=this.context(botId,q.contextId),room=this.ownedRoom(q.roomId),pending=this.store.get('collaborationPending',q.key);
    return {operationId:row.operation_id,fingerprint:row.fingerprint,botId,epoch,controlRevision:p.control_revision,room,params,
      canRespond:!p.stopped&&!b.queuePaused&&!b.archived&&!b.archiving&&!c.paused&&c.threadId===q.threadId&&c.activeTurnId===q.turnId&&!room.held&&room.members.includes(botId)&&a.state==='queued'&&!!pending&&!pending.unavailable&&fingerprint(roomQuestionSource(pending))===params.questionFingerprint&&this.runtime.router.connection(p)?.portableHello?.capabilities?.centralRoomDispatch===true};
  }
  nodeState(owner,nodeId,botId,epoch,operationId,hash){
    const {p}=this.runtime.scope(owner,botId),row=this.runtime.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
    if(p.node_id!==nodeId||p.epoch!==epoch||!row||row.owner!==owner||row.bot_id!==botId||row.node_id!==nodeId||row.epoch!==epoch||row.fingerprint!==hash)throw Error('Foreign original room command.');
    const payload=JSON.parse(row.payload);
    if(payload.method==='portable.roomRespond')return this.owners.run(owner,()=>this.answerState(owner,nodeId,botId,epoch,row,payload));
    if(payload.method!=='portable.roomDispatch')throw Error('This command is not a registered room delivery.');
    return this.owners.run(owner,()=>{
      const delivery=this.store.get('collaborationDelivery',operationId),post=delivery&&this.store.get('collaborationPost',delivery.postId);
      if(!delivery||delivery.botId!==botId||fingerprint(roomDeliverySource(delivery))!==fingerprint(roomDeliverySource(payload.params.delivery))||fingerprint(post)!==fingerprint(payload.params.post))throw Error('Original canonical room source changed.');
      const room=this.ownedRoom(delivery.roomId);
      return {operationId,fingerprint:hash,botId,epoch,controlRevision:p.control_revision,room,post,delivery,
        ...(delivery.answerKey?{answer:this.store.get('collaborationAnswer',delivery.answerKey)?.portableAnswer}:{}),
        canDispatch:!p.stopped&&this.runtime.router.connection(p)?.portableHello?.capabilities?.centralRoomDispatch===true&&delivery.state==='queued'&&this.allowed(delivery)};
    });
  }
  async tool(owner,nodeId,botId,epoch,frame){
    const {p}=this.runtime.scope(owner,botId),{request,origin,confirmation,controlRevision}=frame;
    if(p.node_id!==nodeId||p.epoch!==epoch||p.control_revision!==controlRevision||p.stopped||
        !request||request.botId!==botId||request.clientId||!request.params||typeof request.params!=='object'||Array.isArray(request.params)||
        !origin||origin.authority!=='native-tool'||origin.botId!==botId||!id(origin.contextId)||!id(origin.threadId)||!id(origin.turnId)||
        !confirmation||!originalNativeProof(confirmation.receipt,confirmation.operationId))throw Error('Current assigned native room authority is unconfirmed.');
    if(request.method!=='collaboration.authorize'&&!HUB_ROOM_TOOL_METHODS.has(request.method))throw Error('This native room operation is not yet supported by the central broker.');
    this.runtime.assertWriter();
    return this.owners.run(owner,()=>this.runtime.lock(`room-tool:${botId}`,()=>{
      const current=this.runtime.hub.placement(owner,botId);
      if(fingerprint(current)!==fingerprint(p))throw Error('Control changed before the captured room tool.');
      const row=this.runtime.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(confirmation.operationId);
      if(!row||row.owner!==owner||row.node_id!==nodeId||row.bot_id!==botId||row.epoch!==epoch||row.fingerprint!==confirmation.fingerprint||
          JSON.parse(row.payload).method!=='portable.roomDispatch'||['terminal'].includes(row.state)||
          confirmation.receipt.threadId!==origin.threadId||confirmation.receipt.turnId!==origin.turnId||confirmation.receipt.result?.context?.id!==origin.contextId||
          confirmation.receipt.result?.context?.status!=='running'||confirmation.receipt.result?.nativeStatus)throw Error('Tool proof is outside its original live room delivery.');
      const d=this.store.get('collaborationDelivery',row.operation_id),c=this.store.get('collaborationContext',origin.contextId);
      if(!d||d.contextId!==origin.contextId||d.terminalStatus||d.state==='completed'||c?.generation>confirmation.receipt.result.context.revision||
          this.store.get('collaborationTurn',`${origin.contextId}:${origin.turnId}`))throw Error('The original room turn is no longer current.');
      // A native tool can precede turn/start's ACK. Positive exact-client
      // evidence may bind canonical context/result records, but does not rewrite
      // the mailbox or manufacture its missing transport ACK. No input retry.
      this.receipt({...row,state:'native-accepted',receipt:JSON.stringify(confirmation.receipt)},{mark:false});
      return this.callers.run(origin,()=>{
        this.author(botId,origin,false);
        if(request.method==='collaboration.authorize'){
          const context=this.context(botId,origin.contextId),room=this.room(botId,context.roomId);
          if(room.held)throw Error('The owner held this room. Local effects were not admitted.');
          return {botId,nodeId,epoch,controlRevision,origin,room};
        }
        return super.handle(request,origin);
      });
    }));
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
        const answer=d.answerKey?this.store.get('collaborationAnswer',d.answerKey)?.portableAnswer:null;
        if(d.answerKey&&!answer)return;
        const command=this.runtime.hub.enqueueOn(this.store.db,p.owner,d.botId,d.id,{method:'portable.roomDispatch',params:{room,post,delivery:d,...(answer?{answer}:{})}});
        this.store.saveOperation(d.id,command.fingerprint,'dispatching',{method:'collaboration.dispatch',botId:d.botId,portableFingerprint:command.fingerprint,deliveryId:d.id,contextId:d.contextId,createdAt:now()});
        this.publish(d.roomId,{delivery:this.publicDelivery(d)});
        this.store.afterCommit(()=>this.runtime.router.connection(current)?.send(boundedFrame({type:'sync',...this.runtime.hub.sync(current.node_id)})));
      })));
    }
  }
  answerReceipt(row,{mark=true}={}){
    const payload=JSON.parse(row.payload),r=row.receipt&&JSON.parse(row.receipt);if(payload.method!=='portable.roomRespond'||!r)return;
    this.owners.run(row.owner,()=>this.store.transaction(()=>{
      const {p}=this.runtime.scope(row.owner,row.bot_id),params=payload.params,q=params.question,a=this.store.get('collaborationAnswer',q.key),op=this.store.operation(row.operation_id),c=this.context(row.bot_id,q.contextId);
      if(p.node_id!==row.node_id||p.epoch!==row.epoch||q.botId!==row.bot_id||c.threadId!==q.threadId||a?.botId!==row.bot_id||a.operationId!==row.operation_id||op?.portableFingerprint!==row.fingerprint||op.method!=='conversations.respond'||fingerprint(a.portableAnswer?.params)!==fingerprint(params)||fingerprint(roomQuestionSource(a.pending))!==params.questionFingerprint)throw Error('Original response receipt or placement changed.');
      if(row.state==='unknown'||r.outcome==='rejected'){
        if(a.state==='accepted')throw Error('An ambiguous later receipt cannot remove a confirmed original write.');
        const state=row.state==='unknown'?'uncertain':'rejected';
        this.store.put('collaborationAnswer',{...a,state,error:r.error??'Original response write is unconfirmed.'});
        this.store.saveOperation(op.id,op.fingerprint,state==='uncertain'?'uncertain':'failed',{...op,error:r.error??'Original response write is unconfirmed.'});
      }else if(row.state==='terminal'&&originalLocalControlProof(r,row.operation_id,row.fingerprint,payload)){
        const pending=this.store.get('collaborationPending',q.key);
        if(pending&&fingerprint(roomQuestionSource(pending))!==params.questionFingerprint)throw Error('Original question source changed before receipt application.');
        this.store.put('collaborationAnswer',{...a,state:'accepted',responseConfirmation:'written',evidence:'assigned-agent-original-stdio-write',error:null});
        if(pending)this.store.remove('collaborationPending',q.key);
        this.store.saveOperation(op.id,op.fingerprint,'done',{...op,result:r.result,error:null});
      }else return;
      this.publish(q.roomId,{contextId:q.contextId,questionKey:q.key,operationId:row.operation_id});
      if(mark)this.store.db.prepare('INSERT INTO portable_control_receipts VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET receipt_hash=excluded.receipt_hash').run(row.operation_id,row.receipt_hash);
    }));
  }
  receipt(row,{mark=true}={}){
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
        const status=r.nativeStatus??result.nativeStatus??d.terminalStatus,terminal=['completed','failed','interrupted'].includes(status);
        if(row.state==='terminal'&&!terminal)throw Error('Terminal room receipt lacks a terminal native outcome.');
        // A tool confirmation can precede the transport ACK. A later snapshot
        // of the same original receipt must not regress a newer native context.
        if(!prior||prior.generation<=c.revision){
          // Delivery completion is turn-scoped. A delayed terminal receipt for
          // an older turn cannot clear a newer active turn in this context.
          if(!['running','idle','unknown'].includes(c.status)||c.status==='running'&&!id(c.activeTurnId)||terminal&&c.activeTurnId===r.turnId)throw Error('Original context lacks its current native turn state.');
          if(prior?.generation===c.revision&&(prior.provisioning!==c.provisioning||prior.status!==c.status||prior.activeTurnId!==c.activeTurnId))throw Error('Original context revision has contradictory native status.');
          this.store.put('collaborationContext',{...prior,...c,generation:c.revision});
        }
        this.store.put('collaborationDelivery',{...d,state:terminal?'completed':'accepted',threadId:r.threadId,turnId:r.turnId,terminalStatus:terminal?status:null,evidence:'assigned-agent-original-client',error:null});
        if(d.answerKey){
          const answer=this.store.get('collaborationAnswer',d.answerKey);
          if(answer?.deliveryId!==d.id)throw Error('Original owner answer receipt changed.');
          this.store.put('collaborationAnswer',{...answer,state:'accepted',turnId:r.turnId,evidence:'assigned-agent-original-client'});this.store.remove('collaborationPending',d.answerKey);
        }
        this.store.saveOperation(op.id,op.fingerprint,'done',{...op,result,error:null});
      }else return;
      this.publish(d.roomId,{delivery:this.publicDelivery(this.store.get('collaborationDelivery',d.id))});
      if(mark)this.store.db.prepare('INSERT INTO portable_control_receipts VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET receipt_hash=excluded.receipt_hash').run(row.operation_id,row.receipt_hash);
    }));
  }
}
