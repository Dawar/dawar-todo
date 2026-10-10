#!/usr/bin/env node
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { installDefinitions } from './services.mjs';
import { nodeKey, PROTOCOL_VERSION, RUNTIME_VERSION } from './protocol.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const args=process.argv.slice(2),command=args.shift();
function option(name){const index=args.indexOf(`--${name}`);return index<0?null:args[index+1];}
function json(value){console.log(JSON.stringify(value,null,2));}
async function privateSnapshotDestination(destination) {
  const {dirname}=await import('node:path');
  const {mkdir,lstat}=await import('node:fs/promises');
  const directory=dirname(resolve(destination));
  await mkdir(directory,{recursive:true,mode:0o700});
  const state=await lstat(directory);
  if(!state.isDirectory()||state.isSymbolicLink()||state.mode&0o077||process.getuid&&state.uid!==process.getuid())throw Error('Use an owner-only snapshot directory.');
}
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
} else if(command==='export-application' || command==='import-application') {
  const source=option('source'),destination=option('destination');
  if(!source||!destination)throw Error('Provide the exact source and a new private destination.');
  const {exportSQLiteApplication,importApplicationSnapshot}=await import('./application-export.mjs');
  const signal=AbortSignal.timeout(120000);
  process.umask(0o077);
  json(command==='export-application'
    ? await exportSQLiteApplication({source,destination,signal})
    : await importApplicationSnapshot({source,destination,signal,expectedSHA256:option('sha256')}));
} else if(command==='export-original-application') {
  const configuration=option('configuration');if(!configuration)throw Error('Provide the reviewed private original-capture configuration path.');
  process.umask(0o077);
  try {
    const {readPrivate}=await import('./private-file.mjs');
    const {exportOwnerSessionApplication}=await import('./owner-session-read.mjs');
    const configPath=resolve(configuration),c=JSON.parse(readPrivate(configPath));
    const fields=['version','kind','capture','ownerIdentityFile','sessionFile','recipientFile','destination'];
    if(!c||Object.keys(c).length!==fields.length||Object.keys(c).some(k=>!fields.includes(k))||c.version!==1||c.kind!=='dawar-original-application-export')throw Error('Capture configuration differs.');
    const path=value=>{if(typeof value!=='string'||!value)throw Error('Private path required.');return resolve(dirname(configPath),value);};
    const identity=JSON.parse(readPrivate(path(c.ownerIdentityFile))),recipient=JSON.parse(readPrivate(path(c.recipientFile)));
    const result=await exportOwnerSessionApplication({capture:c.capture,recipient,expectedOwner:{ownerUserId:identity.ownerUserId,ownerKey:identity.ownerKey},
      sessionPath:path(c.sessionFile),destination:path(c.destination),signal:AbortSignal.timeout(900000)});
    json({format:result.format,version:result.version,bytes:result.bytes,sha256:result.sha256,tableCount:result.tables.length,
      automaticExecutionDisabled:result.automaticExecutionDisabled,sourceWriterFreeze:result.productionWriterFreezeEstablished,
      note:'Private application snapshot only; control/files, migration authority and public rollover remain separate.'});
  }catch{throw Error('Original owner-authenticated capture was not confirmed. Retain its original configuration and receipts; do not retry uncertain operations.');}
} else if(command==='snapshot-key') {
  const destination=option('destination');if(!destination)throw Error('Provide a new private recipient-key destination.');
  const {newSnapshotRecipient}=await import('./snapshot-sealing.mjs');
  const {savePrivate}=await import('./private-file.mjs');
  await privateSnapshotDestination(destination);
  const recipient=await newSnapshotRecipient();savePrivate(resolve(destination),JSON.stringify(recipient)+'\n',{exclusive:true});
  json({publicKey:recipient.publicKey,fingerprint:recipient.fingerprint,privateKeyPrinted:false});
} else if(command==='unseal-application') {
  const source=option('source'),key=option('key'),destination=option('destination'),origin=option('origin');
  if(!source||!key||!destination||!origin)throw Error('Provide exact ciphertext/key paths, original HTTPS origin and a new private destination.');
  const {unsealApplicationSnapshot}=await import('./snapshot-sealing.mjs');
  const {readPrivate,savePrivate}=await import('./private-file.mjs');
  await privateSnapshotDestination(destination);
  const decoded=await unsealApplicationSnapshot(JSON.parse(readPrivate(resolve(source),20*1024*1024)),JSON.parse(readPrivate(resolve(key))),origin);
  savePrivate(resolve(destination),decoded.snapshot,{exclusive:true});
  json({sha256:decoded.sha256,sourceOrigin:decoded.sourceOrigin,sourceAuthenticationEstablished:false,
    note:'Verify the original owner-authenticated HTTPS download separately before migration.'});
} else if(command==='run' && args[0]==='hub') {
  const c=loadConfig(option('config'));if(c.mode==='agent')throw Error('Agent configuration cannot start a hub.');
  process.umask(0o077);
  const {startGateway}=await import('../dist/portable/gateway.mjs');
  const gateway=startGateway(c);
  const child=spawn(process.execPath,[join(root,'.next-portable/standalone/server.js')],{cwd:join(root,'.next-portable/standalone'),env:{...process.env,DAWAR_HUB_CONFIG:resolve(option('config')),PORT:String(c.sitePort??3211),HOSTNAME:'127.0.0.1'},stdio:'inherit'});
  let shutdownConfirmed=false;
  const retainedShutdown=()=>console.error('Hub shutdown is blocked by original active or unconfirmed voice work. Preserve its state and use the reviewed handoff.');
  child.on('exit',()=>{void gateway.close().then(()=>process.exit(shutdownConfirmed?0:1)).catch(retainedShutdown);});
  // Agents own their native maintenance boundary. Hub voice/provider work has
  // its own drain and must finish before the local site is stopped.
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void gateway.close().then(()=>{shutdownConfirmed=true;child.kill('SIGTERM');}).catch(retainedShutdown);});
} else if(command==='run' && args[0]==='agent') {
  const c=loadConfig(option('config'));if(c.mode==='hub')throw Error('Hub configuration cannot start an agent.');
  const {runAgent}=await import('../bot-bridge/portable-agent.mjs');await runAgent(c);
} else {
  throw Error('Use version, key, pair, install, run hub|agent, export-application, import-application, export-original-application, snapshot-key, or unseal-application.');
}
