import { EventEmitter } from 'node:events';
import { createHash,randomUUID } from 'node:crypto';
import { Store } from '../bot-bridge/store.mjs';
import { BotRuntime } from '../bot-bridge/runtime.mjs';
import { acceptLocalQueueOperation } from '../bot-bridge/local-queue-operation.mjs';
import {acceptSingleThreadOperation} from '../bot-bridge/single-thread-operations.mjs';
import {PrimaryExecution} from '../bot-bridge/primary-execution.mjs';
import {preferencePatch} from '../bot-bridge/bot-preferences.mjs';
import {HubBursts} from './hub-bursts.mjs';
import {HubCollaboration} from './hub-collaboration.mjs';
import {HubPeers} from './hub-peers.mjs';
import { stagedQueue } from '../bot-bridge/prompt-queue.mjs';
import { ownedList,publicLists,queueTool,flushDueLists } from '../bot-bridge/queue-lists.mjs';
import { normalizeSchedule,collectDueRuns } from '../bot-bridge/schedules.mjs';
import { ExecutionConfiguration } from '../bot-bridge/execution-config.mjs';
import { PlanLifecycle } from '../bot-bridge/plan-lifecycle.mjs';
import { ownedReply } from '../bot-bridge/message-replies.mjs';
import { replyInputText } from '../lib/bot-replies.ts';
import { activityUnresolved } from '../bot-bridge/turn-state.mjs';
import { boundedFrame,fingerprint,id,originalNativeProof } from './protocol.mjs';
import {foregroundSource,validateForeground} from './foreground-source.mjs';
import {validatePrimary} from './primary-source.mjs';
import {operatorSource,validateOperatorSource} from './operator-source.mjs';
export { hubActivation } from './hub-authority.mjs';
import { controlWriteGuard } from './hub-authority.mjs';
import { HUB_READS,HUB_MUTATIONS,HUB_TOOLS,NODE_LOGICAL_COMMANDS,HUB_BURST_MUTATIONS,HUB_ROOM_READS,HUB_ROOM_MUTATIONS,HUB_PEER_READS,HUB_PEER_MUTATIONS } from './control-protocol.mjs';

export { HUB_READS,HUB_MUTATIONS,HUB_TOOLS,NODE_LOGICAL_COMMANDS };
const now=()=>new Date().toISOString();
const digest=value=>createHash('sha256').update(value).digest('hex');
const MAILBOX=Symbol('prepared-mailbox');
const ownerQueueControls=new Set(['queue.send','queue.resume','work.resume']);

