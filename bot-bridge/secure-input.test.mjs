import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from './store.mjs';import {SecureInputs,redactSecureNotification} from './secure-input.mjs';
import {encryptSecureInput,secureDecode,secureBase64,SECURE_CHUNK_BYTES} from '../lib/secure-input.ts';import {secureBrowserFrame} from '../lib/secure-relay.ts';
import {transferSecureInput} from '../app/bots/secure-input-transfer.ts';
import {EventEmitter} from 'node:events';
import {runtime as loadBrowser} from '../tests/helpers/load-ts.mjs';
import {BotRuntime} from './runtime.mjs';import {CodexManager} from './manager.mjs';import {SECURE_TOOLS} from './secure-input-tools.mjs';import {intendedOutputs} from './artifact-outputs.mjs';
const owner='synthetic-owner',marker='SYNTHETIC_PRIVATE_8a79234_unicode_第二行';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVhkAAAAASUVORK5CYII=';
async function setup(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'secure-input-test-')),store=new Store(join(root,'state.sqlite'));
 const bot=store.saveBot({id:'A',slug:'A',threadId:'thread-A',cwd:root}),other=store.saveBot({id:'B',slug:'B',threadId:'thread-B',cwd:root});let clock=1000000;
 const typed=[],calls=[],notices=[];const runtime={store,relayOnline:true,emitEvent:(type,data,botId)=>store.event({type,data,botId}),secureReceived:row=>notices.push(row),desktops:{call:async(bot,name,p)=>{typed.push({botId:bot.id,name,p});return{content:[{type:'text',text:'input verified'}]};}}};
 const secure=new SecureInputs(runtime,{clock:()=>clock,fetcher:async(url,init)=>{calls.push({url:String(url),init});return new Response(marker+' response',{status:201});},...options});
 t.after(async()=>{secure.close();store.close();await rm(root,{recursive:true,force:true});});
 const request=async(kind='https',op='request-one',images=true)=>secure.request(bot,{operationId:op,title:'Secure details',purpose:'Synthetic workflow',destination:{kind,label:'Synthetic destination',...(kind==='https'?{origin:'https://api.example.test'}:{})},fields:[{name:'token',label:'Token'},{name:'number',label:'Number',required:false}],images:images?[{name:'image',label:'Image',required:false}]:[]});
 const seal=async(row,p={fields:{token:marker},images:[{slot:'image',mimeType:'image/png',data:png}],modelRead:false})=>encryptSecureInput(await secure.channel({owner,botId:bot.id,threadId:bot.threadId,requestId:row.id,action:'key'}),'submission-one',p);
 const transport={owner,secure:async frame=>secure.channel({...frame,owner})};
 return{root,store,bot,other,secure,runtime,typed,calls,notices,request,seal,transport,advance:ms=>{clock+=ms;secure.sweep();}};
}
test('ECDH/HKDF/AES authenticated form fields/images arrive privately with bound scope and immutable receipt',async t=>{
 const s=await setup(t),r=await s.request(),e=await s.seal(r.request);const received=await transferSecureInput(s.transport,e);
 assert.equal(received.state,'received');assert.equal(received.modelRead,false);assert.equal(s.secure.live.get(r.handle).payload.fields.token,marker);assert.equal(s.secure.live.get(r.handle).payload.images[0].bytes.toString('base64'),png);assert.equal(s.notices.length,1);
 assert.equal((await transferSecureInput(s.transport,e)).id,received.id);assert.equal(s.notices.length,1);
 assert.deepEqual((await s.request()).request,received);assert.equal(s.store.list('attachment').length,0);assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,0);
});
test('concurrent original request IDs publish only one secure card and volatile key',async t=>{
 const s=await setup(t);const results=await Promise.all(Array.from({length:4},()=>s.request()));
 assert.equal(new Set(results.map(r=>r.handle)).size,1);assert.equal(s.store.list('secureInput').length,1);assert.equal(s.secure.live.size,1);
});
test('foreign bot, thread, owner, handle and envelope tampering are rejected without consuming form',async t=>{
 const s=await setup(t),r=await s.request(),e=await s.seal(r.request),bytes=secureDecode(e.ciphertext);const frame={action:'chunk',...e.context,publicKey:e.publicKey,iv:e.iv,digest:e.digest,total:bytes.length,offset:0,data:secureBase64(bytes)};
 for(const change of [{botId:s.other.id},{threadId:s.other.threadId},{owner:'foreign-owner'},{requestId:'secure:missing'},{submissionId:'changed-id'},{iv:'AAAAAAAAAAAAAAAA'},{digest:'0'.repeat(64)}])await assert.rejects(s.secure.channel({...frame,...change}));
 const changed=bytes.slice();changed[0]^=1;await assert.rejects(s.secure.channel({...frame,data:secureBase64(changed)}));
 assert.equal(s.store.get('secureInput',r.handle).state,'waiting');assert.equal((await transferSecureInput(s.transport,e)).state,'received');
 await assert.rejects(s.secure.tool(s.other,'bots_use_secure_input',{handle:r.handle,mode:'status'}));
});
test('interrupted transfer, duplicate chunks and lost ACK reuse ciphertext/submission, no duplicate receipt',async t=>{
 const s=await setup(t),r=await s.request(),e=await s.seal(r.request,{fields:{token:marker},images:[{slot:'image',mimeType:'image/png',data:Buffer.concat([Buffer.from(png,'base64'),Buffer.alloc(250000)]).toString('base64')}],modelRead:false});
 const bytes=secureDecode(e.ciphertext),frame={action:'chunk',...e.context,publicKey:e.publicKey,iv:e.iv,digest:e.digest,total:bytes.length,offset:0,data:secureBase64(bytes.subarray(0,SECURE_CHUNK_BYTES))};
 const first=await s.secure.channel(frame);assert.equal(first.nextOffset,SECURE_CHUNK_BYTES);assert.deepEqual(await s.secure.channel(frame),first);
 let lost=true;const transport={owner,secure:async frame=>{const receipt=await s.secure.channel(frame);if(receipt.received&&lost){lost=false;throw Error('synthetic lost ACK');}return receipt;}};
 await assert.rejects(transferSecureInput(transport,e),/lost ACK/);assert.equal((await transferSecureInput(transport,e)).state,'received');assert.equal(s.notices.length,1);
 const alternate=await s.seal({...r.request,state:'waiting'}).catch(()=>null);assert.equal(alternate,null);
});
test('one-hour receipt expiry, human/bot deletion and restart lose payload/key and retain only metadata',async t=>{
 const s=await setup(t),r=await s.request(),e=await s.seal(r.request);await transferSecureInput(s.transport,e);const image=s.secure.live.get(r.handle).payload.images[0].bytes;
 s.advance(3600001);assert.equal(s.store.get('secureInput',r.handle).state,'expired');assert.ok(image.every(b=>b===0));await assert.rejects(s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'model-read'}));
 const r2=await s.request('https','second');await transferSecureInput(s.transport,await s.seal(r2.request));assert.deepEqual(await s.secure.channel({owner,botId:s.bot.id,threadId:s.bot.threadId,requestId:r2.handle,action:'delete'}),{deleted:true});assert.deepEqual(await s.secure.tool(s.bot,'bots_delete_secure_input',{handle:r2.handle}),{deleted:true});
 const r3=await s.request('https','third');const e3=await s.seal(r3.request);s.secure.close();const restarted=new SecureInputs(s.runtime);t.after(()=>restarted.close());assert.equal(s.store.get('secureInput',r3.handle).state,'unavailable');await assert.rejects(transferSecureInput({owner,secure:frame=>restarted.channel({...frame,owner})},e3));
});
test('excess fields/images/bytes, invalid mime and required missing values reject before receipt',async t=>{
 const s=await setup(t),r=await s.request();
 const invalid=[{fields:{token:''},images:[],modelRead:false},{fields:{token:marker,foreign:'x'},images:[],modelRead:false},{fields:{token:'x'.repeat(4097)},images:[],modelRead:false},{fields:{token:marker},images:[{slot:'image',mimeType:'text/plain',data:png}],modelRead:false},{fields:{token:marker},images:[{slot:'image',mimeType:'image/png',data:png},{slot:'image',mimeType:'image/png',data:png}],modelRead:false},{fields:{token:marker},images:[],modelRead:'true'}];
 for(let i=0;i<invalid.length;i++){const descriptor=await s.secure.channel({action:'key',owner,botId:s.bot.id,threadId:s.bot.threadId,requestId:r.handle});const e=await encryptSecureInput(descriptor,`invalid-${i}`,invalid[i]);await assert.rejects(transferSecureInput(s.transport,e));}
 assert.equal(s.store.get('secureInput',r.handle).state,'waiting');
 await assert.rejects(s.secure.channel({action:'chunk',owner,botId:s.bot.id,threadId:s.bot.threadId,requestId:r.handle,submissionId:'huge',publicKey:{},iv:'x',digest:'0'.repeat(64),total:30*1024*1024,offset:0,data:'AAAA'}));
 const p={operationId:'too-many',title:'Title',purpose:'Purpose',destination:{kind:'desktop',label:'Own desktop'},fields:Array.from({length:7},(_,i)=>({name:`field${i}`,label:'Field'}))};await assert.rejects(s.secure.request(s.bot,p));
});
test('private HTTPS substitutions, multipart images and responses return safe metadata only, same-ID use does not repeat',async t=>{
 const s=await setup(t),r=await s.request();const ascii='SYNTHETIC_TOKEN_8a79234';await transferSecureInput(s.transport,await s.seal(r.request,{fields:{token:ascii,number:marker},images:[{slot:'image',mimeType:'image/png',data:png}],modelRead:false}));
 const p={handle:r.handle,mode:'https',operationId:'use-one',url:'https://api.example.test/receive',method:'POST',headers:{Authorization:['Bearer ',{field:'token'}]},form:{credential:{field:'number'}},images:[{slot:'image',field:'photo'}]};
 const result=await s.secure.tool(s.bot,'bots_use_secure_input',p);assert.equal(result.status,201);assert.ok(!JSON.stringify(result).includes(marker));assert.equal(s.calls[0].init.headers.get('Authorization'),'Bearer '+ascii);assert.equal(s.calls[0].init.body.get('credential'),marker);assert.equal(s.calls[0].init.body.get('photo').type,'image/png');
 assert.deepEqual(await s.secure.tool(s.bot,'bots_use_secure_input',p),result);assert.equal(s.calls.length,1);await assert.rejects(s.secure.tool(s.bot,'bots_use_secure_input',{...p,url:'https://evil.example/'}));
 const bad=await s.secure.tool(s.bot,'bots_use_secure_input',{...p,operationId:'wrong-origin',url:'https://evil.example/'});assert.equal(bad.state,'rejected');assert.equal(s.calls.length,1);
 await assert.rejects(s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'model-read',source:'response',responseId:result.responseId}),/not approved/);
});
test('redirects never send secrets onward and explicit human model-read choice gates fields/images and response reading',async t=>{
 const s=await setup(t),r=await s.request();await transferSecureInput(s.transport,await s.seal(r.request,{fields:{token:marker},images:[{slot:'image',mimeType:'image/png',data:png}],modelRead:true}));
 const read=await s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'model-read'});assert.equal(JSON.parse(read.__secureModelContent[0].text).token,marker);assert.equal(read.__secureModelContent[1].type,'image');
 const result=await s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'https',operationId:'approved-response',url:'https://api.example.test',json:{nested:{secret:{field:'token'}}}});
 assert.equal((await s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'model-read',source:'response',responseId:result.responseId})).__secureModelContent[0].text,marker+' response');
 s.secure.fetcher=async()=>new Response(null,{status:302,headers:{Location:'https://foreign.example'}});const redirected=await s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'https',operationId:'redirect',url:'https://api.example.test'});assert.equal(redirected.state,'redirect-rejected');
});
test('private own-desktop entry uses existing observation/window/lease tool with bounded ASCII only, no values returned',async t=>{
 const s=await setup(t),r=await s.request('desktop','desktop-one',false);await transferSecureInput(s.transport,await s.seal(r.request,{fields:{token:'synthetic-secret'},images:[],modelRead:false}));
 const p={handle:r.handle,mode:'desktop',field:'token',window_id:'0x00000042',operationId:'type-one'};const result=await s.secure.tool(s.bot,'bots_use_secure_input',p);assert.equal(result.state,'used');assert.equal(s.typed[0].botId,s.bot.id);assert.equal(s.typed[0].p.text,'synthetic-secret');assert.ok(!JSON.stringify(result).includes('synthetic-secret'));await s.secure.tool(s.bot,'bots_use_secure_input',p);assert.equal(s.typed.length,1);
 s.runtime.desktops.call=async()=>{throw Error('existing lease active');};assert.equal((await s.secure.tool(s.bot,'bots_use_secure_input',{...p,operationId:'lease'})).state,'unconfirmed');
});
test('secure relay injects authenticated owner/routing, strips arbitrary data and accepts only bounded encrypted frames',()=>{
 const base={id:'frame',botId:'A',threadId:'thread-A',requestId:'secure:id',action:'key',owner:'forged',clientId:'forged',params:{secret:marker}};
 const frame=secureBrowserFrame(base,owner,'actual-client');assert.equal(frame.owner,owner);assert.equal(frame.clientId,'actual-client');assert.ok(!JSON.stringify(frame).includes(marker));assert.throws(()=>secureBrowserFrame({...base,action:'chunk',data:marker},owner,'client'));
});
test('ordinary SQLite/WAL/catalog/event paths contain no synthetic payload or API response; opt-in native tool events redacted',async t=>{
 const s=await setup(t),r=await s.request();await transferSecureInput(s.transport,await s.seal(r.request));await s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'https',operationId:'private-api',url:'https://api.example.test'});
 const raw={method:'item/completed',params:{item:{type:'mcpToolCall',id:'item',tool:'bots_use_secure_input',result:{content:[{type:'text',text:marker}]}}}};const clean=redactSecureNotification(raw);s.runtime.emitEvent('codex',clean,s.bot.id);assert.ok(!JSON.stringify(clean).includes(marker));
 for(const name of await readdir(s.root)){const bytes=await readFile(join(s.root,name));assert.equal(bytes.includes(Buffer.from(marker)),false,name);assert.equal(bytes.includes(Buffer.from(png)),false,name);}
 assert.equal(s.store.list('attachment').length,0);assert.equal(s.store.list('artifactPublication').length,0);assert.equal(s.store.list('answerExecution').length,0);assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,0);
});
test('ordinary RPC is rejected before journaling; installed MCP and native tools bypass manager operation journals',async t=>{
 const s=await setup(t);const codex=new EventEmitter(),native=[];codex.respond=(id,result)=>native.push({id,result});
 const runtime=new BotRuntime({store:s.store,codex,root:s.root});runtime.secure=s.secure;runtime.manager=new CodexManager({runtime,store:s.store,directory:s.root});runtime.primary.single=()=>true;
 assert.deepEqual(runtime.manager.tools(s.bot).filter(tool=>tool.name.includes('secure_input')).map(t=>t.name),SECURE_TOOLS.map(t=>t.name));
 await assert.rejects(runtime.handle({method:'secure.submit',botId:s.bot.id,operationId:'forbidden',params:{fields:{token:marker}}}),/dedicated/);
 const r=await runtime.manager.call(s.bot.id,'bots_request_secure_input',{operationId:'installed',title:'Private input',purpose:'Synthetic check',destination:{kind:'https',label:'Example',origin:'https://api.example.test'},fields:[{name:'token',label:'Token'}]});
 await transferSecureInput(s.transport,await s.seal(r.request,{fields:{token:marker},images:[],modelRead:false}));
 await runtime.onServerRequest({id:1,method:'item/tool/call',params:{threadId:s.bot.threadId,tool:'bots_use_secure_input',callId:'native-status',arguments:{handle:r.handle,mode:'status'}}});
 assert.equal(native[0].result.success,true);assert.ok(!JSON.stringify(native).includes(marker));
 await assert.rejects(runtime.manager.call(s.other.id,'bots_use_secure_input',{handle:r.handle,mode:'status'}));
 assert.equal(s.store.list('managerOperation').length,0);assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,0);
});
test('offline requests, operation changes, expired partial transfers and receipt scope are handled safely',async t=>{
 const s=await setup(t);s.runtime.relayOnline=false;await assert.rejects(s.request(),/Connect/);s.runtime.relayOnline=true;
 const r=await s.request(),e=await s.seal(r.request),bytes=secureDecode(e.ciphertext);
 await assert.rejects(s.secure.request(s.bot,{operationId:'request-one',title:'Changed',purpose:'Synthetic workflow',destination:{kind:'https',label:'Synthetic destination',origin:'https://api.example.test'},fields:[{name:'token',label:'Token'},{name:'number',label:'Number',required:false}],images:[{name:'image',label:'Image',required:false}]}));
 await s.secure.channel({action:'chunk',...e.context,publicKey:e.publicKey,iv:e.iv,digest:e.digest,total:bytes.length,offset:0,data:secureBase64(bytes.subarray(0,16))});s.advance(60001);
 assert.equal(s.secure.transfers.size,0);assert.equal((await transferSecureInput(s.transport,e)).state,'received');
 await assert.rejects(transferSecureInput({owner,secure:async()=>({received:true,request:{...r.request,state:'received',botId:'B',receivedAt:'now',expiresAt:'later'}})},e),/scope/);
});
test('20MB cumulative image cap, required slots, key tampering and same-ID uncertain use prevent duplicate consumption',async t=>{
 const s=await setup(t),r=await s.request();
 const large=Buffer.alloc(11*1024*1024);Buffer.from(png,'base64').copy(large);
 const described={...r.request,images:[{name:'one',required:true},{name:'two',required:true}]};
 assert.throws(()=>s.secure.validate(described,{fields:{token:marker},images:[{slot:'one',mimeType:'image/png',data:large.toString('base64')},{slot:'two',mimeType:'image/png',data:large.toString('base64')}],modelRead:false}));
 assert.throws(()=>s.secure.validate(described,{fields:{token:marker},images:[],modelRead:false}));large.fill(0);
 const e=await s.seal(r.request);await assert.rejects(transferSecureInput(s.transport,{...e,publicKey:{...e.publicKey,x:'A'.repeat(43)}}));await transferSecureInput(s.transport,e);
 let calls=0;s.secure.fetcher=async()=>{calls++;throw Error(marker+' private transport failure');};
 const p={handle:r.handle,mode:'https',operationId:'uncertain',url:'https://api.example.test',json:{secret:{field:'token'}}};const result=await s.secure.tool(s.bot,'bots_use_secure_input',p);
 assert.equal(result.state,'unconfirmed');assert.ok(!JSON.stringify(result).includes(marker));assert.deepEqual(await s.secure.tool(s.bot,'bots_use_secure_input',p),result);assert.equal(calls,1);
});
test('private use does not elevate opted-in images into artifacts; raw and normal events omit secure output',()=>{
 const item={id:'secure-item',type:'mcpToolCall',tool:'mcp__codex_manager__bots_use_secure_input',status:'completed',arguments:{},result:{content:[{type:'resource',annotations:{audience:['user']},resource:{uri:'file:///sensitive.png',mimeType:'image/png',blob:png}},{type:'text',text:marker}]}};
 assert.deepEqual(intendedOutputs(item),[]);
 for(const event of [{method:'item/completed',params:{item}},{method:'turn/completed',params:{turn:{items:[item]}}},{method:'rawResponseItem/completed',params:{threadId:'thread-A',turnId:'turn',item:{type:'function_call_output',output:marker}}}]){
 const clean=JSON.stringify(redactSecureNotification(event));assert.ok(!clean.includes(marker));assert.ok(!clean.includes(png));
 }
});
test('full 20MiB image transfer is accepted, the next byte is rejected, and deletion wipes retained bytes',async t=>{
 const s=await setup(t),r=await s.request();const image=Buffer.alloc(20*1024*1024);Buffer.from(png,'base64').copy(image);
 const payload={fields:{token:marker},images:[{slot:'image',mimeType:'image/png',data:image.toString('base64')}],modelRead:false};
 s.secure.validate(r.request,payload);
 assert.throws(()=>s.secure.validate(r.request,{...payload,images:[{...payload.images[0],data:Buffer.concat([image,Buffer.from([0])]).toString('base64')}]}));
 await transferSecureInput(s.transport,await s.seal(r.request,payload));const retained=s.secure.live.get(r.handle).payload.images[0].bytes;assert.deepEqual(retained,image);await s.secure.tool(s.bot,'bots_delete_secure_input',{handle:r.handle});assert.ok(retained.every(b=>b===0));image.fill(0);
});
test('deletion cancels every private in-flight request and queued desktop validity is rechecked before input',async t=>{
 const s=await setup(t),r=await s.request();await transferSecureInput(s.transport,await s.seal(r.request));let requests=0;
 s.secure.fetcher=async(_url,init)=>new Promise((_,reject)=>{requests++;init.signal.addEventListener('abort',()=>reject(Error('aborted')));});
 const use=id=>s.secure.tool(s.bot,'bots_use_secure_input',{handle:r.handle,mode:'https',operationId:id,url:'https://api.example.test'});
 const a=use('one'),b=use('two');assert.equal(requests,2);s.secure.clear(r.handle);assert.equal((await a).state,'unconfirmed');assert.equal((await b).state,'unconfirmed');assert.equal(s.secure.live.size,0);
 const desktop=await s.request('desktop','queued-desktop',false);await transferSecureInput(s.transport,await s.seal(desktop.request,{fields:{token:'synthetic-ascii'},images:[],modelRead:false}));let guard;
 s.runtime.desktops.call=async(_bot,_name,_params,beforeInput)=>{guard=beforeInput;await Promise.resolve();s.secure.clear(desktop.handle);beforeInput();throw Error('must not reach input');};
 assert.equal((await s.secure.tool(s.bot,'bots_use_secure_input',{handle:desktop.handle,mode:'desktop',field:'token',window_id:'0x42',operationId:'delayed-input'})).state,'unconfirmed');assert.equal(typeof guard,'function');assert.equal(s.typed.length,0);
});
test('real browser client uses only volatile secure pending state and rejects it on owner revocation',async()=>{
 const writes=[],sent=[];const env=loadBrowser({WebSocket:{OPEN:1},localStorage:{setItem:(k,v)=>writes.push({k,v}),getItem:()=>null,removeItem:()=>{}},btoa,atob});
 const {BotsClient}=env.load('app/bots/client.ts'),client=new BotsClient();client.owner=owner;client.online=true;client.socket={readyState:1,send:v=>sent.push(JSON.parse(v)),close:()=>{}};
 const promise=client.secure({action:'chunk',botId:'A',ciphertext:'opaque-encrypted-bytes'});assert.equal(client.pending.size,0);assert.equal(writes.length,0);assert.equal(sent[0].type,'secure');
 client.receive({type:'secure.response',id:sent[0].id,result:{received:true}});assert.equal((await promise).received,true);assert.equal(client.securePending.size,0);
 const revoked=client.secure({action:'key',botId:'A'});client.clearOwnerCache();await assert.rejects(revoked,/owner changed/);assert.equal(client.securePending.size,0);assert.equal(writes.length,0);await assert.rejects(client.secure({action:'key'}),/offline/);
});
test('lost metadata writes recover the original receipt; deletion still wipes RAM during catalog failure',async t=>{
 const s=await setup(t),r=await s.request(),e=await s.seal(r.request),put=s.store.put.bind(s.store);let failWrite=true;
 s.store.put=(kind,row)=>{if(kind==='secureInput'&&row.state==='received'&&failWrite){failWrite=false;throw Error('synthetic metadata write interruption');}return put(kind,row);};
 await assert.rejects(transferSecureInput(s.transport,e));const original=s.secure.live.get(r.handle).receipt;
 const retried=await transferSecureInput(s.transport,e);assert.equal(retried.receivedAt,original.receivedAt);assert.equal(retried.expiresAt,original.expiresAt);assert.equal(s.notices.length,1);
 const image=s.secure.live.get(r.handle).payload.images[0].bytes;s.store.put=()=>{throw Error('synthetic unavailable catalog');};
 assert.deepEqual(s.secure.clear(r.handle),{deleted:true});assert.ok(image.every(b=>b===0));assert.equal(s.secure.live.size,0);assert.equal(s.secure.list(s.bot)[0].state,'deleted');
 s.store.put=put;s.secure.sweep();assert.equal(s.store.get('secureInput',r.handle).state,'deleted');
});
test('receipt wake uses one non-sensitive automatic intake ID, preserves Stop and hides the internal envelope',async t=>{
 const s=await setup(t),r=await s.request();await transferSecureInput(s.transport,await s.seal(r.request));const codex=new EventEmitter();
 const runtime=new BotRuntime({store:s.store,codex,root:s.root});runtime.primary.single=()=>true;const bot=s.store.saveBot({...s.bot,queuePaused:true});
 await runtime.secureReceived(s.store.get('secureInput',r.handle));await runtime.secureReceived(s.store.get('secureInput',r.handle));
 const rows=s.store.list('primaryInbox',bot.id);assert.equal(rows.length,1);assert.equal(rows[0].kind,'secure-input');assert.equal(rows[0].state,'queued');assert.ok(!rows[0].text.includes(marker));assert.equal(s.store.bot(bot.id).queuePaused,true);assert.equal(s.store.db.prepare('SELECT COUNT(*) AS n FROM operations').get().n,0);
 const {projectConversationItem}=loadBrowser().load('lib/bot-conversation.ts');assert.equal(projectConversationItem({id:'turn',status:'completed'},{type:'userMessage',id:'receipt',clientId:rows[0].id,content:[{type:'text',text:rows[0].text}]},{kind:'conversation'}),null);
});
