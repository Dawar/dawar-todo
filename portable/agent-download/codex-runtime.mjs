import { readFileSync,lstatSync,realpathSync } from 'node:fs';
import { join,resolve,relative,isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

// The platform package owns its launch layout through
// vendor/<target>/codex-package.json. 0.162.1 places the entrypoint at
// bin/codex on every platform; the old installer guessed codex/codex, which
// is absent from the integrity-verified darwin-arm64 archive.
export const TARGETS={'darwin-arm64':'aarch64-apple-darwin','darwin-x64':'x86_64-apple-darwin','linux-arm64':'aarch64-unknown-linux-musl','linux-x64':'x86_64-unknown-linux-musl'};
export function codexTarget(platform=process.platform,arch=process.arch) {
  const target=TARGETS[`${platform}-${arch}`];
  if(!target)throw Error(`Unsupported Codex platform ${platform}-${arch}.`);
  return target;
}
const inside=(root,path)=>{const r=relative(root,path);return r!==''&&r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};

// packageRoot is the installed platform package (…/@openai/codex-darwin-arm64)
// or a copied vendor tree's parent. Returns absolute launch paths.
export function resolveCodexLaunch(packageRoot,{platform=process.platform,arch=process.arch,version}={}) {
  const target=codexTarget(platform,arch),root=join(resolve(packageRoot),'vendor',target);
  let layout;
  try{layout=JSON.parse(readFileSync(join(root,'codex-package.json'),'utf8'));}
  catch(e){throw Error(`Codex package layout is missing for ${target} (${e.code??e.message}).`);}
  if(layout.layoutVersion!==1||layout.target!==target||version&&layout.version!==version||layout.variant!=='codex')
    throw Error(`Codex package layout ${layout.layoutVersion}/${layout.target}/${layout.version} is not the approved ${target} ${version??''} layout.`);
  const paths={};
  for(const key of ['entrypoint','resourcesDir','pathDir']){
    const value=layout[key];
    if(typeof value!=='string'||!value||isAbsolute(value)||value.includes('\\')||!inside(root,resolve(root,value)))throw Error(`Codex package ${key} escapes its vendor directory.`);
    paths[key]=resolve(root,value);
  }
  const s=lstatSync(paths.entrypoint,{throwIfNoEntry:false});
  if(!s)throw Error(`Codex entrypoint ${layout.entrypoint} is absent from ${target}.`);
  if(!s.isFile()||s.isSymbolicLink()||realpathSync(paths.entrypoint)!==paths.entrypoint)throw Error('Codex entrypoint must be a regular file.');
  if(!(s.mode&0o100))throw Error('Codex entrypoint is not executable by its owner.');
  return {target,version:layout.version,root,binary:paths.entrypoint,resourcesDir:paths.resourcesDir,pathDir:paths.pathDir};
}

// Mach-O header inspection (no execution): lets Linux packaging prove a
// bundled executable targets arm64 macOS before an owner ever launches it.
const CPU={0x0100000c:'arm64',0x01000007:'x64'};
export function machOArchitectures(bytes) {
  if(bytes.length<8)return null;
  const be=bytes.readUInt32BE(0),le=bytes.readUInt32LE(0);
  if(le===0xfeedfacf)return [CPU[bytes.readUInt32LE(4)]??`cpu:${bytes.readUInt32LE(4).toString(16)}`];
  if(be===0xcafebabe||be===0xcafebabf){
    const count=bytes.readUInt32BE(4),size=be===0xcafebabe?20:32;if(count>16||8+count*size>bytes.length)return null;
    return Array.from({length:count},(_,i)=>{const c=bytes.readUInt32BE(8+i*size);return CPU[c]??`cpu:${c.toString(16)}`;});
  }
  return null;
}

const SECRET=/(Bearer\s+|token[=:"\s]+|sk-|ghp_|xox[abp]-)[A-Za-z0-9._\-]{8,}/gi;
export const redact=text=>String(text??'').replace(SECRET,(m,p)=>`${p}[redacted]`);
const tail=(value,limit=2000)=>{const t=redact(Buffer.isBuffer(value)?value.toString('utf8'):value??'');return t.length>limit?'…'+t.slice(-limit):t;};

// Concrete child failure details without credentials: OS error code, exit
// status, signal and bounded redacted output.
export function describeLaunch(binary,result) {
  return {binary,error:result.error?{code:result.error.code??null,message:redact(result.error.message)}:null,
    status:result.status??null,signal:result.signal??null,stdout:tail(result.stdout),stderr:tail(result.stderr)};
}
export class RuntimeLaunchError extends Error {
  constructor(message,diagnostics){super(message);this.name='RuntimeLaunchError';this.diagnostics=diagnostics;}
}
export function verifyCodexVersion({binary,pathDir},version,{spawn=spawnSync}={}) {
  const result=spawn(binary,['--version'],{encoding:'utf8',timeout:30000,env:{...process.env,PATH:`${pathDir}:${process.env.PATH??''}`}});
  const diagnostics=describeLaunch(binary,result);
  if(result.error||result.status!==0||String(result.stdout).trim()!==`codex-cli ${version}`){
    const why=result.error?`launch error ${result.error.code??result.error.message}`:result.signal?`signal ${result.signal}`:result.status!==0?`exit status ${result.status}`:`unexpected version "${String(result.stdout).trim().slice(0,80)}"`;
    throw new RuntimeLaunchError(`Required local Codex ${version} could not be verified: ${why}.`,diagnostics);
  }
  return diagnostics;
}
