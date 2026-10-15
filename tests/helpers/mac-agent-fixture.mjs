// Linux stand-ins for the Agent.app inputs: Mach-O headers (never executed),
// an exact-source agent download, an npm tree and a nodejs.org-shaped archive.
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const SOURCE_A='a'.repeat(40),SOURCE_B='b'.repeat(40),RUNTIME='0.162.1';
export const temp=prefix=>mkdtempSync(join(tmpdir(),prefix));
export function machO(arch='arm64',size=64){const b=Buffer.alloc(size);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(arch==='arm64'?0x0100000c:0x01000007,4);return b;}
const put=(path,bytes,mode=0o644)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,bytes);chmodSync(path,mode);};

// agent-cli stand-in: pairing reads the private token file and records an
// enrollment receipt exactly where enrollment-client would.
const FAKE_AGENT_CLI=`import {readFileSync,writeFileSync,statSync} from 'node:fs';import {join} from 'node:path';
const a=process.argv.slice(2),o=n=>a[a.indexOf('--'+n)+1],c=JSON.parse(readFileSync(o('config'),'utf8'));
if(a[0]==='pair'){const t=o('token-file');if((statSync(t).mode&0o777)!==0o600)process.exit(9);const token=readFileSync(t,'utf8');
writeFileSync(join(c.dataDirectory,'node-enrollment.json'),JSON.stringify({nodeId:'node:'+'n'.repeat(24),owner:'owner',fingerprint:'f',hub:'https://work.dawar.ca'}),{mode:0o600});
console.log(JSON.stringify({nodeId:'node:'+'n'.repeat(24),paired:true,tokenLength:token.length}));}`;

export function agentDownload(source=SOURCE_A) {
  const dir=temp('agent-download-');
  put(join(dir,'portable/agent-cli.mjs'),FAKE_AGENT_CLI);
  put(join(dir,'bot-bridge/portable-agent.mjs'),'export async function runAgent(){}\n');
  put(join(dir,'Install DawarTodo Agent.command'),'#!/bin/bash\n',0o755);
  writeFileSync(join(dir,'manifest.json'),JSON.stringify({source,protocol:1,runtime:RUNTIME,nodeMajor:24,platforms:['darwin-arm64'],files:[]},null,2)+'\n');
  return dir;
}
export function nodeModules({arch='arm64',codexArch=arch,libArch=arch}={}) {
  const dir=temp('node-modules-'),target=arch==='arm64'?'aarch64-apple-darwin':'x86_64-apple-darwin',pkg=join(dir,'@openai',`codex-darwin-${arch}`);
  put(join(pkg,'package.json'),JSON.stringify({name:'@openai/codex',version:`${RUNTIME}-darwin-${arch}`,license:'Apache-2.0'}));
  put(join(pkg,'vendor',target,'codex-package.json'),JSON.stringify({layoutVersion:1,version:RUNTIME,target,variant:'codex',entrypoint:'bin/codex',resourcesDir:'codex-resources',pathDir:'codex-path'}));
  put(join(pkg,'vendor',target,'bin/codex'),machO(codexArch,256),0o755);
  put(join(pkg,'vendor',target,'codex-path/rg'),machO(codexArch),0o755);
  put(join(pkg,'vendor',target,'codex-resources/NOTICE.md'),'notice\n');
  put(join(dir,'@openai/codex/package.json'),JSON.stringify({name:'@openai/codex',version:RUNTIME,license:'Apache-2.0'}));
  put(join(dir,'sharp/package.json'),JSON.stringify({name:'sharp',version:'0.35.5',license:'Apache-2.0'}));
  put(join(dir,`@img/sharp-darwin-${arch}/package.json`),JSON.stringify({name:`@img/sharp-darwin-${arch}`,version:'0.35.5',license:'Apache-2.0'}));
  put(join(dir,`@img/sharp-darwin-${arch}/lib/sharp-darwin-${arch}.node`),machO(libArch),0o755);
  return dir;
}
export function nodeTarball(arch='arm64',nodeArch=arch) {
  const dir=temp('node-tarball-'),name=`node-v24.21.0-darwin-${arch}`;
  put(join(dir,name,'bin/node'),machO(nodeArch,128),0o755);put(join(dir,name,'LICENSE'),'Node.js license\n');put(join(dir,name,'README.md'),'readme\n');
  const archive=join(dir,`${name}.tar.gz`);execFileSync('tar',['-czf',archive,'-C',dir,name]);
  return {archive,sha256:createHash('sha256').update(readFileSync(archive)).digest('hex')};
}
