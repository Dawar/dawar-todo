import { lstat,readFile,writeFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const HUB_ORIGIN='https://work.dawar.ca';

// Finder drag escaping is intentionally not evaluated as shell input.
export const draggedPath=text=>{const t=text.trim();return t.startsWith("'")&&t.endsWith("'")?t.slice(1,-1):t.replace(/\\ /g,' ');};

// The owner downloads a five-minute pairing file from Settings → Execution
// machines. It binds this machine's key fingerprint; the token inside is only
// ever written to a private 0600 file for agent-cli pair and removed after.
export async function readPairingFile(path,{fingerprint,now=Date.now(),hubOrigin=HUB_ORIGIN}) {
  const p=await lstat(path);if(!p.isFile()||p.isSymbolicLink()||p.size>16384)throw Error('Invalid pairing file.');
  const pairing=JSON.parse(await readFile(path,'utf8'));
  if(pairing.version!==1||pairing.hubOrigin!==hubOrigin||pairing.fingerprint!==fingerprint||!(pairing.expiresAt>now)||typeof pairing.token!=='string')
    throw Error('Pairing file is expired or belongs to another machine.');
  return pairing;
}
export async function pairWithFile({pairingPath,fingerprint,data,configPath,release,node=process.execPath,spawn=spawnSync,stdio='inherit',now}) {
  const pairing=await readPairingFile(pairingPath,{fingerprint,now});
  const tokenPath=join(data,'pairing-token-'+randomUUID());await writeFile(tokenPath,pairing.token,{mode:0o600,flag:'wx'});
  let result;try{result=spawn(node,[join(release,'portable/agent-cli.mjs'),'pair','--config',configPath,'--token-file',tokenPath],{stdio,encoding:'utf8'});}finally{await rm(tokenPath,{force:true});}
  if(result.status!==0)throw Error('Pairing is not confirmed. Retain the original grant and pending record; do not request another token after a lost acknowledgement.');
  return result;
}
