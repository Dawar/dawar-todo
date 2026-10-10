import { BotStorageClient } from '../bot-bridge/storage.mjs';
import { id } from './protocol.mjs';
import { artifactInput } from './node-storage-contract.mjs';

// No shared machine service credential travels to an agent. The authenticated
// node connection supplies scope; short-lived object grants carry only the
// exact registered file operation. Repository and workspace paths stay local.
export class NodeStorageClient extends BotStorageClient {
  constructor(runtime,transport,hub){
    const origin=new URL(hub).origin;
    super(runtime,{url:origin,credential:'unused-node-transport',fetch:(url,init={})=>{
      const u=new URL(url);if(u.origin!==origin||u.pathname!=='/storage/object'||!u.searchParams.get('grant')||u.username||u.password||u.hash)
        throw Error('Artifact transfer requires its exact same-origin registered grant.');
      return globalThis.fetch(u,{...init,redirect:'error'});
    }});
    this.headers={};this.transport=transport;this.features={taskQueues:true,taskRequests:process.platform==='linux',peerShare:false};
  }
  taskRequest(action,input={},botId=null){
    if(!this.features.taskRequests)throw Error('Task Requests are not enabled on this platform.');
    if(action==='pending'&&!botId)botId=this.runtime.store.bots().find(b=>{
      const c=this.transport.journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(b.id);
      return c&&this.transport.journal.currentControl({bot_id:b.id,epoch:c.epoch});
    })?.id;
    if(!id(botId))throw Error('Original assigned Task Request bot scope is required.');
    return this.transport.requestHub(botId,'task-request',{action,input},['pending','delivery','secure-authorize','intake-status'].includes(action));
  }
  async call(action,input={}){
    if(action==='registerBots')return this.registerBots();
    const safe=artifactInput(action,input);if(!id(safe.botId))throw Error('Assigned artifact bot scope is required.');
    return this.transport.artifactRequest(safe.botId,action,safe);
  }
  async registerBots(){
    let registered=0;
    for(const bot of this.runtime.store.bots({includeDeleted:true})){
      const control=this.transport.journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(bot.id);
      if(!control||!this.transport.journal.currentControl({bot_id:bot.id,epoch:control.epoch}))continue;
      await this.transport.artifactRequest(bot.id,'registerBot',{botId:bot.id});registered++;
    }
    return {registered};
  }
  async share(){throw Error('Cross-node peer files await their canonical addressed-room grant; original files are retained.');}
}
