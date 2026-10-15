import { createHash } from 'node:crypto';
import { readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,lstatSync,copyFileSync,chmodSync,rmSync,openSync,readSync,closeSync,existsSync,renameSync,cpSync } from 'node:fs';
import { join,dirname,relative,resolve,isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { machOArchitectures,codexTarget,resolveCodexLaunch } from '../codex-runtime.mjs';

// Pinned Node runtime. These hashes are the same nodejs.org v24.21.0 archives
// the existing installer verifies (tests keep the two in step).
export const NODE_VERSION='24.21.0';
export const NODE_SHA256={'darwin-arm64':'bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057','darwin-x64':'1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097'};
export const BUNDLE_MANIFEST='bundle-manifest.json',APP_RELEASE='app-release.json';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const header=path=>{const b=Buffer.alloc(64),fd=openSync(path,'r');try{return b.subarray(0,readSync(fd,b,0,64,0));}finally{closeSync(fd);}};

// Every regular file with its hash, owner-exec bit and Mach-O architectures.
// Links and special files are refused: the app copies plain files only.
export function walkTree(root,{skip=()=>false}={}) {
  const entries=[];
  const visit=dir=>{
    for(const e of readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      const path=join(dir,e.name),rel=relative(root,path);
      if(skip(rel))continue;
      if(e.isDirectory()){visit(path);continue;}
      const s=lstatSync(path);
      if(!s.isFile())throw Error(`Bundle may contain only regular files: ${rel}`);
      const bytes=readFileSync(path),archs=machOArchitectures(header(path));
      entries.push({path:rel,bytes:s.size,sha256:sha(bytes),mode:s.mode&0o100?'0755':'0644',...(archs?{macho:archs}:{})});
    }
  };
  visit(root);return entries;
}
export function verifyArchitecture(entries,arch) {
  const wrong=entries.filter(e=>e.macho&&!e.macho.includes(arch));
  if(wrong.length)throw Error(`Bundled Mach-O files do not target ${arch}: ${wrong.slice(0,5).map(e=>e.path).join(', ')}`);
  for(const required of ['node/bin/node'])if(!entries.find(e=>e.path===required)?.macho)throw Error(`${required} must be a ${arch} Mach-O executable.`);
  if(!entries.some(e=>/^codex\/vendor\/[^/]+\/bin\/codex$/.test(e.path)&&e.macho))throw Error(`The Codex entrypoint must be a ${arch} Mach-O executable.`);
}
export function verifyTree(root,entries) {
  const seen=new Set();
  for(const e of entries){
    if(typeof e.path!=='string'||!e.path||isAbsolute(e.path)||e.path.includes('\\')||seen.has(e.path)||relative(root,resolve(root,e.path))!==e.path||e.path.startsWith('..'))throw Error('Invalid bundle path.');
    seen.add(e.path);
    const p=join(root,e.path),s=lstatSync(p,{throwIfNoEntry:false});
    if(!s?.isFile()||s.size!==e.bytes||sha(readFileSync(p))!==e.sha256)throw Error(`Bundle file changed: ${e.path}`);
    if(e.mode==='0755'&&!(s.mode&0o100))throw Error(`Bundle executable lost its permission: ${e.path}`);
  }
  return seen;
}
// Copy a verified subtree into an exclusive stage, then rename into place.
// An existing destination must already hold the same verified bytes.
export function installTree(sourceRoot,entries,prefix,destination) {
  const selected=entries.filter(e=>e.path.startsWith(prefix+'/')).map(e=>({...e,path:e.path.slice(prefix.length+1)}));
  if(!selected.length)throw Error(`Bundle has no ${prefix} files.`);
  if(existsSync(destination)){verifyTree(destination,selected);return {destination,installed:false};}
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  const stage=mkdtempSync(destination+'.install-');
  try{
    for(const e of selected){const to=join(stage,e.path);mkdirSync(dirname(to),{recursive:true,mode:0o700});copyFileSync(join(sourceRoot,prefix,e.path),to);chmodSync(to,e.mode==='0755'?0o700:0o600);}
    verifyTree(stage,selected);renameSync(stage,destination);
  }catch(error){rmSync(stage,{recursive:true,force:true});throw error;}
  return {destination,installed:true};
}

const licenseOf=dir=>{try{const p=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));return {name:p.name,version:p.version,license:p.license??null};}catch{return null;}};
function packages(nodeModules) {
  const out=[];
  for(const e of existsSync(nodeModules)?readdirSync(nodeModules,{withFileTypes:true}):[]){
    if(!e.isDirectory()||e.name.startsWith('.'))continue;
    const dirs=e.name.startsWith('@')?readdirSync(join(nodeModules,e.name)).map(n=>join(nodeModules,e.name,n)):[join(nodeModules,e.name)];
    for(const d of dirs){const l=licenseOf(d);if(l)out.push({...l,directory:relative(nodeModules,d)});}
  }
  return out.sort((a,b)=>a.directory<b.directory?-1:1);
}

