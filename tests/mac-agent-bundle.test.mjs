import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,writeFileSync,existsSync,chmodSync,statSync } from 'node:fs';
import { join } from 'node:path';
import { stageResources,readBundle,verifyTree,installTree,walkTree,NODE_SHA256,NODE_VERSION } from '../portable/mac-agent/bundle.mjs';
import { releaseRecord } from '../portable/mac-agent/release-tool.mjs';
import { agentDownload,nodeModules,nodeTarball,temp,SOURCE_A,RUNTIME } from './helpers/mac-agent-fixture.mjs';

const stage=(options={})=>{
  const tar=nodeTarball(options.arch,options.nodeArch),out=join(temp('resources-'),'Resources');
  return {out,result:stageResources({agentDownload:agentDownload(),nodeModules:nodeModules(options),nodeTarball:tar.archive,nodeSHA256:tar.sha256,out,appVersion:'1.0.0',build:3,arch:options.arch??'arm64'})};
};

test('pinned Node hashes are the same ones the existing installer verifies',()=>{
  const installer=readFileSync(new URL('../portable/agent-download/Install DawarTodo Agent.command',import.meta.url),'utf8');
  assert.match(installer,new RegExp(`darwin-arm64\\) agent_node_hash=${NODE_SHA256['darwin-arm64']}`));
  assert.match(installer,new RegExp(`darwin-x64\\) agent_node_hash=${NODE_SHA256['darwin-x64']}`));
  assert.match(installer,new RegExp(`node-v${NODE_VERSION.replaceAll('.','\\.')}-`));
});

test('arm64 resources hold Node, Codex outside the agent release, licenses and hash receipts',()=>{
  const {out,result}=stage();
  const {manifest,release,bundleManifestSHA256}=readBundle(out);
  assert.equal(bundleManifestSHA256,result.bundleManifestSHA256);
  assert.equal(release.agentSource,SOURCE_A);assert.equal(release.runtime,RUNTIME);assert.equal(release.codexTarget,'aarch64-apple-darwin');
  const paths=new Set(manifest.files.map(f=>f.path));
  for(const p of ['node/bin/node','node/LICENSE','codex/vendor/aarch64-apple-darwin/bin/codex','codex/vendor/aarch64-apple-darwin/codex-package.json',
    'agent/manifest.json','agent/portable/agent-cli.mjs','agent/node_modules/sharp/package.json','licenses/third-party.json','app-release.json'])assert.ok(paths.has(p),p);
  assert.ok(![...paths].some(p=>p.startsWith('agent/node_modules/@openai/')),'Codex is not duplicated inside the agent release');
  assert.ok(!paths.has('agent/Install DawarTodo Agent.command'));
  assert.ok(!paths.has('node/README.md'),'only the Node executable and license are bundled');
  const node=manifest.files.find(f=>f.path==='node/bin/node');
  assert.equal(node.mode,'0755');assert.deepEqual(node.macho,['arm64']);
  assert.equal(manifest.files.find(f=>f.path==='codex/vendor/aarch64-apple-darwin/bin/codex').mode,'0755');
  const licenses=JSON.parse(readFileSync(join(out,'licenses/third-party.json'),'utf8'));
  assert.deepEqual(licenses.map(l=>l.name).slice(0,2),['node','@openai/codex']);
  assert.ok(licenses.some(l=>l.name==='sharp'&&l.license==='Apache-2.0'));
  verifyTree(out,manifest.files);
});

test('any x64 Mach-O in an arm64 bundle refuses the whole staging',()=>{
  assert.throws(()=>stage({nodeArch:'x64'}),/do not target arm64: node\/bin\/node/);
  assert.throws(()=>stage({codexArch:'x64'}),/do not target arm64/);
  assert.throws(()=>stage({libArch:'x64'}),/sharp-darwin-arm64\.node/);
});

test('a Node archive with the wrong hash or a non-exact agent download is refused before anything is written',()=>{
  const tar=nodeTarball(),out=join(temp('resources-'),'Resources');
  assert.throws(()=>stageResources({agentDownload:agentDownload(),nodeModules:nodeModules(),nodeTarball:tar.archive,nodeSHA256:'0'.repeat(64),out,appVersion:'1.0.0',build:1}),/checksum/);
  assert.equal(existsSync(out),false);
  const bad=agentDownload();writeFileSync(join(bad,'manifest.json'),JSON.stringify({source:'HEAD',nodeMajor:24}));
  assert.throws(()=>stageResources({agentDownload:bad,nodeModules:nodeModules(),nodeTarball:tar.archive,nodeSHA256:tar.sha256,out,appVersion:'1.0.0',build:1}),/exact reviewed/);
  assert.throws(()=>stageResources({agentDownload:agentDownload(),nodeModules:nodeModules(),nodeTarball:tar.archive,nodeSHA256:tar.sha256,out,appVersion:'1.0',build:1}),/x\.y\.z/);
});

test('tampered resources, lost executable bits and changed receipts are detected',()=>{
  const {out}=stage(),{manifest}=readBundle(out);
  chmodSync(join(out,'node/bin/node'),0o644);
  assert.throws(()=>verifyTree(out,manifest.files),/lost its permission/);
  chmodSync(join(out,'node/bin/node'),0o755);
  writeFileSync(join(out,'agent/portable/agent-cli.mjs'),'changed');
  assert.throws(()=>verifyTree(out,manifest.files),/changed: agent\/portable\/agent-cli\.mjs/);
  const {out:other}=stage(),receipt=JSON.parse(readFileSync(join(other,'app-release.json'),'utf8'));
  writeFileSync(join(other,'app-release.json'),JSON.stringify({...receipt,build:99}));
  assert.throws(()=>readBundle(other),/receipt differs/);
});

test('installTree stages exclusively, keeps owner-only modes and refuses a changed existing install',()=>{
  const {out}=stage(),{manifest}=readBundle(out),destination=join(temp('install-'),'node-v24');
  assert.equal(installTree(out,manifest.files,'node',destination).installed,true);
  assert.equal(statSync(join(destination,'bin/node')).mode&0o777,0o700);
  assert.equal(statSync(join(destination,'LICENSE')).mode&0o777,0o600);
  assert.equal(installTree(out,manifest.files,'node',destination).installed,false);
  writeFileSync(join(destination,'LICENSE'),'changed');
  assert.throws(()=>installTree(out,manifest.files,'node',destination),/changed/);
});

test('release records bind the staged bundle and the exact archive bytes',()=>{
  const {out,result}=stage(),dir=temp('archive-'),archive=join(dir,'DawarTodoAgent-1.0.0-3.zip');
  writeFileSync(archive,'zip bytes');
  const record=releaseRecord({resources:out,archive,edSignature:'A'.repeat(86)+'==',publishedAt:'2026-10-15T00:00:00.000Z'});
  assert.equal(record.bundleManifestSHA256,result.bundleManifestSHA256);
  assert.equal(record.archive.bytes,9);assert.equal(record.build,3);assert.deepEqual(record.hub,{protocols:[1],runtimes:[RUNTIME]});
  assert.throws(()=>releaseRecord({resources:out,archive,edSignature:'short'}),/Invalid Mac agent release/);
  assert.ok(walkTree(out).length>5);
});
