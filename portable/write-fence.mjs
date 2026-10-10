// Application write admission is separate from execution-agent maintenance.
// Freezing the hub never kills an agent or claims an active native turn ended.
export class WriteFence {
  constructor() { this.frozen=false;this.active=0;this.waiters=new Set(); }
  enter() {
    if(this.frozen)throw Error('The hub is preserving a consistent snapshot. Retain the original operation and retry only after its receipt is reconciled.');
    this.active++;let ended=false;
    return ()=>{if(ended)return;ended=true;this.active--;if(this.active===0)for(const wake of this.waiters)wake();};
  }
  async freeze(callback,{deadlineMs=30000,settleBackground=async()=>{}}={}) {
    if(this.frozen)throw Error('An existing write freeze owns this hub.');
    if(!Number.isInteger(deadlineMs)||deadlineMs<1||deadlineMs>60000)throw Error('Invalid write-freeze deadline.');
    this.frozen=true;let timer;const abort=new AbortController();
    try {
      await Promise.race([(async()=>{
        if(this.active)await new Promise(resolve=>this.waiters.add(resolve));
        await settleBackground();
      })(),new Promise((resolve,reject)=>{timer=setTimeout(()=>{abort.abort(Error('Write-freeze deadline exceeded.'));reject(abort.signal.reason);},deadlineMs);})]);
      // The callback must honor the signal. Never drop the write fence while
      // an expired asynchronous snapshot is still reading authoritative data.
      const result=await callback(abort.signal);abort.signal.throwIfAborted();return result;
    }finally{clearTimeout(timer);this.waiters.clear();this.frozen=false;}
  }
}
