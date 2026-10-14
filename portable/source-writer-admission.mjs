// Cross-isolate admission for the original Worker. This is one component of a
// cutover, never an assertion about native, voice or direct-upload writers.
const STATE='__dawar_migration_admission_state',RECEIPTS='__dawar_migration_admission_receipts',WRITERS='__dawar_migration_admission_writers';
const PREFIX='__dawar_migration_admission_',encoder=new TextEncoder();
const failure=()=>Error('The original source writer admission or receipt could not be confirmed.');
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value)))),b=>b.toString(16).padStart(2,'0')).join('');
function id(v){if(typeof v!=='string'||!v||v.includes('\0')||encoder.encode(v).length>1024)throw failure();return v;}
function binding(v){if(!v||Object.keys(v).length!==3||Object.keys(v).some(k=>!['sourceId','installationId','producerSHA256'].includes(k))||typeof v.producerSHA256!=='string'||!/^[a-f0-9]{64}$/.test(v.producerSHA256))throw failure();return {sourceId:id(v.sourceId),installationId:id(v.installationId),producerSHA256:v.producerSHA256};}
function rows(r){if(r?.success!==true||!Array.isArray(r.results)||r.results.length>1000)throw failure();return r.results;}
async function batch(db,sql){if(typeof db?.batch!=='function'||typeof db?.prepare!=='function'||typeof db?.getBookmark==='function')throw failure();const r=await db.batch(sql.map(([s,p=[]])=>db.prepare(s).bind(...p)));if(!Array.isArray(r)||r.length!==sql.length||r.some(x=>x.success!==true))throw failure();return r;}
const objects=[
  {name:STATE,sql:`CREATE TABLE "${STATE}"(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source_id TEXT NOT NULL,installation_id TEXT NOT NULL,producer_hash TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('open','draining')),generation INTEGER NOT NULL CHECK(generation>=0),operation_id TEXT,expires_at INTEGER NOT NULL)`},
  {name:RECEIPTS,sql:`CREATE TABLE "${RECEIPTS}"(id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,expires_at INTEGER NOT NULL,outcome TEXT NOT NULL,valid INTEGER NOT NULL CHECK(valid=1))`},
  {name:WRITERS,sql:`CREATE TABLE "${WRITERS}"(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,installation_id TEXT NOT NULL,producer_hash TEXT NOT NULL,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','finished','unknown')),finish_fingerprint TEXT,valid INTEGER NOT NULL CHECK(valid=1))`},
].sort((a,b)=>a.name.localeCompare(b.name));
const schemaSQL=`SELECT name,sql FROM sqlite_schema WHERE substr(name,1,${PREFIX.length})='${PREFIX}' AND sql IS NOT NULL ORDER BY name`;
async function inspect(db,expected,extra=[]) {
  expected=binding(expected);
  const result=await batch(db,[[schemaSQL],[`SELECT * FROM "${STATE}" WHERE singleton=1`],...extra]);
  if(JSON.stringify(rows(result[0]))!==JSON.stringify(objects))throw failure();
  const states=rows(result[1]);if(states.length!==1)throw failure();const s=states[0];
  if(s.source_id!==expected.sourceId||s.installation_id!==expected.installationId||s.producer_hash!==expected.producerSHA256||
      !['open','draining'].includes(s.phase)||!Number.isSafeInteger(s.generation)||s.generation<0||!Number.isSafeInteger(s.expires_at))throw failure();
  return {state:s,extra:result.slice(2).map(rows)};
}
export async function installSourceWriterAdmission({db,expected}) {
  expected=binding(expected);const fingerprint=await hash({version:1,kind:'install',...expected});
  const existing=rows((await batch(db,[[schemaSQL]]))[0]);
  if(existing.length) {
    const found=await inspect(db,expected,[[`SELECT * FROM "${RECEIPTS}" WHERE id=?`,[expected.installationId]]]);
    if(found.extra[0].length!==1||found.extra[0][0].fingerprint!==fingerprint||found.extra[0][0].kind!=='install'||found.extra[0][0].outcome!=='installed')throw failure();
    return {installed:true,reconciled:true,...expected};
  }
  await batch(db,[...objects.map(o=>[o.sql]),
    [`INSERT INTO "${STATE}" VALUES(1,?,?,?,'open',0,NULL,0)`,[expected.sourceId,expected.installationId,expected.producerSHA256]],
    [`INSERT INTO "${RECEIPTS}" VALUES(?,'install',?,0,0,'installed',1)`,[expected.installationId,fingerprint]],
  ]);
  await inspect(db,expected);return {installed:true,reconciled:false,...expected};
}
export async function readSourceWriterAdmission({db,expected}) {
  expected=binding(expected);const fingerprint=await hash({version:1,kind:'install',...expected});
  const value=await inspect(db,expected,[[`SELECT * FROM "${RECEIPTS}" WHERE id=?`,[expected.installationId]],
    [`SELECT state,COUNT(*) AS n FROM "${WRITERS}" GROUP BY state ORDER BY state`],
    [`SELECT COUNT(*) AS n FROM "${WRITERS}" WHERE source_id<>? OR installation_id<>? OR producer_hash<>? OR kind NOT IN ('worker-http','worker-scheduled') OR valid<>1`,[expected.sourceId,expected.installationId,expected.producerSHA256]]]);
  const receipt=value.extra[0];
  if(receipt.length!==1||receipt[0].kind!=='install'||receipt[0].fingerprint!==fingerprint||receipt[0].outcome!=='installed'||
      value.extra[2].length!==1||value.extra[2][0].n!==0)throw failure();
  const counts={active:0,finished:0,unknown:0};
  for(const row of value.extra[1]){if(!Object.hasOwn(counts,row.state)||!Number.isSafeInteger(row.n)||row.n<0)throw failure();counts[row.state]=row.n;}
  return {version:1,kind:'dawar-source-writer-installation',scope:'worker-request-and-scheduled-lifetimes',...expected,
    phase:value.state.phase,generation:value.state.generation,operationId:value.state.operation_id,expiresAt:value.state.expires_at,
    activeWriters:counts.active,unknownWriters:counts.unknown,retainedFinishedWriters:counts.finished,observedAt:Date.now(),
    externalWriterCoverageEstablished:false,productionWriterFreezeEstablished:false};
}
export async function readSourceWriterControlReceipt({db,expected,kind,operationId,expiresAt=0,generation=0,drainId}) {
  expected=binding(expected);id(operationId);let fingerprint;
  if(kind==='install'&&operationId===expected.installationId&&expiresAt===0&&generation===0)fingerprint=await hash({version:1,kind,...expected});
  else if(kind==='drain'&&Number.isSafeInteger(expiresAt)&&expiresAt>0&&generation===0)fingerprint=await hash({version:1,kind,...expected,operationId,expiresAt});
  else if(kind==='release'&&expiresAt===0&&Number.isSafeInteger(generation)&&generation>0)fingerprint=await hash({version:1,kind,...expected,drainId:id(drainId),releaseId:operationId,generation});
  else throw failure();
  const value=await inspect(db,expected,[[`SELECT * FROM "${RECEIPTS}" WHERE id=?`,[operationId]]]),r=value.extra[0];
  const outcomes={install:['installed'],drain:['draining','released'],release:['released']};
  if(r.length!==1||r[0].kind!==kind||r[0].fingerprint!==fingerprint||!outcomes[kind].includes(r[0].outcome)||
      r[0].valid!==1||!Number.isSafeInteger(r[0].generation)||r[0].generation<0||r[0].expires_at!==expiresAt||
      kind==='install'&&r[0].generation!==0||kind==='drain'&&r[0].generation<1||kind==='release'&&r[0].generation!==generation)throw failure();
  return {version:1,kind:'dawar-source-writer-control-receipt',...expected,operationId,receiptKind:kind,fingerprint,
    outcome:r[0].outcome,generation:r[0].generation,expiresAt:r[0].expires_at,receiptConfirmed:true,currentPhase:value.state.phase,
    productionWriterFreezeEstablished:false};
}
export async function admitSourceWriter({db,expected,operationId,kind}) {
  expected=binding(expected);id(operationId);
  if(!['worker-http','worker-scheduled'].includes(kind))throw failure();
  const fingerprint=await hash({version:1,...expected,operationId,kind});
  const found=await inspect(db,expected,[[`SELECT * FROM "${WRITERS}" WHERE id=?`,[operationId]]]);
  // This record is admission, not a business-effect idempotency receipt. An old
  // admission may already have begun work; it can be read but cannot start it.
  if(found.extra[0].length)throw failure();
  await batch(db,[[`INSERT INTO "${WRITERS}" SELECT ?,source_id,installation_id,producer_hash,?,?,'active',NULL,
    CASE WHEN phase='open' AND source_id=? AND installation_id=? AND producer_hash=?
      AND NOT EXISTS(SELECT 1 FROM "${RECEIPTS}" WHERE id=?) AND (SELECT COUNT(*) FROM "${WRITERS}")<100000 AND (SELECT COUNT(*) FROM "${WRITERS}" WHERE state<>'finished')<1024 THEN 1 ELSE 0 END
    FROM "${STATE}" WHERE singleton=1`,[operationId,kind,fingerprint,expected.sourceId,expected.installationId,expected.producerSHA256,operationId]]]);
  const confirmed=await inspect(db,expected,[[`SELECT * FROM "${WRITERS}" WHERE id=?`,[operationId]]]);
  const row=confirmed.extra[0][0];if(confirmed.extra[0].length!==1||row.fingerprint!==fingerprint||row.state!=='active')throw failure();
  return {operationId,kind,fingerprint,admitted:true,...expected};
}
export async function settleSourceWriter({db,expected,operationId,kind,outcome}) {
  expected=binding(expected);id(operationId);
  if(!['worker-http','worker-scheduled'].includes(kind)||!['finished','unknown'].includes(outcome))throw failure();
  const fingerprint=await hash({version:1,...expected,operationId,kind});
  const finish=await hash({version:1,...expected,operationId,kind,outcome});
  const found=await inspect(db,expected,[[`SELECT * FROM "${WRITERS}" WHERE id=?`,[operationId]]]);
  if(found.extra[0].length!==1)throw failure();const row=found.extra[0][0];
  if(row.fingerprint!==fingerprint||row.source_id!==expected.sourceId||row.installation_id!==expected.installationId||row.producer_hash!==expected.producerSHA256||row.kind!==kind)throw failure();
  if(row.state!=='active') {
    if(row.state!==outcome||row.finish_fingerprint!==finish)throw failure();
    return {settled:true,reconciled:true,outcome,operationId};
  }
  await batch(db,[
    // INSERT into receipts enforces the exact preceding state in the same D1
    // transaction. It is distinct from the retained writer row, never deleted.
    [`INSERT INTO "${RECEIPTS}" VALUES(?,'settle',?,0,0,?,CASE WHEN EXISTS(SELECT 1 FROM "${WRITERS}" WHERE id=? AND fingerprint=? AND state='active' AND source_id=? AND installation_id=? AND producer_hash=? AND kind=?) AND EXISTS(SELECT 1 FROM "${STATE}" WHERE singleton=1 AND source_id=? AND installation_id=? AND producer_hash=?) THEN 1 ELSE 0 END)`,[operationId,finish,outcome,operationId,fingerprint,expected.sourceId,expected.installationId,expected.producerSHA256,kind,expected.sourceId,expected.installationId,expected.producerSHA256]],
    [`UPDATE "${WRITERS}" SET state=?,finish_fingerprint=? WHERE id=? AND fingerprint=? AND state='active'`,[outcome,finish,operationId,fingerprint]],
  ]);
  const after=await inspect(db,expected,[[`SELECT * FROM "${WRITERS}" WHERE id=?`,[operationId]]]);
  if(after.extra[0][0]?.state!==outcome||after.extra[0][0]?.finish_fingerprint!==finish)throw failure();
  return {settled:true,reconciled:false,outcome,operationId};
}
export async function beginSourceWriterDrain({db,expected,operationId,expiresAt}) {
  expected=binding(expected);id(operationId);const now=Date.now();
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt-now>900000)throw failure();
  const fingerprint=await hash({version:1,kind:'drain',...expected,operationId,expiresAt});
  const before=await inspect(db,expected,[[`SELECT * FROM "${RECEIPTS}" WHERE id=?`,[operationId]]]);
  if(before.extra[0].length) {
    const p=before.extra[0][0];if(p.fingerprint!==fingerprint||p.kind!=='drain'||p.outcome!=='draining')throw failure();
    return observeSourceWriterDrain({db,expected,operationId});
  }
  await batch(db,[
    [`INSERT INTO "${RECEIPTS}" SELECT ?,'drain',?,generation+1,?,'draining',CASE WHEN phase='open' AND generation<9007199254740991 AND source_id=? AND installation_id=? AND producer_hash=? AND NOT EXISTS(SELECT 1 FROM "${WRITERS}" WHERE id=?) THEN 1 ELSE 0 END FROM "${STATE}" WHERE singleton=1`,[operationId,fingerprint,expiresAt,expected.sourceId,expected.installationId,expected.producerSHA256,operationId]],
    [`UPDATE "${STATE}" SET phase='draining',generation=generation+1,operation_id=?,expires_at=? WHERE singleton=1 AND phase='open' AND EXISTS(SELECT 1 FROM "${RECEIPTS}" WHERE id=? AND fingerprint=? AND generation="${STATE}".generation+1)`,[operationId,expiresAt,operationId,fingerprint]],
  ]);
  return observeSourceWriterDrain({db,expected,operationId});
}
export async function observeSourceWriterDrain({db,expected,operationId}) {
  expected=binding(expected);id(operationId);
  const value=await inspect(db,expected,[[`SELECT * FROM "${RECEIPTS}" WHERE id=?`,[operationId]],
    [`SELECT state,COUNT(*) AS n FROM "${WRITERS}" GROUP BY state ORDER BY state`],
    [`SELECT COUNT(*) AS n FROM "${WRITERS}" WHERE source_id<>? OR installation_id<>? OR producer_hash<>? OR kind NOT IN ('worker-http','worker-scheduled') OR valid<>1`,[expected.sourceId,expected.installationId,expected.producerSHA256]]]);
  const s=value.state,r=value.extra[0];
  const fingerprint=await hash({version:1,kind:'drain',...expected,operationId,expiresAt:s.expires_at});
  if(s.phase!=='draining'||s.operation_id!==operationId||s.generation<1||r.length!==1||r[0].kind!=='drain'||r[0].fingerprint!==fingerprint||r[0].generation!==s.generation||r[0].expires_at!==s.expires_at||r[0].outcome!=='draining')throw failure();
  if(value.extra[2].length!==1||value.extra[2][0].n!==0)throw failure();
  const counts={active:0,finished:0,unknown:0};for(const row of value.extra[1]) {
    if(!Object.hasOwn(counts,row.state)||!Number.isSafeInteger(row.n)||row.n<0)throw failure();counts[row.state]=row.n;
  }
  const observedAt=Date.now();
  return {version:1,kind:'dawar-source-writer-drain',scope:'worker-request-and-scheduled-lifetimes',...expected,operationId,generation:s.generation,expiresAt:s.expires_at,observedAt,
    status:s.expires_at<=observedAt?'expired':counts.active||counts.unknown?'draining':'idle',activeWriters:counts.active,unknownWriters:counts.unknown,retainedFinishedWriters:counts.finished,
    externalWriterCoverageEstablished:false,productionWriterFreezeEstablished:false};
}
export async function releaseSourceWriterDrain({db,expected,drainId,releaseId,generation}) {
  expected=binding(expected);id(drainId);id(releaseId);if(!Number.isSafeInteger(generation)||generation<1)throw failure();
  const fingerprint=await hash({version:1,kind:'release',...expected,drainId,releaseId,generation});
  const before=await inspect(db,expected,[[`SELECT * FROM "${RECEIPTS}" WHERE id=?`,[releaseId]],
    [`SELECT * FROM "${RECEIPTS}" WHERE id=?`,[drainId]]]);
  if(before.extra[0].length) {
    const p=before.extra[0][0];if(p.kind!=='release'||p.fingerprint!==fingerprint||p.outcome!=='released')throw failure();
    return {releasedOriginal:true,reconciled:true,generation,currentPhase:before.state.phase};
  }
  const p=before.extra[1][0],s=before.state;
  const drainFingerprint=await hash({version:1,kind:'drain',...expected,operationId:drainId,expiresAt:s.expires_at});
  if(before.extra[1].length!==1||p.kind!=='drain'||p.outcome!=='draining'||p.fingerprint!==drainFingerprint||p.generation!==generation||p.expires_at!==s.expires_at)throw failure();
  await batch(db,[
    [`INSERT INTO "${RECEIPTS}" VALUES(?,'release',?,?,0,'released',CASE WHEN EXISTS(SELECT 1 FROM "${STATE}" WHERE singleton=1 AND phase='draining' AND operation_id=? AND generation=? AND source_id=? AND installation_id=? AND producer_hash=? AND expires_at=?) AND EXISTS(SELECT 1 FROM "${RECEIPTS}" WHERE id=? AND kind='drain' AND fingerprint=? AND generation=? AND expires_at=? AND outcome='draining') AND NOT EXISTS(SELECT 1 FROM "${WRITERS}" WHERE id=?) THEN 1 ELSE 0 END)`,[releaseId,fingerprint,generation,drainId,generation,expected.sourceId,expected.installationId,expected.producerSHA256,s.expires_at,drainId,drainFingerprint,generation,s.expires_at,releaseId]],
    [`UPDATE "${STATE}" SET phase='open',operation_id=NULL,expires_at=0 WHERE singleton=1 AND phase='draining' AND operation_id=? AND generation=?`,[drainId,generation]],
    [`UPDATE "${RECEIPTS}" SET outcome='released' WHERE id=? AND kind='drain' AND generation=? AND outcome='draining'`,[drainId,generation]],
  ]);
  const after=await inspect(db,expected);if(after.state.phase!=='open'||after.state.generation!==generation)throw failure();
  return {releasedOriginal:true,reconciled:false,generation,currentPhase:after.state.phase};
}
