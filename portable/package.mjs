import { RUNTIME_COMPANIONS } from './runtime-companions.mjs';
import { RUNTIME_VERSION } from './protocol.mjs';
import { cp, mkdir, readdir, readFile, writeFile, lstat, readlink, rm } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('Package only an exact clean source.');
const build=JSON.parse(await readFile('dist/portable/build.json','utf8'));
if(build.source!==source||build.nodeMajor!==24||build.protocol!==1||build.runtime!==RUNTIME_VERSION)throw Error('Build the exact current portable source before packaging.');
for(const [file,field] of [['gateway.mjs','gatewaySHA256'],['portable-agent.mjs','agentSHA256']])
  if(!/^[a-f0-9]{64}$/.test(build[field]??'')||createHash('sha256').update(await readFile(join('dist/portable',file))).digest('hex')!==build[field])throw Error('Portable build bytes differ from their original manifest.');
const download=JSON.parse(await readFile('dist/agent-downloads/current.json','utf8'));
if(download.version!==1||download.source!==source||download.name!==`dawartodo-agent-${source.slice(0,12)}.zip`||
  !Number.isSafeInteger(download.bytes)||download.bytes<1||download.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(download.sha256??''))throw Error('Prepare the exact current agent download before packaging.');
const downloadPath=join('dist/agent-downloads',download.name),downloadStat=await lstat(downloadPath);
if(!downloadStat.isFile()||downloadStat.isSymbolicLink()||downloadStat.size!==download.bytes||createHash('sha256').update(await readFile(downloadPath)).digest('hex')!==download.sha256)
  throw Error('Agent download bytes differ from their original manifest.');
const version=`dawartodo-${source.slice(0,12)}-${process.platform}-${process.arch}`;
const directory=resolve('dist/packages',version);
await mkdir(resolve('dist/packages'),{recursive:true});
// A new exact release never replaces an earlier package or a live directory.
await mkdir(directory);
try {
  await cp('.next-portable/standalone',join(directory,'.next-portable/standalone'),{recursive:true});
  await cp('portable',join(directory,'portable'),{recursive:true});
  await mkdir(join(directory,'dist/agent-downloads'),{recursive:true});
  for(const file of ['current.json',download.name,download.name+'.sha256'])await cp(join('dist/agent-downloads',file),join(directory,'dist/agent-downloads',file));
  await mkdir(join(directory,'dist/portable'),{recursive:true});
  await cp('dist/portable/gateway.mjs',join(directory,'dist/portable/gateway.mjs'));
  await cp('dist/portable/build.json',join(directory,'dist/portable/build.json'));
  for(const file of RUNTIME_COMPANIONS)await cp(join('dist/portable',file),join(directory,'dist/portable',file));
  await mkdir(join(directory,'bot-bridge'),{recursive:true});
  await cp('dist/portable/portable-agent.mjs',join(directory,'bot-bridge/portable-agent.mjs'));
  // Offline control staging uses the original SQLite Store constructor.
  // Keep its exact source in the release; the bundled agent is not a substitute.
  await cp('bot-bridge/store.mjs',join(directory,'bot-bridge/store.mjs'));
  for(const file of RUNTIME_COMPANIONS)
    await cp(join('bot-bridge',file),join(directory,'bot-bridge',file));
  await cp('bot-bridge/desktops',join(directory,'bot-bridge/desktops'),{recursive:true});
  await cp('drizzle',join(directory,'drizzle'),{recursive:true});
  await cp('package-lock.json',join(directory,'package-lock.json'));
  await cp('package.json',join(directory,'package.json'));
  // External gateway/agent dependencies come from the traced portable site.
  // All modules resolve within this release rather than the build repository.
  await cp('.next-portable/standalone/node_modules',join(directory,'node_modules'),{recursive:true});
  const dependencies=['ws','busboy','streamsearch','web-push','http_ece','asn1.js','bn.js','safer-buffer','minimalistic-assert','agent-base','https-proxy-agent'];
  for(const name of dependencies){
    try{await cp(join('node_modules',name),join(directory,'node_modules',name),{recursive:true});}catch(e){if(e.code!=='ENOENT')throw e;}
  }
  const files=[];
  async function inspect(path){
    for(const name of (await readdir(path)).sort()){
      const full=join(path,name),s=await lstat(full),entry=relative(directory,full);
      if(s.isDirectory())await inspect(full);
      else if(s.isSymbolicLink()){
        const target=await readlink(full),location=resolve(path,target);
        if(isAbsolute(target)||relative(directory,location).startsWith('..'))throw Error('Package contains an external dependency link.');
        files.push({path:entry,link:target});
      }else if(s.isFile())files.push({path:entry,bytes:s.size,sha256:createHash('sha256').update(await readFile(full)).digest('hex')});
      else throw Error('Package contains a special file.');
    }
  }
  await inspect(directory);
  await writeFile(join(directory,'release-manifest.json'),JSON.stringify({version:1,source,protocol:1,runtime:RUNTIME_VERSION,nodeMajor:24,platform:process.platform,arch:process.arch,executionEnabled:false,files},null,2)+'\n');
  execFileSync('tar',['-czf',`${directory}.tar.gz`,'-C',resolve('dist/packages'),version]);
  const archive=await readFile(`${directory}.tar.gz`);
  await writeFile(`${directory}.tar.gz.sha256`,`${createHash('sha256').update(archive).digest('hex')}  ${version}.tar.gz\n`);
  console.log(JSON.stringify({directory,archive:`${directory}.tar.gz`,source,files:files.length,executionEnabled:false}));
}catch(error){await rm(directory,{recursive:true,force:true});throw error;}
