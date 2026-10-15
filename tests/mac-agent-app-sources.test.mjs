import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync,cpSync,mkdirSync,copyFileSync,existsSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RUNTIME_COMPANIONS } from '../portable/runtime-companions.mjs';
import { MacAgentController } from '../portable/mac-agent/controller.mjs';
import { temp,agentDownload } from './helpers/mac-agent-fixture.mjs';

// Swift cannot be compiled on Linux; these checks pin the contract between
// the native shell, its Info.plist, the build script and the controller.
const root=fileURLToPath(new URL('../',import.meta.url));
const read=path=>readFileSync(join(root,path),'utf8');
const swiftDir='mac-agent/AgentApp/Sources/DawarTodoAgent';
const swift=readdirSync(join(root,swiftDir)).filter(n=>n.endsWith('.swift')).map(n=>read(join(swiftDir,n))).join('\n');
const cli=read('portable/mac-agent/cli.mjs');
const commands=new Set([...cli.matchAll(/^\s+(?:'([a-z-]+)'|([a-z]+)):\(\)=>/gm)].map(m=>m[1]??m[2]));
for(const line of cli.split('\n'))for(const m of line.matchAll(/(?:'([a-z-]+)'|\b([a-z]+)):\(\)=>controller/g))commands.add(m[1]??m[2]);

