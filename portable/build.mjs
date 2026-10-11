import { RUNTIME_COMPANIONS } from './runtime-companions.mjs';
import { RUNTIME_VERSION } from './protocol.mjs';
import { build } from 'esbuild';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// The generated native contracts, compatibility handshake and downloader must
// describe the same reviewed runtime, even before an installer is executed.
const dependencies=JSON.parse(await readFile('portable/agent-dependencies/package.json','utf8'));
const lock=JSON.parse(await readFile('portable/agent-dependencies/package-lock.json','utf8'));
const codex=lock.packages?.['node_modules/@openai/codex'];
if(dependencies.dependencies?.['@openai/codex']!==RUNTIME_VERSION||lock.packages?.['']?.dependencies?.['@openai/codex']!==RUNTIME_VERSION||
  codex?.version!==RUNTIME_VERSION||!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(codex.integrity??'')||
  codex.resolved!==`https://registry.npmjs.org/@openai/codex/-/codex-${RUNTIME_VERSION}.tgz`)
  throw Error('Portable dependency lock does not match the reviewed native runtime.');
await mkdir('dist/portable',{recursive:true});
await build({ entryPoints:['portable/gateway.mjs'],outfile:'dist/portable/gateway.mjs',bundle:true,platform:'node',target:'node24',format:'esm',packages:'external' });
await build({ entryPoints:['portable/agent.mjs'],outfile:'dist/portable/portable-agent.mjs',bundle:true,platform:'node',target:'node24',format:'esm',packages:'external' });
for(const file of RUNTIME_COMPANIONS)await cp(`bot-bridge/${file}`,`dist/portable/${file}`);
await cp('bot-bridge/desktops','dist/portable/desktops',{recursive:true});
await cp('public','.next-portable/standalone/public',{recursive:true});
const releaseSource=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
// The standalone server does not run Vinext's generated build-marker plugin.
// Give its existing PWA lifecycle the same truthful marker and a fresh shell
// generation. Activation still keeps the previous shell and never navigates
// an open client or clears drafts, IDB, questions, calls or private inputs.
const shellGeneration=Date.now();
await writeFile('.next-portable/standalone/public/pwa-build.json',JSON.stringify({build:process.env.DAWAR_BUILD_ID??releaseSource.slice(0,12),databaseVersion:11})+'\n');
const workerPath='.next-portable/standalone/public/sw.js';
let workerSource=await readFile(workerPath,'utf8');
if(!workerSource.includes('const CACHE_NAME = `${CACHE_PREFIX}v104`;'))throw Error('Review the changed original PWA generation before portable packaging.');
const resourceBoundary='if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;';
const fetchBoundary='if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/calendar/")) return;';
const documentBoundary='async function refreshDocumentShell(response, cacheKey) {\n  if (!response.ok) return;';
if(!workerSource.includes(resourceBoundary)||!workerSource.includes(fetchBoundary)||!workerSource.includes(documentBoundary))throw Error('Review the changed PWA authentication/cache boundaries before portable packaging.');
const authBoundary='url.pathname.startsWith("/auth/") || ["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"].includes(url.pathname)';
workerSource=workerSource.replace(resourceBoundary,`if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || ${authBoundary}) return;`)
  .replace(fetchBoundary,`if (url.origin !== self.location.origin || url.pathname.startsWith("/api/") || url.pathname.startsWith("/calendar/") || ${authBoundary}) return;`)
  .replace(documentBoundary,'async function refreshDocumentShell(response, cacheKey) {\n  if (!response.ok || new URL(response.url).origin !== self.location.origin) return;')
  .replace('if (!page.ok) throw new Error(`Could not cache the app shell (${page.status}).`);','if (!page.ok || new URL(page.url).origin !== self.location.origin) throw new Error(`Could not cache the app shell (${page.status}).`);');
await writeFile(workerPath,workerSource.replace('const CACHE_NAME = `${CACHE_PREFIX}v104`;',`const CACHE_NAME = \`\${CACHE_PREFIX}v${shellGeneration}\`;`));
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
await writeFile('dist/portable/build.json',JSON.stringify({version:1,source:releaseSource,nodeMajor:24,protocol:1,runtime:RUNTIME_VERSION,shellGeneration,
  gatewaySHA256:await checksum('dist/portable/gateway.mjs'),agentSHA256:await checksum('dist/portable/portable-agent.mjs')},null,2)+'\n');
