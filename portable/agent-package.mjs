import { RUNTIME_COMPANIONS } from './runtime-companions.mjs';
import { RUNTIME_VERSION } from './protocol.mjs';
import { mkdir,cp,writeFile,readFile,readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim())throw Error('Agent downloads require exact clean source.');
const build=JSON.parse(await readFile('dist/portable/build.json','utf8'));
if(build.source!==source||build.nodeMajor!==24||build.protocol!==1||build.runtime!==RUNTIME_VERSION||
  !/^[a-f0-9]{64}$/.test(build.agentSHA256??'')||createHash('sha256').update(await readFile('dist/portable/portable-agent.mjs')).digest('hex')!==build.agentSHA256)
  throw Error('Build the exact current portable agent before packaging its download.');
const name=`dawartodo-agent-${source.slice(0,12)}`,directory=resolve('dist/agent-downloads',name);
await mkdir(resolve('dist/agent-downloads'),{recursive:true});
await mkdir(directory);
await mkdir(join(directory,'bot-bridge'),{recursive:true});
await cp('dist/portable/portable-agent.mjs',join(directory,'bot-bridge/portable-agent.mjs'));
await cp('portable/agent-download',join(directory,'portable'),{recursive:true});
for(const file of ['config.mjs','protocol.mjs','private-file.mjs','bounded-json.mjs','enrollment-client.mjs','agent-capabilities.mjs','services.mjs','agent-cli.mjs'])await cp(join('portable',file),join(directory,'portable',file));
for(const file of RUNTIME_COMPANIONS)await cp(join('bot-bridge',file),join(directory,'bot-bridge',file));
await cp('bot-bridge/desktops',join(directory,'bot-bridge/desktops'),{recursive:true});
await cp('portable/agent-dependencies/package.json',join(directory,'package.json'));
await cp('portable/agent-dependencies/package-lock.json',join(directory,'package-lock.json'));
await cp('portable/agent-download/Install DawarTodo Agent.command',join(directory,'Install DawarTodo Agent.command'));
const files=[];
async function inspect(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await inspect(p);else if(e.isFile()){const b=await readFile(p);files.push({path:p.slice(directory.length+1),bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')});}else throw Error('Installer may contain only regular files.');}}
await inspect(directory);
await writeFile(join(directory,'manifest.json'),JSON.stringify({source,protocol:1,runtime:RUNTIME_VERSION,nodeMajor:24,platforms:['darwin-arm64','darwin-x64','linux-x64','linux-arm64'],files},null,2)+'\n');
const archive=`${directory}.zip`;
execFileSync('zip',['-qr',archive,name],{cwd:resolve('dist/agent-downloads')});
const bytes=await readFile(archive),sha256=createHash('sha256').update(bytes).digest('hex');
await writeFile(`${archive}.sha256`,sha256+'  '+name+'.zip\n');
await writeFile(resolve('dist/agent-downloads/current.json'),JSON.stringify({version:1,source,name:name+'.zip',sha256,bytes:bytes.length})+'\n');
console.log(JSON.stringify({source,archive,sha256,files:files.length,secretsBundled:false,executionEnabled:false}));
