// Startup does not resume a native thread before the authoritative hub has
// synchronized its placement/Stop state. Existing current-state barriers stay
// unresolved until a fresh control permits bounded ordinary reconciliation.
export class AgentStartup {
  constructor(runtime,journal){Object.assign(this,{runtime,journal});this.recovering=false;}
  async recover(){
    const {runtime,journal}=this;
    if(this.recovering||!runtime.ready||runtime.maintenance.holding())return;
    this.recovering=true;
    try{
      const due=runtime.store.list('botActivity').filter(row=>row.unresolved&&Date.parse(row.reconcileAfter??'1970-01-01')<=Date.now())
        .sort((a,b)=>(a.reconcileAfter??'').localeCompare(b.reconcileAfter??'')||a.botId.localeCompare(b.botId));
      let count=0;
      for(const state of due){
        const bot=runtime.store.bot(state.botId),control=journal.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(state.botId);
        if(!bot||bot.archived||bot.archiving||bot.deletedAt||!bot.threadId||runtime.locks.has(bot.id)||
            !control||!journal.canAdmit({bot_id:bot.id,epoch:control.epoch}))continue;
        if(count++>=2)break;
        // The existing load/current-activity path checks native thread IDs,
        // uses the same bot lock, and rechecks admission immediately at RPC.
        try{await runtime.lock(bot.id,()=>runtime.maintenance.track(()=>runtime.ensureCurrentActivity(bot.id)));}
        catch{/* Preserve the original barrier, error and retry time. */}
      }
    }finally{this.recovering=false;}
  }
}
