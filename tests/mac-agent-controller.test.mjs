import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync,readdirSync,mkdirSync,statSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash,generateKeyPairSync,createPublicKey } from 'node:crypto';
import { MacAgentController,parseLaunchctlPrint,LABEL,HEALTH_WINDOW_MS } from '../portable/mac-agent/controller.mjs';
import { stageResources } from '../portable/mac-agent/bundle.mjs';
import { MacReleaseService,signRelease } from '../portable/mac-releases.mjs';
import { savePrivate,readPrivate } from '../portable/private-file.mjs';
import { RUNTIME_VERSION } from '../portable/protocol.mjs';
import { agentDownload,nodeModules,nodeTarball,temp,SOURCE_A,SOURCE_B } from './helpers/mac-agent-fixture.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
function bundle(source,build) {
  const tar=nodeTarball(),out=join(temp('resources-'),'Resources');
  stageResources({agentDownload:agentDownload(source),nodeModules:nodeModules(),nodeTarball:tar.archive,nodeSHA256:tar.sha256,out,appVersion:`1.0.${build}`,build});
  return out;
}
// launchd stand-in speaking the same print/bootstrap/kickstart/bootout protocol.
function launchd() {
  const calls=[],svc={loaded:false,pid:null,lastExit:'(never exited)',nextPid:4000};
  const run=args=>{
    calls.push(args.join(' '));
    if(args[0]==='print')return svc.loaded?{status:0,stdout:`gui/501/${LABEL} = {\n\tstate = ${svc.pid?'running':'not running'}\n${svc.pid?`\tpid = ${svc.pid}\n`:''}\tlast exit code = ${svc.lastExit}\n}`,stderr:''}:{status:113,stdout:'',stderr:'Could not find service'};
    if(args[0]==='bootstrap'){if(svc.loaded)return {status:5,stdout:'',stderr:'already loaded'};svc.loaded=true;return {status:0,stdout:'',stderr:''};}
    if(args[0]==='kickstart'){if(!svc.loaded)return {status:113,stdout:'',stderr:''};svc.pid??=++svc.nextPid;return {status:0,stdout:'',stderr:''};}
    if(args[0]==='bootout'){svc.loaded=false;if(svc.pid)svc.lastExit='0';svc.pid=null;return {status:0,stdout:'',stderr:''};}
    return {status:1,stdout:'',stderr:'unknown'};
  };
  return {run,calls,svc};
}
function rig({resources=bundle(SOURCE_A,1),fetcher,releasePublicKey}={}) {
  const home=temp('mac-home-'),ld=launchd(),clock={t:Date.now()};
  const make=res=>new MacAgentController({resources:res,home,uid:501,launchctl:ld.run,nodeBinary:process.execPath,now:()=>clock.t,fetcher,releasePublicKey,timeZone:'America/Toronto'});
  return {home,ld,clock,make,c:make(resources)};
}
const writeStatus=(c,{connected=true,working=0,settling=0,source,pid}={})=>savePrivate(c.paths.status,JSON.stringify({version:1,at:Date.now(),pid:pid??c.service().pid,source:source??c.state.current,
  connected,ready:true,bots:{total:2,working,settling,active:working?[{id:'bot-1',name:'Dwight',status:'working'}]:[]}}));
async function paired(r) {
  r.c.install();
  const {fingerprint}=r.c.fingerprint(),file=join(temp('pairing-'),'pairing.json');
  writeFileSync(file,JSON.stringify({version:1,hubOrigin:'https://work.dawar.ca',fingerprint,expiresAt:Date.now()+300000,token:'T'.repeat(40)}));
  return {file,result:await r.c.pair(file)};
}

test('launchctl print output is parsed for state, pid and last exit',()=>{
  assert.deepEqual(parseLaunchctlPrint('x = {\n\tstate = running\n\tpid = 812\n\tlast exit code = 0\n}'),{loaded:true,state:'running',pid:812,lastExit:'0'});
  assert.deepEqual(parseLaunchctlPrint('\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n'),{loaded:true,state:'not running',pid:null,lastExit:'78: EX_CONFIG'});
});

