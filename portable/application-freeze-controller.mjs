import {observeSourceWriterDrain} from './source-writer-admission.mjs';
import {readD1WriteFence} from './d1-write-fence.mjs';

// Only trusted, source-bound adapters supply these observations. A request,
// environment assertion, elapsed quiet period or database-only proof cannot
// stand in for any of the four independent writer authorities.
const scopes=Object.freeze([
  'legacy-worker-lifetimes',
  'voice-provider-effects',
  'issued-storage-uploads',
  'native-control-files',
]);
const encoder=new TextEncoder();
const failure=()=>Error('The complete original application writer freeze could not be confirmed.');
function id(v){if(typeof v!=='string'||!v||v.includes('\0')||encoder.encode(v).length>1024)throw failure();return v;}
function hash(v){if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw failure();return v;}
function integer(v){if(!Number.isSafeInteger(v)||v<1)throw failure();return v;}
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw failure();}
async function digest(v){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(v)))),b=>b.toString(16).padStart(2,'0')).join('');}
function externalBinding(v){
  exact(v,['scope','sourceId','installationId','producerSHA256','operationId','epoch','generation','expiresAt']);
  if(!scopes.includes(v.scope))throw failure();
  return {scope:v.scope,sourceId:id(v.sourceId),installationId:id(v.installationId),producerSHA256:hash(v.producerSHA256),
    operationId:id(v.operationId),epoch:integer(v.epoch),generation:integer(v.generation),expiresAt:integer(v.expiresAt)};
}
function inputBinding(v){
  exact(v,['sourceId','operationId','epoch','expiresAt','journal','database','external']);
  exact(v.journal,['installationId','producerSHA256','operationId','generation']);
  exact(v.database,['installId','schemaSHA256','guardSHA256','operationId','generation']);
  if(!Array.isArray(v.external)||v.external.length!==scopes.length)throw failure();
  const external=v.external.map(externalBinding);
  if(new Set(external.map(e=>e.scope)).size!==scopes.length)throw failure();
  const original={sourceId:id(v.sourceId),operationId:id(v.operationId),epoch:integer(v.epoch),expiresAt:integer(v.expiresAt),
    journal:{installationId:id(v.journal.installationId),producerSHA256:hash(v.journal.producerSHA256),operationId:id(v.journal.operationId),generation:integer(v.journal.generation)},
    database:{installId:id(v.database.installId),schemaSHA256:hash(v.database.schemaSHA256),guardSHA256:hash(v.database.guardSHA256),operationId:id(v.database.operationId),generation:integer(v.database.generation)},
    external:scopes.map(scope=>external.find(e=>e.scope===scope))};
  if(original.database.operationId!==original.operationId||original.database.generation!==original.epoch||external.some(e=>e.expiresAt!==original.expiresAt))throw failure();
  return original;
}

