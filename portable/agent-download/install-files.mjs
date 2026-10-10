import { createHash,randomUUID } from 'node:crypto';
import { readFile,mkdir,writeFile,lstat,realpath,rename,rm } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute,dirname } from 'node:path';

export async function verifyFiles(directory,manifest) {
  if(!/^[a-f0-9]{40}$/.test(manifest.source)||manifest.nodeMajor!==24||manifest.protocol!==1||manifest.runtime!=='0.161.0'
    ||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>1000)throw Error('Invalid installer manifest.');
  const seen=new Set();let total=0;
  for(const f of manifest.files){
    if(typeof f.path!=='string'||isAbsolute(f.path)||!f.path||f.path.includes('\\')||seen.has(f.path)||f.path==='manifest.json'||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid installer path or hash.');
    const p=resolve(directory,f.path);if(relative(directory,p)!==f.path||relative(directory,p).startsWith('..')||await realpath(p)!==p)throw Error('Installer path escapes its release.');
    seen.add(f.path);total+=f.bytes;if(total>32*1024*1024)throw Error('Installer exceeds its bound.');
    const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==f.bytes||createHash('sha256').update(await readFile(p)).digest('hex')!==f.sha256)throw Error('Installer source checksum failed.');
  }
}
export async function prepareRelease(base,source,manifest,installDependencies) {
  await verifyFiles(source,manifest);
  const releases=join(base,'releases');await mkdir(releases,{recursive:true,mode:0o700});
  if(await realpath(releases)!==releases)throw Error('Installation directory must not use a symbolic link.');
  const release=join(releases,manifest.source);
  try{
    const stored=JSON.parse(await readFile(join(release,'manifest.json'),'utf8'));
    if(JSON.stringify(stored)!==JSON.stringify(manifest))throw Error('Existing release manifest differs.');
    await verifyFiles(release,manifest);await installDependencies(release,{verifyOnly:true});return release;
  }catch(e){if(e.code!=='ENOENT')throw e;}
  // Exclusive staging prevents an installer from modifying a running release.
  const stage=join(releases,`${manifest.source}.install-${randomUUID()}`);await mkdir(stage,{mode:0o700});
  try{
    for(const f of manifest.files){const p=join(stage,f.path);await mkdir(dirname(p),{recursive:true,mode:0o700});await writeFile(p,await readFile(join(source,f.path)),{flag:'wx',mode:f.path.endsWith('.command')?0o700:0o600});}
    await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600,flag:'wx'});
    await verifyFiles(stage,manifest);await installDependencies(stage,{verifyOnly:false});
    await rename(stage,release);return release;
  }catch(e){await rm(stage,{recursive:true,force:true});throw e;}
}
