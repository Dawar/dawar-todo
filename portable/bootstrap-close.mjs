import {readFile,readlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {readPrivate,savePrivate} from './private-file.mjs';

const start=async pid=>{try{const s=await readFile(`/proc/${pid}/stat`,'utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[19];}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const wait=async(test,deadline)=>{while(Date.now()<deadline){if(await test())return;await new Promise(r=>setTimeout(r,250));}throw Error('Original idle shutdown remains pending; no signal is repeated.');};
const children=async pid=>(await readFile(`/proc/${pid}/task/${pid}/children`,'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);

// Only for first installation from an old runtime whose own graceful shutdown
// cannot consume retained-record proof. The original native/tool work must be
// finished, writes frozen and backup verified before this function is called.
// Each signal has its own durable intent. GUI/browser processes are untouched.
export async function closeBootstrap(spec,row,{original,status,idle}){
  const native=row.hold.nativeProcess;
  if(!native?.pid||!native.start||!row.events.some(e=>e.phase==='backup-verified')||row.phase!=='stop-intent')throw Error('Original backup/stop identity missing.');
  const proof=await idle(await status());
  if(!proof.safe)throw Error('Current native/tool work prevents compatibility shutdown.');
  await original();
  const signal=async(label,identity,kind)=>{
    const path=join(spec.receiptDirectory,`bootstrap-${label}-intent.json`);
    if(existsSync(path)){
      const prior=JSON.parse(readPrivate(path));
      if(prior.pid!==identity.pid||prior.start!==identity.start||prior.signal!==kind)throw Error('Original shutdown intent differs.');
      return;
    }
    if(await start(identity.pid)!==identity.start)throw Error('Shutdown process identity changed.');
    savePrivate(path,JSON.stringify({operationId:spec.operationId,...identity,signal:kind,proof,at:new Date().toISOString()},null,2)+'\n');
    process.kill(identity.pid,kind);
    savePrivate(path.replace('-intent.json','-sent.json'),JSON.stringify({operationId:spec.operationId,...identity,signal:kind,at:new Date().toISOString()})+'\n');
  };
  if(await start(native.pid)===native.start){
    if(await readlink(`/proc/${native.pid}/exe`)!==spec.nativeBinaryPath)throw Error('Original native binary changed.');
    await signal('native',native,'SIGTERM');
  }
  await wait(async()=>await start(native.pid)!==native.start,Math.min(row.deadline,Date.now()+30000));
  // The old daemon has exited. Only registered idle desktop stdio clients may
  // remain directly under the parent. Never signal browser/desktop sessions.
  await original();
  for(const pid of await children(spec.old.pid)){
    const identity={pid,start:await start(pid)};
    if(!identity.start)continue;
    const command=(await readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
    if(!command.includes(spec.compatibilityBootstrap.transportScript)||(await children(pid)).length)
      throw Error('Unregistered or active descendants remain; no parent termination.');
    const counts=(await status()).counts;
    if((counts.desktopToolRequests??0)!==0||(counts.requests??0)!==0||(counts.localActive??0)!==0)
      throw Error('Desktop/native requests changed during shutdown.');
    await signal(`transport-${pid}`,identity,'SIGTERM');
    await wait(async()=>await start(pid)!==identity.start,Math.min(row.deadline,Date.now()+15000));
  }
  await original();
  if((await children(spec.old.pid)).length)throw Error('A new descendant appeared; no parent termination.');
  if(spec.old.controlGroup){
    const pids=(await readFile(join('/sys/fs/cgroup',spec.old.controlGroup,'cgroup.procs'),'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
    if(pids.some(pid=>pid!==spec.old.pid))throw Error('Original cgroup still owns work; no parent termination.');
  }
  // The service-manager stop is already pending. The idle legacy parent
  // refuses its own outdated claim; ending only that empty parent completes
  // the original stop. No active process, native turn or tool is killed.
  const parent={pid:spec.old.pid,start:spec.old.start};
  await signal('idle-parent',parent,'SIGKILL');
  await wait(async()=>await start(parent.pid)!==parent.start,Math.min(row.deadline,Date.now()+15000));
}