export function createApplicationFreezeController({db,expected,externalObservers,signal}) {
  const original=inputBinding(expected);
  exact(externalObservers,scopes);
  if(scopes.some(scope=>typeof externalObservers[scope]!=='function'))throw failure();
  // Capture the callbacks and values once; mutation of caller configuration
  // across awaited observations cannot replace an original writer authority.
  const observers=scopes.map(scope=>externalObservers[scope]);
  const configuredAt=Date.now();
  if(original.expiresAt<=configuredAt||original.expiresAt-configuredAt>900000)throw failure();
  const deadline=performance.now()+original.expiresAt-configuredAt;
  let closed=false,active=null,lastWall=configuredAt,lastObserved=new Map();
  const cancelled=new AbortController();
  function current(){
    signal?.throwIfAborted();cancelled.signal.throwIfAborted();const now=Date.now();
    if(closed||now<lastWall||now>=original.expiresAt||performance.now()>=deadline)throw failure();
    lastWall=now;return now;
  }
  function fresh(key,p){
    const now=current();
    if(!p||!Number.isSafeInteger(p.observedAt)||Math.abs(p.observedAt-now)>5000||lastObserved.has(key)&&p.observedAt<lastObserved.get(key))throw failure();
    lastObserved.set(key,p.observedAt);
  }
  async function observe(){
    current();
    const journal=await observeSourceWriterDrain({db,expected:{sourceId:original.sourceId,installationId:original.journal.installationId,producerSHA256:original.journal.producerSHA256},operationId:original.journal.operationId});
    fresh('journal',journal);
    if(journal.kind!=='dawar-source-writer-drain'||journal.scope!=='worker-request-and-scheduled-lifetimes'||journal.status!=='idle'||
        journal.operationId!==original.journal.operationId||journal.generation!==original.journal.generation||journal.expiresAt!==original.expiresAt||
        journal.activeWriters!==0||journal.unknownWriters!==0)throw failure();
    const database=await readD1WriteFence({db,expected:{sourceId:original.sourceId,installId:original.database.installId,schemaSHA256:original.database.schemaSHA256},operationId:original.database.operationId});
    fresh('database',database);
    if(database.scope!=='d1-database-writes'||database.status!=='frozen'||database.sourceId!==original.sourceId||
        database.operationId!==original.operationId||database.epoch!==original.epoch||database.generation!==original.database.generation||
        database.guardSHA256!==original.database.guardSHA256||database.expiresAt!==original.expiresAt)throw failure();
    const external=[];
    for(let i=0;i<scopes.length;i++){
      current();const e=original.external[i],p=await observers[i]({...e},AbortSignal.any([cancelled.signal,...(signal?[signal]:[])]));
      fresh(e.scope,p);
      if(p.version!==1||p.kind!=='dawar-external-writer-freeze'||p.status!=='frozen'||Object.keys(e).some(k=>p[k]!==e[k])||
          p.controllerOperationId!==original.operationId||p.releaseAuthority!=='captured-controller'||p.automaticExpiryRelease!==false||
          p.admittedWriters!==0||p.unknownWriters!==0||p.newStartsHeld!==true||p.currentToolsSettled!==true||p.currentVolatileStateSettled!==true)throw failure();
      external.push(p);
    }
    // External observers can await native/service queries. Re-read the two
    // primary database authorities after those awaits, while checking every
    // original external observation is still fresh. Never fabricate freshness.
    const journalAfter=await observeSourceWriterDrain({db,expected:{sourceId:original.sourceId,installationId:original.journal.installationId,producerSHA256:original.journal.producerSHA256},operationId:original.journal.operationId});
    fresh('journal',journalAfter);
    if(journalAfter.status!=='idle'||journalAfter.operationId!==journal.operationId||journalAfter.generation!==journal.generation||journalAfter.expiresAt!==journal.expiresAt||
        journalAfter.activeWriters!==0||journalAfter.unknownWriters!==0||journalAfter.retainedFinishedWriters!==journal.retainedFinishedWriters)throw failure();
    const databaseAfter=await readD1WriteFence({db,expected:{sourceId:original.sourceId,installId:original.database.installId,schemaSHA256:original.database.schemaSHA256},operationId:original.database.operationId});
    fresh('database',databaseAfter);
    if(databaseAfter.status!=='frozen'||databaseAfter.operationId!==database.operationId||databaseAfter.epoch!==database.epoch||
        databaseAfter.generation!==database.generation||databaseAfter.expiresAt!==database.expiresAt||databaseAfter.guardSHA256!==database.guardSHA256)throw failure();
    for(let i=0;i<external.length;i++)fresh(scopes[i],external[i]);
    const componentBindingSHA256=await digest(original);current();
    fresh('journal',journalAfter);fresh('database',databaseAfter);
    for(let i=0;i<external.length;i++)fresh(scopes[i],external[i]);
    return {version:1,kind:'dawar-application-writer-freeze',scope:'all-application-writers',status:'frozen',
      sourceId:original.sourceId,operationId:original.operationId,epoch:original.epoch,generation:original.epoch,
      expiresAt:original.expiresAt,observedAt:Math.min(journalAfter.observedAt,databaseAfter.observedAt,...external.map(p=>p.observedAt)),
      admittedWriters:0,unknownWriters:0,componentBindingSHA256};
  }
  return {
    async verify(){
      current();if(active)throw failure();
      const task=observe();active=task;
      try{return await task;}finally{if(active===task)active=null;}
    },
    async stopAndWait(){closed=true;cancelled.abort();if(active)await active.catch(()=>{});},
    get idle(){return active===null;},
  };
}