// Assemble Agent.app/Contents/Resources from reviewed inputs:
//  agentDownload: the exact dist/agent-downloads/dawartodo-agent-<sha>/ tree
//  nodeModules:   `npm ci --ignore-scripts --no-bin-links` of its lock for this arch
//  nodeTarball:   nodejs.org node-v24.21.0-darwin-<arch>.tar.gz (pinned hash)
//  releasePublicKey: optional PEM verifying signed update records
export function stageResources({agentDownload,nodeModules,nodeTarball,out,appVersion,build,releasePublicKey,arch='arm64',nodeSHA256=NODE_SHA256[`darwin-${arch}`],now=new Date()}) {
  if(!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(appVersion)||!Number.isSafeInteger(build)||build<1)throw Error('App version x.y.z and a positive build number are required.');
  if(existsSync(out))throw Error('Resources output must not exist yet.');
  const agentManifestBytes=readFileSync(join(agentDownload,'manifest.json')),agentManifest=JSON.parse(agentManifestBytes);
  if(!/^[a-f0-9]{40}$/.test(agentManifest.source)||agentManifest.nodeMajor!==24)throw Error('Agent download manifest is not an exact reviewed release.');
  const tarball=readFileSync(nodeTarball);
  if(sha(tarball)!==nodeSHA256)throw Error('Node runtime archive checksum failed.');
  const target=codexTarget('darwin',arch),codexPackage=join(nodeModules,'@openai',`codex-darwin-${arch}`);
  const launch=resolveCodexLaunch(codexPackage,{platform:'darwin',arch,version:agentManifest.runtime});
  mkdirSync(out,{recursive:true});
  try{
    const nodeName=`node-v${NODE_VERSION}-darwin-${arch}`,scratch=mkdtempSync(join(dirname(resolve(out)),'.node-'));
    try{
      execFileSync('tar',['-xzf',nodeTarball,'-C',scratch,`${nodeName}/bin/node`,`${nodeName}/LICENSE`]);
      mkdirSync(join(out,'node/bin'),{recursive:true});
      copyFileSync(join(scratch,nodeName,'bin/node'),join(out,'node/bin/node'));chmodSync(join(out,'node/bin/node'),0o755);
      copyFileSync(join(scratch,nodeName,'LICENSE'),join(out,'node/LICENSE'));
    }finally{rmSync(scratch,{recursive:true,force:true});}
    // The Codex platform package lives outside the agent release so releases
    // with the same runtime share one verified binary path.
    mkdirSync(join(out,'codex/vendor'),{recursive:true});
    cpSync(launch.root,join(out,'codex/vendor',target),{recursive:true,verbatimSymlinks:true});
    copyFileSync(join(codexPackage,'package.json'),join(out,'codex/package.json'));
    cpSync(agentDownload,join(out,'agent'),{recursive:true,verbatimSymlinks:true});
    rmSync(join(out,'agent','Install DawarTodo Agent.command'),{force:true});
    cpSync(nodeModules,join(out,'agent/node_modules'),{recursive:true,verbatimSymlinks:true});
    rmSync(join(out,'agent/node_modules/@openai'),{recursive:true,force:true});
    const third=[{name:'node',version:NODE_VERSION,license:'MIT AND others (node/LICENSE)',directory:'node'},
      {name:'@openai/codex',version:agentManifest.runtime,license:licenseOf(codexPackage)?.license??null,directory:`codex/vendor/${target}`},...packages(join(out,'agent/node_modules'))];
    mkdirSync(join(out,'licenses'));writeFileSync(join(out,'licenses/third-party.json'),JSON.stringify(third,null,2)+'\n');
    const release={kind:'dawartodo-mac-agent-bundle',version:1,appVersion,build,arch,agentSource:agentManifest.source,protocol:agentManifest.protocol,
      runtime:agentManifest.runtime,nodeVersion:NODE_VERSION,codexTarget:target,codexBinarySHA256:null,
      agentManifestSHA256:sha(agentManifestBytes),stagedAt:now.toISOString()};
    writeFileSync(join(out,APP_RELEASE),JSON.stringify(release,null,2)+'\n');
    // Public half of the owner's offline release key; verifies update records.
    if(releasePublicKey)copyFileSync(releasePublicKey,join(out,'release-public-key.pem'));
    return sealResources(out);
  }catch(error){rmSync(out,{recursive:true,force:true});throw error;}
}
// Record final hashes. Run again after code signing, which rewrites Mach-O
// bytes; the installed copies are verified against these sealed values.
export function sealResources(out) {
  const release=JSON.parse(readFileSync(join(out,APP_RELEASE),'utf8'));
  release.codexBinarySHA256=sha(readFileSync(join(out,'codex/vendor',release.codexTarget,'bin/codex')));
  writeFileSync(join(out,APP_RELEASE),JSON.stringify(release,null,2)+'\n');
  const entries=walkTree(out,{skip:rel=>rel===BUNDLE_MANIFEST});
  verifyArchitecture(entries,release.arch);
  const manifestBytes=Buffer.from(JSON.stringify({kind:'dawartodo-mac-agent-files',version:1,agentSource:release.agentSource,arch:release.arch,files:entries},null,1)+'\n');
  writeFileSync(join(out,BUNDLE_MANIFEST),manifestBytes);
  return {release,files:entries.length,bundleManifestSHA256:sha(manifestBytes)};
}
export function readBundle(resources) {
  const manifestBytes=readFileSync(join(resources,BUNDLE_MANIFEST)),manifest=JSON.parse(manifestBytes);
  if(manifest.kind!=='dawartodo-mac-agent-files'||manifest.version!==1||!Array.isArray(manifest.files))throw Error('Invalid app bundle manifest.');
  const release=JSON.parse(readFileSync(join(resources,APP_RELEASE),'utf8'));
  const entry=manifest.files.find(e=>e.path===APP_RELEASE);
  if(!entry||entry.sha256!==sha(readFileSync(join(resources,APP_RELEASE)))||release.agentSource!==manifest.agentSource)throw Error('App release receipt differs from the bundle manifest.');
  return {manifest,release,bundleManifestSHA256:sha(manifestBytes)};
}
