import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, readlink, chmod, mkdir, lstat, rm, rmdir } from 'node:fs/promises';
import {existsSync} from 'node:fs';
import { join, isAbsolute, resolve, relative,dirname } from 'node:path';
import { request } from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';
import { readPrivate,savePrivate } from './private-file.mjs';
import { LocalWriterDrain } from './local-work-admission.mjs';
import { RetainedRecords } from './retained-records.mjs';
import {bootstrapAuthority,bootstrapIdle} from './bootstrap-idle.mjs';
import {closeBootstrap} from './bootstrap-close.mjs';
import {linuxProbe,verifyPlan,ROLES} from './deploy-plan.mjs';

const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Every refusal names what differed. Messages never include credentials.
const failure=(reason='Deployment prerequisite differs.')=>Object.assign(Error(`${reason} Inspect the private original transaction; no lifecycle effect was repeated.`),{deploymentBlocked:true});
const allowedUnit=/^[A-Za-z0-9_-]{8,100}\.service$/;
const pause=ms=>new Promise(r=>setTimeout(r,ms));
export function linuxDeployment(spec,{systemctl=async(...args)=>(await exec('systemctl',['--user',...args],{timeout:10000,maxBuffer:65536})).stdout,poll=1000}={}) {
  if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])!==24)throw failure('Deployment requires Linux and Node 24.');
  // Roles (SPLIT_HUB_RUNNER.md): `both` is the combined process; `hub` owns
  // the hub writer and site, never the native runtime; `runner` owns the
  // native runtime, never the hub writer; `cutover` turns `both` into the two.
  const role=spec.role??'both';
  if(!ROLES.includes(role))throw failure('Plan role is invalid.');
  const native=role!=='hub',hubWriter=role!=='runner',cutover=role==='cutover';
  if(!allowedUnit.test(spec.unitId??'')||!allowedUnit.test(spec.controllerUnitId??''))throw failure('Plan unit names are invalid.');
  if(!isAbsolute(spec.releaseDirectory??'')||!isAbsolute(spec.receiptDirectory??''))throw failure('Plan release and receipt paths must be absolute.');
  if(native&&(!isAbsolute(spec.managerSocket??'')||!isAbsolute(spec.nativeBinaryPath??'')||!/^[a-f0-9]{64}$/.test(spec.nativeBinarySHA256??'')||!Array.isArray(spec.expectedModels)||!spec.expectedModels.length))throw failure('Plan manager socket, native binary or expected models are invalid.');
  if(!/^[a-f0-9]{40}$/.test(spec.old?.source??'')||!Number.isSafeInteger(spec.old?.pid)||!spec.old?.start||!spec.old?.invocationId)throw failure('Plan old process identity is incomplete.');
  if(!Array.isArray(spec.databases)||!Array.isArray(spec.files)||hubWriter&&(!isAbsolute(spec.localWriter?.path??'')||!spec.localWriter.expected))throw failure('Plan databases, files or local writer are incomplete.');
  if(!isAbsolute(hubWriter?spec.currentHubConfigPath??'':spec.currentAgentConfigPath??''))throw failure('Plan config path is invalid.');
  if(['both','cutover'].includes(role)?spec.controllerDirectory!==join(dirname(spec.localWriter.path),'deployments',spec.unitId):!isAbsolute(spec.controllerDirectory??'')||!spec.controllerDirectory.endsWith('/deployments/controller'))throw failure('Plan controller directory is invalid.');
  if(cutover&&(!allowedUnit.test(spec.split?.hubUnitId??'')||spec.split.hubUnitId===spec.unitId||!isAbsolute(spec.split.hubUnitPath??'')||!Number.isInteger(spec.split.runnerHealthPort)))throw failure('Plan split topology is incomplete.');
  if(role==='hub'&&!Array.isArray(spec.expectedNodes))throw failure('Plan expected nodes are invalid.');
  if(spec.site&&(!allowedUnit.test(spec.site.unitId??'')||!Number.isSafeInteger(spec.site.oldPid)||!spec.site.oldStart||!spec.site.oldInvocationId))throw failure('Plan site identity is incomplete.');
  const systemd=(...args)=>systemctl(...args);
  const probe=linuxProbe({systemctl});
  const props=text=>Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const unit=async(id=spec.unitId)=>props(await systemd('show',id,'--property=MainPID,InvocationID,ActiveState,SubState,ControlGroup,Job'));
  const processIdentity=async pid=>{try{const text=await readFile(`/proc/${pid}/stat`,'utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19];}catch(error){if(error.code==='ENOENT')return null;throw failure('Process identity is unreadable.');}};
  const health=async(port=spec.healthPort)=>{const r=await fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(5000)});const value=await r.json();return {http:r.status,...value};};
  const original=async()=>{
    const u=await unit();
    if(Number(u.MainPID)!==spec.old.pid||u.InvocationID!==spec.old.invocationId||await processIdentity(spec.old.pid)!==spec.old.start)
      throw failure(`Live ${spec.unitId} is MainPID ${u.MainPID} invocation ${u.InvocationID}, not the planned old process ${spec.old.pid}.`);
    return u;
  };
  const siteState=async()=>props(await systemd('show',spec.site.unitId,'--property=MainPID,InvocationID,ActiveState,Job'));
  const credential=async()=>{
    await original();const env=(await readFile(`/proc/${spec.old.pid}/environ`)).toString().split('\0');
    const value=env.find(v=>v.startsWith('BOTS_MACHINE_SECRET='))?.slice(20);
    if(!value||value.length<32||value.length>512)throw failure('The old process has no usable maintenance credential.');return value;
  };
  const maintenance=async(action,row)=>{
    const token=await credential(),p={...row.hold.native,action};
    return new Promise((yes,no)=>{
      const req=request({socketPath:spec.managerSocket,path:'/runtime/maintenance',method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}},res=>{
        let text='';res.on('data',chunk=>{text+=chunk;if(text.length>65536)req.destroy();});res.on('end',()=>{
          let v;try{v=JSON.parse(text);}catch{return no(failure(`Maintenance ${action} returned ${res.statusCode} without JSON.`));}
          if(res.statusCode!==200||!v.result)return no(failure(`Maintenance ${action} refused (${res.statusCode}): ${String(v.reason??v.error??'no reason').slice(0,200)}`));
          yes(v.result);
        });
      });req.setTimeout(25000,()=>req.destroy());req.on('error',error=>no(failure(`Maintenance ${action} request failed: ${error.code??'connection error'}.`)));req.end(JSON.stringify(p));
    });
  };
  const local=(action,row)=>{
    const db=new DatabaseSync(spec.localWriter.path);
    try{
      const drain=new LocalWriterDrain(db,spec.localWriter.expected,{retained:new RetainedRecords(spec.retainedRecordsPath)});
      try{return action==='begin'?drain.begin(spec.operationId,row.deadline):drain[action](spec.operationId);}
      catch{throw failure(`Local writer ${action} refused: the hub writer row differs from localWriter.expected or its drain changed.`);}
    }finally{db.close();}
  };
  const exactFile=async(path,expected,label=path)=>{
    if(!isAbsolute(path)||!/^[a-f0-9]{64}$/.test(expected))throw failure(`${label} has no exact hash.`);
    let s;try{s=await lstat(path);}catch{throw failure(`${label} is missing.`);}
    if(!s.isFile()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid())throw failure(`${label} is not a private regular file.`);
    if(hash(await readFile(path))!==expected)throw failure(`${label} content differs from its planned hash.`);
  };
  const nativeProofs=new Map();
  const nativeProof=async pid=>{
    if(spec.rehearsal)return {pid,rehearsal:true};
    const children=(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
    if(children.length>100)throw failure('Too many child processes to prove the native runtime.');
    const matches=[];
    for(const child of children){let executable;try{executable=await readlink(`/proc/${child}/exe`);}catch{continue;}
      if(executable!==spec.nativeBinaryPath)continue;
      const start=await processIdentity(child),key=`${child}:${start}`;
      if(!start)throw failure('Native child identity changed.');
      if(!nativeProofs.has(key)){if(hash(await readFile(`/proc/${child}/exe`))!==spec.nativeBinarySHA256)throw failure('Native child binary differs from nativeBinarySHA256.');nativeProofs.set(key,{pid:child,start,binarySHA256:spec.nativeBinarySHA256});}
      matches.push(nativeProofs.get(key));
    }
    if(matches.length!==1)throw failure(`Expected one native runtime child, found ${matches.length}.`);return matches[0];
  };
  const target=async()=>{
    const manifestPath=join(spec.releaseDirectory,'release-manifest.json');let m;
    try{m=JSON.parse(await readFile(manifestPath,'utf8'));}catch{throw failure('Target release manifest is unreadable.');}
    if(m.source!==spec.source||m.runtime!==spec.runtime||m.nodeMajor!==24||hash(await readFile(manifestPath))!==spec.manifestSHA256)throw failure('Target release manifest differs from manifestSHA256/source/runtime.');
    for(const entry of m.files){
      const path=resolve(spec.releaseDirectory,entry.path);if(relative(spec.releaseDirectory,path).startsWith('..')||!entry.path)throw failure('Target manifest escapes its release directory.');
      if(entry.sha256)await exactFile(path,entry.sha256,`Release file ${entry.path}`);
      else if(entry.link){if(await readlink(path)!==entry.link||relative(spec.releaseDirectory,resolve(path,'..',entry.link)).startsWith('..'))throw failure(`Release link ${entry.path} differs.`);}
      else throw failure(`Release entry ${entry.path} has no hash.`);
    }
  };
  const sameModels=h=>JSON.stringify([...(h?.models??[])].sort())===JSON.stringify([...spec.expectedModels].sort());
  const runnerHealthy=h=>Boolean(h?.http===200&&h.ready&&h.role==='runner'&&h.relayConnected&&h.source===spec.source&&h.codexVersion===spec.runtime&&sameModels(h));
  const hubHealthy=h=>Boolean(h?.http===200&&h.ready&&h.role==='hub'&&h.siteReady&&h.source===spec.source&&(spec.expectedNodes??[]).every(n=>(h.nodes??[]).includes(n)));
  const inTarget=async pid=>{try{return await readlink(`/proc/${pid}/cwd`)===resolve(spec.releaseDirectory);}catch{return false;/* Incomplete process observation remains pending. */}};
  // `starting` covers the new invocation's activation and first seconds: a
  // writer that does not look like the target yet is pending, not foreign.
  const reconcile=async(_,__,{graceUntil=0}={})=>{
    const u=await unit(),pid=Number(u.MainPID),oldAlive=await processIdentity(spec.old.pid)===spec.old.start;
    const targetProcess=pid>0&&!oldAlive&&await inTarget(pid);
    let h;try{h=await health();}catch{/* Public front stays alive while execution is absent. */}
    // The cutover's runner reports on its own port; the hub keeps the old one.
    let r=null,hubUnit=null,hubTarget=false;
    if(cutover){try{r=await health(spec.split.runnerHealthPort);}catch{/* Runner not up yet. */}
      hubUnit=await unit(spec.split.hubUnitId);hubTarget=Number(hubUnit.MainPID)>0&&await inTarget(Number(hubUnit.MainPID));}
    const starting=['activating','reloading'].includes(u.ActiveState)||Boolean(u.Job)||Boolean(hubUnit?.Job)||hubUnit?.ActiveState==='activating'||Date.now()<graceUntil;
    const fresh=!oldAlive&&pid>0&&targetProcess&&u.ActiveState==='active'&&u.InvocationID!==spec.old.invocationId;
    const newHealthy=Boolean(fresh&&(
      role==='both'?h?.http===200&&h.ready&&h.relayConnected&&h.siteReady&&h.source===spec.source&&h.codexVersion===spec.runtime&&sameModels(h):
      role==='hub'?hubHealthy(h):
      role==='runner'?runnerHealthy(h):
      runnerHealthy(r)&&hubHealthy(h)&&hubTarget&&hubUnit.ActiveState==='active'));
    const native=newHealthy&&role!=='hub'?await nativeProof(pid):null;
    const sources=[h?.source,r?.source].filter(Boolean);
    const foreign=pid>0&&!oldAlive&&(!targetProcess||sources.some(source=>source!==spec.source));
    const runnerView=cutover?r:role==='runner'?h:null;
    return {newHealthy,oldExited:!oldAlive,starting,foreignWriter:foreign&&!starting,pendingWriter:foreign&&starting,activeState:u.ActiveState,
      proof:{pid,invocationId:u.InvocationID,native,source:h?.source??null,ready:h?.ready??false,relayConnected:(runnerView??h)?.relayConnected??false,siteReady:h?.siteReady??false,
        codexVersion:(runnerView??h)?.codexVersion??null,models:(runnerView??h)?.models??[],
        ...(role==='hub'?{nodes:h?.nodes??[]}:{}),
        ...(cutover?{runner:{source:r?.source??null,ready:r?.ready??false,role:r?.role??null},hub:{pid:Number(hubUnit.MainPID),activeState:hubUnit.ActiveState,inTarget:hubTarget,role:h?.role??null}}:{})}};
  };
  const describe=r=>r.foreignWriter?`a foreign writer holds ${spec.unitId} (pid ${r.proof.pid}, source ${r.proof.source??'unknown'})`:
    `target not healthy: state ${r.activeState}, source ${r.proof.source??'none'}, ready ${r.proof.ready}, relay ${r.proof.relayConnected}, site ${r.proof.siteReady}, runtime ${r.proof.codexVersion??'none'}`+
    (r.proof.runner?`, runner ${r.proof.runner.source??'none'}/${r.proof.runner.ready}, hub unit ${r.proof.hub.activeState}`:'')+
    (role==='hub'?`, nodes ${r.proof.nodes.length}/${spec.expectedNodes.length}`:'');
  const wait=async(until,test)=>{while(Date.now()<until){const result=await test();if(result)return result;await pause(poll);}return null;};
  const restoreFiles=async()=>{
    for(const [i,f] of spec.files.entries()){
      const current=existsSync(f.path)?hash(await readFile(f.path)):null;if(current===f.beforeSHA256)continue;
      // A file this operation created (the cutover's hub unit) is removed.
      if(f.beforeSHA256===null){if(current!==f.afterSHA256)throw failure(`${f.path} differs from what this operation created.`);await rm(f.path);continue;}
      const saved=join(spec.receiptDirectory,'backup',`configuration-${i}`);
      if(!existsSync(saved)||hash(readPrivate(saved))!==f.beforeSHA256)throw failure(`Backup of ${f.path} is missing or differs from beforeSHA256.`);
      savePrivate(f.path,readPrivate(saved));
    }
  };
  // Return the hub writer to the old source, open. Covers both a flipped
  // source (target started) and a still-frozen old source (prepare failed).
  const rollbackWriter=()=>{
    const db=new DatabaseSync(spec.localWriter.path);
    try{
      db.exec('BEGIN IMMEDIATE');const r=db.prepare('SELECT * FROM portable_async_admission WHERE id=1').get();
      if(r.writer_id!==spec.localWriter.expected.writerId||r.epoch!==spec.localWriter.expected.epoch)throw failure(`Hub writer row is ${r.writer_id}/${r.epoch}, not localWriter.expected.`);
      if(![spec.source,spec.old.source].includes(r.source))throw failure(`Hub writer source is ${r.source}, neither the target nor the old source.`);
      if(r.source===spec.source||r.phase==='frozen'&&r.operation_id===spec.operationId){
        db.prepare("UPDATE portable_async_admission SET source=?,phase='open',operation_id=NULL,deadline=0 WHERE id=1").run(spec.old.source);
        db.prepare('UPDATE portable_authority SET frozen=0 WHERE id=1').run();
        db.prepare("UPDATE portable_async_drains SET state='released' WHERE id=?").run(spec.operationId);
      }
      db.exec('COMMIT');
    }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
  };
  const restartSite=async(name,until,{requireOld=true}={})=>{
    if(!spec.site)return;
    const intent=join(spec.receiptDirectory,`${name}-intent.json`);let before=null;
    if(!existsSync(intent)){
      before=await siteState();
      if(requireOld&&(Number(before.MainPID)!==spec.site.oldPid||before.InvocationID!==spec.site.oldInvocationId||await processIdentity(spec.site.oldPid)!==spec.site.oldStart))throw failure(`${spec.site.unitId} is no longer the planned site process.`);
      savePrivate(intent,JSON.stringify({operationId:spec.operationId,unitId:spec.site.unitId,oldPid:Number(before.MainPID),oldInvocationId:before.InvocationID,at:new Date().toISOString()})+'\n');
      await systemd('restart','--no-block',spec.site.unitId);
    }
    const recorded=JSON.parse(readPrivate(intent));
    const s=await wait(until,async()=>{const s=await siteState();return s.ActiveState==='active'&&!s.Job&&Number(s.MainPID)>0&&s.InvocationID!==recorded.oldInvocationId?s:null;});
    if(!s)throw failure(`${spec.site.unitId} did not become active after restart.`);
    savePrivate(join(spec.receiptDirectory,`${name}-result.json`),JSON.stringify({operationId:spec.operationId,source:spec.source,...await siteState(),frontendFilesUnchanged:true,at:new Date().toISOString()})+'\n');
  };
  const exactBefore=async(f,label)=>{if(f.beforeSHA256!==null)return exactFile(f.path,f.beforeSHA256,label);if(existsSync(f.path))throw failure(`${label} already exists; this operation only creates it.`);};
  // Hub voice/provider work has its own drain: a hub stop waits for it.
  const voiceIdle=async()=>{const h=await health();if(h.voice?.idle===false)return {idle:false,reason:'Hub voice work is active.'};return {idle:true};};
  const nativeObserve=row=>spec.compatibilityBootstrap?maintenance('status',row).then(s=>bootstrapIdle(spec,s)):maintenance('observe',row);
  const startUnit=async id=>{const u=await unit(id);if(Number(u.MainPID)>0||u.Job)throw failure(`${id} already has MainPID ${u.MainPID} or job ${u.Job}.`);if(u.ActiveState==='failed')await systemd('reset-failed',id);await systemd('start','--no-block',id);};
  const stopAndWait=async(id,until)=>{
    let u=await unit(id);if(!(Number(u.MainPID)>0)&&!u.Job)return;
    if(!u.Job||u.ActiveState!=='deactivating')await systemd('stop','--no-block',id);
    let gone=await wait(Math.min(until,Date.now()+(spec.timeoutStopSec??120)*1000+30000),async()=>{const s=await unit(id);return Number(s.MainPID)>0||s.Job?null:s;});
    if(!gone){await systemd('kill','--signal=SIGKILL',id);gone=await wait(Date.now()+30000,async()=>{const s=await unit(id);return Number(s.MainPID)>0||s.Job?null:s;});}
    if(!gone)throw failure(`${id} did not exit for rollback.`);
  };
  return {
    async preflight(){
      if(spec.compatibilityBootstrap)bootstrapAuthority(spec);
      // Every plan field is re-derived from live state; any drift (a stale
      // hub writer source, a changed config, models) refuses before a hold.
      await verifyPlan(spec,probe);
      await target();await original();
      // Service access and network are checked BEFORE a hold or cutover.
      await systemd('show-environment');if(native)await credential();
      if(spec.site){const s=await siteState();if(Number(s.MainPID)!==spec.site.oldPid||s.InvocationID!==spec.site.oldInvocationId||await processIdentity(spec.site.oldPid)!==spec.site.oldStart)throw failure(`${spec.site.unitId} is no longer the planned site process.`);}
      for(const [i,f] of spec.files.entries()){await exactBefore(f,`files[${i}].path`);await exactFile(f.preparedPath,f.afterSHA256,`files[${i}].preparedPath`);}
      if(!Number.isInteger(spec.healthPort)||spec.healthPort<1024||spec.healthPort>65535)throw failure('Plan health port is invalid.');
    },reconcile,
    async prepareHold(){
      if(!native)return {hub:{operationId:spec.operationId,unitId:spec.controllerUnitId}};
      const h=await health();
      const hold={operationId:spec.operationId,commit:spec.old.source,version:spec.runtime,instanceId:h.maintenance.instanceId,
        invocationId:spec.old.invocationId,unitId:spec.controllerUnitId,waitSeconds:spec.waitSeconds};
      return {native:hold,...(spec.compatibilityBootstrap?{nativeProcess:await nativeProof(spec.old.pid)}:{})};
    },
    async begin(_,row){
      // A hub release holds only the hub writer: the runner keeps executing
      // and its hub requests wait (or end uncertain) across the restart.
      if(!native){local('begin',row);return row.hold;}
      const held=await maintenance('begin',row);if(!held.active||held.phase!=='draining'||Date.parse(held.expiresAt)>row.deadline+5000)throw failure(`Maintenance begin returned phase ${held.phase}, active ${held.active}.`);
      // Native admission owns the wait. Keep the website writer open while
      // current turns/tools finish: login, session renewal and original
      // completion acknowledgments must not inherit a minutes-long DB hold.
      return {...row.hold,native:row.hold.native};
    },
    async observe(_,row){
      if(!native){
        const h=local('observe',row),v=await voiceIdle();
        return {safe:h.status==='ready'&&v.idle,hub:h,reason:h.status!=='ready'?`Hub writer drain is ${h.status}. Busy: active=${h.active}, unknown=${h.unknown}.`:v.idle?null:v.reason};
      }
      const n=await nativeObserve(row);
      // Name the non-zero drain counters so an expiry explains itself.
      const busy=Object.entries(n.counts??{}).filter(([,v])=>v).map(([k,v])=>`${k}=${v}`).join(', ');
      const nativeReason=`${n.reason??'Native work is not idle.'}${busy?` Busy: ${busy}.`:''}`;
      // A runner release never touches the hub writer.
      if(!hubWriter)return {safe:n.safe===true,native:n,reason:n.safe===true?null:nativeReason};
      const db=new DatabaseSync(spec.localWriter.path,{readOnly:true});let held;
      try{held=db.prepare('SELECT * FROM portable_async_drains WHERE id=?').get(spec.operationId);}finally{db.close();}
      if(!held&&n.safe!==true)return {safe:false,native:n,hub:{phase:'open',status:'waiting-for-native-idle',holdingWrites:false},reason:nativeReason};
      if(!held)local('begin',row);
      const h=local('observe',row);return {safe:n.safe===true&&h.status==='ready',native:n,hub:h,reason:n.safe!==true?nativeReason:h.status!=='ready'?`Hub writer drain is ${h.status}.`:null};
    },
    async freezeBackup(_,row){
      if(!native){
        const v=await voiceIdle();if(!v.idle)throw failure(`Final idle observation failed: ${v.reason}`);
        local('freeze',row);return {hubWriterFrozen:true,retainedContract:new RetainedRecords(spec.retainedRecordsPath).fingerprint};
      }
      const final=await nativeObserve(row);if(!final.safe)throw failure(`Final idle observation failed: ${final.reason??'work resumed'}.`);
      if(hubWriter)local('freeze',row);
      if(!spec.compatibilityBootstrap){await maintenance('seal',row);await maintenance('claim',row);}
      return {installedSealClaim:!spec.compatibilityBootstrap,compatibilityBootstrap:spec.compatibilityBootstrap?final:null,...(hubWriter?{retainedContract:new RetainedRecords(spec.retainedRecordsPath).fingerprint}:{})};
    },
    async backup(){
      const directory=join(spec.receiptDirectory,'backup');await mkdir(directory,{recursive:true,mode:0o700});const results=[];
      for(const [i,path] of spec.databases.entries()){
        if(!isAbsolute(path))throw failure(`databases[${i}] is not absolute.`);const db=new DatabaseSync(path,{readOnly:true}),destination=join(directory,`database-${i}.sqlite`);
        try{await backup(db,destination);}finally{db.close();}await chmod(destination,0o600);
        const check=new DatabaseSync(destination,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw failure(`Backup of databases[${i}] failed integrity_check.`);}finally{check.close();}
        results.push({path,destination,sha256:hash(await readFile(destination)),mode:'0600'});
      }
      for(const [i,f] of spec.files.entries()){await exactBefore(f,`files[${i}].path`);if(f.beforeSHA256!==null)savePrivate(join(directory,`configuration-${i}`),(await readFile(f.path)).toString());}
      return {verified:true,databases:results,configurationFiles:spec.files.filter(f=>f.beforeSHA256!==null).length,restoreDatabasesOnRollback:false};
    },
    async seal(_,row){
      await target();for(const [i,file] of spec.files.entries())await exactBefore(file,`files[${i}].path`);
      if(!native){
        const h=local('observe',row),v=await voiceIdle();
        if(h.status!=='frozen'||h.active||h.unknown||!v.idle)throw failure(`Sealed idle observation failed: hub writer ${h.status}${v.idle?'':`, ${v.reason}`}.`);
        return {safe:true,hub:h,retainedContract:new RetainedRecords(spec.retainedRecordsPath).fingerprint};
      }
      const final=await nativeObserve(row);if(!final.safe)throw failure(`Sealed idle observation failed: ${final.reason??'work resumed'}.`);
      if(!spec.compatibilityBootstrap&&final.phase!=='claimed')throw failure(`Maintenance phase is ${final.phase}, not claimed.`);return {safe:true,installedSealClaim:!spec.compatibilityBootstrap,native:final,...(hubWriter?{retainedContract:new RetainedRecords(spec.retainedRecordsPath).fingerprint}:{})};
    },
    async stop(){await original();await systemd('stop','--no-block',spec.unitId);},
    async waitOldExit(_,row,{until}){
      if(spec.compatibilityBootstrap&&await processIdentity(spec.old.pid)===spec.old.start)
        await closeBootstrap(spec,row,{original,status:()=>maintenance('status',row),idle:s=>bootstrapIdle(spec,s)});
      return await wait(until,async()=>{
        if(await processIdentity(spec.old.pid)===spec.old.start)return null;
        const u=await unit();
        // Something else started the unit after the old exit (a dependency or
        // a manual start) before the controller's own start.
        if(Number(u.MainPID)>0&&u.InvocationID!==spec.old.invocationId&&['active','activating'].includes(u.ActiveState))
          return {oldExited:true,pid:spec.old.pid,start:spec.old.start,unplannedStart:{pid:Number(u.MainPID),invocationId:u.InvocationID,activeState:u.ActiveState}};
        if(Number(u.MainPID)>0||u.Job)return null;
        if(spec.old.controlGroup){try{if((await readFile(join('/sys/fs/cgroup',spec.old.controlGroup,'cgroup.procs'),'utf8')).trim())return null;}catch(e){if(e.code!=='ENOENT')throw e;}}
        return {oldExited:true,pid:spec.old.pid,start:spec.old.start};
      })??{oldExited:false,reason:`Process ${spec.old.pid} had not exited.`};
    },
    // The stop request may never have been issued (ambiguous failure); issue
    // it if no stop job exists, otherwise SIGKILL the proven-idle old process.
    async escalateStop(){
      if(await processIdentity(spec.old.pid)!==spec.old.start)return;
      const u=await unit();
      if(u.ActiveState==='active'&&!u.Job)await systemd('stop','--no-block',spec.unitId);
      else await systemd('kill','--signal=SIGKILL',spec.unitId);
    },
    async prepareStart(_,row,{until}){
      if(await processIdentity(spec.old.pid)===spec.old.start)throw failure('The old process is still alive.');await target();
      for(const [i,f] of spec.files.entries()){
        const current=existsSync(f.path)?hash(await readFile(f.path)):null;if(current===f.afterSHA256)continue;
        if(current!==f.beforeSHA256)throw failure(`files[${i}].path changed after the plan was prepared.`);await exactFile(f.preparedPath,f.afterSHA256,`files[${i}].preparedPath`);savePrivate(f.path,(await readFile(f.preparedPath)).toString());
      }
      if(hubWriter){
        const db=new DatabaseSync(spec.localWriter.path);
        try{
          db.exec('BEGIN IMMEDIATE');const r=db.prepare('SELECT * FROM portable_async_admission WHERE id=1').get();
          if(r.writer_id!==spec.localWriter.expected.writerId||r.epoch!==spec.localWriter.expected.epoch)throw failure(`Hub writer row is ${r.writer_id}/${r.epoch}, not localWriter.expected.`);
          if(r.source!==spec.source){
            if(r.source!==spec.old.source||r.phase!=='frozen'||r.operation_id!==spec.operationId)throw failure(`Hub writer row is source ${r.source} phase ${r.phase}; expected the frozen old source of this operation.`);
            db.prepare("UPDATE portable_async_admission SET source=?,phase='open',operation_id=NULL,deadline=0 WHERE id=1").run(spec.source);
            db.prepare('UPDATE portable_authority SET frozen=0 WHERE id=1').run();
            db.prepare("UPDATE portable_async_drains SET state='released' WHERE id=?").run(spec.operationId);
          }
          db.exec('COMMIT');
        }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
      }
      await systemd('daemon-reload');
      // The installed hub must come back after a reboot like the runner.
      if(cutover&&!spec.rehearsal)await systemd('enable',spec.split.hubUnitId);
      // The standalone site's in-memory application writer must consume the
      // new source-bound authority, while the public front/connector stay up.
      // Preserve its reviewed frontend directory/assets; refresh config once.
      // A runner release leaves the site and its writer alone.
      if(hubWriter)await restartSite('site-restart',until);
    },
    async start(){
      if(!cutover)return startUnit(spec.unitId);
      // Cutover: the hub first, so the runner connects to the new hub.
      await startUnit(spec.split.hubUnitId);
      const until=Date.now()+(spec.convergence?.healthWindowSeconds??300)*1000;
      const up=await wait(until,async()=>{let h;try{h=await health();}catch{return null;}return h.http===200&&h.ready&&h.role==='hub'&&h.source===spec.source?h:null;});
      if(!up)throw failure(`${spec.split.hubUnitId} did not report hub health for ${spec.source} before the runner start.`);
      await startUnit(spec.unitId);
    },
    async waitHealthy(_,row,{until,graceUntil}){
      let last;
      const result=await wait(until,async()=>{last=await reconcile(spec,row,{graceUntil});return last.newHealthy||last.foreignWriter?last:null;});
      if(result?.newHealthy)return result;
      return {newHealthy:false,reason:`Not healthy within the bounded window: ${last?describe(last):'no observation'}.`,proof:last?.proof};
    },
    async finalize(){const r=await reconcile();if(!r.newHealthy)throw failure(`Target stopped being healthy before finalize: ${describe(r)}.`);},
    // Forward-only fallback: stop whatever the target start produced, restore
    // the before-configs from this operation's backup, return the hub writer
    // to the old source and start the previous release.
    async rollback(_,row,{until}){
      const u=await unit();
      if(Number(u.MainPID)>0&&await processIdentity(spec.old.pid)!==spec.old.start)await stopAndWait(spec.unitId,until);
      // The cutover's hub holds the combined ports; it goes before the
      // combined release starts again.
      if(cutover){await stopAndWait(spec.split.hubUnitId,until);if(!spec.rehearsal&&existsSync(spec.split.hubUnitPath))await systemd('disable',spec.split.hubUnitId);}
      await restoreFiles();
      if(cutover)try{await rmdir(dirname(spec.split.hubDropInPath));}catch{/* Not empty or already gone: left for inspection. */}
      if(hubWriter)rollbackWriter();
      await systemd('daemon-reload');
      if(existsSync(join(spec.receiptDirectory,'site-restart-intent.json')))await restartSite('site-rollback-restart',until,{requireOld:false});
      const s=await unit();
      if(!(Number(s.MainPID)>0)&&!s.Job){if(s.ActiveState==='failed')await systemd('reset-failed',spec.unitId);await systemd('start','--no-block',spec.unitId);}
    },
    async waitPreviousHealthy(_,row,{until}){
      let last;
      const ok=await wait(until,async()=>{let h;try{h=await health();}catch{return null;}last=h;return h.http===200&&h.ready&&h.source===spec.old.source?h:null;});
      return {healthy:Boolean(ok),proof:last?{source:last.source??null,ready:Boolean(last.ready),relayConnected:Boolean(last.relayConnected),siteReady:Boolean(last.siteReady)}:null};
    },
    // Whatever happened, the unit is left running (or queued to start).
    // The unplanned process runs the previous release with the before-configs
    // (prepareStart has not run). Reopen the writer this operation froze so it
    // can serve; never stop it: it may already have admitted new work.
    async yieldToUnplannedStart(){
      for(const [i,f] of spec.files.entries()){const current=existsSync(f.path)?hash(await readFile(f.path)):null;if(current!==f.beforeSHA256)throw failure(`files[${i}].path is not the before-config; the unplanned process needs inspection.`);}
      if(hubWriter)rollbackWriter();
    },
    async ensureRunning(){
      // A cutover that already installed the hub keeps both halves running.
      const ids=cutover&&existsSync(spec.split.hubUnitPath)?[spec.split.hubUnitId,spec.unitId]:[spec.unitId];
      for(const id of ids){
        const u=await unit(id);
        if(Number(u.MainPID)>0||u.Job||u.ActiveState==='active')continue;
        if(u.ActiveState==='failed')await systemd('reset-failed',id);
        await systemd('start','--no-block',id);
      }
    },
    async release(_,row){
      if(!row.hold)return;
      // A prior failed begin might not have acquired the local hold. Do not
      // manufacture one merely to release it.
      if(hubWriter){
        const db=new DatabaseSync(spec.localWriter.path);let held;
        try{held=db.prepare('SELECT * FROM portable_async_drains WHERE id=?').get(spec.operationId);}finally{db.close();}
        if(held)local('release',row);
      }
      if(!row.hold.native)return;
      const status=await maintenance('status',row);
      const r=status.phase==='claimed'?await maintenance('release-before-stop',row):await maintenance('cancel',row);if(r.active)throw failure('Maintenance hold is still active after release.');
    },
  };
}
