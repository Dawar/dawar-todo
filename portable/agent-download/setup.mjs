import { createHash } from 'node:crypto';
import { readFile,mkdir,writeFile,stat,lstat,rm } from 'node:fs/promises';
import { join,resolve,dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { nodeKey } from './protocol.mjs';
import { prepareRelease } from './install-files.mjs';
import { randomUUID } from 'node:crypto';
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
 const triple=`${process.arch==='arm64'?'aarch64':'x86_64'}-${process.platform==='darwin'?'apple-darwin':'unknown-linux-musl'}`;
 const binary=join(dirname(require.resolve(platformPackage+'/package.json')),'vendor',triple,'codex','codex');
 const version=spawnSync(binary,['--version'],{encoding:'utf8'});
 if(version.status!==0||!/^codex-cli 0\.161\.0\s*$/.test(version.stdout))throw Error('Required local Codex runtime could not be verified.');
 const lock=await readFile(join(directory,'package-lock.json')),bytes=await readFile(binary);
 const value={source:manifest.source,platform:process.platform,arch:process.arch,runtime:'0.161.0',lockHash:createHash('sha256').update(lock).digest('hex'),binaryHash:createHash('sha256').update(bytes).digest('hex')};
 if(verifyOnly){if(JSON.stringify(JSON.parse(await readFile(receiptPath,'utf8')))!==JSON.stringify(value))throw Error('Installed dependency receipt changed.');}
 else await writeFile(receiptPath,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});
 return binary;
}
const release=await prepareRelease(base,source,manifest,dependencies);
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
 // Finder drag escaping is intentionally not evaluated as shell input.
 const pairingPath=path.startsWith("'")&&path.endsWith("'")?path.slice(1,-1):path.replace(/\\ /g,' ');
 const p=await lstat(pairingPath);if(!p.isFile()||p.isSymbolicLink()||p.size>16384)throw Error('Invalid pairing file.');
 const pairing=JSON.parse(await readFile(pairingPath,'utf8'));
 if(pairing.version!==1||pairing.hubOrigin!=='https://work.dawar.ca'||pairing.fingerprint!==key.fingerprint||pairing.expiresAt<=Date.now())throw Error('Pairing file is expired or belongs to another machine.');
 const tokenPath=join(data,'pairing-token-'+randomUUID());await writeFile(tokenPath,pairing.token,{mode:0o600,flag:'wx'});
 let result;try{result=spawnSync(process.execPath,[join(release,'portable/agent-cli.mjs'),'pair','--config',configPath,'--token-file',tokenPath],{stdio:'inherit'});}finally{await rm(tokenPath);}
 if(result.status!==0)throw Error('Pairing is not confirmed. Retain the original grant and pending record; do not request another token after a lost acknowledgement.');
 console.log('Paired. Return to Settings to select this machine and approve its first bot. Execution remains disabled until that approval.');
}finally{input.close();}