// The hub reuses the original logical records and local acceptance closures.
// This facade has no native process: queue mutation cannot become inference.
export class HubControls extends EventEmitter {
  constructor({path,hub,router,authority=null,defaultTimeZone='America/Toronto',broadcast=()=>{},quietWindow={start:'02:30',end:'04:30',timeZone:'America/Toronto',scheduleIds:[]}}) {
    super();Object.assign(this,{hub,router,authority,defaultTimeZone,broadcast,quietWindow});
    this.store=new Store(path);this.ready=true;this.locks=new Map();this.closed=false;
    this.store.db.exec('PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS portable_control_receipts(operation_id TEXT PRIMARY KEY,receipt_hash TEXT NOT NULL)');
    this.defaults=this.store.meta('portable-defaults')??{};
    this.executionConfig=new ExecutionConfiguration(this);this.plans=new PlanLifecycle(this);
    this.primary={store:this.store,runtime:this,single:bot=>PrimaryExecution.prototype.single(bot),accept:PrimaryExecution.prototype.accept,
      list:PrimaryExecution.prototype.list,publicItem:PrimaryExecution.prototype.publicItem,cursor:PrimaryExecution.prototype.cursor,openItems:PrimaryExecution.prototype.openItems,
      publish:botId=>this.emitEvent('work',{},botId)};this.bursts=HubBursts.create(this);
    this.collaboration=new HubCollaboration(this);
    this.peers=new HubPeers(this);
    const transaction=this.store.transaction.bind(this.store);
    const refresh=controlWriteGuard(this.store.db,{writeScope:()=>this.store.transactionDepth>0,transactionScope:()=>this.controlTransactionDepth>0});
    this.store.transaction=fn=>{
      refresh();this.controlTransactionDepth=(this.controlTransactionDepth??0)+1;
      try{return transaction(()=>{this.assertWriter();const result=fn();this.assertWriter();return result;});}
      finally{this.controlTransactionDepth--;refresh();}
    };
    // These original Store helpers also serve callers outside a larger batch.
    // Preserve nested transactions and after-commit publication semantics.
    for(const name of ['put','remove','saveBot','saveOperation','event']){
      const method=this.store[name].bind(this.store);
      this.store[name]=(...args)=>this.store.transactionDepth?method(...args):this.store.transaction(()=>method(...args));
    }
    const meta=this.store.meta.bind(this.store);
    this.store.meta=(key,value)=>value===undefined||this.store.transactionDepth?meta(key,value):this.store.transaction(()=>meta(key,value));
    // A fault is retained as metadata, without spawning a bot or an ACK loop.
    this.on('fault',error=>{this.lastFault={message:error.message,at:now()};});
  }
  assertWriter() {
    const r=this.hub.db.prepare('SELECT * FROM portable_authority WHERE id=1').get();
    if(this.closed||!this.authority||!r||r.frozen!==0||r.writer_id!==this.authority.writerId||r.epoch!==this.authority.epoch)
      throw Object.assign(Error('Logical controls are awaiting the authoritative hub activation or write freeze.'),{outcome:'not-sent'});
  }
  scope(owner,botId) {const p=this.hub.placement(owner,botId),b=this.store.bot(botId);if(b.deletedAt)throw Error('This bot was deleted; its records are retained.');return {p,b};}
  owned(kind,value,botId) {const r=this.store.get(kind,value);if(!r||r.botId!==botId)throw Error('Record belongs to another bot.');return r;}
  activityUnresolved(botId) {return activityUnresolved(this,botId);}
  settings(bot) {return BotRuntime.prototype.settings.call(this,bot);}
  managedPrompt(botId,clientId) {return BotRuntime.prototype.managedPrompt.call(this,botId,clientId);}
  publicAttachment(a) {return BotRuntime.prototype.publicAttachment.call(this,a);}
  publicQueued(bot,item) {return BotRuntime.prototype.publicQueued.call(this,bot,item);}
  projectRead(botId,method,result) {
    if(method!=='replies.prepare'||!result?.reply)return;
    this.store.transaction(()=>{
      const bot=this.store.bot(botId),r=result.reply;
      if(!id(r.id)||r.botId!==botId||r.threadId!==bot.threadId||!id(r.turnId)||typeof r.itemId!=='string'||r.itemId.length>200||!['assistant','user'].includes(r.role)||typeof r.text!=='string'||r.text.length>32000||typeof r.truncated!=='boolean')throw Error('Native reply reference exceeds its original scope.');
      const prior=this.store.get('replyReference',r.id);if(prior&&fingerprint(prior)!==fingerprint(r))throw Error('Original native reply reference changed.');
      if(!prior)this.store.put('replyReference',r);
    });
  }
  captureForeground(botId,nodeId,epoch,agentEpoch,activity,turnId=null) {
    const p=this.hub.db.prepare('SELECT * FROM portable_placements WHERE bot_id=?').get(botId),b=this.store.bot(botId);
    if(!p||p.node_id!==nodeId||p.epoch!==epoch||!id(agentEpoch)||this.router.connection(p)?.portableHello?.agentEpoch!==agentEpoch)throw Error('Foreground proof is outside the live assigned agent lifetime.');
    validateForeground(activity,botId,b.threadId,turnId);
    const prior=this.store.get('botActivity',botId);
    if(prior?.generation>activity.generation)return false;
    if(prior?.generation===activity.generation&&fingerprint(foregroundSource(prior))!==fingerprint(activity))throw Error('Foreground generation has contradictory native evidence.');
    this.store.put('botActivity',{...activity,portableSource:{nodeId,epoch,agentEpoch}});
    if(turnId)this.store.saveBot({...b,activeTurnId:turnId,status:'running'});
    return true;
  }
  nativeEvent(event,nodeId,epoch) {
    if(event.type!=='bot'||!this.authority)return true;
    return this.store.transaction(()=>{
      const b=this.store.bot(event.botId),v=event.data;
      if(v?.id!==b.id||v.threadId!==b.threadId)throw Error('Assigned native bot projection changed its original identity.');
      const source=event.portableActivity,p=this.hub.db.prepare('SELECT * FROM portable_placements WHERE bot_id=?').get(b.id);
      if(source){
        if(this.router.connection(p)?.portableHello?.agentEpoch!==source.agentEpoch)return false;
        if(!this.captureForeground(b.id,nodeId,epoch,source.agentEpoch,source.activity))return false;
        if((v.activeTurnId??null)!==source.activity.activeTurnId)throw Error('Bot event and captured native activity conflict.');
      }
      const patch={};for(const key of ['status','activeTurnId','preview','error','updatedAt','model','effort','serviceTier','mode','modeIntentId','managerPaused'])if(Object.hasOwn(v,key))patch[key]=v[key];
      if(Object.hasOwn(v,'burstQuietSeconds'))Object.assign(patch,preferencePatch(b,{burstQuietSeconds:v.burstQuietSeconds}));
      if(Number.isSafeInteger(v.queuePauseRevision)&&v.queuePauseRevision>=(b.queuePauseRevision??0)){patch.queuePaused=v.queuePaused;patch.queuePauseRevision=v.queuePauseRevision;}
      this.store.saveBot({...b,...patch});
      return true;
    });
  }
  queueList(bot) {return stagedQueue(this.store,bot.id);}
  async lock(key,fn) {const before=this.locks.get(key)??Promise.resolve(),p=before.catch(()=>{}).then(fn);this.locks.set(key,p);try{return await p;}finally{if(this.locks.get(key)===p)this.locks.delete(key);}}
  emitEvent(type,data,botId) {
    const p=this.hub.db.prepare('SELECT * FROM portable_placements WHERE bot_id=?').get(botId);if(!p)return;
    const event={botId,type,data,at:now(),seq:1},text=boundedFrame(event);
    const sequence=Number(this.store.db.prepare('INSERT INTO portable_events(node_id,event_id,bot_id,epoch,fingerprint,event,created_at) VALUES(?,?,?,?,?,?,?)').run(p.node_id,`hub:${randomUUID()}`,botId,p.epoch,digest(text),text,Date.now()).lastInsertRowid);
    this.store.afterCommit(()=>this.broadcast(p.owner,{...event,seq:sequence}));
  }
  async messageInput(bot,p) {
    const text=String(p.text??'').trim(),files=p.attachments??[];
    if(text.length>200000||!Array.isArray(files)||files.length>12||new Set(files).size!==files.length||!text&&!files.length)throw Error('Provide a bounded message and up to twelve distinct registered files.');
    const reply=ownedReply(this,bot,p.reply),full=reply?replyInputText(reply,text):text;
    if(full.length>200000)throw Error('The message and quoted reply exceed their bound.');
    // Logical input never asserts a remote filesystem path. Local paths are
    // resolved and verified by the assigned agent immediately before admission.
    const input=full?[{type:'text',text:full,text_elements:[]}]:[];let images=0;
    for(const file of files){const a=this.owned('attachment',file,bot.id);if(!a.ready||!/^[a-f0-9]{64}$/.test(a.sha256??''))throw Error('A registered file is not ready or lacks its immutable checksum.');if(a.mimeType?.startsWith('image/')&&++images>6)throw Error('Attach at most six images.');input.push({type:'text',text:`Attached file: ${a.name}\nRegistered file ID: ${a.id}`,text_elements:[]});}
    return input;
  }
  async request(owner,{method,botId,params={},operationId},caller={kind:'owner'}) {
    const {b}=this.scope(owner,botId);
    if(!params||typeof params!=='object'||Array.isArray(params))throw Error('Invalid logical control parameters.');
    if(HUB_PEER_READS.has(method)||HUB_PEER_MUTATIONS.has(method)){
      if(caller.kind!=='owner')throw Error('Use the captured assigned peer tool route.');
      return this.peers.request(owner,{method,botId,params,operationId});
    }
    if(HUB_ROOM_READS.has(method)||HUB_ROOM_MUTATIONS.has(method)||method==='conversations.respond')return this.collaboration.request(owner,{method,botId,params,operationId},caller);
    if(method==='inbox.list')return this.primary.list(b,params);
    if(method==='bursts.read')return this.bursts.read(b);
    if(method==='bursts.typing'){
      if(caller.kind!=='owner')throw Error('Typing belongs to the authenticated owner browser.');
      this.assertWriter();return this.bursts.typing(b,params);
    }
    if(method==='queue.list'){const l=ownedList(this,botId,params.listId);return stagedQueue(this.store,botId,l?.id??null).map(i=>this.publicQueued(b,i));}
    if(method==='queueLists.list')return publicLists(this,botId);
    if(method==='schedules.list')return {schedules:this.store.list('schedule',botId),runs:this.store.list('run',botId)};
    if(method==='runs.page'){
      const limit=params.limit??25;if(!Number.isInteger(limit)||limit<1||limit>50)throw Error('Invalid run page size.');
      const runs=this.store.list('run',botId).sort((a,b)=>b.scheduledAt.localeCompare(a.scheduledAt)||b.id.localeCompare(a.id));
      const start=params.cursor==null?0:runs.findIndex(r=>r.id===params.cursor)+1;if(params.cursor!=null&&start===0)throw Error('Run cursor is no longer available.');
      return {runs:runs.slice(start,start+limit),nextCursor:runs[start+limit]?runs[start+limit-1]?.id:null,latestBySchedule:runs.filter((r,i)=>r.finishedAt&&!runs.slice(0,i).some(x=>x.scheduleId===r.scheduleId&&x.finishedAt))};
    }
    if(!HUB_MUTATIONS.has(method)||!id(operationId))throw Error('Unsupported logical control or missing original operation.');
    this.assertWriter();const binding=fingerprint({owner,method,botId,params,caller});
    if(HUB_BURST_MUTATIONS.has(method)){
      // Synchronous Pause/Queue cannot wait behind an awaited read. The
      // original acceptance closure commits its source and receipt together.
      const apply=async()=>{
        this.assertWriter();const current=this.scope(owner,botId).b;
        if(caller.kind!=='owner')throw Object.assign(Error('Burst controls require the authenticated owner.'),{outcome:'rejected'});
        if(current.threadId!==b.threadId)throw Object.assign(Error('Original conversation changed.'),{outcome:'rejected'});
        const prior=this.store.operation(operationId);
        if(prior){if(prior.fingerprint!==binding)throw Error('Original burst operation changed.');if(prior.status==='done')return prior.result;throw Object.assign(Error('Original burst acceptance is unconfirmed.'),{outcome:'uncertain'});}
        const originalTransaction=this.store.transaction.bind(this.store);
        // prepare() may await. Its later closure must not admit against a
        // replaced thread or archived bot, even if the preparation succeeded.
        const facade=Object.assign(Object.create(this),{store:Object.assign(Object.create(this.store),{transaction:fn=>originalTransaction(()=>{
          const after=this.scope(owner,botId).b;if(after.threadId!==b.threadId||after.archived||after.archiving||after.deletedAt)throw Error('Original burst conversation is unavailable.');return fn();
        })})});
        return (await acceptSingleThreadOperation(facade,{method,botId,params,operationId},binding)).result;
      };
      return method==='bursts.submit'?this.lock(botId,apply):apply();
    }
    const accepted=await this.lock(botId,async()=>{
      this.assertWriter();this.scope(owner,botId);const prior=this.store.operation(operationId);
      if(ownerQueueControls.has(method)&&caller.kind!=='owner')throw Object.assign(Error('Send and Resume require the authenticated owner.'),{outcome:'rejected'});
      if(prior){if(prior.fingerprint!==binding)throw Error('Original logical operation changed.');if(prior.status==='done')return prior.result;
        if(ownerQueueControls.has(method)){const row=this.hub.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);if(!row)throw Object.assign(Error('Original logical delivery record is missing; do not repeat it.'),{outcome:'uncertain'});return {[MAILBOX]:row};}
        throw Object.assign(Error('Original logical acceptance is unconfirmed.'),{outcome:'uncertain'});}
      if(ownerQueueControls.has(method)){
        try{return {[MAILBOX]:this.prepareOwnerQueueControl(owner,botId,method,params,operationId,binding,caller)};}
        catch(error){error.outcome=this.store.operation(operationId)?'uncertain':'rejected';throw error;}
      }
      const apply=async()=>{
        const queue=await acceptLocalQueueOperation(this,{method,botId,params,operationId},binding);if(queue)return queue.result;
        return this.store.transaction(()=>{
          this.assertWriter();const bot=this.store.bot(botId);if(bot.archived||bot.archiving)throw Error('Restore this bot first.');let result;
          if(method==='schedules.save'){
            const old=params.id?this.owned('schedule',params.id,botId):null;
            result=normalizeSchedule({...params,timeZone:params.timeZone??old?.timeZone??this.defaultTimeZone},botId,old);if(!old){result.id=operationId;result.origin={...caller,operationId};}this.store.put('schedule',result);
          }else if(method==='schedules.delete'){
            this.owned('schedule',params.id,botId);this.store.remove('schedule',params.id);
            for(const run of this.store.list('run',botId))if(run.scheduleId===params.id&&run.status==='queued')this.store.put('run',{...run,status:'cancelled',finishedAt:now()});result={};
          }else if(method==='schedules.run'){
            const s=this.owned('schedule',params.id,botId);result=this.store.put('run',{id:operationId,botId,scheduleId:s.id,title:s.title,prompt:s.prompt,origin:s.origin??null,selectedContext:s.selectedContext??null,status:'queued',scheduledAt:now(),startedAt:null,finishedAt:null,error:null});
          }else throw Error('Unsupported logical control.');
          this.store.saveOperation(operationId,binding,'done',{method,botId,params,caller,result,localOnly:'portable-hub-controls',createdAt:now()});this.emitEvent('schedules',{},botId);return result;
        });
      };
      return apply();
    });
    if(accepted?.[MAILBOX]){const value=(await this.router.wait(accepted[MAILBOX])).result;return method==='queue.resume'?{}:value;}
    return accepted;
  }
  queuePayload(bot,q,method='portable.queueDispatch') {
    const reply=this.store.get('messageReply',q.clientUserMessageId),savedFiles=this.store.get('queuedAttachments',q.clientUserMessageId);
    if(reply&&(reply.botId!==bot.id||reply.threadId!==bot.threadId)||savedFiles&&savedFiles.botId!==bot.id)throw Error('Original queue receipt belongs to another conversation.');
    const attachmentIds=q.attachmentIds??savedFiles?.attachmentIds??[];
    if(!attachmentIds.length&&q.input.some(part=>part.type!=='text'||part.text.startsWith('Attached file: ')))throw Error('Original saved files require recovery; nothing was sent.');
    const text=reply?.text??q.input.filter(part=>part.type==='text'&&!part.text.startsWith('Attached file: ')).map(part=>part.text).join('\n');
    const files=attachmentIds.map(id=>{const a=this.owned('attachment',id,bot.id);if(!a.ready||!/^[a-f0-9]{64}$/.test(a.sha256??'')||!Number.isSafeInteger(a.size)||a.size<0)throw Error('Queued file is unconfirmed.');return {id:a.id,sha256:a.sha256,size:a.size};});
    const original=this.store.db.prepare("SELECT json FROM records WHERE kind='operatorRequest' AND bot_id=? AND json_extract(json,'$.nativeOperationId')=? LIMIT 1").get(bot.id,q.id),operator=original&&JSON.parse(original.json);
    if(operator)validateOperatorSource(operator,bot.id,bot.threadId,q.id);
    return {method,params:{item:{...q,attachmentIds},text,files,...(operator?{operatorSource:operatorSource(operator)}:{}),...(reply?.reply?{reply:reply.reply}:{})}};
  }
  prepareOwnerQueueControl(owner,botId,method,params,operationId,binding,caller) {
    return this.store.transaction(()=>{
      this.assertWriter();const {p,b}=this.scope(owner,botId);
      if(b.archived||b.archiving)throw Error('Restore this bot first.');
      const outstanding=this.hub.db.prepare("SELECT state,receipt,node_id,epoch FROM portable_mailbox WHERE bot_id=? AND state<>'terminal' LIMIT 100").all(botId);
      if(outstanding.length>=100||outstanding.some(r=>{
        if(method!=='queue.send'||!['native-accepted','running'].includes(r.state)||!r.receipt||r.node_id!==p.node_id||r.epoch!==p.epoch)return true;
        const receipt=JSON.parse(r.receipt);return receipt.threadId!==b.threadId||!id(receipt.turnId);
      }))throw Object.assign(Error('Reconcile the original pending input or Stop before Send or Resume.'),{outcome:'rejected'});
      let payload,source;
      if(method==='queue.send'){
        if(Object.keys(params).some(k=>!['id','expectedRevision'].includes(k)))throw Error('Choose only the original queued message and revision.');
        source=this.owned('promptQueue',params.id,botId);
        if(source.threadId!==b.threadId||!Number.isSafeInteger(params.expectedRevision)||params.expectedRevision<1||source.revision!==params.expectedRevision||!['queued','failed'].includes(source.state)||source.nativeQueueId||source.configuration?.confirmation==='pending-unsupported')throw Error('The original queue revision is changed, already starting or awaiting configuration.');
        payload=this.queuePayload(b,source,'portable.queueSend');
      }else{
        if(Object.keys(params).length)throw Error('Resume accepts no replacement input.');
        if(this.queueList(b).some(q=>q.state!=='queued')||this.plans.blocked(botId))throw Error('Reconcile original queue uncertainty or rejected prompts before resuming.');
        payload={method:'portable.queueResume',params:{threadId:b.threadId}};
      }
      // This is a human release intent, not a native acceptance claim. An
      // outstanding mailbox fences automatic admission until it is settled.
      const revision=p.control_revision+1;
      this.store.db.prepare('UPDATE portable_placements SET stopped=0,control_revision=? WHERE bot_id=?').run(revision,botId);
      payload.params.controlRevision=revision;
      const row=this.hub.enqueueOn(this.store.db,owner,botId,operationId,payload);
      this.store.put('portableQueueControl',{id:operationId,botId,threadId:b.threadId,method,controlRevision:revision,previousStopped:p.stopped,...(source?{source}:{})});
      if(source)this.store.put('promptQueue',{...source,state:'dispatching',operationId,clientUserMessageId:operationId,dispatchKind:'send-now',attemptedAt:now(),error:null});
      this.store.saveOperation(operationId,binding,'dispatching',{method,botId,params,caller,createdAt:now(),localOnly:'portable-owner-queue'});
      this.emitEvent('queue',{},botId);return row;
    });
  }
  async tool(owner,botId,tool,args,caller={kind:'authenticated-node-tool',botId}) {
    this.scope(owner,botId);if(!HUB_TOOLS.has(tool)||!args||typeof args!=='object'||Array.isArray(args))throw Error('Unsupported hub tool.');
    if(tool==='bots_schedule_list')return {...await this.request(owner,{method:'schedules.list',botId}),defaultTimeZone:this.defaultTimeZone};
    if(tool==='bots_queue'){
      // Pass an owner-bound facade; never a mutable ambient caller identity.
      return queueTool(Object.assign(Object.create(this),{handle:r=>this.request(owner,r,caller)}),this.store.bot(botId),args);
    }
    const method=tool==='bots_schedule_save'?'schedules.save':'schedules.delete';
    const {operationId,...params}=args;return this.request(owner,{method,botId,params,operationId},caller);
  }
  quiet(run,date) {
    if(run&&this.quietWindow.scheduleIds.includes(run.scheduleId))return false;
    const parts=new Intl.DateTimeFormat('en-GB',{timeZone:this.quietWindow.timeZone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date),value=parts.find(p=>p.type==='hour').value+':'+parts.find(p=>p.type==='minute').value;
    const {start,end}=this.quietWindow;return start<end?value>=start&&value<end:value>=start||value<end;
  }
  async tick(date=new Date()) {
    if(this.ticking||this.closed)return;this.assertWriter();this.ticking=true;
    try{
      this.reconcileReceipts();await this.collaboration.pump();await this.bursts.tick();await flushDueLists(this,date);this.assertWriter();
      const created=collectDueRuns(this.store,date);
      this.store.transaction(()=>{for(const run of created)if(this.quiet(run,date))this.store.put('run',{...run,decision:{id:`quiet:${run.id}`,version:1,state:'required',reason:'Quiet release window; original occurrence retained, not started.'}});});
      for(const p of this.hub.db.prepare('SELECT * FROM portable_placements ORDER BY bot_id').all()){
        if(this.locks.has(p.bot_id)||p.stopped||!this.router.connection(p))continue;
        const bot=this.store.bot(p.bot_id);if(bot.archived||bot.archiving||bot.deletedAt||bot.queuePaused||this.plans.blocked(bot.id))continue;
        if(this.hub.db.prepare("SELECT 1 FROM portable_mailbox WHERE bot_id=? AND state<>'terminal' LIMIT 1").get(bot.id))continue;
        const item=stagedQueue(this.store,bot.id)[0],run=this.store.list('run',bot.id).filter(r=>r.status==='queued'&&!r.laneId&&!r.selectedContext&&(!r.decision||r.decision.state==='start-approved')).sort((a,b)=>a.scheduledAt.localeCompare(b.scheduledAt))[0];
        const intake=!item&&!run&&this.router.connection(p)?.portableHello?.capabilities?.centralPrimaryDispatch===true?this.store.db.prepare("SELECT json FROM records WHERE kind='primaryInbox' AND bot_id=? AND json_extract(json,'$.state')='queued' ORDER BY rowid LIMIT 1").get(bot.id):null;
        if(item&&(item.state!=='queued'||item.configuration?.confirmation==='pending-unsupported')||!item&&!run&&!intake||this.quiet(item||intake?null:run,date))continue;
        const response=await this.router.request(p.owner,{id:`work:${randomUUID()}`,method:'work.read',botId:bot.id,params:{}},'hub:scheduler');
        const w=response.result;if(response.cache?.stale||w?.botId!==bot.id||w.threadId!==bot.threadId||w.state!=='ready'||w.activeTurnId||w.paused||w.goal?.status==='active')continue;
        await this.lock(bot.id,()=>intake?this.dispatchPrimary(p,JSON.parse(intake.json)):this.dispatch(p,item,run));
      }
    }finally{this.ticking=false;}
  }
  primaryEligible(owner,intake){
    if(intake.kind==='peer')return this.peers.eligible(owner,intake);
    if(intake.kind==='task-request')return this.taskRequests?.eligible(intake)===true;
    const r=this.store.get('collaborationResult',intake.sourceId);
    return r?.botId===intake.botId&&r.promotion?.id===intake.id&&!this.store.get('collaborationConsumption',r.id);
  }
  primaryState(row,payload){
    const {p,b}=this.scope(row.owner,row.bot_id),intake=this.store.get('primaryInbox',row.operation_id);
    if(p.node_id!==row.node_id||p.epoch!==row.epoch||!intake||validatePrimary(intake,b.id,b.threadId,row.operation_id)!==validatePrimary(payload.params.intake,b.id,b.threadId,row.operation_id)||intake.operationId!==row.operation_id)throw Error('Canonical original intake source or placement changed.');
    const project=()=>{
    const fresh=this.scope(row.owner,row.bot_id);
    if(fingerprint(fresh.p)!==fingerprint(p)||fresh.b.threadId!==b.threadId||fingerprint(this.store.get('primaryInbox',intake.id))!==fingerprint(intake))throw Error('Original intake changed during scoped admission.');
    return {operationId:row.operation_id,fingerprint:row.fingerprint,controlRevision:p.control_revision,intake,
      canDispatch:!p.stopped&&!b.queuePaused&&!b.archived&&!b.archiving&&intake.state==='dispatching'&&this.primaryEligible(row.owner,intake)&&this.router.connection(p)?.portableHello?.capabilities?.centralPrimaryDispatch===true};
    };
    return intake.kind==='task-request'?this.taskRequests.preflight(intake).then(allowed=>allowed?project():{canDispatch:false}):project();
  }
  dispatchPrimary(p,intake){
    const dispatch=()=>this.store.transaction(()=>{
      const current=this.hub.placement(p.owner,p.bot_id),bot=this.store.bot(p.bot_id),q=this.owned('primaryInbox',intake.id,bot.id);
      if(fingerprint(current)!==fingerprint(p)||current.stopped||bot.queuePaused||bot.archived||bot.archiving||this.plans.blocked(bot.id)||this.router.connection(current)?.portableHello?.capabilities?.centralPrimaryDispatch!==true||fingerprint(q)!==fingerprint(intake)||q.state!=='queued'||!this.primaryEligible(p.owner,q))return;
      validatePrimary(q,bot.id,bot.threadId,q.id);
      if(this.hub.db.prepare("SELECT 1 FROM portable_mailbox WHERE bot_id=? AND state<>'terminal' LIMIT 1").get(bot.id))return;
      const files=(q.attachmentIds??[]).map(fileId=>this.owned('attachment',fileId,bot.id));
      if(files.some(f=>!f.ready||!/^[a-f0-9]{64}$/.test(f.sha256??'')||!Number.isSafeInteger(f.size)||f.size<0)||files.reduce((n,f)=>n+f.size,0)>100*1024*1024)return;
      const row=this.hub.enqueueOn(this.store.db,p.owner,bot.id,q.id,{method:'portable.primaryDispatch',params:{intake:q,files:files.map(({id,sha256,size})=>({id,sha256,size}))}});
      this.store.put('primaryInbox',{...q,state:'dispatching',operationId:q.id,attemptedAt:now()});
      this.emitEvent('work',{},bot.id);this.store.afterCommit(()=>this.router.connection(current)?.send(boundedFrame({type:'sync',...this.hub.sync(current.node_id)})));return row;
    });
    return intake.kind==='task-request'?this.taskRequests.preflight(intake).then(allowed=>allowed?dispatch():undefined):dispatch();
  }
  dispatch(p,item,run) {
    return this.store.transaction(()=>{
      this.assertWriter();const current=this.hub.placement(p.owner,p.bot_id),bot=this.store.bot(p.bot_id);
      if(current.node_id!==p.node_id||current.epoch!==p.epoch||current.control_revision!==p.control_revision||current.stopped||bot.queuePaused)return;
      if(this.hub.db.prepare("SELECT 1 FROM portable_mailbox WHERE bot_id=? AND state<>'terminal' LIMIT 1").get(bot.id))return;
      let payload,operationId;
      if(item){
        const q=this.owned('promptQueue',item.id,bot.id);if(fingerprint(q)!==fingerprint(item)||q.state!=='queued'||q.listId)return;
        operationId=`queue-start:${digest(`${bot.id}:${q.id}:${q.revision}`)}`;
        payload=this.queuePayload(bot,q);
      }else{
        const r=this.owned('run',run.id,bot.id);if(fingerprint(r)!==fingerprint(run)||r.status!=='queued')return;
        operationId=r.operationId??`schedule:${r.id}`;if(!id(operationId))throw Error('Retained scheduled operation exceeds protocol identity bounds.');payload={method:'portable.scheduleDispatch',params:{run:{...r,threadId:bot.threadId}}};
      }
      // Mailbox and parent record commit on ONE connection, not two nested
      // independent writers. Enqueue validates placement/payload unchanged.
      const row=this.hub.enqueueOn(this.store.db,p.owner,bot.id,operationId,payload);
      if(item)this.store.put('promptQueue',{...item,state:'dispatching',operationId,clientUserMessageId:operationId,attemptedAt:now()});
      else this.store.put('run',{...run,status:'starting',operationId,threadId:bot.threadId,startedAt:now()});
      this.emitEvent(item?'queue':'schedules',{},bot.id);
      this.store.afterCommit(()=>this.router.connection(p)?.send(boundedFrame({type:'sync',...this.hub.sync(p.node_id)})));return row;
    });
  }
  reconcileReceipts() {
    // A durable applied hash prevents a busy recent tail from starving older
    // receipts, and catches later terminal evidence for the same operation.
    const rows=this.hub.db.prepare("SELECT m.* FROM portable_mailbox m LEFT JOIN portable_control_receipts c ON c.operation_id=m.operation_id WHERE m.receipt IS NOT NULL AND (c.receipt_hash IS NULL OR c.receipt_hash<>m.receipt_hash) AND json_extract(m.payload,'$.method') IN ('portable.queueDispatch','portable.scheduleDispatch','portable.queueSend','portable.queueResume','portable.burstDispatch','portable.roomDispatch','portable.roomRespond','portable.primaryDispatch') ORDER BY m.sequence LIMIT 40").all();
    for(const row of rows)this.receipt(row);
  }
  receipt(row) {
    const payload=JSON.parse(row.payload),receipt=row.receipt&&JSON.parse(row.receipt);if(!NODE_LOGICAL_COMMANDS.has(payload.method)||!receipt)return;
    if(payload.method==='portable.burstDispatch'){this.bursts.receipt(row);return;}
    if(payload.method==='portable.roomDispatch'){this.collaboration.receipt(row);return;}
    if(payload.method==='portable.roomRespond'){this.collaboration.answerReceipt(row);return;}
    if(payload.method==='portable.primaryDispatch'){
      this.store.transaction(()=>{
        const {p,b}=this.scope(row.owner,row.bot_id),q=this.store.get('primaryInbox',row.operation_id);
        if(p.node_id!==row.node_id||p.epoch!==row.epoch||!q||q.operationId!==row.operation_id||validatePrimary(q,b.id,b.threadId,row.operation_id)!==validatePrimary(payload.params.intake,b.id,b.threadId,row.operation_id))throw Error('Original result receipt source changed.');
        let patch;
        if(row.state==='unknown'||receipt.outcome==='rejected'){
          if(q.turnId)throw Error('A later uncertainty cannot erase confirmed original result acceptance.');
          patch={state:row.state==='unknown'?'uncertain':'failed',error:receipt.error??'Original result admission is unconfirmed.'};
        }else if(['native-accepted','running','terminal'].includes(row.state)&&originalNativeProof(receipt,row.operation_id)&&receipt.threadId===b.threadId){
          const terminal=receipt.nativeStatus??receipt.result?.turn?.status;
          if(row.state==='terminal'&&!['completed','failed','interrupted'].includes(terminal))throw Error('Original result terminal receipt lacks native outcome.');
          if(q.turnId&&q.turnId!==receipt.turnId)throw Error('Original result receipt changed its accepted turn.');
          patch={state:'accepted',turnId:receipt.turnId,...(row.state==='terminal'?{terminalStatus:terminal}:{}),error:null};
        }else return;
        const accepted=this.store.put('primaryInbox',{...q,...patch});this.emitEvent('work',{},b.id);
        if(q.kind==='peer')this.peers.receipt(row.owner,accepted,patch.turnId?{id:patch.turnId,status:patch.terminalStatus??'inProgress'}:null);
        this.store.db.prepare('INSERT INTO portable_control_receipts VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET receipt_hash=excluded.receipt_hash').run(row.operation_id,row.receipt_hash);
      });return;
    }
    this.store.transaction(()=>{
      const mark=()=>this.store.db.prepare('INSERT INTO portable_control_receipts VALUES(?,?) ON CONFLICT(operation_id) DO UPDATE SET receipt_hash=excluded.receipt_hash').run(row.operation_id,row.receipt_hash);
      const control=this.store.get('portableQueueControl',row.operation_id);
      if(control){
        const p=this.hub.placement(row.owner,row.bot_id),op=this.store.operation(row.operation_id);
        if(control.botId!==row.bot_id||control.threadId!==this.store.bot(row.bot_id).threadId||!op||op.botId!==row.bot_id){mark();return;}
        if(row.state==='unknown')this.store.saveOperation(op.id,op.fingerprint,'uncertain',{...op,error:receipt.error??'Original node acceptance is unconfirmed.'});
        else if(receipt.outcome==='rejected'){
          if(p.control_revision===control.controlRevision&&control.previousStopped)this.store.db.prepare('UPDATE portable_placements SET stopped=1,control_revision=control_revision+1 WHERE bot_id=?').run(row.bot_id);
          this.store.saveOperation(op.id,op.fingerprint,'failed',{...op,outcome:'rejected',error:receipt.error});
          if(control.source){const current=this.store.get('promptQueue',control.source.id);if(current?.operationId===op.id&&current.revision===control.source.revision)this.store.put('promptQueue',{...control.source,state:'failed',error:receipt.error,lastRejectedSend:op.id});}
          this.emitEvent('queue',{},row.bot_id);mark();return;
        }else if(['native-accepted','running','terminal'].includes(row.state)&&receipt.result!==undefined){
          this.store.saveOperation(op.id,op.fingerprint,'done',{...op,result:op.method==='queue.resume'?{}:receipt.result,error:null});
          if(payload.method==='portable.queueResume'){
            if(p.control_revision===control.controlRevision){const b=this.store.bot(row.bot_id);this.store.saveBot({...b,queuePaused:false,managerPaused:false});this.emitEvent('queue',{},row.bot_id);}
            mark();return;
          }
        }else {mark();return;}
        if(payload.method==='portable.queueResume'){mark();return;}
      }
      const q=payload.params.item,r=payload.params.run,key=q?'promptQueue':'run',source=q??r,current=this.store.get(key,source.id);
      if(!current||current.botId!==row.bot_id||current.operationId!==row.operation_id||current.threadId!==source.threadId||q&&(current.revision!==q.revision||fingerprint(current.input)!==fingerprint(q.input)||fingerprint(current.attachmentIds??[])!==fingerprint(q.attachmentIds??[]))){
        this.store.put('portableReceiptConflict',{id:row.operation_id,botId:row.bot_id,receiptHash:row.receipt_hash,reason:'Original logical source differs from its node receipt.',at:now()});mark();return;
      }
      if(receipt.outcome==='rejected'||row.state==='unknown'){
        if((q?current.state:current.status)===(row.state==='unknown'?'uncertain':'failed')){mark();return;}
        this.store.put(key,{...current,[q?'state':'status']:row.state==='unknown'?'uncertain':'failed',error:receipt.error??'Original node admission is unconfirmed.'});
      }else if(['native-accepted','running','terminal'].includes(row.state)&&receipt.turnId){
        const terminal=receipt.nativeStatus??receipt.result?.turn?.status;
        const status=q?'delivered':row.state==='terminal'&&['completed','failed','interrupted'].includes(terminal)?terminal:row.state==='terminal'?'uncertain':'running';
        if((q?current.state:current.status)===status&&current.turnId===receipt.turnId){mark();return;}
        this.store.put(key,{...current,[q?'state':'status']:status,turnId:receipt.turnId,...(q?{deliveredAt:now()}:{...(row.state==='terminal'?{finishedAt:now()}:{})}),error:null});
      }else {mark();return;}
      this.emitEvent(q?'queue':'schedules',{},row.bot_id);
      mark();
    });
  }
  close(){this.closed=true;this.bursts.close();this.store.db.close();}
}
