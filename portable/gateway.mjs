import { createServer, request as httpRequest } from 'node:http';
import { WebSocketServer } from 'ws';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HubStore } from './control-store.mjs';
import { LocalD1 } from './sqlite.mjs';
import { GoogleIdentity, stripIdentity } from './identity.mjs';
import { compatible, MAX_FRAME_BYTES, secret, verifySignature } from './protocol.mjs';
import { appAccessResponse } from '../worker/access.ts';
import { signGateway } from './gateway-proof.ts';

const json = (response,status,body) => { response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body)); };
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length;if(size>128*1024)throw Error('Request too large.');chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export function startGateway(config) {
  const store = new HubStore(join(config.dataDirectory,'control.sqlite'));
  const application = new LocalD1(join(config.dataDirectory,'application.sqlite'));
  const identity = new GoogleIdentity(store,config);
  const connections = new Map(), challenges = new Map();
  const sockets = new WebSocketServer({noServer:true,maxPayload:MAX_FRAME_BYTES,perMessageDeflate:false});
  const server = createServer(async (req,res) => {
    try {
      const u = new URL(req.url,config.publicOrigin), headers = new Headers();
      for (const [key,value] of Object.entries(req.headers)) if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
      stripIdentity(headers);
      const r = new Request(u,{method:req.method,headers}), session = identity.session(r);
      if (u.pathname === '/healthz') return json(res,200,{ready:true,protocol:1,role:'hub',executionEnabled:false});
      if (u.pathname === '/auth/login' && req.method === 'GET') {
        const a = identity.login(u.searchParams.get('return_to'));res.writeHead(303,{location:a.location,'set-cookie':a.cookie,'cache-control':'no-store'});return res.end();
      }
      if (u.pathname === '/auth/callback' && req.method === 'GET') {
        const a = await identity.callback(r);res.writeHead(303,{location:a.location,'set-cookie':a.cookies,'cache-control':'no-store'});return res.end();
      }
      if (u.pathname === '/auth/session' && req.method === 'GET') return json(res,session?200:401,session?{owner:session.owner,userId:session.userId,csrf:session.csrf}:{error:'Sign in required.'});
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
      if (u.pathname.startsWith('/api/portable/')) {
        if (!session || session.owner!==config.owner.key) return json(res,403,{error:'Owner session required.'});
        if(req.method!=='GET')identity.csrf(r,session);
        const b = req.method==='GET'?{}:await readBody(req);
        if(u.pathname==='/api/portable/nodes' && req.method==='GET') return json(res,200,{nodes:store.db.prepare('SELECT id,fingerprint,hello,revoked_at FROM portable_nodes WHERE owner=?').all(session.owner).map(n=>({...n,online:connections.has(n.id)}))});
        if(u.pathname==='/api/portable/enrollment' && req.method==='POST')return json(res,200,store.grantEnrollment(session.owner,b.fingerprint));
        if(u.pathname==='/api/portable/revoke' && req.method==='POST'){store.revoke(session.owner,b.nodeId);connections.get(b.nodeId)?.close(1008,'Node revoked');return json(res,200,{revoked:true});}
        if(u.pathname==='/api/portable/placement' && req.method==='POST')return json(res,200,store.place(session.owner,b.botId,b.nodeId,b.expectedEpoch));
        if(u.pathname==='/api/portable/stop' && req.method==='POST'){
          const p=store.stop(session.owner,b.botId,b.stopped);connections.get(p.node_id)?.send(JSON.stringify({type:'sync',...store.sync(p.node_id)}));
          return json(res,200,{placement:p,confirmation:'pending'});
        }
        if(u.pathname==='/api/portable/commands' && req.method==='POST')return json(res,200,store.enqueue(session.owner,b.botId,b.operationId,b.payload));
        return json(res,404,{error:'Unknown portable operation.'});
      }
      if (session && !headers.has('authorization')) {
        if (!['GET','HEAD','OPTIONS'].includes(req.method)) identity.csrf(r,session);
        headers.set('oai-authenticated-user-email',session.owner);headers.set('oai-authenticated-user-id',session.userId);
      }
      const blocked = u.pathname.startsWith('/portable-assets/') ? null : await appAccessResponse(new Request(u,{method:req.method,headers}),{DB:application});
      if (blocked) {
        if (!u.pathname.startsWith('/api/') && blocked.status===303) {
          res.writeHead(303,{location:`/auth/login?return_to=${encodeURIComponent(u.pathname+u.search)}`});return res.end();
        }
        res.writeHead(blocked.status,Object.fromEntries(blocked.headers));return res.end(Buffer.from(await blocked.arrayBuffer()));
      }
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
          else if(m.type==='receipt') {const receipt=store.receipt(nodeId,m.operationId,m.fingerprint,m.state,m.receipt);ws.send(JSON.stringify({type:'receipt-ack',operationId:m.operationId,state:receipt.state}));}
          else if(m.type==='event') {const sequence=store.event(nodeId,m.eventId,m.botId,m.epoch,m.event);ws.send(JSON.stringify({type:'event-ack',eventId:m.eventId,sequence}));}
          else throw Error('Unknown node frame.');
        } catch {ws.close(1008,'Node frame rejected');}
      });
      ws.on('close',()=>{clearTimeout(timeout);challenges.delete(connectionId);if(connections.get(nodeId)===ws)connections.delete(nodeId);});
    });
  });
  server.listen(config.gatewayPort??3210,'127.0.0.1');
  return {server,store,application,close:async()=>{for(const ws of sockets.clients)ws.close();await new Promise(resolve=>server.close(resolve));store.close();application.close();}};
}
