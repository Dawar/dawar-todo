#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { installDefinitions } from './services.mjs';
import { nodeKey, signature, digest, PROTOCOL_VERSION, RUNTIME_VERSION } from './protocol.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const args=process.argv.slice(2),command=args.shift();
function option(name){const index=args.indexOf(`--${name}`);return index<0?null:args[index+1];}
function json(value){console.log(JSON.stringify(value,null,2));}
if (Number(process.versions.node.split('.')[0])!==24) throw Error('DawarTodo portable requires Node 24.');
if(command==='version') {
  json({package:'dawartodo',protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION,node:process.versions.node});
} else if(command==='install') {
  const configPath=option('config'),c=loadConfig(configPath),mode=option('mode')??c.mode;
  if(mode!==c.mode)throw Error('Installation mode differs from configuration.');
  const paths=await installDefinitions({mode,releaseDirectory:root,configPath});json({installed:paths,activated:false});
} else if(command==='key') {
  const directory=option('data');if(!directory)throw Error('Provide the agent data directory.');
  const k=nodeKey(join(resolve(directory),'node-key.pem'));json({fingerprint:k.fingerprint,publicKey:k.publicKey});
} else if(command==='pair') {
  const c=loadConfig(option('config'));if(c.mode==='hub')throw Error('Only an agent can pair.');
  const u=new URL(option('hub')??c.agent.hubOrigin);
  if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('Pair with a fixed HTTPS hub origin.');
  // Token is read from a private file, never a process argument or log.
  const token=(await readFile(option('token-file'),'utf8')).trim(),key=nodeKey(join(c.dataDirectory,'node-key.pem'));
  const hello={protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION,platform:process.platform,arch:process.arch,capabilities:{text:true,localStdio:true,desktop:false,voice:false,secureTransfer:false,autonomousGoals:false}};
  async function post(path,body){const r=await fetch(new URL(path,u),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Enrollment was not accepted. Retain the original request; do not create another grant after uncertain acceptance.');return r.json();}
  await mkdir(c.dataDirectory,{recursive:true,mode:0o700});
  // Persist original grant/key proof before the remote write. Lost ACK stays
  // unknown and requires owner reconciliation, rather than a second identity.
  const pendingPath=join(c.dataDirectory,'enrollment-pending.json');
  await writeFile(pendingPath,JSON.stringify({tokenHash:digest(token),fingerprint:key.fingerprint,hub:u.origin,createdAt:Date.now()}),{mode:0o600,flag:'wx'});
  const challenge=await post('/nodes/enroll/challenge',{token,publicKey:key.publicKey});
  const bound={grantId:challenge.grantId,challenge:challenge.challenge,hello};
  await writeFile(pendingPath,JSON.stringify({grantId:challenge.grantId,fingerprint:key.fingerprint,hub:u.origin,createdAt:Date.now()}),{mode:0o600});
  const result=await post('/nodes/enroll/prove',{...bound,proof:signature(key.privateKey,bound)});
  await writeFile(join(c.dataDirectory,'node-enrollment.json'),JSON.stringify({...result,hub:u.origin}),{mode:0o600,flag:'wx'});
  json({nodeId:result.nodeId,fingerprint:key.fingerprint,paired:true,executionStarted:false});
} else if(command==='run' && args[0]==='hub') {
  const c=loadConfig(option('config'));if(c.mode==='agent')throw Error('Agent configuration cannot start a hub.');
  process.umask(0o077);
  const {startGateway}=await import('../dist/portable/gateway.mjs');
  const gateway=startGateway(c);
  const child=spawn(process.execPath,[join(root,'.next-portable/standalone/server.js')],{cwd:join(root,'.next-portable/standalone'),env:{...process.env,DAWAR_HUB_CONFIG:resolve(option('config')),PORT:String(c.sitePort??3211),HOSTNAME:'127.0.0.1'},stdio:'inherit'});
  child.on('exit',()=>{void gateway.close().then(()=>process.exit(1));});
  // The hub has no local Codex child or admitted model turn. Agents have their
  // own maintenance boundary and survive a hub transport outage.
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void gateway.close().then(()=>{child.kill('SIGTERM');});});
} else if(command==='run' && args[0]==='agent') {
  const c=loadConfig(option('config'));if(c.mode==='hub')throw Error('Hub configuration cannot start an agent.');
  const {runAgent}=await import('../bot-bridge/portable-agent.mjs');await runAgent(c);
} else {
  throw Error('Use version, key --data PATH, pair --config PATH --token-file PATH, install --mode hub|agent|both --config PATH, or run hub|agent --config PATH.');
}
