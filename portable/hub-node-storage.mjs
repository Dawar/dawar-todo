import { BotStorage,StorageError } from '../db/bot-storage.ts';
import { TaskQueueExports } from '../db/task-queue-exports.ts';
import { fingerprint,id } from './protocol.mjs';
import { artifactInput } from './node-storage-contract.mjs';
import {createHash} from 'node:crypto';

export class HubNodeStorage {
  constructor({hub,controls,application,objects,config}){
    Object.assign(this,{hub,controls,application,objects,config});
    const assertStorageWriter=objects.assertWriter;
    objects.assertWriter=()=>{if(objects.writer)assertStorageWriter();this.controls.assertWriter();};
    objects.authorizeNode=scope=>{this.controls.assertWriter();return this.scope(scope.nodeId,scope.botId,scope.epoch);};
    this.environment={...config.applicationEnvironment,DB:application,DAWAR_OBJECT_STORAGE:objects.adapter(),BOTS_MACHINE_ID:config.applicationEnvironment?.BOTS_MACHINE_ID??'dawar-vm'};
  }
  scope(nodeId,botId,epoch){
    const n=this.hub.node(nodeId),p=this.hub.placement(n.owner,botId);
    if(n.owner!==this.config.owner.key||p.node_id!==nodeId||p.epoch!==epoch)throw Error('Foreign, revoked or stale artifact node scope.');
    return {nodeId,botId,epoch};
  }
  async peerCopies(owner,sender,recipient,ids,exchangeId){
    if(owner!==this.config.owner.key||!id(exchangeId)||!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length||ids.some(value=>!id(value)))throw Error('Invalid scoped registered peer files.');
    const placements=[sender,recipient].map(b=>this.hub.placement(owner,b.id));
    const current=()=>{
      this.controls.assertWriter();
      for(let i=0;i<placements.length;i++)if(fingerprint(this.hub.placement(owner,[sender,recipient][i].id))!==fingerprint(placements[i]))throw Error('Original peer file placement changed.');
    };
    current();const storage=new BotStorage(this.environment,owner,true);await storage.initialize();current();
    const sources=[];
    for(const fileId of ids){
      const {attachment}=await storage.download(fileId,sender.id);current();
      if(attachment.id!==fileId||attachment.botId!==sender.id||!attachment.ready||attachment.parentId||!Number.isSafeInteger(attachment.size)||attachment.size<0||!/^[a-f0-9]{64}$/.test(attachment.sha256??''))throw Error('Peer file must be its ready registered original.');
      sources.push(attachment);
    }
    if(sources.reduce((n,a)=>n+a.size,0)>100*1024*1024||sources.filter(a=>a.mimeType.startsWith('image/')).length>6)throw Error('Peer files exceed the original 100 MiB/six-image bounds.');
    const copies=[];
    for(const source of sources){
      current();const attachmentId=`peer-file:${createHash('sha256').update(`${exchangeId}:${recipient.id}:${source.id}`).digest('hex')}`;
      const {attachment}=await storage.share({id:source.id,botId:sender.id,recipientBotId:recipient.id,attachmentId,exchangeId,createdAt:new Date().toISOString()});current();
      if(attachment.id!==attachmentId||attachment.botId!==recipient.id||attachment.sha256!==source.sha256||attachment.size!==source.size||attachment.peerSource?.exchangeId!==exchangeId||attachment.peerSource?.botId!==sender.id||attachment.peerSource?.attachmentId!==source.id)throw Error('Original registered peer grant changed.');
      copies.push({...attachment,received:attachment.size});
    }
    // Metadata grants may precede the control transaction. They are private,
    // deterministic and reused under the same exchange/file IDs after a crash;
    // only PeerInbox commits their visible intake and original receipt.
    return copies;
  }
  grantResult(result,scope,input){
    const copy=structuredClone(result);
    for(const value of [copy.upload,copy]){
      if(typeof value?.url!=='string')continue;
      const u=new URL(value.url);if(u.origin!==this.config.publicOrigin||u.pathname!=='/storage/object')throw Error('Artifact grant origin mismatch.');
      const method=copy.upload===value?'POST':'GET',v=this.objects.verify(u.searchParams.get('grant'),method);
      const expires=Math.min(v.expires,Date.now()+900000);u.searchParams.set('grant',this.objects.token({...v,node:scope,...(method==='POST'?{hash:input.sha256}:{}),expires}));value.url=u.toString();if(method==='GET')copy.expiresAt=new Date(expires).toISOString();
    }
    return copy;
  }
  async request(nodeId,message){
    const {botId,epoch,action}=message,scope=this.scope(nodeId,botId,epoch),input=artifactInput(action,message.input);
    if(input.botId!==botId||Buffer.byteLength(JSON.stringify(input))>128*1024)throw Error('Registered artifact input scope or bound changed.');
    const mutation=['registerBot','prepare','finalize'].includes(action);
    if(mutation)this.controls.assertWriter();
    const identity=action==='registerBot'?botId:input.id??input.taskExportId;
    if(!id(identity))throw Error('Original registered artifact identity is required.');
    const operationId=`storage:${fingerprint({scope,action,identity})}`;
    const immutable=action==='prepare'?Object.fromEntries(['id','botId','name','size','mimeType','sha256','artifact','source','parentId'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])):input;
    const hash=fingerprint({scope,action,input:immutable});
    if(mutation){
      this.hub.transaction(()=>{
        this.scope(nodeId,botId,epoch);const prior=this.hub.db.prepare('SELECT * FROM portable_storage_operations WHERE id=?').get(operationId);
        if(prior&&prior.fingerprint!==hash)throw Error('Original artifact operation changed; retain its original file.');
        this.hub.db.prepare("INSERT OR IGNORE INTO portable_storage_operations VALUES(?,?,?,?,?,?,'pending')").run(operationId,nodeId,botId,epoch,action,hash);
      });
    }
    try{
      const storage=new BotStorage(this.environment,this.config.owner.key,true);await storage.initialize();this.scope(nodeId,botId,epoch);
      let result;
      if(action==='registerBot'){
        const b=this.controls.store.bot(botId);if(!b)throw Error('Assigned canonical bot registration is absent.');
        result=await storage.registerBots([{id:b.id,name:b.name,color:b.color,archived:Boolean(b.archived),deleted:Boolean(b.deletedAt)}]);
      }else if(action==='prepare')result=await storage.prepare(input);
      else if(action==='finalize')result=await storage.finalize(input.id,botId);
      else if(action==='taskQueueExport')result=await new TaskQueueExports(this.environment,this.config.owner.key).resolve(input.taskExportId,botId);
      else result=await storage.download(input.id,botId,action==='preview');
      this.scope(nodeId,botId,epoch);if(mutation)this.hub.transaction(()=>{
        this.scope(nodeId,botId,epoch);this.hub.db.prepare("UPDATE portable_storage_operations SET state='done' WHERE id=? AND fingerprint=?").run(operationId,hash);
      });
      return this.grantResult(result,scope,input);
    }catch(error){
      if(mutation)try{this.hub.transaction(()=>this.hub.db.prepare("UPDATE portable_storage_operations SET state='unknown' WHERE id=? AND state<>'done' AND fingerprint=?").run(operationId,hash));}catch{/* A frozen writer retains its original pending receipt; never infer completion. */}
      if(error instanceof StorageError)throw error;
      throw Error('Registered file confirmation is unavailable; retain its original ID and local bytes.');
    }
  }
}
