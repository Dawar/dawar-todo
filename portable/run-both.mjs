import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadConfig} from './config.mjs';
import {RUNTIME_VERSION} from './protocol.mjs';

// A single systemd/launchd cgroup owns the site, hub and the very same agent
// entrypoint used on remote machines. There is exactly one logical scheduler.
export async function runBoth(configPath) {
  const c=loadConfig(configPath);
  if(c.mode!=='both'||!c.agentConfigFile)throw Error('Combined installation requires its separate private agent configuration.');
  const a=loadConfig(c.agentConfigFile),root=fileURLToPath(new URL('..',import.meta.url));
  if(a.mode!=='agent'||a.dataDirectory===c.dataDirectory||a.agent.loopbackHubPort!==(c.gatewayPort??3210))throw Error('Combined role storage/transport differs.');
  // A web-only release can retain the exact installed backend and its native
  // process. On later service starts, use that same verified backend release
  // while systemd owns the independently updated site.
  const backendRoot=c.backendReleaseDirectory??root;
  const {startGateway}=await import(pathToFileURL(join(backendRoot,'dist/portable/gateway.mjs')).href);
  const {runAgent}=await import(pathToFileURL(join(backendRoot,'bot-bridge/portable-agent.mjs')).href);
  const gateway=startGateway(c);
  await new Promise((resolve,reject)=>{if(gateway.server.listening)return resolve();gateway.server.once('listening',resolve);gateway.server.once('error',reject);});
  const child=c.externalSite===true?null:spawn(process.execPath,[join(root,'.next-portable/standalone/server.js')],{cwd:join(root,'.next-portable/standalone'),
    env:{...process.env,DAWAR_HUB_CONFIG:configPath,PORT:String(c.sitePort??3211),HOSTNAME:'127.0.0.1'},stdio:'inherit'});
  let agent,stopping=false,siteReady=false;
  child?.on('exit',()=>{siteReady=false;if(!stopping)console.error('Portable site exited; execution health is unavailable. Inspect the original service, never blindly restart.');});
  try{agent=await runAgent(a);}catch(error){await gateway.close();child?.kill('SIGTERM');throw error;}
  const checkSite=async()=>{try{const r=await fetch(`http://127.0.0.1:${c.sitePort??3211}/api/health`,{signal:AbortSignal.timeout(2000)});await r.body?.cancel();siteReady=r.status<500;}catch{siteReady=false;}};
  await checkSite();const siteTimer=setInterval(()=>void checkSite(),5000);
  const health=createServer((req,res)=>{
    if(req.url!=='/healthz'){res.writeHead(404).end();return;}
    const r=agent.runtime,ready=r.ready&&agent.transport.startupReady&&r.relayOnline&&siteReady;
    res.writeHead(ready?200:503,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ready,relayConnected:Boolean(r.relayOnline),codexVersion:RUNTIME_VERSION,source:c.hub.source,role:'both',
      siteReady,maintenance:r.maintenance.snapshot(),collaboration:r.collaboration.health(),bots:r.store.bots().length,
      models:r.models.map(m=>m.model),nodeId:agent.transport.enrollment.nodeId,capabilities:agent.transport.hello().capabilities,
      manager:{ready:true}}));
  });health.listen(c.healthPort??47821,'127.0.0.1');
  const close=async()=>{
    if(stopping)return;
    // This path is for a separately proved idle handoff, not an active-turn
    // stop/resume mechanism. Do not silently kill live work on a signal.
    const counts=agent.runtime.maintenance.counts();
    if(Object.values(counts).some(n=>n!==0)||agent.transport.pending.size||agent.transport.controlPending.size)
      throw Error('Portable shutdown requires reviewed all-context idle proof.');
    await gateway.close();stopping=true;clearInterval(siteTimer);health.close();agent.transport.close();
    agent.runtime.usage.stop();agent.runtime.maintenance.close();agent.runtime.secure?.close();
    agent.runtime.codex.close();await agent.runtime.desktops?.close();await agent.manager.close();
    agent.journal.close();agent.runtime.store.close();child?.kill('SIGTERM');
  };
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close().then(()=>process.exit(0)).catch(()=>console.error('Portable shutdown blocked by active or unconfirmed work; preserve the service and original receipts.'));});
  return {gateway,agent,health,close};
}
