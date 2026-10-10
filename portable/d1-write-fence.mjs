// One-time migration gate, supplied only to the authenticated source controller.
// There is no public SQL input. All application DML, including old Workers and
// trigger side effects, is fenced by SQLite itself. External effects are NOT.
const STATE='__dawar_migration_write_state';
const RECEIPTS='__dawar_migration_write_receipts';
const PREFIX='__dawar_migration_write_';
const identifier=s=>'"'+s.replaceAll('"','""')+'"';
const failure=()=>Error('The original D1 migration gate or receipt could not be confirmed. Retain its identity; do not replay it.');
const bytes=s=>new TextEncoder().encode(s);
const hex=b=>Array.from(new Uint8Array(b),v=>v.toString(16).padStart(2,'0')).join('');
const hash=async value=>hex(await crypto.subtle.digest('SHA-256',bytes(JSON.stringify(value))));
function id(value) { if(typeof value!=='string'||!value||value.includes('\0')||bytes(value).length>1024)throw failure();return value; }
function digest(value) { if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw failure();return value; }
function binding(value) { return {sourceId:id(value?.sourceId),installId:id(value?.installId),schemaSHA256:digest(value?.schemaSHA256)}; }
const schemaSQL="SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND lower(substr(name,1,7)) <> 'sqlite_' AND lower(name) NOT IN ('_cf_kv','_cf_metadata') ORDER BY type,name";
async function all(db,sql,params=[]) {
  // Raw D1 bindings execute on the primary. A sequential-consistency session
  // can read replicas and is not sufficient for a current fence proof.
  if(typeof db?.getBookmark==='function'||typeof db?.prepare!=='function')throw failure();
  const result=await db.prepare(sql).bind(...params).all();
  return resultRows(result);
}
function resultRows(result) { if(result?.success!==true||!Array.isArray(result.results)||result.results.length>4000)throw failure();return result.results; }
function originalSchema(rows) {
  const schema=rows.filter(r=>!r.name.startsWith(PREFIX)).map(r=>({type:r.type,name:r.name,tbl_name:r.tbl_name,sql:r.sql}));
  if(!schema.length||bytes(JSON.stringify(schema)).length>128*1024)throw failure();
  for(const r of schema) {
    id(r.name);id(r.tbl_name);
    if(!['table','index','view','trigger'].includes(r.type)||typeof r.sql!=='string'||r.sql.length>100000||
        !new RegExp(`^\\s*CREATE\\s+(?:UNIQUE\\s+)?${r.type}\\b`,'i').test(r.sql)||/CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql))throw failure();
  }
  return schema;
}
async function gateObjects(schema) {
  const objects=[
    {type:'table',name:STATE,tbl_name:STATE,sql:`CREATE TABLE ${identifier(STATE)}(singleton INTEGER PRIMARY KEY CHECK(singleton=1),source_id TEXT NOT NULL,schema_hash TEXT NOT NULL,install_id TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('open','frozen')),generation INTEGER NOT NULL CHECK(generation>=0),operation_id TEXT,expires_at INTEGER NOT NULL)`},
    {type:'table',name:RECEIPTS,tbl_name:RECEIPTS,sql:`CREATE TABLE ${identifier(RECEIPTS)}(id TEXT PRIMARY KEY,kind TEXT NOT NULL,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,expires_at INTEGER NOT NULL,outcome TEXT NOT NULL,valid INTEGER NOT NULL CHECK(valid=1))`},
  ];
  for(const table of schema.filter(r=>r.type==='table')) {
    const stem=PREFIX+(await hash(table.name)).slice(0,32);
    for(const action of ['INSERT','UPDATE','DELETE']) {
      const name=stem+'_'+action.toLowerCase();
      objects.push({type:'trigger',name,tbl_name:table.name,sql:`CREATE TRIGGER ${identifier(name)} BEFORE ${action} ON ${identifier(table.name)} WHEN (SELECT phase FROM ${identifier(STATE)} WHERE singleton=1) IS NOT 'open' BEGIN SELECT RAISE(ABORT,'DawarTodo migration write freeze'); END`});
    }
  }
  if(schema.length+objects.length>4000||bytes(JSON.stringify([...schema,...objects])).length>1024*1024)throw failure();
  return objects.sort((a,b)=>a.type.localeCompare(b.type)||a.name.localeCompare(b.name));
}
async function inspect(db,expected) {
  const results=await batch(db,[[schemaSQL],[`SELECT * FROM ${identifier(STATE)} WHERE singleton=1`]]);
  return inspectRows(resultRows(results[0]),resultRows(results[1]),expected);
}
async function inspectRows(rows,states,expected) {
  id(expected.sourceId);id(expected.installId);digest(expected.schemaSHA256);
  const schema=originalSchema(rows);
  if(await hash(schema)!==expected.schemaSHA256)throw failure();
  const actual=rows.filter(r=>r.name.startsWith(PREFIX)).map(r=>({type:r.type,name:r.name,tbl_name:r.tbl_name,sql:r.sql}));
  const wanted=await gateObjects(schema);
  if(JSON.stringify(actual)!==JSON.stringify(wanted))throw failure();
  if(states.length!==1)throw failure();const state=states[0];
  if(state.source_id!==expected.sourceId||state.schema_hash!==expected.schemaSHA256||state.install_id!==expected.installId||
      !['open','frozen'].includes(state.phase)||!Number.isSafeInteger(state.generation)||state.generation<0)throw failure();
  return {state,schema,guardSHA256:await hash(wanted)};
}
async function prior(db,operationId,fingerprint) {
  const rows=await all(db,`SELECT * FROM ${identifier(RECEIPTS)} WHERE id=?`,[operationId]);
  if(rows.length>1||rows.length&&rows[0].fingerprint!==fingerprint)throw failure();return rows[0]??null;
}
async function batch(db,statements) {
  if(typeof db?.getBookmark==='function'||typeof db?.batch!=='function')throw failure();
  // D1 documents batch as one transaction, rolling back on any failed statement.
  const results=await db.batch(statements.map(([sql,params=[]])=>db.prepare(sql).bind(...params)));
  if(!Array.isArray(results)||results.length!==statements.length||results.some(r=>r.success!==true))throw failure();
  return results;
}
export async function planD1WriteFence(db) {
  const rows=await all(db,schemaSQL);
  if(rows.some(r=>r.name.startsWith(PREFIX)))throw failure();
  const schema=originalSchema(rows);
  const tables=(await all(db,'PRAGMA table_list')).filter(t=>schema.some(r=>r.type==='table'&&r.name===t.name));
  if(tables.length!==schema.filter(r=>r.type==='table').length||tables.some(t=>t.schema!=='main'||t.type!=='table'))throw failure();
  return {schemaSHA256:await hash(schema),tableCount:tables.length,triggerCount:tables.length*3};
}
export async function installD1WriteFence({db,sourceId,installId,schemaSHA256}) {
  id(sourceId);id(installId);digest(schemaSHA256);
  const expected={sourceId,installId,schemaSHA256};
  const fingerprint=await hash({version:1,kind:'install',...expected});
  const rows=await all(db,schemaSQL);
  if(rows.some(r=>r.name.startsWith(PREFIX))) {
    const current=await inspect(db,expected),receipt=await prior(db,installId,fingerprint);
    if(receipt?.kind!=='install'||receipt.outcome!=='installed')throw failure();
    return {installed:true,...expected,guardSHA256:current.guardSHA256,reconciled:true};
  }
  const schema=originalSchema(rows);if(await hash(schema)!==schemaSHA256)throw failure();
  const tables=await all(db,'PRAGMA table_list');
  if(schema.some(r=>r.type==='table'&&!tables.some(t=>t.name===r.name&&t.schema==='main'&&t.type==='table')))throw failure();
  const objects=await gateObjects(schema),ddl=objects.filter(r=>r.type==='table');
  // Original schema equality is checked INSIDE the installation transaction,
  // before any gate trigger is attached. A schema race rolls the batch back.
  const schemaEquality=`(SELECT json_group_array(json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)) FROM (${schemaSQL.replace(' ORDER BY type,name',` AND substr(name,1,${PREFIX.length}) <> '${PREFIX}' ORDER BY type,name`)}))`;
  await batch(db,[...ddl.map(r=>[r.sql]),
    [`INSERT INTO ${identifier(RECEIPTS)} VALUES(?,'install',?,0,0,'installed',CASE WHEN ${schemaEquality}=? THEN 1 ELSE 0 END)`,[installId,fingerprint,JSON.stringify(schema)]],
    [`INSERT INTO ${identifier(STATE)} VALUES(1,?,?,?,'open',0,NULL,0)`,[sourceId,schemaSHA256,installId]],
    ...objects.filter(r=>r.type==='trigger').map(r=>[r.sql]),
  ]);
  const current=await inspect(db,expected);
  return {installed:true,...expected,guardSHA256:current.guardSHA256,reconciled:false};
}
export async function readD1WriteFenceInstallation({db,expected}) {
  expected=binding(expected);const current=await inspect(db,expected);
  const fingerprint=await hash({version:1,kind:'install',...expected}),receipt=await prior(db,expected.installId,fingerprint);
  if(receipt?.kind!=='install'||receipt.outcome!=='installed')throw failure();
  return {version:1,kind:'dawar-database-fence-installation',scope:'d1-database-writes',...expected,installed:true,
    guardSHA256:current.guardSHA256,phase:current.state.phase,generation:current.state.generation,
    operationId:current.state.operation_id,expiresAt:current.state.expires_at,observedAt:Date.now(),
    externalWriterCoverageEstablished:false,productionWriterFreezeEstablished:false};
}
export async function readD1WriteFenceControlReceipt({db,expected,kind,operationId,expiresAt=0,generation=0,freezeId}) {
  expected=binding(expected);id(operationId);const current=await inspect(db,expected);let fingerprint;
  if(kind==='install'&&operationId===expected.installId&&expiresAt===0&&generation===0)fingerprint=await hash({version:1,kind,...expected});
  else if(kind==='freeze'&&Number.isSafeInteger(expiresAt)&&expiresAt>0&&generation===0)fingerprint=await hash({version:1,kind,...expected,operationId,expiresAt});
  else if(kind==='release'&&expiresAt===0&&Number.isSafeInteger(generation)&&generation>0)fingerprint=await hash({version:1,kind,...expected,freezeId:id(freezeId),releaseId:operationId,generation});
  else throw failure();
  const receipt=await prior(db,operationId,fingerprint),outcomes={install:['installed'],freeze:['frozen','released'],release:['released']};
  if(!receipt||receipt.kind!==kind||!outcomes[kind].includes(receipt.outcome)||receipt.valid!==1||!Number.isSafeInteger(receipt.generation)||receipt.generation<0||
      receipt.expires_at!==expiresAt||kind==='install'&&receipt.generation!==0||kind==='freeze'&&receipt.generation<1||kind==='release'&&receipt.generation!==generation)throw failure();
  return {version:1,kind:'dawar-database-fence-control-receipt',...expected,operationId,receiptKind:kind,fingerprint,
    outcome:receipt.outcome,generation:receipt.generation,expiresAt:receipt.expires_at,receiptConfirmed:true,currentPhase:current.state.phase,
    productionWriterFreezeEstablished:false};
}
export async function freezeD1Writes({db,expected,operationId,expiresAt}) {
  expected=binding(expected);
  id(operationId);const now=Date.now();
  if(!Number.isSafeInteger(expiresAt)||expiresAt<=now||expiresAt-now>900000)throw failure();
  await inspect(db,expected);
  const fingerprint=await hash({version:1,kind:'freeze',...expected,operationId,expiresAt});
  const existing=await prior(db,operationId,fingerprint);
  if(existing) {
    if(existing.kind!=='freeze'||existing.outcome!=='frozen')throw failure();
    return readD1WriteFence({db,expected,operationId});
  }
  await batch(db,[
    [`INSERT INTO ${identifier(RECEIPTS)} SELECT ?,'freeze',?,generation+1,?,'frozen',CASE WHEN phase='open' AND generation<9007199254740991 AND source_id=? AND schema_hash=? AND install_id=? THEN 1 ELSE 0 END FROM ${identifier(STATE)} WHERE singleton=1`,[operationId,fingerprint,expiresAt,expected.sourceId,expected.schemaSHA256,expected.installId]],
    [`UPDATE ${identifier(STATE)} SET phase='frozen',generation=generation+1,operation_id=?,expires_at=? WHERE singleton=1 AND phase='open' AND EXISTS(SELECT 1 FROM ${identifier(RECEIPTS)} WHERE id=? AND fingerprint=? AND generation=${identifier(STATE)}.generation+1)`,[operationId,expiresAt,operationId,fingerprint]],
  ]);
  return readD1WriteFence({db,expected,operationId});
}
export async function readD1WriteFence({db,expected,operationId}) {
  expected=binding(expected);
  id(operationId);
  const results=await batch(db,[[schemaSQL],[`SELECT * FROM ${identifier(STATE)} WHERE singleton=1`],
    [`SELECT * FROM ${identifier(RECEIPTS)} WHERE id=?`,[operationId]]]);
  const current=await inspectRows(resultRows(results[0]),resultRows(results[1]),expected),s=current.state;
  const fingerprint=await hash({version:1,kind:'freeze',...expected,operationId,expiresAt:s.expires_at});
  const receipts=resultRows(results[2]);if(receipts.length!==1)throw failure();const receipt=receipts[0];
  if(s.phase!=='frozen'||s.operation_id!==operationId||receipt?.kind!=='freeze'||receipt.outcome!=='frozen'||
      receipt.fingerprint!==fingerprint||receipt.generation!==s.generation||receipt.expires_at!==s.expires_at||
      s.generation<1||!Number.isSafeInteger(s.expires_at))throw failure();
  const observedAt=Date.now();
  return {version:1,kind:'dawar-application-writer-freeze',scope:'d1-database-writes',status:s.expires_at>observedAt?'frozen':'expired',
    sourceId:expected.sourceId,operationId,epoch:s.generation,generation:s.generation,expiresAt:s.expires_at,observedAt,
    schemaSHA256:expected.schemaSHA256,guardSHA256:current.guardSHA256,
    externalWriterCoverageEstablished:false,automaticExecutionDisabled:true};
}
export async function releaseD1Writes({db,expected,freezeId,releaseId,generation}) {
  expected=binding(expected);
  id(freezeId);id(releaseId);if(!Number.isSafeInteger(generation)||generation<1)throw failure();
  const current=await inspect(db,expected);
  const fingerprint=await hash({version:1,kind:'release',...expected,freezeId,releaseId,generation});
  const existing=await prior(db,releaseId,fingerprint);
  if(existing) {
    if(existing.kind!=='release'||existing.outcome!=='released')throw failure();
    return {releasedOriginal:true,generation,currentPhase:current.state.phase,reconciled:true};
  }
  const freezeFingerprint=await hash({version:1,kind:'freeze',...expected,operationId:freezeId,expiresAt:current.state.expires_at});
  const freezeReceipt=await prior(db,freezeId,freezeFingerprint);
  if(freezeReceipt?.kind!=='freeze'||freezeReceipt.outcome!=='frozen'||freezeReceipt.generation!==generation||
      freezeReceipt.expires_at!==current.state.expires_at)throw failure();
  await batch(db,[
    [`INSERT INTO ${identifier(RECEIPTS)} VALUES(?,'release',?, ?,0,'released',CASE WHEN EXISTS(SELECT 1 FROM ${identifier(STATE)} WHERE singleton=1 AND phase='frozen' AND operation_id=? AND generation=? AND source_id=? AND schema_hash=? AND install_id=?) THEN 1 ELSE 0 END)`,[releaseId,fingerprint,generation,freezeId,generation,expected.sourceId,expected.schemaSHA256,expected.installId]],
    [`UPDATE ${identifier(STATE)} SET phase='open',operation_id=NULL,expires_at=0 WHERE singleton=1 AND phase='frozen' AND operation_id=? AND generation=?`,[freezeId,generation]],
    [`UPDATE ${identifier(RECEIPTS)} SET outcome='released' WHERE id=? AND kind='freeze' AND generation=? AND outcome='frozen'`,[freezeId,generation]],
  ]);
  const after=await inspect(db,expected);if(after.state.phase!=='open'||after.state.generation!==generation)throw failure();
  return {releasedOriginal:true,generation,currentPhase:'open',reconciled:false};
}
