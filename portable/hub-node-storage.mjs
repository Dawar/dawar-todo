import { BotStorage,StorageError } from '../db/bot-storage.ts';
import { TaskQueueExports } from '../db/task-queue-exports.ts';
import { fingerprint,id } from './protocol.mjs';
import { artifactInput } from './node-storage-contract.mjs';

export class HubNodeStorage {
  constructor({hub,controls,application,objects,config}){
    Object.assign(this,{hub,controls,application,objects,config});
    const assertStorageWriter=objects.assertWriter;
    objects.assertWriter=()=>{if(objects.writer)assertStorageWriter();this.controls.assertWriter();};
    objects.authorizeNode=scope=>{this.controls.assertWriter();return this.scope(scope.nodeId,scope.botId,scope.epoch);};
    this.environment={...config.applicationEnvironment,DB:application,DAWAR_OBJECT_STORAGE:objects.adapter(),BOTS_MACHINE_ID:config.applicationEnvironment?.BOTS_MACHINE_ID??'dawar-vm',BOTS_OWNER_EMAIL:config.owner.key,BOTS_TICKET_SECRET:config.gatewaySecret,
      TASK_REQUEST_SECRET:config.applicationEnvironment?.TASK_REQUEST_SECRET??config.applicationEnvironment?.BOTS_TICKET_SECRET??config.gatewaySecret};
  }
  registeredAttachment(fileId,botId){
    if(!id(fileId)||!id(botId))throw Error('Invalid registered attachment identity.');
    this.hub.placement(this.config.owner.key,botId);
    // Synchronous, indexed, owner+bot scoped lookup: safe inside the existing
    // logical acceptance transaction without a network await or new receipt.
    const row=this.application.sqlite.prepare('SELECT state,metadata,parent_id FROM bot_storage_files WHERE owner_key=? AND id=? AND bot_id=?').get(this.config.owner.key,fileId,botId);
    if(!row)throw Error('Registered attachment is unavailable for this bot.');
    if(row.state!=='ready'||row.parent_id)throw Error('Registered attachment is not ready for sending.');
    const a=JSON.parse(row.metadata);
    if(a.id!==fileId||a.botId!==botId||!Number.isSafeInteger(a.size)||a.size<0||a.size>100*1024*1024||!/^[a-f0-9]{64}$/.test(a.sha256??'')||typeof a.name!=='string'||a.name.length>160||typeof a.mimeType!=='string')throw Error('Registered attachment metadata is invalid.');
    // Do not project paths, grants or private storage keys into logical input.
    return {id:a.id,botId:a.botId,name:a.name,size:a.size,mimeType:a.mimeType,sha256:a.sha256,createdAt:a.createdAt,ready:true,cloudState:'ready'};
  }
  scope(nodeId,botId,epoch){
    const n=this.hub.node(nodeId),p=this.hub.placement(n.owner,botId);
    if(n.owner!==this.config.owner.key||p.node_id!==nodeId||p.epoch!==epoch)throw Error('Foreign, revoked or stale artifact node scope.');
    return {nodeId,botId,epoch};
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