test('every controller command the Swift app invokes exists in the bundled CLI',()=>{
  const used=new Set([...swift.matchAll(/(?:client\.run|command|invoke)\("([a-z-]+)"/g)].map(m=>m[1]));
  assert.ok(used.size>=10,[...used].join());
  for(const name of used)assert.ok(commands.has(name),`Swift calls missing controller command ${name}`);
  assert.doesNotMatch(swift,/token/i,'the app never handles pairing tokens');
  assert.match(swift,/"--pairing-file", url\.path/);
});

test('the Swift status model decodes the fields the controller reports',()=>{
  const status=new MacAgentController({resources:null,home:temp('home-'),launchctl:()=>({status:113,stdout:'',stderr:''})}).status();
  for(const key of ['phase','agent','release','app','update','wanted','logs'])assert.ok(Object.hasOwn(status,key),key);
  for(const key of ['current','previous','staged','health'])assert.ok(Object.hasOwn(status.release,key),key);
  for(const key of ['directory','stdout','stderr'])assert.ok(Object.hasOwn(status.logs,key),key);
  const phaseEnum=swift.slice(swift.indexOf('enum Phase'),swift.indexOf('var title'));
  for(const phase of ['not-installed','needs-pairing','needs-activation','stopped','crashed','starting','unresponsive','disconnected','connected','working']){
    assert.ok(read('portable/mac-agent/controller.mjs').includes(`'${phase}'`),phase);
    assert.ok(phaseEnum.includes(`"${phase}"`)||new RegExp(`\\b${phase}\\b`).test(phaseEnum),`Swift Phase lacks ${phase}`);
  }
});

test('Info.plist, Package.swift and release records agree on identity, macOS floor and update settings',()=>{
  const plist=read('mac-agent/Info.plist.template'),pkg=read('mac-agent/AgentApp/Package.swift');
  assert.match(plist,/<key>CFBundleExecutable<\/key><string>DawarTodoAgent<\/string>/);assert.match(pkg,/name: "DawarTodoAgent"/);
  assert.match(plist,/<key>LSMinimumSystemVersion<\/key><string>13\.0<\/string>/);assert.match(pkg,/\.macOS\(\.v13\)/);
  assert.match(read('portable/mac-agent/release-tool.mjs'),/minimumMacOS='13\.0'/);
  assert.match(plist,/<key>LSUIElement<\/key><true\/>/);
  assert.match(plist,/<key>SUEnableAutomaticChecks<\/key><false\/>/);
  assert.match(plist,/<key>SUPublicEDKey<\/key><string>@SPARKLE_PUBLIC_ED_KEY@<\/string>/);
  assert.match(pkg,/sparkle-project\/Sparkle", exact: "\d+\.\d+\.\d+"/);
  assert.equal((plist.match(/<key>/g)??[]).length,(plist.match(/<\/key>/g)??[]).length);
});

test('the build script is valid bash and refuses to build the app off macOS',()=>{
  assert.equal(spawnSync('bash',['-n',join(root,'mac-agent/build-app.sh')]).status,0);
  const r=spawnSync('bash',[join(root,'mac-agent/build-app.sh'),'--version','1.0.0','--build','1','--agent-download',agentDownload()],{encoding:'utf8'});
  if(process.platform!=='darwin'){assert.equal(r.status,1);assert.match(r.stderr,/Build the app on macOS/);}
  const bad=spawnSync('bash',[join(root,'mac-agent/build-app.sh'),'--version','1.0','--build','1'],{encoding:'utf8'});
  assert.equal(bad.status,2);assert.match(bad.stderr,/x\.y\.z/);
  const script=read('mac-agent/build-app.sh');
  assert.match(script,/npm ci --ignore-scripts --no-bin-links/);
  assert.ok(script.indexOf('release-tool.mjs" seal')>script.indexOf('codesign')&&script.indexOf('release-tool.mjs" seal')<script.indexOf('ditto "$work/Resources"'),'hashes are sealed after signing and before assembly');
  assert.doesNotMatch(script,/notarytool submit[^\n]*--password|gh release|wrangler|scp |rsync /,'the build never publishes');
});

test('the agent download ships every module the Mac controller imports',()=>{
  const source=read('portable/agent-package.mjs'),dir=temp('shipped-');
  const lists=[...source.matchAll(/for\(const file of \[([^\]]+)\]\)await cp\(join\('([^']+)',file\),join\(directory,'([^']+)',file\)\)/g)];
  assert.ok(lists.length>=2);
  cpSync(join(root,'portable/agent-download'),join(dir,'portable'),{recursive:true});
  for(const [,names,from,to] of lists)for(const name of names.match(/'[^']+'/g).map(n=>n.slice(1,-1))){mkdirSync(join(dir,to),{recursive:true});copyFileSync(join(root,from,name),join(dir,to,name));}
  mkdirSync(join(dir,'bot-bridge'),{recursive:true});for(const name of RUNTIME_COMPANIONS)copyFileSync(join(root,'bot-bridge',name),join(dir,'bot-bridge',name));
  // Every module reachable from the shipped entry points resolves inside the
  // installed layout (setup.mjs and the controller run from there). The
  // bundled agent itself is a single file and is checked by its own build.
  const queue=['portable/setup.mjs','portable/agent-cli.mjs','portable/mac-agent/cli.mjs'].map(p=>join(dir,p)),seen=new Set();
  while(queue.length){
    const file=queue.pop();if(seen.has(file))continue;seen.add(file);
    for(const [,spec] of readFileSync(file,'utf8').matchAll(/(?:from |import\()'(\.{1,2}\/[^']+)'/g)){
      const target=resolve(dirname(file),spec);
      if(target===join(dir,'bot-bridge/portable-agent.mjs'))continue;
      assert.ok(existsSync(target),`${file.slice(dir.length)} imports missing ${spec}`);queue.push(target);
    }
  }
  assert.ok(seen.size>=12,`${seen.size} shipped modules reached`);
  const r=spawnSync(process.execPath,[join(dir,'portable/mac-agent/cli.mjs'),'status','--resources',agentDownload()],{encoding:'utf8',env:{...process.env,HOME:temp('home-')}});
  const reply=JSON.parse(r.stdout);
  assert.equal(reply.ok,true,r.stderr);assert.equal(reply.result.phase,'not-installed');
  const unknown=spawnSync(process.execPath,[join(dir,'portable/mac-agent/cli.mjs'),'rm-rf','--resources','x'],{encoding:'utf8',env:{...process.env,HOME:temp('home-')}});
  assert.equal(unknown.status,1);assert.equal(JSON.parse(unknown.stdout).ok,false);
});
