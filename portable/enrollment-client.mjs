import { join } from 'node:path';
import { digest,nodeKey,signature,secret,PROTOCOL_VERSION,RUNTIME_VERSION } from './protocol.mjs';
import { readPrivate,savePrivate } from './private-file.mjs';
import { boundedJSON } from './bounded-json.mjs';

export async function pairAgent(config,tokenFile,{fetcher=fetch,now=()=>Date.now()}={}) {
  const origin=new URL(config.agent.hubOrigin);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Pair only with a fixed HTTPS hub.');
  const key=nodeKey(join(config.dataDirectory,'node-key.pem')),token=readPrivate(tokenFile,1024).trim();
  if(!/^[A-Za-z0-9_-]{20,100}$/.test(token))throw Error('Invalid private pairing token.');
  const hello={protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION,platform:process.platform,arch:process.arch,capabilities:{text:true,localStdio:true,desktop:process.platform==='linux'&&config.agent.desktops?.enabled===true,voice:false,secureTransfer:process.platform==='linux',autonomousGoals:false}};
  const pendingPath=join(config.dataDirectory,'enrollment-pending.json'),binding={tokenHash:digest(token),fingerprint:key.fingerprint,hub:origin.origin,helloHash:digest(JSON.stringify(hello))};
  let pending;
  try{pending=JSON.parse(readPrivate(pendingPath));}catch(e){if(e.code!=='ENOENT')throw e;pending={...binding,createdAt:now()};savePrivate(pendingPath,JSON.stringify(pending),{exclusive:true});}
  if(Object.keys(binding).some(k=>pending[k]!==binding[k]))throw Error('Original enrollment identity differs. Reconcile it before another attempt.');
  async function post(path,body){
    const r=await fetcher(new URL(path,origin),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok){await r.body?.cancel();throw Error('Original enrollment was not confirmed; no replacement grant was made.');}return boundedJSON(r,16*1024);
  }
  const statusBinding={purpose:'enrollment-status',tokenHash:binding.tokenHash,publicKey:key.publicKey,hello,nonce:secret(),issuedAt:now()};
  const status=await post('/nodes/enroll/status',{token,publicKey:key.publicKey,hello,nonce:statusBinding.nonce,issuedAt:statusBinding.issuedAt,proof:signature(key.privateKey,statusBinding)});
  let result;
  if(status.state==='accepted')result=status;
  else {
    if(status.state!=='pending'||status.expiresAt<=now())throw Error('Original grant expired; no node was enrolled. Start a new owner-approved attempt explicitly.');
    const challenge=await post('/nodes/enroll/challenge',{token,publicKey:key.publicKey});
    if(challenge.grantId!==status.grantId||challenge.expiresAt<=now())throw Error('Original challenge changed or expired.');
    const bound={grantId:challenge.grantId,challenge:challenge.challenge,hello};
    savePrivate(pendingPath,JSON.stringify({...pending,grantId:bound.grantId}));
    // A timeout is left pending. The next invocation queries the same grant's
    // signed status before it considers another proof; it never creates a node.
    result=await post('/nodes/enroll/prove',{...bound,proof:signature(key.privateKey,bound)});
  }
  if(result.fingerprint!==key.fingerprint||typeof result.owner!=='string'||!/^node:[A-Za-z0-9_-]{20,100}$/.test(result.nodeId))throw Error('Enrollment receipt is not bound to this key.');
  const receipt={nodeId:result.nodeId,owner:result.owner,fingerprint:key.fingerprint,hub:origin.origin};
  const path=join(config.dataDirectory,'node-enrollment.json');
  try{const old=JSON.parse(readPrivate(path));if(JSON.stringify(old)!==JSON.stringify(receipt))throw Error('Original node receipt differs.');}catch(e){if(e.code!=='ENOENT')throw e;savePrivate(path,JSON.stringify(receipt),{exclusive:true});}
  if(config.agent.nodeId&&config.agent.nodeId!==receipt.nodeId)throw Error('Configured node differs; original receipt retained without activation.');
  return {...receipt,paired:true,executionStarted:false};
}
