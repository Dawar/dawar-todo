import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {loadConfig} from './config.mjs';
import {closeHttpServer} from './close-http.mjs';

// The separate hub (SPLIT_HUB_RUNNER.md): gateway, login, mailbox, website
// writer, voice and the one scheduler, without the native runner. The runner
// reaches it over /nodes/connect like any remote node, so restarting this
// process never drains or stops native work. `/healthz` is front-facing hub
// readiness only; a connected runner is reported, never required.
export async function runHub(configPath,{startGateway:injected,signals=true,siteHealth}={}) {
  const c=loadConfig(configPath),root=fileURLToPath(new URL('..',import.meta.url));
  if(c.mode!=='hub')throw Error('A separate hub requires its own mode "hub" configuration.');
  if(c.agentConfigFile!==undefined)throw Error('A separate hub configuration names no agent configuration; the runner has its own.');
  if(!c.teamWorkspaceRoot)throw Error('A separate hub requires its explicit team workspace root.');
  const {startGateway}=injected?{startGateway:injected}:await import(pathToFileURL(join(root,'dist/portable/gateway.mjs')).href);
  // No legacyTeamSource: the one-time adoption from the agent's store is
  // already recorded by the combined release (portable-team-authority meta).
  const gateway=startGateway(c);
  await new Promise((resolve,reject)=>{if(gateway.server.listening)return resolve();gateway.server.once('listening',resolve);gateway.server.once('error',reject);});
  const child=c.externalSite===true?null:spawn(process.execPath,[join(root,'.next-portable/standalone/server.js')],{cwd:join(root,'.next-portable/standalone'),
    env:{...process.env,DAWAR_HUB_CONFIG:configPath,PORT:String(c.sitePort??3211),HOSTNAME:'127.0.0.1'},stdio:'inherit'});
  let stopping=false,siteReady=false;
  child?.on('exit',()=>{siteReady=false;if(!stopping)console.error('Portable site exited; hub health is unavailable. Inspect the original service, never blindly restart.');});
  const checkSite=siteHealth??(async()=>{try{const r=await fetch(`http://127.0.0.1:${c.sitePort??3211}/api/health`,{signal:AbortSignal.timeout(2000)});await r.body?.cancel();return r.status<500;}catch{return false;}});
  const refreshSite=async()=>{siteReady=await checkSite();};
  await refreshSite();const siteTimer=setInterval(()=>void refreshSite(),5000);
  const writerReady=()=>{try{gateway.controls.assertWriter();return true;}catch{return false;}};
  const health=createServer((req,res)=>{
    if(req.url!=='/healthz'){res.writeHead(404).end();return;}
    const writer=writerReady(),voice=gateway.voice?{enabled:true,idle:gateway.voice.idle(),...gateway.voice.status()}:{enabled:false,idle:true};
    const nodes=[...(gateway.router?.connections?.keys?.()??[])];
    const ready=!stopping&&gateway.server.listening&&writer&&siteReady;
    res.writeHead(ready?200:503,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ready,role:'hub',source:c.hub?.source??null,siteReady,writer:{ready:writer},voice,
      scheduler:Boolean(c.hub?.activationReceipt),nodes,relayConnected:nodes.length>0}));
  });
  await new Promise((resolve,reject)=>health.once('error',reject).listen(c.healthPort??47821,'127.0.0.1',resolve));
  let closing;
  const close=()=>closing??=(async()=>{
    // Voice/provider work drains first (it refuses rather than cutting a
    // live call); after that nothing may hold the process open.
    if(gateway.voice)await gateway.voice.drain();
    stopping=true;clearInterval(siteTimer);
    setTimeout(()=>{console.error('Hub shutdown exceeded its bounded close; exiting.');process.exit(0);},Number(process.env.DAWAR_SHUTDOWN_CLOSE_MS??20000)).unref();
    await gateway.close();await closeHttpServer(health);child?.kill('SIGTERM');
  })().catch(error=>{closing=null;throw error;});
  if(signals)for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void close().then(()=>process.exit(0)).catch(()=>console.error('Hub shutdown is blocked by original active or unconfirmed voice work. Preserve its state and use the reviewed handoff.'));});
  return {gateway,health,child,close};
}