test('install copies node, codex and the agent release outside the app and writes a status-enabled config once',()=>{
  const r=rig();
  assert.equal(r.c.status().phase,'not-installed');
  const first=r.c.install(),p=r.c.paths;
  assert.equal(first.current,SOURCE_A);
  assert.ok(existsSync(join(p.runtime,'node-v24.21.0-darwin-arm64/bin/node')));
  assert.equal(first.codexBinary,join(p.runtime,`codex-${RUNTIME_VERSION}-aarch64-apple-darwin/vendor/aarch64-apple-darwin/bin/codex`));
  assert.ok(existsSync(join(p.releases,SOURCE_A,'portable/agent-cli.mjs')));
  const config=JSON.parse(readPrivate(p.config));
  assert.deepEqual(config.agent,{hubOrigin:'https://work.dawar.ca',codexBinary:first.codexBinary,workspaces:p.workspaces,activationReceipt:p.activation,statusFile:p.status});
  writeFileSync(p.config,JSON.stringify({...config,agent:{...config.agent,ownerSetting:true}}),{mode:0o600});
  r.c.install();
  assert.equal(JSON.parse(readPrivate(p.config)).agent.ownerSetting,true,'existing owner config is never replaced');
  const {statusFile,...withoutStatus}=JSON.parse(readPrivate(p.config)).agent;
  writeFileSync(p.config,JSON.stringify({...config,agent:withoutStatus}),{mode:0o600});
  r.c.install();
  assert.deepEqual(JSON.parse(readPrivate(p.config)).agent,{...withoutStatus,statusFile},'only the missing status feed is added');
  assert.equal(r.c.status().phase,'needs-pairing');
});

test('pairing uses the existing enrollment with a private, removed token file and rejects foreign or expired files',async()=>{
  const r=rig(),{file,result}=await paired(r);
  assert.equal(result.paired,true);assert.equal(result.receipt.tokenLength,40);
  assert.deepEqual(readdirSync(r.c.paths.data).filter(n=>n.startsWith('pairing-token-')),[]);
  assert.equal(r.c.status().phase,'needs-activation');
  const other=JSON.parse(readFileSync(file,'utf8'));
  writeFileSync(file,JSON.stringify({...other,fingerprint:'0'.repeat(64)}));
  await assert.rejects(r.c.pair(file),/another machine/);
  writeFileSync(file,JSON.stringify({...other,expiresAt:Date.now()-1}));
  await assert.rejects(r.c.pair(file),/expired/);
  writeFileSync(file,JSON.stringify({...other,hubOrigin:'https://evil.example'}));
  await assert.rejects(r.c.pair(file),/another machine/);
});

test('execution needs pairing first; the activation binds node, release manifest and Codex bytes',async()=>{
  const r=rig();r.c.install();
  assert.throws(()=>r.c.enableExecution(),/Pair this Mac/);
  assert.throws(()=>r.c.start(),/Enable execution/);
  await paired(r);
  const enabled=r.c.enableExecution(),activation=JSON.parse(readPrivate(r.c.paths.activation));
  assert.equal(enabled.source,SOURCE_A);
  assert.equal(activation.kind,'portable-agent-activation');assert.equal(activation.nodeId,'node:'+'n'.repeat(24));
  assert.equal(activation.releaseManifestSHA256,sha(readFileSync(join(r.c.paths.releases,SOURCE_A,'manifest.json'))));
  assert.equal(activation.codexBinarySHA256,sha(readFileSync(JSON.parse(readPrivate(r.c.paths.config)).agent.codexBinary)));
  assert.equal(r.c.status().phase,'stopped');
});

