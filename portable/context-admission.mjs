import {AsyncLocalStorage} from 'node:async_hooks';
import {fingerprint} from './protocol.mjs';
import {nativeAdmissionRefusal} from '../bot-bridge/native-admission-refusal.mjs';
import {COLLABORATION_POLICY} from '../bot-bridge/collaboration.mjs';

// Resuming can activate native Goal/queue work; it is not an offline read.
const inputs=new Set(['thread/resume','turn/start','turn/steer','thread/queue/add','thread/queue/update','thread/goal/set']);
const stopped=()=>nativeAdmissionRefusal('Assigned hub control is offline, stale, stopped or changed; no native input was submitted.');

// The same guard runs on every execution agent. A bot's registered room
// context inherits its placement; a native thread never supplies that owner.
export class AgentContextAdmission {
  constructor(runtime,journal,platform=process.platform){
    Object.assign(this,{runtime,journal,platform});this.scope=new AsyncLocalStorage();
    const original=runtime.collaboration.provision.bind(runtime.collaboration);
    runtime.collaboration.provision=delivery=>{
      const row=runtime.store.get('collaborationDelivery',delivery.id);
      if(!row||fingerprint(row)!==fingerprint(delivery)||row.state!=='queued')throw stopped();
      const control=this.control(row.botId);
      if(!control||control.stopped!==0||!runtime.collaboration.allowed(row))throw stopped();
      const captured={botId:row.botId,deliveryId:row.id,contextId:row.contextId,
        roomId:row.roomId,deliveryFingerprint:fingerprint(row),epoch:control.epoch,revision:control.revision,
        toolsFingerprint:fingerprint(runtime.collaboration.tools)};
      return this.scope.run(captured,()=>original(delivery));
    };
  }
  control(botId){
    const row=this.journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(botId);
    return row&&this.journal.currentControl({bot_id:botId,epoch:row.epoch});
  }
  bot(botId){
    const bot=this.runtime.store.bot(botId);
    if(!bot||bot.archived||bot.archiving||bot.deletedAt)throw stopped();return bot;
  }
  context(threadId){
    const primary=this.runtime.store.bots().filter(bot=>bot.threadId===threadId);
    const contexts=this.runtime.store.list('collaborationContext').filter(context=>context.threadId===threadId);
    if(primary.length+contexts.length!==1)throw stopped();
    const context=contexts[0],bot=this.bot(primary[0]?.id??context.botId);
    if(context&&(context.provisioning!=='bound'||!this.runtime.collaboration.byThread(threadId)||
        this.runtime.collaboration.byThread(threadId).id!==context.id))throw stopped();
    return {bot,context};
  }
  provision(params){
    if(this.platform!=='linux')throw nativeAdmissionRefusal('New native contexts remain unavailable on this unvalidated platform.');
    const captured=this.scope.getStore();if(!captured)throw nativeAdmissionRefusal('A captured registered collaboration delivery is required; no native thread was created.');
    const {store,collaboration}=this.runtime,bot=this.bot(captured.botId),control=this.control(bot.id);
    const delivery=store.get('collaborationDelivery',captured.deliveryId),context=store.get('collaborationContext',captured.contextId);
    if(!control||control.stopped!==0||control.epoch!==captured.epoch||control.revision!==captured.revision||
        !delivery||delivery.state!=='queued'||fingerprint(delivery)!==captured.deliveryFingerprint||!collaboration.allowed(delivery)||
        !context||context.botId!==bot.id||context.roomId!==captured.roomId||context.creationOperationId!==delivery.id||context.threadId!==null||context.provisioning!=='dispatching'||
        fingerprint(collaboration.tools)!==captured.toolsFingerprint)throw stopped();
    // Parameters still come from the original named-context producer. A
    // different cwd/tools/instructions cannot borrow this captured permission.
    const settings=this.runtime.settings(bot);
    const expectedInstructions=`You are ${bot.name}, the SAME named bot ${bot.id}, in registered room ${delivery.roomId}, context ${context.id}. The foreground ${bot.threadId} is separate.\n${COLLABORATION_POLICY}`;
    if(params.cwd!==bot.cwd||params.model!==settings.model||params.serviceTier!==settings.serviceTier||
        params.approvalPolicy!=='never'||params.sandbox!=='danger-full-access'||params.developerInstructions!==expectedInstructions||
        fingerprint(params.dynamicTools)!==fingerprint(collaboration.tools)||params.experimentalRawEvents!==false||params.persistExtendedHistory!==true||
        fingerprint(params.config)!==fingerprint({'features.multi_agent':false,'features.fast_mode':true,'model_reasoning_effort':settings.effort,
          'mcp_servers.codex_manager.enabled':false,'mcp_servers.bot_desktop.enabled':false,'mcp_servers.linux_computer_use.enabled':false})||
        Object.keys(params).some(key=>!['cwd','model','serviceTier','approvalPolicy','sandbox','developerInstructions','config','dynamicTools','experimentalRawEvents','persistExtendedHistory'].includes(key)))throw nativeAdmissionRefusal('Registered context parameters changed before native admission.');
  }
  guard(method,params={}){
    if(method==='thread/fork')throw nativeAdmissionRefusal('Anonymous or copied native contexts are unavailable; registered named collaboration uses a fresh thread.');
    if(method==='thread/start')return this.provision(params);
    if(!inputs.has(method))return;
    const {bot,context}=this.context(params.threadId),control=this.control(bot.id);
    if(!control)throw stopped();
    // Synchronized Stop must be able to pause its already admitted Goal. This
    // does not authorize a new objective, resume, user settings or other input.
    const stopPause=method==='thread/goal/set'&&control.stopped===1&&params.origin==='automatic'&&params.status==='paused'&&
      Object.keys(params).every(key=>['threadId','origin','status'].includes(key));
    if(!stopPause&&control.stopped!==0)throw stopped();
    if(context&&!stopPause){
      const room=this.runtime.store.get('collaborationRoom',context.roomId);
      if(!room||room.held||!room.members.includes(bot.id)||context.paused)throw stopped();
      if(['turn/start','turn/steer'].includes(method)){
        if(typeof context.dispatchId!=='string'||!context.dispatchId)throw stopped();
        const delivery=this.runtime.store.get('collaborationDelivery',context.dispatchId);
        if(!delivery||delivery.state!=='dispatching'||delivery.botId!==bot.id||delivery.contextId!==context.id||
            delivery.threadId!==context.threadId||delivery.method!==method||delivery.id!==params.clientUserMessageId||
            fingerprint(delivery.nativeParams)!==fingerprint(params)||!this.runtime.collaboration.allowed(delivery))throw stopped();
      }
    }
  }
}
