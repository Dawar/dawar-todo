import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {cpSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HubStore} from '../portable/control-store.mjs';
import {RUNTIME_COMPANIONS} from '../portable/runtime-companions.mjs';

// Real hub controls and submission acceptance; disposable SQLite, no node.
test('a bot messages any other bot by name through the hub, on any team or none',async t=>{
  const root=fileURLToPath(new URL('../',import.meta.url));mkdirSync(join(root,'dist'),{recursive:true});
  const dir=mkdtempSync(join(root,'dist','messaging-names-'));let hub,controls;
  t.after(()=>{controls?.close();hub?.close();rmSync(dir,{recursive:true,force:true});});
  for(const name of RUNTIME_COMPANIONS)cpSync(join(root,'bot-bridge',name),join(dir,name));
  await build({entryPoints:[join(root,'portable/hub-controls.mjs')],outfile:join(dir,'controls.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',packages:'external',logLevel:'error'});
  const {HubControls}=await import(pathToFileURL(join(dir,'controls.mjs')).href),path=join(dir,'state.sqlite');
  hub=new HubStore(path);
  hub.db.exec("INSERT INTO portable_nodes VALUES('node','owner','unused','fingerprint','{}',NULL,1); INSERT INTO portable_authority VALUES(1,'writer',1,0)");
  for(const b of ['connie','claudia','dwight','dwight-copy','unplaced'])if(b!=='unplaced')hub.db.prepare("INSERT INTO portable_placements VALUES(?,'owner','node',1,1,0)").run(b);
  controls=new HubControls({path,hub,owner:{key:'owner',userId:'owner-id',name:'Dawar'},router:{connection:()=>null},authority:{writerId:'writer',epoch:1}});
  const save=(id,name,extra={})=>controls.store.saveBot({id,slug:`${id}-workspace`,name,threadId:`thread-${id}`,executionMode:'single-thread',mode:'default',burstQuietSeconds:3,...extra});
  save('connie','Connie: Communications Manager',{teamId:'team-a'});save('claudia','Claudia: Lead Developer DawarTodo',{provider:'claude'});
  save('dwight','Dwight: Lead Developer DawarTodo');save('dwight-copy','Dwight: Lead Developer (copy)');save('unplaced','Ursula');
  const caller={kind:'authenticated-node-tool',botId:'connie',nodeId:'node',epoch:1};
  const tool=args=>controls.tool('owner','connie','bots_message',args,caller);

  const {bots}=await tool({operation:'directory'});
  assert.deepEqual(bots.map(b=>b.id).sort(),['claudia','dwight','dwight-copy'],'placed, active, not self; teamless included');

  const sent=await tool({operation:'send',recipient:'Claudia',text:'Hi Claudia, test from Connie.',operationId:'connie-claudia-test-0001'});
  assert.equal(sent.recipientBotId,'claudia');
  const queued=controls.store.list('promptQueue','claudia');
  assert.equal(queued.length,1);assert.equal(queued[0].input[0].text,'Hi Claudia, test from Connie.');
  assert.equal(controls.sources.read(controls.store.bot('claudia'),{submissionId:sent.submissionId}).source.id,'connie');
  // A retry by name is idempotent; the same operation to another bot conflicts.
  assert.deepEqual(await tool({operation:'send',recipient:'claudia',text:'Hi Claudia, test from Connie.',operationId:'connie-claudia-test-0001'}),sent);
  await assert.rejects(tool({operation:'send',recipient:'#'+controls.store.bot('dwight-copy').extension,text:'Hi Claudia, test from Connie.',operationId:'connie-claudia-test-0001'}),/conflicts/);
  // Exact IDs still work, and must agree with a name when both are given.
  assert.equal((await tool({operation:'send',recipientBotId:'dwight',text:'By id',operationId:'connie-dwight-byid-01'})).recipientBotId,'dwight');
  await assert.rejects(tool({operation:'send',recipient:'Claudia',recipientBotId:'dwight',text:'x',operationId:'connie-mismatch-0001'}),/different bots/);
  await assert.rejects(tool({operation:'send',recipient:'Dwight',text:'x',operationId:'connie-ambiguous-01'}),/matches several bots/);
  await assert.rejects(tool({operation:'send',recipient:'Ursula',text:'x',operationId:'connie-unplaced-001'}),/No active bot/);
  await assert.rejects(tool({operation:'send',text:'x',operationId:'connie-nobody-0001'}),/Name the recipient/);
  assert.equal(controls.store.list('promptQueue','dwight-copy').length,0);
});
