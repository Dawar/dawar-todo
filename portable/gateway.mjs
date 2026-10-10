import { createServer, request as httpRequest } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFile,stat,realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHmac } from 'node:crypto';
import { HubStore } from './control-store.mjs';
import { LocalD1 } from './sqlite.mjs';
import { OIDCIdentity, stripIdentity,csrfCookie } from './identity.mjs';
import { compatible, MAX_FRAME_BYTES, secret, verifySignature } from './protocol.mjs';
import { appAccessResponse } from '../worker/access.ts';
import { signGateway } from './gateway-proof.ts';
import { ObjectStorage } from './object-storage.mjs';
import { HubRpc,AGENT_MUTATIONS } from './hub-rpc.mjs';
import { HubControls,hubActivation } from './hub-controls.mjs';
import { HUB_TOOLS } from './control-protocol.mjs';
import { verifyBotTicket } from '../lib/bots-auth.ts';

const json = (response,status,body) => { response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body)); };
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length;if(size>128*1024)throw Error('Request too large.');chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function startGateway(config) {
  const store = new HubStore(join(config.dataDirectory,'control.sqlite'));
  const application = new LocalD1(join(config.dataDirectory,'application.sqlite'));
  const identity = new OIDCIdentity(store,config);
  const objects = new ObjectStorage(config);
  const connections = new Map(), challenges = new Map();
  const router = new HubRpc(store,connections), browsers=new Set();
  const authority=hubActivation(config),broadcast=(owner,event)=>{for(const b of browsers)if(b.owner===owner&&b.ws.readyState===1)b.ws.send(JSON.stringify({type:'event',event}));};
  const controls=new HubControls({path:join(config.dataDirectory,'control.sqlite'),hub:store,router,authority,broadcast,...(config.schedulerQuietWindow?{quietWindow:config.schedulerQuietWindow}:{})});router.controls=controls;
  const scheduler=authority?setInterval(()=>void controls.tick().catch(error=>controls.emit('fault',error)),5000):null;
  const downloadDirectory=resolve(config.agentDownloadDirectory??fileURLToPath(new URL('../agent-downloads',import.meta.url)));
  const sockets = new WebSocketServer({noServer:true,maxPayload:MAX_FRAME_BYTES,perMessageDeflate:false});
  const server = createServer(async (req,res) => {
    try {
      const u = new URL(req.url,config.publicOrigin), headers = new Headers();
      for (const [key,value] of Object.entries(req.headers)) if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      stripIdentity(headers);
      const r = new Request(u,{method:req.method,headers}), session = identity.session(r);
      if(u.pathname==='/storage/object'){
        const result=await objects.serveNode(req,u);res.writeHead(result.status,Object.fromEntries(result.headers));
        if(!result.body)return res.end();
        const {Readable}=await import('node:stream');const stream=Readable.fromWeb(result.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
      }
      if (u.pathname === '/healthz') {let enabled=false;try{controls.assertWriter();enabled=true;}catch{/* Staging has no execution authority. */}return json(res,200,{ready:true,protocol:1,role:'hub',executionEnabled:enabled,source:config.hub?.source??null});}
      if (u.pathname === '/auth/login' && req.method === 'GET') {
        const a = identity.login(u.searchParams.get('return_to'));res.writeHead(303,{location:a.location,'set-cookie':a.cookie,'cache-control':'no-store'});return res.end();
      }
      if (u.pathname === '/auth/callback' && req.method === 'GET') {
        const a = await identity.callback(r);res.writeHead(303,{location:a.location,'set-cookie':a.cookies,'cache-control':'no-store'});return res.end();
      }
      if (u.pathname === '/auth/session' && req.method === 'GET') {if(session)res.setHeader('set-cookie',csrfCookie(session.csrf));return json(res,session?200:401,session?{owner:session.owner,userId:session.userId,csrf:session.csrf}:{error:'Sign in required.'});}
      if (u.pathname === '/auth/logout' && req.method === 'POST') {
        if (!session) return json(res,401,{error:'Sign in required.'});identity.csrf(r,session);
        res.writeHead(204,{'set-cookie':identity.logout(r),'cache-control':'no-store'});return res.end();
      }
      // Enrollment is public only with a five-minute owner-approved token and
      // matching key; it never authenticates human or Todo API requests.
      if (u.pathname === '/nodes/enroll/challenge' && req.method === 'POST') {
        const b = await readBody(req);return json(res,200,store.enrollmentChallenge(b.token,b.publicKey));
      }
      if (u.pathname === '/nodes/enroll/prove' && req.method === 'POST') {
        const b = await readBody(req);return json(res,200,store.enroll(b.grantId,b.hello,b.proof));
      }
      if (u.pathname === '/nodes/enroll/status' && req.method === 'POST') return json(res,200,store.enrollmentStatus(await readBody(req)));
      if (u.pathname.startsWith('/api/portable/')) {
        if (!session || session.owner!==config.owner.key) return json(res,403,{error:'Owner session required.'});
        if(req.method!=='GET')identity.csrf(r,session);
        const b = req.method==='GET'?{}:await readBody(req);
        if(u.pathname==='/api/portable/nodes' && req.method==='GET') return json(res,200,{nodes:store.db.prepare('SELECT id,fingerprint,hello,revoked_at FROM portable_nodes WHERE owner=?').all(session.owner).map(n=>({...n,online:connections.has(n.id)}))});
        if(u.pathname==='/api/portable/installer'&&req.method==='GET'){
          const d=JSON.parse(await readFile(join(downloadDirectory,'current.json'),'utf8'));
          if(!/^dawartodo-agent-[a-f0-9]{12}\.zip$/.test(d.name)||!/^[a-f0-9]{64}$/.test(d.sha256))throw Error('Installer manifest unavailable.');
          return json(res,200,{source:d.source,sha256:d.sha256,bytes:d.bytes,href:'/api/portable/installer/download'});
        }
        if(u.pathname==='/api/portable/installer/download'&&req.method==='GET'){
          const d=JSON.parse(await readFile(join(downloadDirectory,'current.json'),'utf8'));
          if(!/^dawartodo-agent-[a-f0-9]{12}\.zip$/.test(d.name))throw Error('Installer name invalid.');
          const path=join(downloadDirectory,d.name),s=await stat(path);
          if(!s.isFile()||s.size!==d.bytes||s.size>32*1024*1024||await realpath(path)!==path)throw Error('Installer file invalid.');
          res.writeHead(200,{'content-type':'application/zip','content-length':s.size,'content-disposition':`attachment; filename="${d.name}"`,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
          const stream=createReadStream(path);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());return stream.pipe(res);
        }
        if(u.pathname==='/api/portable/enrollment' && req.method==='POST'){
          if(typeof b.operationId!=='string'||b.operationId.length>180)throw Error('Original pairing operation required.');
          const token=createHmac('sha256',config.gatewaySecret).update(JSON.stringify({owner:session.owner,operationId:b.operationId,fingerprint:b.fingerprint})).digest('base64url');
          return json(res,200,store.grantEnrollment(session.owner,b.fingerprint,Date.now(),b.operationId,token));
        }
        if(u.pathname==='/api/portable/revoke' && req.method==='POST'){store.revoke(session.owner,b.nodeId);connections.get(b.nodeId)?.close(1008,'Node revoked');return json(res,200,{revoked:true});}
        if(u.pathname==='/api/portable/placement' && req.method==='POST')return json(res,200,store.place(session.owner,b.botId,b.nodeId,b.expectedEpoch));
        if(u.pathname==='/api/portable/stop' && req.method==='POST'){
          if(b.stopped!==true)throw Error('Use the original queue or work Resume action to release Stop.');
          const p=store.stop(session.owner,b.botId,b.stopped);connections.get(p.node_id)?.send(JSON.stringify({type:'sync',...store.sync(p.node_id)}));
          return json(res,200,{placement:p,confirmation:'pending'});
        }
        if(u.pathname==='/api/portable/commands' && req.method==='POST'){
          if(!AGENT_MUTATIONS.has(b.payload?.method))throw Error('Internal logical dispatch is not a browser command.');
          return json(res,200,store.enqueue(session.owner,b.botId,b.operationId,b.payload));
        }
        return json(res,404,{error:'Unknown portable operation.'});
      }
      if (session && !headers.has('authorization')) {
        if (!['GET','HEAD','OPTIONS'].includes(req.method)) identity.csrf(r,session);
        headers.set('oai-authenticated-user-email',session.owner);headers.set('oai-authenticated-user-id',session.userId);
      }
      const accessRequest=new Request(u,{method:req.method,headers});
      const blocked = u.pathname.startsWith('/portable-assets/') ? null : await appAccessResponse(accessRequest,{DB:application});
      if (blocked) {
        if (!u.pathname.startsWith('/api/') && blocked.status===303) {
          res.writeHead(303,{location:`/auth/login?return_to=${encodeURIComponent(u.pathname+u.search)}`});return res.end();
        }
        res.writeHead(blocked.status,Object.fromEntries(blocked.headers));return res.end(Buffer.from(await blocked.arrayBuffer()));
      }
      // Access validation adds the original token actor to its own mutable
      // Request. Forward that verified copy; never recreate it from input.
      for(const [name,value] of accessRequest.headers)headers.set(name,value);
      // Fixed loopback target; never proxy a URL, host or identity from input.
      if(u.pathname==='/signin-with-chatgpt'){res.writeHead(303,{location:'/auth/login'});return res.end();}
      headers.set('host',u.host);headers.set('x-forwarded-host',u.host);headers.set('x-forwarded-proto','https');
      const path = u.pathname==='/_vinext/image'?`/_next/image${u.search}`:u.pathname+u.search;
      signGateway(config.gatewaySecret,req.method,path,headers);
      const proxy = httpRequest({hostname:'127.0.0.1',port:config.sitePort??3211,path,method:req.method,headers:Object.fromEntries(headers)}, upstream=>{
        res.writeHead(upstream.statusCode,upstream.headers);upstream.pipe(res);
      });
      proxy.on('error',()=>{if(!res.headersSent)json(res,502,{error:'Site temporarily unavailable.'});else res.destroy();});
      req.on('aborted',()=>proxy.destroy());res.on('close',()=>{if(!res.writableEnded)proxy.destroy();});req.pipe(proxy);
    } catch(error) { if(!res.headersSent)json(res,/large/.test(error.message)?413:403,{error:error.message});else res.destroy(); }
  });
  server.on('upgrade',(req,socket,head)=>{
    const u=new URL(req.url,config.publicOrigin);
    if(u.pathname==='/connect'){
      const session=identity.session(new Request(u,{headers:req.headers}));
      if(!session||req.headers.origin!==config.publicOrigin||u.searchParams.get('machine')!==(config.applicationEnvironment?.BOTS_MACHINE_ID??'dawar-vm')){socket.destroy();return;}
      sockets.handleUpgrade(req,socket,head,ws=>{
        const clientId=`browser:${randomUUID()}`;let authenticated=false,expiresAt=0;
        const timeout=setTimeout(()=>{if(!authenticated)ws.close(1008,'Authentication expired');},10000);
        const send=value=>{if(ws.readyState===1)ws.send(JSON.stringify(value));};
        let frameChain=Promise.resolve();
        ws.on('message',raw=>{
          frameChain=frameChain.then(async()=>{
            if (ws.readyState!==1) return;
            if(!identity.session(new Request(u,{headers:req.headers})))throw Error('Owner session expired.');
            if(raw.toString()==='ping'){if(authenticated)ws.send('pong');return;}
            const m=JSON.parse(raw.toString());
            if(!authenticated){
              if(m.type!=='auth'||m.desktop||m.role==='task-request')throw Error('Unsupported portable browser role.');
              const ticket=await verifyBotTicket(m.ticket,config.gatewaySecret,config.applicationEnvironment?.BOTS_MACHINE_ID??'dawar-vm');
              if(ticket.owner!==session.owner||store.db.prepare('SELECT 1 FROM portable_tickets WHERE jti=?').get(ticket.jti))throw Error('Foreign or reused ticket.');
              store.db.prepare('DELETE FROM portable_tickets WHERE expires_at<=?').run(Date.now());
              store.db.prepare('INSERT INTO portable_tickets VALUES(?,?)').run(ticket.jti,ticket.exp*1000);
              authenticated=true;expiresAt=ticket.sessionExp*1000;clearTimeout(timeout);browsers.add({ws,owner:session.owner});
              send({type:'authenticated',role:'browser',online:true,expiresAt,clientId});return;
            }
            if(expiresAt<=Date.now()||m.type!=='request')throw Error('Session or request invalid.');
            // Authentication is serialized; independent owner requests are
            // not. Stop cannot wait behind a slow turn-send acknowledgment.
            void (async()=>{try{const value=await router.request(session.owner,m,clientId);send({type:'response',id:m.id,...value});}
              catch(e){send({type:'response',id:m.id,error:e.message,outcome:e.outcome==='rejected'?'rejected':e.outcome==='not-sent'?'not-sent':'uncertain',delivery:e.delivery});}})();
          }).catch(()=>ws.close(1008,'Owner request rejected'));
        });
        ws.on('close',()=>{clearTimeout(timeout);for(const b of browsers)if(b.ws===ws)browsers.delete(b);});
      });return;
    }
    if(u.pathname!=='/nodes/connect' || req.headers.origin){socket.destroy();return;}
    sockets.handleUpgrade(req,socket,head,ws=>{
      const challenge=secret(),connectionId=randomUUID(),createdAt=Date.now();challenges.set(connectionId,challenge);
      let nodeId=null;
      const timeout=setTimeout(()=>{if(!nodeId)ws.close(1008,'Authentication expired');},10000);
      ws.send(JSON.stringify({type:'challenge',challenge,connectionId,protocol:1}));
      ws.on('message',raw=>{
        try {
          const m=JSON.parse(raw.toString());
          if(!nodeId){
            const n=store.node(m.nodeId);compatible(m.hello);
            if(m.type!=='authenticate'||Date.now()-createdAt>10000||!challenges.has(connectionId)
              ||!verifySignature(n.public_key,{nodeId:m.nodeId,challenge,connectionId,hello:m.hello},m.proof))throw Error('Node proof invalid.');
            challenges.delete(connectionId);clearTimeout(timeout);nodeId=n.id;
            connections.get(nodeId)?.close(1008,'Connection superseded');connections.set(nodeId,ws);
            ws.send(JSON.stringify({type:'sync',...store.sync(nodeId,m.cursor??0)}));return;
          }
          store.node(nodeId);if(connections.get(nodeId)!==ws)throw Error('Connection superseded.');
          if(m.type==='sync')ws.send(JSON.stringify({type:'sync',...store.sync(nodeId,m.cursor??0)}));
          else if(m.type==='receipt') {const receipt=store.receipt(nodeId,m.operationId,m.fingerprint,m.state,m.receipt);router.receipt(receipt);if(authority)controls.receipt(receipt);ws.send(JSON.stringify({type:'receipt-ack',operationId:m.operationId,state:receipt.state}));}
          else if(m.type==='rpc-result')router.readResult(nodeId,m);
          else if(m.type==='control-request'){
            const n=store.node(nodeId),p=store.placement(n.owner,m.botId);
            if(p.node_id!==nodeId||p.epoch!==m.epoch||!HUB_TOOLS.has(m.tool)||typeof m.requestId!=='string')throw Error('Foreign hub tool request.');
            const answer=value=>{const current=store.placement(n.owner,m.botId);if(connections.get(nodeId)===ws&&current.node_id===nodeId&&current.epoch===m.epoch)ws.send(boundedFrame({type:'control-result',requestId:m.requestId,botId:m.botId,epoch:m.epoch,...value}));};
            void controls.tool(n.owner,m.botId,m.tool,m.args,{kind:'authenticated-node-tool',botId:m.botId,nodeId,epoch:m.epoch}).then(result=>answer({result})).catch(error=>answer({error:error.message,outcome:error.outcome??'uncertain'})).catch(()=>ws.close(1008,'Control scope changed'));
          }
          else if(m.type==='event') {const before=store.eventCursor(),sequence=store.event(nodeId,m.eventId,m.botId,m.epoch,m.event);if(sequence>before)controls.nativeEvent(m.event);ws.send(JSON.stringify({type:'event-ack',eventId:m.eventId,sequence}));if(sequence>before)broadcast(store.node(nodeId).owner,{...m.event,seq:sequence});}
          else throw Error('Unknown node frame.');
        } catch {ws.close(1008,'Node frame rejected');}
      });
      ws.on('close',()=>{clearTimeout(timeout);challenges.delete(connectionId);if(connections.get(nodeId)===ws)connections.delete(nodeId);});
    });
  });
  server.listen(config.gatewayPort??3210,'127.0.0.1');
  return {server,store,application,objects,router,controls,close:async()=>{clearInterval(scheduler);router.close();for(const ws of sockets.clients)ws.close();await new Promise(resolve=>server.close(resolve));controls.close();objects.close();store.close();application.close();}};
}