test('start, status, stop and reconnect drive launchd without interrupting active work',async()=>{
  const r=rig();await paired(r);r.c.enableExecution();
  assert.equal(r.c.start().started,true);
  const plist=readFileSync(r.c.paths.plist,'utf8');
  assert.match(plist,new RegExp(`<string>${process.execPath}</string><string>${join(r.c.paths.releases,SOURCE_A,'portable/agent-cli.mjs')}</string><string>run</string>`));
  assert.match(plist,/codex-path:/);assert.match(plist,/<key>BOTS_TIME_ZONE<\/key><string>America\/Toronto<\/string>/);
  assert.match(plist,/<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);assert.match(plist,/agent\.err\.log/);
  assert.doesNotMatch(plist,/token|pairing/i);
  assert.equal(r.c.status().phase,'starting');
  writeStatus(r.c,{connected:false});assert.equal(r.c.status().phase,'disconnected');
  writeStatus(r.c,{working:1});const s=r.c.status();assert.equal(s.phase,'working');assert.equal(s.agent.bots.active[0].name,'Dwight');
  assert.deepEqual(r.c.reconnect(),{reconnected:false,reason:'connected'});
  assert.equal(r.c.start().started,false,'a running agent is not restarted');
  const refused=r.c.stop();assert.equal(refused.stopped,false);assert.equal(refused.reason,'busy');
  assert.equal(r.ld.svc.pid!==null,true);
  writeStatus(r.c,{connected:false,working:1});
  assert.match(r.c.reconnect().reason,/busy/);
  writeStatus(r.c,{connected:false});const pid=r.ld.svc.pid;
  assert.equal(r.c.reconnect().reconnected,true);assert.notEqual(r.ld.svc.pid,pid);
  writeStatus(r.c);assert.equal(r.c.status().phase,'connected');
  assert.equal(r.c.stop().stopped,true);assert.equal(r.c.status().phase,'stopped');
  r.c.start();writeStatus(r.c,{working:2});assert.equal(r.c.stop({force:true}).stopped,true);
  r.clock.t+=200000;r.ld.svc.loaded=true;r.ld.svc.lastExit='1';const st=r.c.state;st.wanted=true;r.c.save(st);
  assert.equal(r.c.status().phase,'crashed');
});

test('an upgrade stages while busy, switches only after work settles and preserves data, settings and queues',async()=>{
  const r=rig();await paired(r);r.c.enableExecution();r.c.start();
  const data=r.c.paths.data;mkdirSync(join(data,'manager'),{recursive:true});
  writeFileSync(join(data,'native-control.sqlite'),'queue:op-original-1;settings:fast=true');writeFileSync(join(data,'manager/queue.json'),'{"id":"op-original-2"}');
  const before=Object.fromEntries(['native-control.sqlite','manager/queue.json','node-key.pem','node-enrollment.json'].map(n=>[n,readFileSync(join(data,n),'utf8')]));
  const updated=r.make(bundle(SOURCE_B,2));
  assert.equal(updated.install().staged,SOURCE_B);
  assert.equal(updated.status().release.current,SOURCE_A,'installing never switches the running release');
  writeStatus(updated,{working:1});
  assert.deepEqual(updated.applyStaged(),{switched:false,reason:'waiting for native work to settle'});
  writeStatus(updated,{working:0,settling:1});
  assert.equal(updated.applyStaged().switched,false,'unresolved tool activity also waits');
  const pid=r.ld.svc.pid;writeStatus(updated);
  const sw=updated.applyStaged();assert.deepEqual([sw.switched,sw.from,sw.to,sw.restarted],[true,SOURCE_A,SOURCE_B,true]);
  assert.notEqual(r.ld.svc.pid,pid);
  assert.match(readFileSync(updated.paths.plist,'utf8'),new RegExp(join(updated.paths.releases,SOURCE_B)));
  assert.equal(JSON.parse(readPrivate(updated.paths.activation)).source,SOURCE_B);
  assert.ok(existsSync(join(updated.paths.releases,SOURCE_A,'manifest.json')),'previous release is retained');
  for(const [n,v] of Object.entries(before))assert.equal(readFileSync(join(data,n),'utf8'),v,`${n} unchanged`);
  writeStatus(updated,{source:SOURCE_B});assert.deepEqual(updated.checkHealth(),{health:'healthy'});
});

