import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {cpSync,mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {HubStore} from '../portable/control-store.mjs';
import {RUNTIME_COMPANIONS} from '../portable/runtime-companions.mjs';
import {teamProfileContext} from '../bot-bridge/profiles.mjs';
import {teamReference} from '../bot-bridge/teams.mjs';

async function fixture(t){
 const root=fileURLToPath(new URL('../',import.meta.url));mkdirSync(join(root,'dist'),{recursive:true});
 const dir=mkdtempSync(join(root,'dist','portable-teams-'));let controls;
 const hub=new HubStore(join(dir,'control.sqlite')),events=[];
 t.after(()=>{controls?.close();hub.close();rmSync(dir,{recursive:true,force:true});});
 for(const file of RUNTIME_COMPANIONS)cpSync(join(root,'bot-bridge',file),join(dir,file));
 const bundle=join(dir,'controls.mjs');await build({stdin:{contents:"export {HubControls} from './portable/hub-controls.mjs'; export {HubRpc} from './portable/hub-rpc.mjs';",resolveDir:root,sourcefile:'teams-fixture-entry.mjs'},outfile:bundle,bundle:true,platform:'node',target:'node24',format:'esm',packages:'external'});
 const {HubControls,HubRpc}=await import(pathToFileURL(bundle).href);
 hub.db.exec("INSERT INTO portable_nodes VALUES('node','owner','unused','fingerprint','{}',NULL,1); INSERT INTO portable_nodes VALUES('foreign-node','foreign-owner','unused','foreign-fingerprint','{}',NULL,1); INSERT INTO portable_placements VALUES('one','owner','node',1,1,0); INSERT INTO portable_placements VALUES('two','owner','node',1,1,0); INSERT INTO portable_placements VALUES('foreign','foreign-owner','foreign-node',1,1,0); INSERT INTO portable_authority VALUES(1,'writer',1,0)");
 controls=new HubControls({owner:{key:'owner',userId:'human'},path:join(dir,'control.sqlite'),hub,router:{connection:()=>null},authority:{writerId:'writer',epoch:1},broadcast:(owner,event)=>events.push({owner,event})});
 for(const id of ['one','two','foreign'])controls.store.saveBot({id,slug:id,name:id,threadId:'thread-'+id,executionMode:'single-thread',activeTurnId:null});
 const request=(method,params,operationId)=>controls.request('owner',{method,params,operationId});
 const caller={kind:'authenticated-node-tool',botId:'one',nodeId:'node',epoch:1};
 return {hub,controls,events,request,caller,HubRpc};
}

test('hub teams preserve membership, revisions, original receipts and owner isolation',async t=>{
 const {hub,controls,events,request,caller}=await fixture(t);
 const create={name:'Design',color:'#217050'},created=await request('teams.save',create,'original-create');
 assert.deepEqual(await request('teams.save',create,'original-create'),created);
 assert.equal(controls.store.list('team').length,1);assert.equal(events.length,1);
 await assert.rejects(request('teams.save',{...create,name:'Changed'},'original-create'),/operation changed/);
 const first=await request('teams.assign',{botId:'one',teamId:created.team.id,expectedTeamId:null},'original-assign');
 assert.equal(first.bot.teamId,created.team.id);assert.equal(first.bot.teamOrder,0);
 const second=await request('teams.assign',{botId:'two',teamId:created.team.id,expectedTeamId:null},'assign-two');assert.equal(second.bot.teamOrder,1);
 const detail=await request('teams.read',{id:created.team.id});assert.equal(detail.members.length,2);assert.equal(detail.revision,3);
 assert.deepEqual(await request('teams.assign',{botId:'one',teamId:created.team.id,expectedTeamId:null},'original-assign'),first);
 await assert.rejects(request('teams.assign',{botId:'one',teamId:null,expectedTeamId:null},'stale-assign'),/team changed/);
 await assert.rejects(controls.request('foreign-owner',{method:'teams.list',params:{}}),/authenticated hub owner/);
 await assert.rejects(request('teams.assign',{botId:'foreign',teamId:created.team.id,expectedTeamId:null},'foreign-assign'),/scope|Foreign|placement/i);
 await assert.rejects(controls.request('owner',{method:'teams.assign',botId:'one',params:{botId:'two',teamId:null,expectedTeamId:created.team.id},operationId:'forged-member'},caller),/managed by the owner/);
 assert.equal(controls.store.operation('foreign-assign'),null);assert.equal(controls.store.bot('foreign').teamId,undefined);
 const changed=await request('teams.orderBots',{id:created.team.id,ids:['two','one'],expectedRevision:detail.revision},'order-members');assert.equal(changed.applied,true);assert.equal(controls.store.bot('two').teamOrder,0);
 const current=await request('teams.read',{id:created.team.id});
 await assert.rejects(request('teams.memory',{id:created.team.id,memory:'Old edit',expectedRevision:detail.revision},'stale-memory'),/team changed/);
 await request('teams.memory',{id:created.team.id,memory:'Verified team note',expectedRevision:current.revision},'owner-memory');
 const ref=await controls.tool('owner','one','bots_team',{operation:'read'},caller);assert.match(ref.profile.value,/Verified team note/);assert.equal(ref.workspaceScope,'hub');
 assert.equal((await teamProfileContext({...ref,workspace:'/not-a-local-node-directory'})).teamProfile.value,ref.profile.value);
 const b=controls.store.bot('one');assert.equal((await teamReference({hubTeamReference:async()=>ref},b)).id,ref.id);
 await controls.tool('owner','one','bots_team',{operation:'saveMemory',teamId:ref.id,memory:'Bot useful note',expectedRevision:ref.revision,operationId:'bot-memory'},caller);
 await assert.rejects(controls.tool('owner','one','bots_team',{operation:'read'},{...caller,nodeId:'foreign-node'}),/unavailable/);
 await request('teams.assign',{botId:'one',teamId:null,expectedTeamId:created.team.id},'unassign-one');
 await assert.rejects(controls.tool('owner','one','bots_team',{operation:'saveMemory',teamId:ref.id,memory:'Retired scope',expectedRevision:ref.revision,operationId:'retired-memory'},caller),/Assign this bot/);
 assert.equal((await controls.tool('owner','one','bots_team',{operation:'read'},caller)).team,null);
 await assert.rejects(request('teams.delete',{id:created.team.id,expectedRevision:controls.store.get('team',created.team.id).revision},'nonempty-delete'),/Move the bots/);
 await request('teams.assign',{botId:'two',teamId:null,expectedTeamId:created.team.id},'unassign-two');
 await request('teams.delete',{id:created.team.id,expectedRevision:controls.store.get('team',created.team.id).revision},'delete-team');assert.equal((await request('teams.list',{})).length,0);
 assert.equal(hub.db.prepare('SELECT count(*) n FROM portable_mailbox').get().n,0);
 assert.ok(events.every(value=>value.owner==='owner'&&Array.isArray(value.event.data.placements)&&!value.event.data.placements.some(b=>b.id==='foreign')));
});

test('snapshot keeps canonical teams over stale native metadata and supports offline nodes',async t=>{
 const {hub,controls,request,HubRpc}=await fixture(t),created=await request('teams.save',{name:'Core',color:'#112233'},'create-core');
 await request('teams.assign',{botId:'one',teamId:created.team.id,expectedTeamId:null},'assign-core');
 const router=new HubRpc(hub,new Map());router.controls=controls;
 router.request=async(owner,r)=>({result:{bots:[{id:r.botId,name:r.botId,teamId:'stale-native-team',teamOrder:99}],teams:[],capabilities:{teams:1}},cache:{observedAt:1,stale:true}});
 const {result}=await router.snapshot('owner','browser');
 assert.equal(result.capabilities.teams,1);assert.equal(result.teams[0].id,created.team.id);assert.equal(result.teams[0].memberCount,1);
 assert.equal(result.bots.find(b=>b.id==='one').teamId,created.team.id);assert.equal(result.bots.find(b=>b.id==='one').teamOrder,0);
 assert.equal(result.bots.find(b=>b.id==='two').teamId,null);assert.equal(result.ready,false);
 hub.db.prepare('UPDATE portable_authority SET frozen=1').run();
 await assert.rejects(request('teams.save',{name:'Blocked',color:'#223344'},'frozen-create'),/authoritative hub/);
 assert.equal(controls.store.operation('frozen-create'),null);router.close();
});
