import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,mkdirSync,writeFileSync,chmodSync,readFileSync,existsSync,openSync,readSync,closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { codexTarget,resolveCodexLaunch,verifyCodexVersion,machOArchitectures,RuntimeLaunchError,redact } from '../portable/codex-runtime.mjs';

const VERSION='0.162.1';
function vendor(target,{layout={},script=`#!/bin/sh\necho "codex-cli ${VERSION}"\n`,mode=0o755}={}) {
  const root=mkdtempSync(join(tmpdir(),'codex-layout-')),dir=join(root,'vendor',target);
  mkdirSync(join(dir,'bin'),{recursive:true});mkdirSync(join(dir,'codex-path'));mkdirSync(join(dir,'codex-resources'));
  writeFileSync(join(dir,'codex-package.json'),JSON.stringify({layoutVersion:1,version:VERSION,target,variant:'codex',entrypoint:'bin/codex',resourcesDir:'codex-resources',pathDir:'codex-path',...layout}));
  writeFileSync(join(dir,'bin/codex'),script);chmodSync(join(dir,'bin/codex'),mode);
  return root;
}

test('Apple Silicon resolves the package-owned bin/codex entrypoint, not the absent codex/codex guess',()=>{
  assert.equal(codexTarget('darwin','arm64'),'aarch64-apple-darwin');
  const root=vendor('aarch64-apple-darwin'),launch=resolveCodexLaunch(root,{platform:'darwin',arch:'arm64',version:VERSION});
  assert.equal(launch.binary,join(root,'vendor/aarch64-apple-darwin/bin/codex'));
  assert.equal(launch.pathDir,join(root,'vendor/aarch64-apple-darwin/codex-path'));
  assert.equal(existsSync(join(root,'vendor/aarch64-apple-darwin/codex/codex')),false);
  const setup=readFileSync(new URL('../portable/agent-download/setup.mjs',import.meta.url),'utf8');
  assert.match(setup,/resolveCodexLaunch\(/);
  assert.doesNotMatch(setup,/'codex','codex'/);
});

test('layout tampering, wrong targets and non-executable entrypoints are refused',()=>{
  assert.throws(()=>resolveCodexLaunch(vendor('aarch64-apple-darwin',{layout:{entrypoint:'../../x'}}),{platform:'darwin',arch:'arm64'}),/escapes/);
  assert.throws(()=>resolveCodexLaunch(vendor('aarch64-apple-darwin',{layout:{target:'x86_64-apple-darwin'}}),{platform:'darwin',arch:'arm64'}),/approved/);
  assert.throws(()=>resolveCodexLaunch(vendor('aarch64-apple-darwin',{layout:{version:'0.161.0'}}),{platform:'darwin',arch:'arm64',version:VERSION}),/approved/);
  assert.throws(()=>resolveCodexLaunch(vendor('aarch64-apple-darwin',{mode:0o644}),{platform:'darwin',arch:'arm64'}),/not executable/);
  assert.throws(()=>resolveCodexLaunch(vendor('x86_64-apple-darwin'),{platform:'darwin',arch:'arm64'}),/layout is missing/);
  assert.throws(()=>codexTarget('win32','x64'),/Unsupported/);
});

test('version verification launches the resolved binary and reports exit, signal and OS errors without secrets',{skip:process.platform==='win32'},()=>{
  const target=codexTarget(process.platform,process.arch);
  assert.ok(verifyCodexVersion(resolveCodexLaunch(vendor(target)),VERSION).stdout.includes(VERSION));
  const failing=resolveCodexLaunch(vendor(target,{script:'#!/bin/sh\necho "Authorization: Bearer abcdefghijklmnop" >&2\nexit 3\n'}));
  assert.throws(()=>verifyCodexVersion(failing,VERSION),e=>{
    assert.ok(e instanceof RuntimeLaunchError);assert.match(e.message,/exit status 3/);
    assert.equal(e.diagnostics.status,3);assert.match(e.diagnostics.stderr,/Bearer \[redacted\]/);assert.doesNotMatch(e.diagnostics.stderr,/abcdefghijklmnop/);
    return true;
  });
  const signalled=resolveCodexLaunch(vendor(target,{script:'#!/bin/sh\nkill -9 $$\n'}));
  assert.throws(()=>verifyCodexVersion(signalled,VERSION),e=>e.diagnostics.signal==='SIGKILL'&&/signal SIGKILL/.test(e.message));
  const wrong=resolveCodexLaunch(vendor(target,{script:'#!/bin/sh\necho "codex-cli 0.1"\n'}));
  assert.throws(()=>verifyCodexVersion(wrong,VERSION),/unexpected version/);
  const missing={binary:'/nonexistent/codex',pathDir:'/nonexistent'};
  assert.throws(()=>verifyCodexVersion(missing,VERSION),e=>e.diagnostics.error.code==='ENOENT'&&/ENOENT/.test(e.message));
  assert.equal(redact('token=sk-abcdefghijklmnop'),'token=[redacted]');
});

test('Mach-O headers identify arm64, x64 and universal binaries without executing them',()=>{
  const thin=cpu=>{const b=Buffer.alloc(32);b.writeUInt32LE(0xfeedfacf,0);b.writeUInt32LE(cpu,4);return b;};
  assert.deepEqual(machOArchitectures(thin(0x0100000c)),['arm64']);
  assert.deepEqual(machOArchitectures(thin(0x01000007)),['x64']);
  const fat=Buffer.alloc(48);fat.writeUInt32BE(0xcafebabe,0);fat.writeUInt32BE(2,4);fat.writeUInt32BE(0x01000007,8);fat.writeUInt32BE(0x0100000c,28);
  assert.deepEqual(machOArchitectures(fat),['x64','arm64']);
  assert.equal(machOArchitectures(Buffer.from('#!/bin/sh\n')),null);
});

// The integrity-verified pinned archive from the owner Mac diagnosis. It is
// private evidence outside the repository, so the check skips without it.
const ARCHIVE=process.env.DAWAR_CODEX_DARWIN_ARM64_TGZ??'/home/dawar/bots/dwight-lead-developer-dawartodo/mac-installer-diagnosis-20261014/codex-0.162.1-darwin-arm64.tgz';
test('the pinned 0.162.1 darwin-arm64 archive matches the lock and resolves to an arm64 bin/codex',{skip:!existsSync(ARCHIVE)&&'pinned darwin-arm64 archive not present'},()=>{
  const lock=JSON.parse(readFileSync(new URL('../portable/agent-dependencies/package-lock.json',import.meta.url),'utf8'));
  const integrity=lock.packages['node_modules/@openai/codex-darwin-arm64'].integrity;
  assert.equal('sha512-'+createHash('sha512').update(readFileSync(ARCHIVE)).digest('base64'),integrity);
  const root=mkdtempSync(join(tmpdir(),'codex-pinned-'));
  execFileSync('tar',['-xzf',ARCHIVE,'-C',root,'package/vendor/aarch64-apple-darwin/codex-package.json','package/vendor/aarch64-apple-darwin/bin/codex']);
  mkdirSync(join(root,'package/vendor/aarch64-apple-darwin/codex-path'),{recursive:true});
  const launch=resolveCodexLaunch(join(root,'package'),{platform:'darwin',arch:'arm64',version:VERSION});
  assert.equal(launch.binary,join(root,'package/vendor/aarch64-apple-darwin/bin/codex'));
  const header=Buffer.alloc(16),fd=openSync(launch.binary,'r');try{readSync(fd,header,0,16,0);}finally{closeSync(fd);}
  assert.deepEqual(machOArchitectures(header),['arm64']);
});
