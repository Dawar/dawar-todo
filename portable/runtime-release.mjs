import {createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,readlinkSync,realpathSync} from 'node:fs';
import {dirname,resolve,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RUNTIME_COMPANIONS} from './runtime-companions.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const hashPattern=/^[a-f0-9]{64}$/;
const regular=(path,maximum)=>{
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum||stat.mode&0o022||
      process.getuid&&stat.uid!==process.getuid()||realpathSync(path)!==path)throw Error('Reviewed release file is unsafe or changed.');
  return stat;
};

// A private owner activation binds the manifest bytes, not just a claimed Git
// revision. Installed releases do not need a repository or a writable .git.
export function verifiedAgentRelease({activation,entrypoint,codexBinary,runtime}) {
  if(!/^[a-f0-9]{40}$/.test(activation.source??'')||!hashPattern.test(activation.releaseManifestSHA256??'')||
      !hashPattern.test(activation.codexBinarySHA256??''))throw Error('Exact release and binary hashes are required by agent activation.');
  const entry=fileURLToPath(entrypoint),directory=dirname(dirname(entry));
  if(entry!==join(directory,'bot-bridge','portable-agent.mjs')||realpathSync(directory)!==directory||!isAbsolute(codexBinary))throw Error('The agent must run from its reviewed installed release.');
  const names=['release-manifest.json','manifest.json'].filter(name=>existsSync(join(directory,name)));
  if(names.length!==1)throw Error('One original release manifest is required.');
  const manifestPath=join(directory,names[0]);
  const check=(commit=activation.source,version=runtime)=>{
    if(commit!==activation.source||version!==runtime||activation.runtime!==runtime)throw Error('Reviewed maintenance source or runtime changed.');
    regular(manifestPath,8*1024*1024);
    const raw=readFileSync(manifestPath);
    if(sha(raw)!==activation.releaseManifestSHA256)throw Error('Original release manifest changed.');
    const manifest=JSON.parse(raw);
    if(manifest.source!==commit||manifest.runtime!==version||manifest.protocol!==1||manifest.nodeMajor!==24||
        !Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>10000)throw Error('Invalid reviewed release manifest.');
    const seen=new Set();let total=0;
    for(const file of manifest.files){
      if(typeof file.path!=='string'||!file.path||file.path.includes('\\')||isAbsolute(file.path)||seen.has(file.path))throw Error('Invalid release path.');
      const path=resolve(directory,file.path),rel=relative(directory,path);
      if(rel!==file.path||rel==='..'||rel.startsWith('../')||path===manifestPath)throw Error('Release path is outside its original scope.');
      seen.add(rel);
      if(file.link!==undefined){
        const target=resolve(dirname(path),file.link),targetRel=relative(directory,target),stat=lstatSync(path);
        if(typeof file.link!=='string'||isAbsolute(file.link)||targetRel==='..'||targetRel.startsWith('../')||
            !stat.isSymbolicLink()||readlinkSync(path)!==file.link||relative(directory,realpathSync(target)).startsWith('..'))throw Error('Reviewed dependency link changed.');
        continue;
      }
      if(!Number.isSafeInteger(file.bytes)||file.bytes<0||!hashPattern.test(file.sha256??'')||
          (total+=file.bytes)>256*1024*1024)throw Error('Invalid release file bound.');
      if(regular(path,file.bytes).size!==file.bytes||sha(readFileSync(path))!==file.sha256)throw Error('Reviewed release bytes changed.');
    }
    for(const name of ['portable-agent.mjs',...RUNTIME_COMPANIONS])if(!seen.has('bot-bridge/'+name))throw Error('Reviewed agent companion is missing.');
    regular(codexBinary,512*1024*1024);
    if(sha(readFileSync(codexBinary))!==activation.codexBinarySHA256)throw Error('Reviewed local Codex binary changed.');
    return {source:commit,runtime:version,manifestSHA256:activation.releaseManifestSHA256,files:seen.size};
  };
  check();return check;
}