test('a switched release that never connects rolls back to the retained release and is not restaged',async()=>{
  const r=rig();await paired(r);r.c.enableExecution();r.c.start();writeStatus(r.c);
  const resourcesB=bundle(SOURCE_B,2),updated=r.make(resourcesB);updated.install();
  assert.equal(updated.applyStaged().switched,true);
  writeStatus(updated,{connected:false,source:SOURCE_B});
  assert.deepEqual(updated.checkHealth(),{health:'pending'});
  r.clock.t+=HEALTH_WINDOW_MS+1000;
  const back=updated.checkHealth();assert.deepEqual([back.health,back.failed,back.current],['rolled-back',SOURCE_B,SOURCE_A]);
  assert.equal(JSON.parse(readPrivate(updated.paths.activation)).source,SOURCE_A);
  assert.match(readFileSync(updated.paths.plist,'utf8'),new RegExp(join(updated.paths.releases,SOURCE_A)));
  assert.equal(r.make(resourcesB).install().staged,null,'a failed release is not staged again');
});

test('app updates download only the signed, node-authorised archive and hand Sparkle a verified local appcast',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');
  const releaseKey=privateKey.export({format:'pem',type:'pkcs8'}).toString(),releasePublic=publicKey.export({format:'pem',type:'spki'}).toString();
  const downloads=temp('hub-'),zip=Buffer.from('signed app archive');mkdirSync(join(downloads,'mac'));
  const record={kind:'dawartodo-mac-agent-release',version:1,appVersion:'1.0.2',build:2,agentSource:SOURCE_B,protocol:1,runtime:RUNTIME_VERSION,nodeVersion:'24.21.0',
    platform:'darwin',arch:'arm64',minimumMacOS:'13.0',bundleManifestSHA256:'c'.repeat(64),publishedAt:'2026-10-15T00:00:00.000Z',
    archive:{name:'DawarTodoAgent-1.0.2-2.zip',bytes:zip.length,sha256:sha(zip),edSignature:'B'.repeat(86)+'=='},hub:{protocols:[1],runtimes:[RUNTIME_VERSION]}};
  writeFileSync(join(downloads,'mac/releases.json'),JSON.stringify([signRelease(releaseKey,record)]));
  let served=zip;writeFileSync(join(downloads,'mac',record.archive.name),zip);
  let r;
  const service=new MacReleaseService({directory:downloads,nodeLookup:()=>({public_key:createPublicKey(readPrivate(r.c.paths.key,4096)).export({format:'pem',type:'spki'}).toString(),revoked_at:null})});
  const fetcher=async(url,init)=>{
    const body=JSON.parse(init.body);
    if(url.pathname==='/nodes/releases/mac')return Response.json(await service.check(body));
    if(url.pathname==='/nodes/releases/mac/download'){await service.archive(body);return new Response(served,{status:200});}
    return new Response('',{status:404});
  };
  r=rig({fetcher,releasePublicKey:releasePublic});await paired(r);
  const staged=await r.c.stageAppUpdate();
  assert.equal(staged.staged,true);assert.equal(staged.build,2);
  assert.equal(readFileSync(staged.archive,'utf8'),'signed app archive');
  const appcast=readFileSync(staged.appcast,'utf8');
  assert.match(appcast,/<sparkle:version>2<\/sparkle:version>/);assert.match(appcast,new RegExp(`url="${pathToFileURL(staged.archive).href}"`));
  assert.match(appcast,new RegExp(`sparkle:edSignature="${'B'.repeat(86)}=="`));
  assert.equal(r.c.status().update.staged.build,2);
  served=Buffer.from('tampered archive bytes');rmSync(staged.archive);
  await assert.rejects(r.c.stageAppUpdate(),/does not match its signed record/);
  const state=r.c.state;state.app.build=2;r.c.save(state);
  assert.deepEqual((await r.c.stageAppUpdate()).staged,false);
});

test('diagnostics hold versions, state and redacted log tails, never credentials',async()=>{
  const r=rig();await paired(r);mkdirSync(r.c.paths.logs,{recursive:true});
  writeFileSync(r.c.paths.stderr,'boot\nAuthorization: Bearer sekritsekritsekrit\nfailed\n');
  const d=r.c.diagnostics();
  assert.equal(d.credentialsIncluded,false);assert.equal(d.bundle.agentSource,SOURCE_A);assert.deepEqual(d.releases,[SOURCE_A]);
  assert.match(d.stderr,/Bearer \[redacted\]/);assert.doesNotMatch(JSON.stringify(d),/sekrit|BEGIN PRIVATE|TTTTTTTT/);
  assert.equal(statSync(r.c.paths.state).mode&0o777,0o600);
});
