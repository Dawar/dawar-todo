import {AsyncLocalStorage} from 'node:async_hooks';
import {Collaboration} from '../bot-bridge/collaboration.mjs';
import {HUB_ROOM_READS,HUB_ROOM_MUTATIONS} from './control-protocol.mjs';

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
}
