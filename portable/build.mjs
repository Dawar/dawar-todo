import { RUNTIME_COMPANIONS } from './runtime-companions.mjs';
import { build } from 'esbuild';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
await mkdir('dist/portable',{recursive:true});
await build({ entryPoints:['portable/gateway.mjs'],outfile:'dist/portable/gateway.mjs',bundle:true,platform:'node',target:'node24',format:'esm',packages:'external' });
await build({ entryPoints:['portable/agent.mjs'],outfile:'dist/portable/portable-agent.mjs',bundle:true,platform:'node',target:'node24',format:'esm',packages:'external' });
for(const file of RUNTIME_COMPANIONS)await cp(`bot-bridge/${file}`,`dist/portable/${file}`);
await cp('public','.next-portable/standalone/public',{recursive:true});
await mkdir('.next-portable/standalone/public/portable-assets',{recursive:true});
await cp('node_modules/pdfjs-dist/build/pdf.worker.min.mjs','.next-portable/standalone/public/portable-assets/pdf.worker.min.mjs');
for(const folder of ['cmaps','standard_fonts','wasm'])await cp(`node_modules/pdfjs-dist/${folder}`,`.next-portable/standalone/public/portable-assets/pdf/${folder}`,{recursive:true});
await cp('.next-portable/static','.next-portable/standalone/.next-portable/static',{recursive:true});
// Next embeds build-machine roots for tracing. Runtime roots belong to the
// installation directory; strip those diagnostic defaults from the launcher.
const launcher='.next-portable/standalone/server.js';
const source=await readFile(launcher,'utf8');
if(!source.includes('nextConfig.outputFileTracingRoot=__dirname;'))await writeFile(launcher,source.replace('process.env.__NEXT_PRIVATE_STANDALONE_CONFIG',
  'nextConfig.outputFileTracingRoot=__dirname; nextConfig.repoRoot=__dirname; if(nextConfig.turbopack)nextConfig.turbopack.root=__dirname;\nprocess.env.__NEXT_PRIVATE_STANDALONE_CONFIG'));
const checksum=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile('dist/portable/build.json',JSON.stringify({version:1,source:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),nodeMajor:24,protocol:1,runtime:'0.161.0',
  gatewaySHA256:await checksum('dist/portable/gateway.mjs'),agentSHA256:await checksum('dist/portable/portable-agent.mjs')},null,2)+'\n');
