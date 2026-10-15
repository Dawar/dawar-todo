import {createServer} from 'node:http';
import {loadConfig} from './config.mjs';
import {RUNTIME_VERSION} from './protocol.mjs';
import {combinedShutdown} from './combined-shutdown.mjs';

// The separate bot runner (SPLIT_HUB_RUNNER.md): the same runAgent the
// combined process uses, plus its own `/healthz` and the claimed-drain
// shutdown. `ready` is the runner's own readiness; `relayConnected` says
// whether the hub is reachable, so a hub restart does not make the runner
// look broken. Deploys of the runner require both.
export async function runRunner(configPath,{runAgent:injected,signals=true}={}) {
  const a=loadConfig(configPath);
  if(a.mode!=='agent')throw Error('A separate runner requires its own mode "agent" configuration.');
  const {runAgent}=injected?{runAgent:injected}:await import('../bot-bridge/portable-agent.mjs');
  const agent=await runAgent(a);
  let health=null;
  if(a.agent.healthPort!==undefined){
    health=createServer((req,res)=>{
      if(req.url!=='/healthz'){res.writeHead(404).end();return;}
      const r=agent.runtime,ready=Boolean(r.ready&&agent.transport.startupReady&&!r.shutdownStarted);
      res.writeHead(ready?200:503,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({ready,role:'runner',relayConnected:Boolean(r.relayOnline),codexVersion:RUNTIME_VERSION,source:agent.source??null,
        maintenance:r.maintenance.snapshot(),bots:r.store.bots().length,
        models:r.models.filter(m=>m.provider!=='claude').map(m=>m.model),
        claude:{ready:Boolean(r.codex.claudeReady),models:r.models.filter(m=>m.provider==='claude').map(m=>m.model)},
        nodeId:agent.transport.enrollment.nodeId,capabilities:agent.transport.hello().capabilities,manager:{ready:true}}));
    });
    await new Promise((resolve,reject)=>health.once('error',reject).listen(a.agent.healthPort,'127.0.0.1',resolve));
  }
  const effectsStarted=()=>setTimeout(()=>{console.error('Runner shutdown exceeded its bounded close after proven idle; exiting.');process.exit(0);},Number(process.env.DAWAR_SHUTDOWN_CLOSE_MS??20000)).unref();
  const close=combinedShutdown({agent,gateway:null,health,child:null,siteTimer:null,stopping:()=>{},effectsStarted});
  if(signals)for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void close().then(()=>process.exit(0)).catch(()=>console.error('Runner shutdown blocked by active or unconfirmed work; preserve the service and original receipts.'));});
  return {agent,health,close};
}
