const enc=new TextEncoder(),failure=()=>Error('Original voice admission was not confirmed.');
const keys=['sourceId','installationId','producerSHA256'];
const kinds=['http','scheduled','stream','sip'];
const exact=(v,k)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==k.length||Object.keys(v).some(x=>!k.includes(x)))throw failure();};
const id=v=>{if(typeof v!=='string'||!v||enc.encode(v).length>512||/[\s\0]/.test(v))throw failure();return v;};
const digest=async v=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(JSON.stringify(v)))),b=>b.toString(16).padStart(2,'0')).join('');
function binding(v){exact(v,keys);if(!/^[a-f0-9]{40}$/.test(v.sourceId)||!/^[a-f0-9]{64}$/.test(v.producerSHA256))throw failure();return {sourceId:v.sourceId,installationId:id(v.installationId),producerSHA256:v.producerSHA256};}
function state(v,b){
  if(!v||v.version!==1||keys.some(k=>v[k]!==b[k])||!['open','draining'].includes(v.phase)||
    ['generation','active','unknown','finished','rows','expiresAt'].some(k=>!Number.isSafeInteger(v[k])||v[k]<0)||
    v.rows!==v.active+v.unknown+v.finished||v.rows>10000||v.active+v.unknown>1024||
    (v.phase==='open'?(v.operationId!==null||v.expiresAt!==0):(!v.operationId||v.generation<1||v.expiresAt<1)))throw failure();
  return v;
}

// The coordinator owns one durable serialized ledger. Caller assertions cannot
// clear uncertain work or claim coverage of calls admitted before installation.
export function createVoiceMigrationLedger(storage,original){
  const b=binding(original);
  if(typeof storage?.transaction!=='function')throw failure();
  return {async command(input){
    exact(input,['binding','action','args']);if(JSON.stringify(binding(input.binding))!==JSON.stringify(b))throw failure();
    const a=input.args;const action=input.action;
    if(!['install','read','admit','settle','drain','release','receipt'].includes(action))throw failure();
    const hash=await digest(input);
    return storage.transaction(async tx=>{
      let s=await tx.get('state');
      if(action==='install'){
        exact(a,[]);
        if(s){state(s,b);const r=await tx.get(`receipt:${b.installationId}`);if(r?.fingerprint!==hash||r.action!=='install')throw failure();return {installed:true,reconciled:true};}
        s={version:1,...b,phase:'open',generation:0,operationId:null,expiresAt:0,active:0,unknown:0,finished:0,rows:0};
        await tx.put({'state':s,[`receipt:${b.installationId}`]:{action,fingerprint:hash,installed:true}});return {installed:true,reconciled:false};
      }
      state(s,b);
      if(action==='read'){
        exact(a,[]);return {version:1,kind:'dawar-voice-writer-status',...b,phase:s.phase,generation:s.generation,
          operationId:s.operationId,expiresAt:s.expiresAt,activeWriters:s.active,unknownWriters:s.unknown,finishedWriters:s.finished,
          trackedIdle:s.phase==='draining'&&Date.now()<s.expiresAt&&s.active===0&&s.unknown===0,
          observedAt:Date.now(),legacyCallCoverageEstablished:false,fullProductionWriterFreezeEstablished:false};
      }
      if(action==='receipt'){
        exact(a,['operationId']);const r=await tx.get(`receipt:${id(a.operationId)}`);return {found:Boolean(r),receipt:r??null};
      }
      if(action==='admit'){
        exact(a,['operationId','kind','parentId']);id(a.operationId);if(!kinds.includes(a.kind)||a.parentId!==null&&typeof a.parentId!=='string')throw failure();
        if(await tx.get(`receipt:${a.operationId}`))throw failure();
        const prior=await tx.get(`writer:${a.operationId}`);
        if(prior){if(prior.fingerprint!==hash)throw failure();return {admitted:false,reconciled:true,operationId:a.operationId,fingerprint:hash};}
        if(a.parentId!==null){const p=await tx.get(`writer:${id(a.parentId)}`);if(a.kind!=='sip'||p?.state!=='active'||p.kind!=='http'||keys.some(k=>p[k]!==b[k]))throw failure();}
        else if(s.phase!=='open')throw failure();
        if(s.rows>=10000||s.active+s.unknown>=1024)throw failure();
        await tx.put({[`writer:${a.operationId}`]:{...b,operationId:a.operationId,kind:a.kind,parentId:a.parentId,fingerprint:hash,state:'active'},state:{...s,active:s.active+1,rows:s.rows+1}});
        return {admitted:true,reconciled:false,operationId:a.operationId,fingerprint:hash};
      }
      if(action==='settle'){
        exact(a,['operationId','fingerprint','outcome']);id(a.operationId);if(!['finished','unknown'].includes(a.outcome)||!/^[a-f0-9]{64}$/.test(a.fingerprint))throw failure();
        const r=await tx.get(`writer:${a.operationId}`);if(!r||r.fingerprint!==a.fingerprint||keys.some(k=>r[k]!==b[k]))throw failure();
        const prior=await tx.get(`receipt:${a.operationId}`);
        if(prior){if(prior.action!=='settle'||prior.fingerprint!==hash||r.state!==a.outcome)throw failure();return {settled:true,reconciled:true};}
        if(r.state!=='active'||s.active<1)throw failure();
        await tx.put({[`writer:${a.operationId}`]:{...r,state:a.outcome},[`receipt:${a.operationId}`]:{action,fingerprint:hash,outcome:a.outcome},state:{...s,active:s.active-1,[a.outcome]:s[a.outcome]+1}});
        return {settled:true,reconciled:false};
      }
      if(action==='drain'){
        exact(a,['operationId','expiresAt']);id(a.operationId);const prior=await tx.get(`receipt:${a.operationId}`);
        if(prior){if(prior.action!=='drain'||prior.fingerprint!==hash||s.phase!=='draining'||s.operationId!==a.operationId||s.expiresAt!==a.expiresAt)throw failure();return {draining:true,reconciled:true,generation:s.generation};}
        const now=Date.now();if(s.phase!=='open'||!Number.isSafeInteger(a.expiresAt)||a.expiresAt<=now||a.expiresAt-now>900000||s.generation>=Number.MAX_SAFE_INTEGER||await tx.get(`writer:${a.operationId}`))throw failure();
        s={...s,phase:'draining',generation:s.generation+1,operationId:a.operationId,expiresAt:a.expiresAt};
        await tx.put({state:s,[`receipt:${a.operationId}`]:{action,fingerprint:hash,generation:s.generation,expiresAt:a.expiresAt}});return {draining:true,reconciled:false,generation:s.generation};
      }
      exact(a,['operationId','drainId','generation']);id(a.operationId);id(a.drainId);
      const prior=await tx.get(`receipt:${a.operationId}`);
      if(prior){if(prior.action!=='release'||prior.fingerprint!==hash)throw failure();return {released:true,reconciled:true,generation:a.generation,currentPhase:s.phase};}
      if(s.phase!=='draining'||s.operationId!==a.drainId||s.generation!==a.generation||await tx.get(`writer:${a.operationId}`))throw failure();
      await tx.put({state:{...s,phase:'open',operationId:null,expiresAt:0},[`receipt:${a.operationId}`]:{action,fingerprint:hash,generation:a.generation}});
      return {released:true,reconciled:false,generation:a.generation,currentPhase:'open'};
    });
  }};
}
