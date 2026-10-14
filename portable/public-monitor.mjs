// Infrastructure observations only: fixed HTTP reads, no models, queues,
// business actions or execution restarts. Logs contain categories, no bodies.
export function publicMonitor(config,{fetch:read=globalThis.fetch,clock=Date.now,log=console.error}={}) {
  const status={checkedAt:null,connector:null,origin:null,publicHttp:null,failures:0};
  let pending=false,closed=false,reported=null;
  async function probe(url,kind){
    try{
      const response=await read(url,{cache:'no-store',redirect:'manual',signal:AbortSignal.timeout(5000)});
      if(kind==='connector'){const text=await response.text();return response.ok&&/^cloudflared_tunnel_ha_connections\s+([1-9][0-9]*(?:\.[0-9]+)?)\s*$/m.test(text);}
      if(kind==='origin'){const value=await response.json();return response.ok&&value.ready===true&&value.relayConnected===true&&value.siteReady===true;}
      const value=await response.json();return response.status===200&&value.frontReady===true;
    }catch{return false;}
  }
  async function check(){
    if(pending||closed)return;pending=true;
    try{
      const results=await Promise.all([probe(`http://127.0.0.1:${config.tunnelMetricsPort}/metrics`,'connector'),
        probe(`http://127.0.0.1:${config.healthPort}/healthz`,'origin'),probe(`${config.publicOrigin}/_service/status`,'public')]);
      if(closed)return;
      [status.connector,status.origin,status.publicHttp]=results;status.checkedAt=new Date(clock()).toISOString();
      const category=!status.connector?'connector-unavailable':!status.publicHttp?'public-route-unavailable':!status.origin?'execution-unavailable':'healthy';
      status.failures=category==='healthy'?0:status.failures+1;
      if((category==='healthy'&&reported&&reported!=='healthy')||(status.failures>=3&&reported!==category)){reported=category;log(`DawarTodo public status: ${category}; inspect the independent connector/origin. No runtime restart requested.`);}
    }finally{pending=false;}
  }
  const timer=setInterval(()=>void check(),30000);timer.unref();
  return {status:()=>({...status}),check,close:()=>{closed=true;clearInterval(timer);}};
}
