import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,existsSync,mkdirSync,statSync,openSync,readSync,closeSync,createWriteStream,renameSync,rmSync,readdirSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { readPrivate,savePrivate } from '../private-file.mjs';
import { nodeKey,RUNTIME_VERSION } from '../protocol.mjs';
import { resolveCodexLaunch,verifyCodexVersion,redact } from '../codex-runtime.mjs';
import { pairWithFile,HUB_ORIGIN } from '../pairing.mjs';
import { checkForRelease,nodeHello,signedRequest,DOWNLOAD_PURPOSE,ARCHIVE_NAME } from '../mac-releases.mjs';
import { readBundle,installTree,verifyTree } from './bundle.mjs';

export const LABEL='ca.dawar.todo.agent';
export const STATUS_STALE_MS=15000,START_GRACE_MS=90000,HEALTH_WINDOW_MS=180000;
const sha=b=>createHash('sha256').update(b).digest('hex');
const xml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');

export function macPaths(home=homedir()) {
  const base=join(home,'Library/Application Support/DawarTodo'),data=join(base,'agent'),logs=join(home,'Library/Logs/DawarTodo');
  return {home,base,data,config:join(data,'config.json'),status:join(data,'status.json'),activation:join(data,'activation.json'),
    activations:join(data,'activations'),enrollment:join(data,'node-enrollment.json'),key:join(data,'node-key.pem'),
    releases:join(base,'releases'),runtime:join(base,'runtime'),updates:join(base,'updates'),state:join(base,'mac-agent.json'),
    workspaces:join(base,'bots'),logs,stdout:join(logs,'agent.log'),stderr:join(logs,'agent.err.log'),
    plist:join(home,'Library/LaunchAgents',`${LABEL}.plist`)};
}
const readJSON=(path,fallback)=>{try{return JSON.parse(readPrivate(path,1024*1024));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};

// launchctl is injected so Linux tests exercise the exact command protocol.
export function systemLaunchctl(args){const r=spawnSync('/bin/launchctl',args,{encoding:'utf8',timeout:20000});return {status:r.status??-1,stdout:r.stdout??'',stderr:r.stderr??''};}
export function parseLaunchctlPrint(text) {
  const field=name=>text.match(new RegExp(`^\\s*${name} = (.+)$`,'m'))?.[1]?.trim();
  const pid=Number(field('pid'));
  return {loaded:true,state:field('state')??'unknown',pid:Number.isSafeInteger(pid)&&pid>0?pid:null,lastExit:field('last exit code')??null};
}

export class MacAgentController {
  constructor({resources,home=homedir(),uid=process.getuid?.()??501,launchctl=systemLaunchctl,spawn=spawnSync,fetcher=fetch,now=()=>Date.now(),
    releasePublicKey,timeZone=process.env.BOTS_TIME_ZONE??'UTC',nodeBinary}) {
    Object.assign(this,{resources,uid,launchctl,spawn,fetcher,now,timeZone,nodeBinary});
    this.paths=macPaths(home);
    this.releasePublicKey=releasePublicKey??(resources&&existsSync(join(resources,'release-public-key.pem'))?readFileSync(join(resources,'release-public-key.pem'),'utf8'):null);
  }
  get state(){return readJSON(this.paths.state,{version:1,current:null,previous:null,staged:null,failed:[],consent:null,wanted:false,appUpdate:null,lastCheck:null});}
  save(state){savePrivate(this.paths.state,JSON.stringify(state,null,1)+'\n');return state;}
  release(source){return join(this.paths.releases,source);}
  nodeRuntime(){const b=readBundleSafe(this.resources)?.release;return join(this.paths.runtime,`node-v${b?.nodeVersion??'24.21.0'}-darwin-${b?.arch??'arm64'}`);}
  node(){return this.nodeBinary??join(this.nodeRuntime(),'bin/node');}
  codexRoot(release){return join(this.paths.runtime,`codex-${release.runtime}-${release.codexTarget}`);}

  // Idempotent first-run/after-update step: copy the verified bundle into
  // Application Support. A new agent release is staged, never switched here.
  install() {
    const {manifest,release,bundleManifestSHA256}=readBundle(this.resources),p=this.paths;
    verifyTree(this.resources,manifest.files);
    for(const dir of [p.base,p.data,p.releases,p.runtime,p.workspaces,p.logs])mkdirSync(dir,{recursive:true,mode:0o700});
    installTree(this.resources,manifest.files,'node',this.nodeRuntime());
    const codexRoot=this.codexRoot(release);installTree(this.resources,manifest.files,'codex',codexRoot);
    const launch=resolveCodexLaunch(codexRoot,{platform:'darwin',arch:release.arch,version:release.runtime});
    if(sha(readFileSync(launch.binary))!==release.codexBinarySHA256)throw Error('Installed Codex binary differs from the app release receipt.');
    const agent=installTree(this.resources,manifest.files,'agent',this.release(release.agentSource));
    if(sha(readFileSync(join(agent.destination,'manifest.json')))!==release.agentManifestSHA256)throw Error('Installed agent manifest differs from the app release receipt.');
    if(!existsSync(p.config))savePrivate(p.config,JSON.stringify({version:1,mode:'agent',dataDirectory:p.data,agent:{hubOrigin:HUB_ORIGIN,codexBinary:launch.binary,
      workspaces:p.workspaces,activationReceipt:p.activation,statusFile:p.status}},null,2)+'\n');
    else{
      // An existing owner config keeps every value; only the status feed the
      // menu bar needs is added when absent.
      const config=readJSON(p.config,null);
      if(config.agent&&config.agent.statusFile===undefined){config.agent.statusFile=p.status;savePrivate(p.config,JSON.stringify(config,null,2)+'\n');}
    }
    const state=this.state;
    if(!state.current)state.current=release.agentSource;
    else if(state.current!==release.agentSource&&!state.failed.includes(release.agentSource))state.staged={source:release.agentSource,runtime:release.runtime,codexBinary:launch.binary,stagedAt:this.now()};
    state.app={appVersion:release.appVersion,build:release.build,bundleManifestSHA256};
    this.save(state);
    return {installed:true,current:state.current,staged:state.staged?.source??null,codexBinary:launch.binary};
  }
  fingerprint(){return {fingerprint:nodeKey(this.paths.key).fingerprint};}
  verifyRuntime(){const release=readBundle(this.resources).release;return verifyCodexVersion(resolveCodexLaunch(this.codexRoot(release),{platform:'darwin',arch:release.arch,version:release.runtime}),release.runtime,{spawn:this.spawn});}
  async pair(pairingPath) {
    const state=this.state;if(!state.current)throw Error('Install the agent before pairing.');
    const result=await pairWithFile({pairingPath,fingerprint:nodeKey(this.paths.key).fingerprint,data:this.paths.data,configPath:this.paths.config,
      release:this.release(state.current),node:this.node(),spawn:this.spawn,stdio:'pipe'});
    return {paired:true,receipt:JSON.parse(String(result.stdout).trim().split('\n').pop()||'{}')};
  }
  // The owner's explicit consent at this Mac, equivalent to the Linux
  // operator's reviewed activation. Execution still needs hub placement.
  activationFor(source,codexBinary) {
    const enrollment=readJSON(this.paths.enrollment,null);if(!enrollment)throw Error('Pair this Mac before enabling execution.');
    const release=this.release(source);
    return {kind:'portable-agent-activation',executionEnabled:true,nodeId:enrollment.nodeId,runtime:RUNTIME_VERSION,source,
      releaseManifestSHA256:sha(readFileSync(join(release,'manifest.json'))),codexBinarySHA256:sha(readFileSync(codexBinary))};
  }
  writeActivation(source,codexBinary) {
    const activation=this.activationFor(source,codexBinary);
    savePrivate(join(this.paths.activations,`${source}.json`),JSON.stringify(activation)+'\n');
    savePrivate(this.paths.activation,JSON.stringify(activation)+'\n');return activation;
  }
  enableExecution() {
    const state=this.state,config=readJSON(this.paths.config,null);if(!state.current||!config)throw Error('Install the agent first.');
    const activation=this.writeActivation(state.current,config.agent.codexBinary);
    state.consent={at:this.now(),nodeId:activation.nodeId};this.save(state);return {enabled:true,nodeId:activation.nodeId,source:state.current};
  }
  plist(source) {
    const config=readJSON(this.paths.config,null),release=this.release(source),node=this.node();
    const codexPath=join(dirname(dirname(config.agent.codexBinary)),'codex-path');
    const args=[node,join(release,'portable/agent-cli.mjs'),'run','--config',this.paths.config];
    const env={PATH:`${codexPath}:${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,BOTS_TIME_ZONE:this.timeZone};
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>`+
      `<key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args.map(a=>`<string>${xml(a)}</string>`).join('')}</array>`+
      `<key>WorkingDirectory</key><string>${xml(release)}</string><key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join('')}</dict>`+
      `<key>StandardOutPath</key><string>${xml(this.paths.stdout)}</string><key>StandardErrorPath</key><string>${xml(this.paths.stderr)}</string>`+
      `<key>RunAtLoad</key><false/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer>`+
      `<key>ProcessType</key><string>Standard</string><key>Umask</key><integer>63</integer></dict></plist>\n`;
  }
  service(){const r=this.launchctl(['print',`gui/${this.uid}/${LABEL}`]);return r.status===0?parseLaunchctlPrint(r.stdout):{loaded:false,state:'not loaded',pid:null,lastExit:null};}
  agentStatus(){
    try{const s=statSync(this.paths.status),value=JSON.parse(readPrivate(this.paths.status,256*1024));return {...value,fresh:this.now()-s.mtimeMs<STATUS_STALE_MS};}
    catch(e){if(e.code==='ENOENT')return null;return {error:e.message,fresh:false};}
  }
  busy(){const s=this.agentStatus(),svc=this.service();return svc.pid!==null&&(!s?.fresh||s.bots?.working>0||s.bots?.settling>0);}
  rotateLogs(){for(const path of [this.paths.stdout,this.paths.stderr]){try{if(statSync(path).size>10*1024*1024)renameSync(path,path+'.1');}catch(e){if(e.code!=='ENOENT')throw e;}}}
  bootstrap(source) {
    mkdirSync(dirname(this.paths.plist),{recursive:true});mkdirSync(this.paths.logs,{recursive:true,mode:0o700});this.rotateLogs();
    writeFileSync(this.paths.plist,this.plist(source),{mode:0o600});
    const r=this.launchctl(['bootstrap',`gui/${this.uid}`,this.paths.plist]);
    if(r.status!==0&&!this.service().loaded)throw Error(`launchctl bootstrap failed (${r.status}): ${redact(r.stderr).slice(0,300)}`);
    const k=this.launchctl(['kickstart',`gui/${this.uid}/${LABEL}`]);
    if(k.status!==0)throw Error(`launchctl kickstart failed (${k.status}): ${redact(k.stderr).slice(0,300)}`);
  }
  bootout(){const r=this.launchctl(['bootout',`gui/${this.uid}/${LABEL}`]);if(r.status!==0&&this.service().loaded)throw Error(`launchctl bootout failed (${r.status}).`);}
  start() {
    const state=this.state;if(!existsSync(this.paths.activation))throw Error('Enable execution on this Mac before starting the agent.');
    const svc=this.service();state.wanted=true;state.startedAt=this.now();this.save(state);
    if(svc.pid)return {started:false,running:true,pid:svc.pid};
    if(svc.loaded)this.bootout();
    this.bootstrap(state.current);return {started:true,source:state.current};
  }
  // Stop never interrupts native work silently: with active turns or
  // unresolved tool activity it refuses unless the owner forces it.
  stop({force=false}={}) {
    const s=this.agentStatus();
    if(!force&&s?.fresh&&(s.bots?.working>0||s.bots?.settling>0))return {stopped:false,reason:'busy',working:s.bots.working,settling:s.bots.settling};
    const state=this.state;state.wanted=false;this.save(state);
    if(this.service().loaded)this.bootout();return {stopped:true};
  }
  reconnect() {
    const svc=this.service(),s=this.agentStatus();
    if(!svc.pid)return this.start();
    if(s?.fresh&&s.connected)return {reconnected:false,reason:'connected'};
    if(s?.fresh&&(s.bots?.working>0||s.bots?.settling>0))return {reconnected:false,reason:'busy; the agent retries its hub connection automatically'};
    this.bootout();this.bootstrap(this.state.current);return {reconnected:true};
  }
  // Switch to a staged release only while no native work or tool is active,
  // keeping the previous release and activation for rollback.
  applyStaged() {
    const state=this.state;if(!state.staged)return {switched:false,reason:'nothing staged'};
    const running=this.service().pid!==null;
    if(running&&this.busy())return {switched:false,reason:'waiting for native work to settle'};
    if(!state.consent)return {switched:false,reason:'execution not enabled'};
    const {source,codexBinary}=state.staged,from=state.current,config=readJSON(this.paths.config,null),previousCodex=config.agent.codexBinary;
    const activation=this.writeActivation(source,codexBinary);
    if(previousCodex!==codexBinary){config.agent.codexBinary=codexBinary;savePrivate(this.paths.config,JSON.stringify(config,null,2)+'\n');}
    Object.assign(state,{previous:{source:from,codexBinary:previousCodex},current:source,staged:null,switchedAt:this.now(),health:'pending'});
    this.save(state);
    if(running){this.bootout();this.bootstrap(source);}
    return {switched:true,from,to:source,restarted:running,nodeId:activation.nodeId};
  }
  // A switched release that does not come up connected within the health
  // window, or exits, is rolled back to the retained previous release.
  checkHealth() {
    const state=this.state;if(state.health!=='pending'||!state.previous)return {health:state.health??'n/a'};
    const s=this.agentStatus(),svc=this.service();
    if(s?.fresh&&s.connected&&s.ready&&s.source===state.current){state.health='healthy';this.save(state);return {health:'healthy'};}
    const exited=state.wanted&&!svc.pid&&this.now()-state.switchedAt>20000;
    if(!exited&&this.now()-state.switchedAt<HEALTH_WINDOW_MS)return {health:'pending'};
    const failed=state.current,back=state.previous;
    const activation=readJSON(join(this.paths.activations,`${back.source}.json`),null);
    if(!activation)return {health:'failed',rolledBack:false,reason:'previous activation missing'};
    savePrivate(this.paths.activation,JSON.stringify(activation)+'\n');
    const config=readJSON(this.paths.config,null);if(config.agent.codexBinary!==back.codexBinary){config.agent.codexBinary=back.codexBinary;savePrivate(this.paths.config,JSON.stringify(config,null,2)+'\n');}
    Object.assign(state,{current:back.source,previous:null,health:'rolled-back',failed:[...new Set([...state.failed,failed])].slice(-10)});this.save(state);
    if(state.wanted){if(this.service().loaded)this.bootout();this.bootstrap(back.source);}
    return {health:'rolled-back',failed,current:back.source};
  }
  identity(){
    const enrollment=readJSON(this.paths.enrollment,null);if(!enrollment)throw Error('Pair this Mac before checking for updates.');
    return {enrollment,key:nodeKey(this.paths.key)};
  }
  async checkUpdate() {
    if(!this.releasePublicKey)throw Error('This build has no release verification key.');
    const {enrollment,key}=this.identity(),state=this.state,client={build:state.app?.build??0,appVersion:state.app?.appVersion??'0.0.0'};
    const result=await checkForRelease({hub:enrollment.hub??HUB_ORIGIN,key,nodeId:enrollment.nodeId,client,publicKey:this.releasePublicKey,fetcher:this.fetcher,now:this.now(),
      hello:nodeHello('darwin',readBundle(this.resources).release.arch)});
    state.lastCheck={at:this.now(),compatible:result.compatible,reason:result.reason,hub:result.hub,available:result.updateAvailable?{build:result.release.build,appVersion:result.release.appVersion}:null};
    this.save(state);
    return {...state.lastCheck,updateRequired:!result.compatible,envelope:result.updateAvailable?result.envelope:null};
  }
  // Download the approved archive with a node-signed request, verify it, and
  // write a local appcast that Sparkle verifies again with its EdDSA key.
  async stageAppUpdate() {
    const check=await this.checkUpdate();if(!check.envelope)return {staged:false,reason:check.updateRequired?check.reason:'up to date'};
    const r=check.envelope.release,{enrollment,key}=this.identity();
    if(!ARCHIVE_NAME.test(r.archive.name))throw Error('Release archive name is invalid.');
    const dir=join(this.paths.updates,String(r.build)),archive=join(dir,r.archive.name);
    mkdirSync(dir,{recursive:true,mode:0o700});
    if(!existsSync(archive)||sha(readFileSync(archive))!==r.archive.sha256){
      const response=await this.fetcher(new URL('/nodes/releases/mac/download',enrollment.hub??HUB_ORIGIN),{method:'POST',redirect:'error',signal:AbortSignal.timeout(30*60*1000),
        headers:{'content-type':'application/json'},body:JSON.stringify(signedRequest(key,enrollment.nodeId,DOWNLOAD_PURPOSE,{name:r.archive.name},this.now()))});
      if(!response.ok||!response.body){await response.body?.cancel();throw Error(`Release download failed with HTTP ${response.status}.`);}
      const partial=archive+'.partial';await pipeline(Readable.fromWeb(response.body),createWriteStream(partial,{mode:0o600}));
      const bytes=readFileSync(partial);
      if(bytes.length!==r.archive.bytes||sha(bytes)!==r.archive.sha256){rmSync(partial,{force:true});throw Error('Downloaded release does not match its signed record.');}
      renameSync(partial,archive);
    }
    const appcast=join(dir,'appcast.xml');
    writeFileSync(appcast,`<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>DawarTodo Agent</title>`+
      `<item><title>${xml(r.appVersion)}</title><sparkle:version>${r.build}</sparkle:version><sparkle:shortVersionString>${xml(r.appVersion)}</sparkle:shortVersionString>`+
      `<sparkle:minimumSystemVersion>${xml(r.minimumMacOS)}</sparkle:minimumSystemVersion><pubDate>${xml(new Date(r.publishedAt).toUTCString())}</pubDate>`+
      `<enclosure url="${xml(pathToFileURL(archive).href)}" length="${r.archive.bytes}" type="application/octet-stream" sparkle:edSignature="${xml(r.archive.edSignature)}"/></item></channel></rss>\n`,{mode:0o600});
    const state=this.state;state.appUpdate={build:r.build,appVersion:r.appVersion,agentSource:r.agentSource,archive,appcast,stagedAt:this.now()};this.save(state);
    return {staged:true,...state.appUpdate};
  }
  status() {
    const p=this.paths,state=this.state,svc=this.service(),agent=this.agentStatus();
    const installed=!!state.current&&existsSync(p.config),paired=existsSync(p.enrollment),enabled=existsSync(p.activation);
    let phase;
    if(!installed)phase='not-installed';
    else if(!paired)phase='needs-pairing';
    else if(!enabled)phase='needs-activation';
    else if(!svc.pid)phase=state.wanted&&svc.lastExit&&svc.lastExit!=='0'&&svc.lastExit!=='(never exited)'?'crashed':'stopped';
    else if(!agent?.fresh||agent.pid!==svc.pid)phase=this.now()-(state.switchedAt??state.startedAt??0)<START_GRACE_MS?'starting':'unresponsive';
    else if(!agent.connected)phase='disconnected';
    else phase=agent.bots?.working>0?'working':'connected';
    return {phase,service:svc,agent:agent?{connected:agent.connected,ready:agent.ready,bots:agent.bots,source:agent.source,at:agent.at}:null,
      release:{current:state.current,previous:state.previous?.source??null,staged:state.staged?.source??null,health:state.health??null,failed:state.failed},
      app:state.app??null,update:{lastCheck:state.lastCheck,staged:state.appUpdate},wanted:state.wanted,logs:{directory:p.logs,stdout:p.stdout,stderr:p.stderr}};
  }
  diagnostics() {
    const tail=(path,lines=200)=>{try{const s=statSync(path),n=Math.min(s.size,256*1024),b=Buffer.alloc(n),fd=openSync(path,'r');try{readSync(fd,b,0,n,s.size-n);}finally{closeSync(fd);}return redact(b.toString('utf8')).split('\n').slice(-lines).join('\n');}catch{return null;}};
    const releases=existsSync(this.paths.releases)?readdirSync(this.paths.releases).filter(n=>/^[a-f0-9]{40}$/.test(n)):[];
    return {at:new Date(this.now()).toISOString(),status:this.status(),releases,bundle:readBundleSafe(this.resources)?.release??null,
      stdout:tail(this.paths.stdout),stderr:tail(this.paths.stderr),credentialsIncluded:false};
  }
}
function readBundleSafe(resources){try{return resources?readBundle(resources):null;}catch{return null;}}
