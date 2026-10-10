import {randomUUID,createHash} from 'node:crypto';
import {MessageBursts} from '../bot-bridge/message-bursts.mjs';
import {fingerprint} from './protocol.mjs';

const now=()=>new Date().toISOString();
const open=b=>!b.supersededBy&&['pending','preparing','paused','dispatching','uncertain','failed'].includes(b.state);
const legacy=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const burstSource=m=>({id:m.id,botId:m.botId,batchId:m.batchId,text:m.text,attachmentIds:m.attachmentIds,reply:m.reply??null,createdAt:m.createdAt,sequence:m.sequence});

// Original countdown/hold/queue closures, on the ONE hub control database.
// The node never runs this scheduler or owns the source message records.
export class HubBursts extends MessageBursts {
  static create(runtime){
    // The ordinary constructor writes recovery records. Read-only staging
    // has no writer authority; recover only under the hub's real tick fence.
    const value=Object.create(this.prototype);
    Object.assign(value,{runtime,store:runtime.store,leases:new Map(),timers:new Map()});
    return value;
  }
  async pump(botId){
    if(this.runtime.closed||!this.runtime.authority)return;
    return this.runtime.lock(botId,async()=>{
      this.runtime.assertWriter();const bot=this.store.bot(botId),b=this.batches(botId).find(open);
      if(!b||bot.archived||bot.archiving||bot.deletedAt||b.state!=='pending'||this.store.get('burstControl',botId)?.paused)return;
      const lease=b.immediate?0:Math.max(0,...[...this.leases.values()].filter(l=>l.botId===botId).map(l=>l.until));
      if(Date.now()<Math.max(Date.parse(b.dueAt),lease)){this.arm(botId);return;}
      const p=this.runtime.hub.db.prepare('SELECT * FROM portable_placements WHERE bot_id=?').get(botId);
      if(!p||p.stopped||!this.runtime.router.connection(p))return;
      const node=this.runtime.hub.node(p.node_id);
      if(JSON.parse(node.hello??'{}').capabilities?.centralBursts!==true)return;
      // Do not overtake another delivery whose native acceptance is unknown.
      if(this.runtime.hub.db.prepare("SELECT 1 FROM portable_mailbox WHERE bot_id=? AND state IN ('queued','received','unknown') LIMIT 1").get(botId))return;
      const response=await this.runtime.router.request(p.owner,{id:`burst-work:${randomUUID()}`,method:'work.read',botId,params:{}},'hub:bursts');
      const work=response.result;
      if(response.cache?.stale||work?.botId!==botId||work.threadId!==bot.threadId||!['ready','working'].includes(work.state))return;
      // Human sends may steer current work. Automatic queues remain idle-only.
      try{this.dispatch(bot,b,p);}catch(error){
        // A failed local reservation has no remote effect. Retain the exact
        // text/files visibly paused, instead of retrying every scheduler tick.
        if(this.store.operation(b.id)||this.runtime.hub.db.prepare('SELECT 1 FROM portable_mailbox WHERE operation_id=?').get(b.id))throw error;
        this.store.transaction(()=>{const current=this.store.get('messageBurst',b.id);if(fingerprint(current)!==fingerprint(b))throw error;
          this.store.put('messageBurst',{...b,state:'paused',dueAt:null,error:error.message,revision:b.revision+1});this.hold(bot.id,true);this.publish(bot.id);
        });
      }
    });
  }
  dispatch(bot,b,captured){
    return this.store.transaction(()=>{
      const p=this.runtime.hub.placement(captured.owner,bot.id),current=this.store.get('messageBurst',b.id),control=this.store.get('burstControl',bot.id);
      if(fingerprint(p)!==fingerprint(captured)||p.stopped||bot.threadId!==this.store.bot(bot.id).threadId||fingerprint(current)!==fingerprint(b)||current.state!=='pending'||control?.paused)return;
      if(this.store.operation(b.id))throw Error('Original burst reservation must reconcile; it was not repeated.');
      const messages=b.messageIds.map(mid=>this.store.get('burstMessage',mid));
      if(!messages.length||messages.some(m=>!m||m.botId!==bot.id||m.batchId!==b.id||m.state!=='pending'))throw Error('Original burst message identities changed.');
      const files=[...new Set(messages.flatMap(m=>m.attachmentIds))].map(fid=>{
        const a=this.runtime.owned('attachment',fid,bot.id);
        if(!a.ready||!/^[a-f0-9]{64}$/.test(a.sha256??''))throw Error('Original registered file is unavailable.');
        return {id:a.id,sha256:a.sha256,size:a.size};
      });
      const params={text:messages.map(m=>m.text).filter(Boolean).join('\n\n'),attachments:messages.flatMap(m=>m.attachmentIds)};
      const payload={method:'portable.burstDispatch',params:{batch:b,messages:messages.map(burstSource),files,controlRevision:p.control_revision}};
      const row=this.runtime.hub.enqueueOn(this.store.db,p.owner,bot.id,b.id,payload);
      this.store.saveOperation(b.id,legacy({method:'turn.send',botId:bot.id,params}),'dispatching',{method:'turn.send',botId:bot.id,params,portableBurst:true,portableFingerprint:row.fingerprint,createdAt:now()});
      this.store.put('messageBurst',{...b,state:'dispatching',params,dueAt:null});
      for(const m of messages)this.store.put('burstMessage',{...m,state:'dispatching'});
      this.publish(bot.id);
      // The mailbox reservation is the cross-machine in-flight boundary.
      // A later Pause reports it; it never claims to withdraw a possible send.
      this.store.afterCommit(()=>this.runtime.router.connection(p)?.send(JSON.stringify({type:'sync',...this.runtime.hub.sync(p.node_id)})));
      return row;
    });
  }
  receipt(row){
    const payload=JSON.parse(row.payload),r=row.receipt&&JSON.parse(row.receipt);
    if(payload.method!=='portable.burstDispatch'||!r)return false;
    this.store.transaction(()=>{
      const b=this.store.get('messageBurst',row.operation_id),op=this.store.operation(row.operation_id),source=payload.params.batch;
      if(!b||b.botId!==row.bot_id||b.threadId!==source.threadId||b.revision!==source.revision||fingerprint(b.messageIds)!==fingerprint(source.messageIds)||op?.portableFingerprint!==row.fingerprint||payload.params.messages.some(m=>fingerprint(burstSource(this.store.get('burstMessage',m.id)??{}))!==fingerprint(m)))
        throw Error('Original hub burst differs from its native receipt.');
      if(r.outcome==='rejected'||row.state==='unknown'){
        const state=row.state==='unknown'?'uncertain':'failed',outcome=row.state==='unknown'?'uncertain':'rejected';
        this.store.saveOperation(op.id,op.fingerprint,state==='failed'?'failed':'uncertain',{...op,outcome,error:r.error??'Original burst native acceptance is unconfirmed.'});
        this.store.put('messageBurst',{...b,state,error:r.error??'Original burst native acceptance is unconfirmed.'});
        for(const mid of b.messageIds)this.store.put('burstMessage',{...this.store.get('burstMessage',mid),state});
        this.publish(row.bot_id);
      }else if(['native-accepted','running','terminal'].includes(row.state)&&r.turnId&&r.result!==undefined){
        if(r.operationId!==row.operation_id||r.threadId!==b.threadId||(r.result?.turn?.id??r.result?.turnId)!==r.turnId)throw Error('Native burst receipt has a foreign conversation or turn identity.');
        this.store.saveOperation(op.id,op.fingerprint,'done',{...op,result:r.result,error:null});this.settle(b,r.result);
      }else return;
      this.store.db.prepare('INSERT INTO portable_control_receipts VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET receipt_hash=excluded.receipt_hash').run(row.operation_id,row.receipt_hash);
    });return true;
  }
  async tick(){
    for(const bot of this.store.bots()){
      const first=this.batches(bot.id).find(open);
      if(first?.state==='preparing'&&!this.store.operation(first.id))this.store.transaction(()=>{
        const plan=this.store.get('planExecution',first.id);if(plan?.dispatchFence||plan?.turnId)return;
        if(plan?.state==='dispatching')this.store.put('planExecution',{...plan,state:'finished',preparationOutcome:'not-submitted',finishedAt:now()});
        this.store.put('messageBurst',{...first,state:'paused',dueAt:null,revision:(first.revision??0)+1});this.hold(bot.id,true);this.publish(bot.id);
      });
      if(first?.state==='pending'&&!this.runtime.locks.has(bot.id))await this.pump(bot.id).catch(error=>this.runtime.emit('fault',error));
    }
  }
  close(){for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();this.leases.clear();}
}
