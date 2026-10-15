import { savePrivate } from './private-file.mjs';

// A local, credential-free liveness feed for a native status UI (the Mac menu
// bar app). It reads runtime state only; it never admits, stops or resumes work.
export const STATUS_VERSION=1;
export function agentStatusSnapshot({runtime,source,now=Date.now()}) {
  const bots=runtime.store.bots().filter(bot=>!bot.archived);
  const working=bots.filter(bot=>bot.activeTurnId||['starting','waiting'].includes(bot.status));
  const settling=typeof runtime.activityUnresolved==='function'?bots.filter(bot=>runtime.activityUnresolved(bot.id)).length:0;
  return {version:STATUS_VERSION,at:now,pid:process.pid,source:source?.source??null,runtime:source?.runtime??null,
    connected:runtime.relayOnline===true,ready:runtime.ready===true,
    bots:{total:bots.length,working:working.length,settling,
      active:working.slice(0,12).map(bot=>({id:bot.id,name:String(bot.name??bot.id).slice(0,80),status:bot.activeTurnId?'working':String(bot.status)}))}};
}
export function startStatusReporter({runtime,source,path,intervalMs=2000,onError=()=>{}}) {
  const write=()=>{try{savePrivate(path,JSON.stringify(agentStatusSnapshot({runtime,source}))+'\n');}catch(error){onError(error);}};
  write();
  const timer=setInterval(write,intervalMs);timer.unref?.();
  return {write,stop(){clearInterval(timer);try{savePrivate(path,JSON.stringify({...agentStatusSnapshot({runtime,source}),connected:false,stopping:true})+'\n');}catch(error){onError(error);}}};
}
