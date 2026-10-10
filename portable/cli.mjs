#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { installDefinitions } from './services.mjs';
import { nodeKey, PROTOCOL_VERSION, RUNTIME_VERSION } from './protocol.mjs';

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
  const {pairAgent}=await import('./enrollment-client.mjs');
  json(await pairAgent(c,option('token-file')));
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
