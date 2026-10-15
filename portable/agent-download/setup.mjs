import { createHash } from 'node:crypto';
import { readFile,mkdir,writeFile,stat } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { nodeKey,RUNTIME_VERSION } from './protocol.mjs';
import { prepareRelease } from './install-files.mjs';
import { resolveCodexLaunch,verifyCodexVersion } from './codex-runtime.mjs';
import { draggedPath,pairWithFile } from './pairing.mjs';
const args=process.argv.slice(2),option=n=>args[args.indexOf('--'+n)+1];
const base=resolve(option('base')),source=resolve(option('source'));
if(!['darwin','linux'].includes(process.platform)||!['x64','arm64'].includes(process.arch)||Number(process.versions.node.split('.')[0])!==24)throw Error('Unsupported Node/platform.');
process.umask(0o077);
const manifest=JSON.parse(await readFile(join(source,'manifest.json'),'utf8'));
if(!/^[a-f0-9]{40}$/.test(manifest.source)||!Array.isArray(manifest.files)||manifest.files.length>1000)throw Error('Invalid installer manifest.');
const data=join(base,'agent');
async function dependencies(directory,{verifyOnly}) {
 const receiptPath=join(directory,'dependencies-installed.json');
 if(!verifyOnly){
  const npm=join(dirname(process.execPath),'npm');
  const installed=spawnSync(npm,['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,stdio:'inherit'});
  if(installed.status!==0)throw Error('Agent dependencies were not installed.');
 }
 const require=createRequire(join(directory,'package.json')),platformPackage=`@openai/codex-${process.platform}-${process.arch}`;
 const launch=resolveCodexLaunch(dirname(require.resolve(platformPackage+'/package.json')),{version:RUNTIME_VERSION}),binary=launch.binary;
 verifyCodexVersion(launch,RUNTIME_VERSION);
 const lock=await readFile(join(directory,'package-lock.json')),bytes=await readFile(binary);
 const value={source:manifest.source,platform:process.platform,arch:process.arch,runtime:RUNTIME_VERSION,lockHash:createHash('sha256').update(lock).digest('hex'),binaryHash:createHash('sha256').update(bytes).digest('hex')};
 if(verifyOnly){if(JSON.stringify(JSON.parse(await readFile(receiptPath,'utf8')))!==JSON.stringify(value))throw Error('Installed dependency receipt changed.');}
 else await writeFile(receiptPath,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
 return binary;
}
let release;
try{release=await prepareRelease(base,source,manifest,dependencies);}
catch(e){
 // Launch diagnostics name the OS error/exit/signal/output; they hold no credentials.
 if(e.diagnostics)console.error('Codex launch diagnostics: '+JSON.stringify(e.diagnostics,null,1));
 console.error(e.message+' Nothing has been enrolled, configured or started.');process.exit(1);
}
const codexBinary=await dependencies(release,{verifyOnly:true});
await mkdir(data,{recursive:true,mode:0o700});
const key=nodeKey(join(data,'node-key.pem'));
const configPath=join(data,'config.json');
try{await stat(configPath);}catch(e){if(e.code!=='ENOENT')throw e;await writeFile(configPath,JSON.stringify({version:1,mode:'agent',dataDirectory:data,agent:{hubOrigin:'https://work.dawar.ca',codexBinary,workspaces:join(base,'bots'),activationReceipt:join(data,'activation.json')}},null,2)+'\n',{mode:0o600,flag:'wx'});}
console.log('\nAgent installed. No bot, service or model turn has started.');
console.log('Node fingerprint: '+key.fingerprint);
console.log('Open work.dawar.ca → Settings → Execution machines. Confirm this fingerprint and download the five-minute pairing file.');
const input=createInterface({input:process.stdin,output:process.stdout});
try{
 const path=(await input.question('Drag the pairing file here, then press Return (or Return to finish without pairing): ')).trim();
 if(!path)process.exitCode=0;
 if(!path){input.close();process.exit(0);}
 await pairWithFile({pairingPath:draggedPath(path),fingerprint:key.fingerprint,data,configPath,release});
 console.log('Paired. Return to Settings to select this machine and approve its first bot. Execution remains disabled until that approval.');
}finally{input.close();}
