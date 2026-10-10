import {foregroundSource,validateForeground} from './foreground-source.mjs';
import {fingerprint} from './protocol.mjs';
import {HUB_PEER_READS} from './control-protocol.mjs';
import {captureActivity} from '../bot-bridge/turn-state.mjs';

// MCP provenance remains bot-only; a captured native call keeps its actual
// thread/turn/call IDs. Neither route can manufacture owner root controls.
export class AgentPeers {
  constructor(transport){
    Object.assign(this,{transport,runtime:transport.runtime,journal:transport.journal});
    this.runtime.peerTool=(bot,args,origin)=>this.tool(bot,args,origin);
  }
  async tool(bot,args,origin){
    const current=this.runtime.store.bot(bot.id);
    this.runtime.peers.assertReceiptCaller(current,`peers.${args?.operation}`,origin);
    if(current.archived||current.archiving||current.deletedAt||!args||typeof args!=='object'||Array.isArray(args))throw Object.assign(Error('Assigned peer caller is unavailable.'),{outcome:'not-sent'});
    captureActivity(this.runtime,bot.id);
    const activity=validateForeground(foregroundSource(this.runtime.store.get('botActivity',bot.id)),bot.id,current.threadId);
    const control=this.journal.db.prepare('SELECT epoch FROM node_controls WHERE bot_id=?').get(bot.id),before=control&&this.journal.currentControl({bot_id:bot.id,epoch:control.epoch});
    if(!before||before.stopped)throw Object.assign(Error('Assigned peer controls are offline or stopped.'),{outcome:'not-sent'});
    // Publish selected local originals through the existing immutable artifact
    // registration before a new peer acceptance. A stale native caller may
    // still reconcile a prior hub receipt, but cannot publish new local files.
    if(['send','reply'].includes(args.operation)&&args.attachmentIds?.length){
      if(typeof args.operationId!=='string'||!/^[a-zA-Z0-9:_-]{10,180}$/.test(args.operationId)||!Array.isArray(args.attachmentIds)||args.attachmentIds.length>12||new Set(args.attachmentIds).size!==args.attachmentIds.length)throw Error('Retain bounded selected files and the original peer operation ID.');
      let admitted=true;try{this.runtime.peers.assertOrigin(current,{...origin,...captureActivity(this.runtime,bot.id)});}catch{admitted=false;}
      if(admitted){
        const sources=args.attachmentIds.map(fileId=>this.runtime.owned('attachment',fileId,bot.id));
        if(sources.some(a=>!a.ready||!Number.isSafeInteger(a.size)||a.size<0)||sources.reduce((n,a)=>n+a.size,0)>100*1024*1024||sources.filter(a=>a.mimeType.startsWith('image/')).length>6)throw Error('Peer files exceed their ready-file bounds.');
        for(const source of sources)if(this.runtime.storage){
          await this.runtime.storage.publish(current,source);
          const control=this.journal.currentControl({bot_id:bot.id,epoch:before.epoch});
          if(!control||control.stopped||control.revision!==before.revision||fingerprint(foregroundSource(this.runtime.store.get('botActivity',bot.id)))!==fingerprint(activity))throw Object.assign(Error('Peer file preparation lost its original caller/control.'),{outcome:'not-sent'});
        }
      }
    }
    const read=HUB_PEER_READS.has(`peers.${args.operation}`),confirmation={kind:'assigned-peer-foreground',agentEpoch:this.runtime.epoch,activity};
    const result=await this.transport.peerTool(bot.id,{args,origin,confirmation,controlRevision:before.revision},read);
    const after=this.journal.currentControl({bot_id:bot.id,epoch:before.epoch});
    if(!after||after.stopped||after.revision!==before.revision||fingerprint(foregroundSource(this.runtime.store.get('botActivity',bot.id)))!==fingerprint(activity))throw Object.assign(Error('Peer caller changed while its original request awaited confirmation. Retain the original operation ID.'),{outcome:read?'not-sent':'uncertain'});
    return result;
  }
}
