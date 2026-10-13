import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, readlink, chmod, mkdir, lstat } from 'node:fs/promises';
import {existsSync} from 'node:fs';
import { join, isAbsolute, resolve, relative,dirname } from 'node:path';
import { request } from 'node:http';
import { DatabaseSync, backup } from 'node:sqlite';
import { readPrivate,savePrivate } from './private-file.mjs';
import { LocalWriterDrain } from './local-work-admission.mjs';
import { RetainedRecords } from './retained-records.mjs';
import {bootstrapAuthority,bootstrapIdle} from './bootstrap-idle.mjs';
import {closeBootstrap} from './bootstrap-close.mjs';

const exec=promisify(execFile),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=()=>Error('Deployment prerequisite differs. Inspect the private original transaction; no lifecycle effect was repeated.');
const allowedUnit=/^[A-Za-z0-9_-]{8,100}\.service$/;
export function linuxDeployment(spec) {
  if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])!==24||!allowedUnit.test(spec.unitId??'')||!allowedUnit.test(spec.controllerUnitId??'')||
     !isAbsolute(spec.releaseDirectory??'')||!isAbsolute(spec.receiptDirectory??'')||!isAbsolute(spec.managerSocket??'')||
     !isAbsolute(spec.nativeBinaryPath??'')||!/^[a-f0-9]{64}$/.test(spec.nativeBinarySHA256??'')||!Array.isArray(spec.expectedModels)||!spec.expectedModels.length||
     !/^[a-f0-9]{40}$/.test(spec.old?.source??'')||!Number.isSafeInteger(spec.old?.pid)||!spec.old?.start||!spec.old?.invocationId||
     !Array.isArray(spec.databases)||!Array.isArray(spec.files)||!isAbsolute(spec.localWriter?.path??'')||!spec.localWriter.expected||
     spec.controllerDirectory!==join(dirname(spec.localWriter.path),'deployments',spec.unitId)||!isAbsolute(spec.currentHubConfigPath??''))throw failure();
  if(spec.site&&(!allowedUnit.test(spec.site.unitId??'')||!Number.isSafeInteger(spec.site.oldPid)||!spec.site.oldStart||!spec.site.oldInvocationId))throw failure();
  const systemd=async(...args)=>(await exec('systemctl',['--user',...args],{timeout:10000,maxBuffer:65536})).stdout;
  const unit=async()=>Object.fromEntries((await systemd('show',spec.unitId,'--property=MainPID,InvocationID,ActiveState,SubState,ControlGroup,Job')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const processIdentity=async pid=>{try{const text=await readFile(`/proc/${pid}/stat`,'utf8');return text.slice(text.lastIndexOf(')')+2).split(' ')[19];}catch(error){if(error.code==='ENOENT')return null;throw failure();}};
  const health=async()=>{const r=await fetch(`http://127.0.0.1:${spec.healthPort}/healthz`,{signal:AbortSignal.timeout(5000)});const value=await r.json();return {http:r.status,...value};};
  const original=async()=>{
    const u=await unit();if(Number(u.MainPID)!==spec.old.pid||u.InvocationID!==spec.old.invocationId||await processIdentity(spec.old.pid)!==spec.old.start)throw failure();return u;
  };
  const siteState=async()=>Object.fromEntries((await systemd('show',spec.site.unitId,'--property=MainPID,InvocationID,ActiveState,Job')).trim().split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}));
  const credential=async()=>{
    await original();const env=(await readFile(`/proc/${spec.old.pid}/environ`)).toString().split('\0');
    const value=env.find(v=>v.startsWith('BOTS_MACHINE_SECRET='))?.slice(20);
    if(!value||value.length<32||value.length>512)throw failure();return value;
  };
  const maintenance=async(action,row)=>{
    const token=await credential(),p={...row.hold.native,action};
    return new Promise((yes,no)=>{
      const req=request({socketPath:spec.managerSocket,path:'/runtime/maintenance',method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}},res=>{
        let text='';res.on('data',chunk=>{text+=chunk;if(text.length>65536)req.destroy();});res.on('end',()=>{try{const v=JSON.parse(text);if(res.statusCode!==200||!v.result)throw failure();yes(v.result);}catch{no(failure());}});
      });req.setTimeout(25000,()=>req.destroy());req.on('error',()=>no(failure()));req.end(JSON.stringify(p));
    });
  };
  const local=(action,row)=>{
    const db=new DatabaseSync(spec.localWriter.path);
    try{
      const drain=new LocalWriterDrain(db,spec.localWriter.expected,{retained:new RetainedRecords(spec.retainedRecordsPath)});
      return action==='begin'?drain.begin(spec.operationId,row.deadline):drain[action](spec.operationId);
    }finally{db.close();}
  };
  const exactFile=async(path,expected)=>{
    if(!isAbsolute(path)||!/^[a-f0-9]{64}$/.test(expected))throw failure();
    const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||process.getuid&&s.uid!==process.getuid()||hash(await readFile(path))!==expected)throw failure();
  };
  const nativeProofs=new Map();
  const nativeProof=async pid=>{
    const children=(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
    if(children.length>100)throw failure();
    const matches=[];
    for(const child of children){let executable;try{executable=await readlink(`/proc/${child}/exe`);}catch{continue;}
      if(executable!==spec.nativeBinaryPath)continue;
      const start=await processIdentity(child),key=`${child}:${start}`;
      if(!start)throw failure();
      if(!nativeProofs.has(key)){if(hash(await readFile(`/proc/${child}/exe`))!==spec.nativeBinarySHA256)throw failure();nativeProofs.set(key,{pid:child,start,binarySHA256:spec.nativeBinarySHA256});}
      matches.push(nativeProofs.get(key));
    }
    if(matches.length!==1)throw failure();return matches[0];
  };
  const target=async()=>{
    const m=JSON.parse(await readFile(join(spec.releaseDirectory,'release-manifest.json'),'utf8'));
    if(m.source!==spec.source||m.runtime!==spec.runtime||m.nodeMajor!==24||hash(await readFile(join(spec.releaseDirectory,'release-manifest.json')))!==spec.manifestSHA256)throw failure();
    for(const entry of m.files){
      const path=resolve(spec.releaseDirectory,entry.path);if(relative(spec.releaseDirectory,path).startsWith('..')||!entry.path)throw failure();
      if(entry.sha256)await exactFile(path,entry.sha256);
      else if(entry.link){const {readlink}=await import('node:fs/promises');if(await readlink(path)!==entry.link||relative(spec.releaseDirectory,resolve(path,'..',entry.link)).startsWith('..'))throw failure();}
      else throw failure();
    }
  };
  const reconcile=async()=>{
    const u=await unit(),pid=Number(u.MainPID),oldAlive=await processIdentity(spec.old.pid)===spec.old.start;
    let targetProcess=false;
    if(pid>0&&!oldAlive){try{targetProcess=await readlink(`/proc/${pid}/cwd`)===resolve(spec.releaseDirectory);}catch{/* Incomplete process observation remains pending. */}}
    let h;try{h=await health();}catch{/* Public front stays alive while execution is absent. */}
    const newHealthy=Boolean(!oldAlive&&pid>0&&targetProcess&&u.ActiveState==='active'&&u.InvocationID!==spec.old.invocationId&&h?.http===200&&h.ready&&h.relayConnected&&h.siteReady&&h.source===spec.source&&h.codexVersion===spec.runtime&&
      JSON.stringify([...(h.models??[])].sort())===JSON.stringify([...spec.expectedModels].sort()));
    const native=newHealthy?await nativeProof(pid):null;
    return {newHealthy,oldExited:!oldAlive,foreignWriter:pid>0&&!oldAlive&&(!targetProcess||Boolean(h?.source&&h.source!==spec.source)),
      proof:{pid,invocationId:u.InvocationID,native,source:h?.source??null,ready:h?.ready??false,relayConnected:h?.relayConnected??false,siteReady:h?.siteReady??false,codexVersion:h?.codexVersion??null,models:h?.models??[]}};
  };
  const wait=async(row,test)=>{while(Date.now()<row.deadline){const result=await test();if(result)return result;await new Promise(r=>setTimeout(r,1000));}throw failure();};
  return {
    async preflight(){
      if(spec.compatibilityBootstrap)bootstrapAuthority(spec);
      await target();await original();const h=await health();
      if(h.http!==200||h.source!==spec.old.source||!h.ready||h.maintenance?.phase!=='open')throw failure();
      const env=(await readFile(`/proc/${spec.old.pid}/environ`)).toString().split('\0');
      const environmentConfig=env.find(v=>v.startsWith('DAWAR_HUB_CONFIG='))?.slice(17);
      const command=(await readFile(`/proc/${spec.old.pid}/cmdline`)).toString().split('\0').filter(Boolean);
      const configIndex=command.indexOf('--config'),commandConfig=configIndex>=0?command[configIndex+1]:undefined;
      if((environmentConfig&&environmentConfig!==spec.currentHubConfigPath)||
        (commandConfig&&commandConfig!==spec.currentHubConfigPath)||
        ![environmentConfig,commandConfig].includes(spec.currentHubConfigPath))throw failure();
      const c=JSON.parse(readPrivate(spec.currentHubConfigPath)),a=JSON.parse(readPrivate(c.agentConfigFile));
      if(c.hub.source!==spec.old.source||join(c.dataDirectory,'control.sqlite')!==spec.localWriter.path||join(a.dataDirectory,'manager','manager.sock')!==spec.managerSocket)throw failure();
      // Service access and network are checked BEFORE a hold or cutover.
      await systemd('show-environment');await credential();
      if(spec.site){const s=await siteState();if(Number(s.MainPID)!==spec.site.oldPid||s.InvocationID!==spec.site.oldInvocationId||await processIdentity(spec.site.oldPid)!==spec.site.oldStart)throw failure();}
      for(const f of spec.files){await exactFile(f.path,f.beforeSHA256);await exactFile(f.preparedPath,f.afterSHA256);}
      if(!Number.isInteger(spec.healthPort)||spec.healthPort<1024||spec.healthPort>65535)throw failure();
    },reconcile,
    async prepareHold(){
      const h=await health();
      const native={operationId:spec.operationId,commit:spec.old.source,version:spec.runtime,instanceId:h.maintenance.instanceId,
        invocationId:spec.old.invocationId,unitId:spec.controllerUnitId,waitSeconds:spec.waitSeconds};
      return {native,...(spec.compatibilityBootstrap?{nativeProcess:await nativeProof(spec.old.pid)}:{})};
    },
    async begin(_,row){
      const held=await maintenance('begin',row);if(!held.active||held.phase!=='draining'||Date.parse(held.expiresAt)>row.deadline+5000)throw failure();
      const hub=local('begin',row);return {...row.hold,native:row.hold.native,hub};
    },
    async observe(_,row){const n=spec.compatibilityBootstrap?await bootstrapIdle(spec,await maintenance('status',row)):await maintenance('observe',row),h=local('observe',row);return {safe:n.safe===true&&h.status==='ready',native:n,hub:h};},
    async freezeBackup(_,row){
      const final=spec.compatibilityBootstrap?await bootstrapIdle(spec,await maintenance('status',row)):await maintenance('observe',row);if(!final.safe)throw failure();
      local('freeze',row);
      if(!spec.compatibilityBootstrap){await maintenance('seal',row);await maintenance('claim',row);}
      return {installedSealClaim:!spec.compatibilityBootstrap,compatibilityBootstrap:spec.compatibilityBootstrap?final:null,retainedContract:new RetainedRecords(spec.retainedRecordsPath).fingerprint};
    },
    async backup(){
      const directory=join(spec.receiptDirectory,'backup');await mkdir(directory,{recursive:true,mode:0o700});const results=[];
      for(const [i,path] of spec.databases.entries()){
        if(!isAbsolute(path))throw failure();const db=new DatabaseSync(path,{readOnly:true}),destination=join(directory,`database-${i}.sqlite`);
        try{await backup(db,destination);}finally{db.close();}await chmod(destination,0o600);
        const check=new DatabaseSync(destination,{readOnly:true});try{if(check.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw failure();}finally{check.close();}
        results.push({path,destination,sha256:hash(await readFile(destination)),mode:'0600'});
      }
      for(const [i,f] of spec.files.entries()){await exactFile(f.path,f.beforeSHA256);savePrivate(join(directory,`configuration-${i}`),(await readFile(f.path)).toString());}
      return {verified:true,databases:results,configurationFiles:spec.files.length,restoreDatabasesOnRollback:false};
    },
    async seal(_,row){
      await target();for(const file of spec.files)await exactFile(file.path,file.beforeSHA256);
      const final=spec.compatibilityBootstrap?await bootstrapIdle(spec,await maintenance('status',row)):await maintenance('observe',row);if(!final.safe)throw failure();
      if(!spec.compatibilityBootstrap&&final.phase!=='claimed')throw failure();return {safe:true,installedSealClaim:!spec.compatibilityBootstrap,native:final,retainedContract:new RetainedRecords(spec.retainedRecordsPath).fingerprint};
    },
    async stop(){await original();await systemd('stop','--no-block',spec.unitId);},
    async waitOldExit(_,row){
      if(spec.compatibilityBootstrap&&await processIdentity(spec.old.pid)===spec.old.start)
        await closeBootstrap(spec,row,{original,status:()=>maintenance('status',row),idle:s=>bootstrapIdle(spec,s)});
      return wait(row,async()=>{
      if(await processIdentity(spec.old.pid)===spec.old.start)return null;
      const u=await unit();if(Number(u.MainPID)>0||u.Job)return null;
      if(spec.old.controlGroup){try{if((await readFile(join('/sys/fs/cgroup',spec.old.controlGroup,'cgroup.procs'),'utf8')).trim())throw failure();}catch(e){if(e.code!=='ENOENT')throw e;}}
      return {oldExited:true,pid:spec.old.pid,start:spec.old.start};
    });},
    async prepareStart(_,row){
      if(await processIdentity(spec.old.pid)===spec.old.start)throw failure();await target();
      for(const f of spec.files){
        const current=hash(await readFile(f.path));if(current===f.afterSHA256)continue;
        if(current!==f.beforeSHA256)throw failure();await exactFile(f.preparedPath,f.afterSHA256);savePrivate(f.path,(await readFile(f.preparedPath)).toString());
      }
      const db=new DatabaseSync(spec.localWriter.path);
      try{
        db.exec('BEGIN IMMEDIATE');const r=db.prepare('SELECT * FROM portable_async_admission WHERE id=1').get();
        if(r.writer_id!==spec.localWriter.expected.writerId||r.epoch!==spec.localWriter.expected.epoch)throw failure();
        if(r.source!==spec.source){
          if(r.source!==spec.old.source||r.phase!=='frozen'||r.operation_id!==spec.operationId)throw failure();
          db.prepare("UPDATE portable_async_admission SET source=?,phase='open',operation_id=NULL,deadline=0 WHERE id=1").run(spec.source);
          db.prepare('UPDATE portable_authority SET frozen=0 WHERE id=1').run();
          db.prepare("UPDATE portable_async_drains SET state='released' WHERE id=?").run(spec.operationId);
        }
        db.exec('COMMIT');
      }catch(e){if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{db.close();}
      await systemd('daemon-reload');
      // The standalone site's in-memory application writer must consume the
      // new source-bound authority, while the public front/connector stay up.
      // Preserve its reviewed frontend directory/assets; refresh config once.
      if(spec.site){
        const intent=join(spec.receiptDirectory,'site-restart-intent.json');
        if(!existsSync(intent)){
          const s=await siteState();if(Number(s.MainPID)!==spec.site.oldPid||s.InvocationID!==spec.site.oldInvocationId||await processIdentity(spec.site.oldPid)!==spec.site.oldStart)throw failure();
          savePrivate(intent,JSON.stringify({operationId:spec.operationId,unitId:spec.site.unitId,oldPid:spec.site.oldPid,oldStart:spec.site.oldStart,oldInvocationId:spec.site.oldInvocationId,at:new Date().toISOString()})+'\n');
          await systemd('restart','--no-block',spec.site.unitId);
        }
        await wait(row,async()=>{const s=await siteState();return s.ActiveState==='active'&&!s.Job&&Number(s.MainPID)>0&&s.InvocationID!==spec.site.oldInvocationId&&await processIdentity(spec.site.oldPid)!==spec.site.oldStart?s:null;});
        savePrivate(join(spec.receiptDirectory,'site-restart-result.json'),JSON.stringify({operationId:spec.operationId,source:spec.source,...await siteState(),frontendFilesUnchanged:true,at:new Date().toISOString()})+'\n');
      }
    },
    async start(){const u=await unit();if(Number(u.MainPID)>0||u.Job)throw failure();await systemd('start','--no-block',spec.unitId);},
    async waitHealthy(_,row){return wait(row,async()=>{const r=await reconcile();if(r.newHealthy)return r;if(r.foreignWriter)throw failure();return null;});},
    async finalize(){const r=await reconcile();if(!r.newHealthy)throw failure();},
    async release(_,row){
      if(!row.hold?.native)return;
      // A prior failed begin might not have acquired the local hold. Do not
      // manufacture one merely to release it.
      const db=new DatabaseSync(spec.localWriter.path);let held;
      try{held=db.prepare('SELECT * FROM portable_async_drains WHERE id=?').get(spec.operationId);}finally{db.close();}
      if(held)local('release',row);
      const status=await maintenance('status',row);
      const r=status.phase==='claimed'?await maintenance('release-before-stop',row):await maintenance('cancel',row);if(r.active)throw failure();
    },
  };
}
