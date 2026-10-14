const MAXIMUM_LINE=4*1024*1024;
const bytes=value=>new TextEncoder().encode(value);
const identifier=value=>'\"'+value.replaceAll('\"','\"\"')+'\"';
const failure=()=>Error('Application snapshot read or freeze proof is invalid.');
// Value encoding takes place inside SQLite, before the D1/JavaScript boundary.
// Text uses its raw UTF-8 bytes: quote() and JS strings alone lose embedded NUL
// or invalid UTF-8. Integer values never pass through a JS number.
export function cellExpression(column) {
  const c = identifier(column);
  return `CASE typeof(${c}) WHEN 'null' THEN 'N' WHEN 'integer' THEN 'I'||CAST(${c} AS TEXT) ` +
    `WHEN 'real' THEN 'R'||printf('%!.26g',${c}) WHEN 'text' THEN 'T'||hex(CAST(${c} AS BLOB)) ` +
    `WHEN 'blob' THEN 'B'||hex(${c}) END`;
}
export function cellSQL(cell) {
  if (typeof cell !== 'string' || bytes(cell).length > MAXIMUM_LINE / 2) throw failure();
  if (cell === 'N') return 'NULL';
  const value = cell.slice(1);
  if (cell[0] === 'I' && /^(?:0|-?[1-9][0-9]{0,18})$/.test(value)) {
    const n = BigInt(value);
    if (n < -(1n << 63n) || n >= 1n << 63n) throw failure();
    return value;
  }
  if (cell[0] === 'R') {
    if (value === 'Inf') return 'CAST(9e999 AS REAL)';
    if (value === '-Inf') return 'CAST(-9e999 AS REAL)';
    if (/^-?(?:[0-9]+\.[0-9]*|[0-9]*\.[0-9]+|[0-9]+)(?:e[+-]?[0-9]+)?$/i.test(value) && Number.isFinite(Number(value))) {
      return `CAST(${value} AS REAL)`;
    }
  }
  if (['T', 'B'].includes(cell[0]) && /^(?:[A-F0-9]{2})*$/.test(value)) {
    return cell[0] === 'B' ? `X'${value}'` : `CAST(X'${value}' AS TEXT)`;
  }
  throw failure();
}

export function createApplicationFreezeVerifier({expectedFreeze,verifyFreeze,signal,stillReading=()=>true}) {
  if(typeof verifyFreeze!=='function'||!expectedFreeze)throw failure();
  const expected={sourceId:expectedFreeze.sourceId,operationId:expectedFreeze.operationId,epoch:expectedFreeze.epoch};
  const scope=expectedFreeze.scope??'all-application-writers';
  if(!['all-application-writers','d1-database-writes'].includes(scope))throw failure();
  if(typeof expected.sourceId!=='string'||!expected.sourceId||typeof expected.operationId!=='string'||
      !expected.operationId||!Number.isSafeInteger(expected.epoch)||expected.epoch<1)throw failure();
  let binding,wall,observed,monotonicDeadline;
  return async()=>{
    signal?.throwIfAborted();const proof=await verifyFreeze();signal?.throwIfAborted();const now=Date.now();
    if(!stillReading()||!proof||proof.version!==1||proof.kind!=='dawar-application-writer-freeze'||proof.status!=='frozen'||
        proof.scope!==scope||proof.sourceId!==expected.sourceId||
        proof.operationId!==expected.operationId||proof.epoch!==expected.epoch||
        proof.sourceId.length>1024||proof.operationId.length>1024||
        !Number.isSafeInteger(proof.generation)||proof.generation<1||
        !Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=now||proof.expiresAt-now>900000||
        !Number.isSafeInteger(proof.observedAt)||Math.abs(proof.observedAt-now)>5000||
        wall!==undefined&&now<wall||observed!==undefined&&proof.observedAt<observed||
        (scope==='all-application-writers'?(proof.admittedWriters!==0||proof.unknownWriters!==0):
          (proof.externalWriterCoverageEstablished!==false||proof.automaticExecutionDisabled!==true||
            !/^[a-f0-9]{64}$/.test(proof.schemaSHA256??'')||!/^[a-f0-9]{64}$/.test(proof.guardSHA256??''))))throw failure();
    const current=JSON.stringify([proof.sourceId,proof.operationId,proof.epoch,proof.generation,proof.expiresAt]);
    if(binding!==undefined&&binding!==current)throw failure();binding=current;
    monotonicDeadline??=performance.now()+proof.expiresAt-now;
    if(performance.now()>=monotonicDeadline)throw failure();wall=now;observed=proof.observedAt;return proof;
  };
}

// The wire carries typed metadata/page commands, never caller SQL, column
// projections or an arbitrary source. Descriptor columns/order are derived from
// the source's actual schema while the same complete freeze remains held.
export function createD1ApplicationReadSource({db,expectedFreeze,verifyFreeze,signal}) {
  if(typeof db?.prepare!=='function'||typeof db?.getBookmark==='function')throw failure();
  const verify=createApplicationFreezeVerifier({expectedFreeze,verifyFreeze,signal});
  const tables=new Map();let schema;
  async function query(sql) {
    await verify();if(bytes(sql).length>100000)throw failure();
    const result=await db.prepare(sql).all();await verify();
    if(result.success!==true||!Array.isArray(result.results)||result.results.length>4000||
        bytes(JSON.stringify(result.results)).length>MAXIMUM_LINE)throw failure();
    return result.results;
  }
  async function loadSchema() {
    const rows=await query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND lower(substr(name,1,7)) <> 'sqlite_' AND lower(name) NOT IN ('_cf_kv','_cf_metadata') ORDER BY type,name");
    schema=rows;tables.clear();return rows;
  }
  async function queryMany(statements) {
    if(!Array.isArray(statements)||statements.length>64||statements.some(sql=>bytes(sql).length>100000))throw failure();
    if(typeof db.batch!=='function'){const results=[];for(const sql of statements)results.push(await query(sql));return results;}
    await verify();const results=await db.batch(statements.map(sql=>db.prepare(sql)));await verify();
    if(!Array.isArray(results)||results.length!==statements.length)throw failure();
    return results.map(result=>{
      if(result.success!==true||!Array.isArray(result.results)||result.results.length>4000||
          bytes(JSON.stringify(result.results)).length>MAXIMUM_LINE)throw failure();
      return result.results;
    });
  }
  function describe(entry,xinfo,name) {
    if(!entry||entry.type!=='table'||!Array.isArray(xinfo)||xinfo.length>2000)throw failure();
    const columns=xinfo.filter(c=>c.hidden===0).map(c=>c.name);
    let order;
    if(entry.wr)order=xinfo.filter(c=>c.pk).sort((a,b)=>a.pk-b.pk).map(c=>c.name);
    else {
      const rowid=['_rowid_','rowid','oid'].find(n=>!xinfo.some(c=>c.name.toLowerCase()===n));
      if(!rowid)throw failure();columns.unshift(rowid);order=[rowid];
    }
    if(!columns.length||columns.length>2000||!order.length)throw failure();
    return {name,columns,order};
  }
  async function inventory() {
    const current=await loadSchema(),list=await query('PRAGMA table_list');
    const names=current.filter(s=>s.type==='table').map(s=>s.name);
    if(names.length>1000)throw failure();
    const result=[];
    for(let start=0;start<names.length;start+=32) {
      const part=names.slice(start,start+32);
      const infos=await queryMany(part.map(name=>`PRAGMA table_xinfo(${identifier(name)})`));
      const counts=await queryMany(part.map(name=>`SELECT COUNT(*) AS n FROM ${identifier(name)}`));
      for(let i=0;i<part.length;i++) {
        const name=part[i],value=describe(list.find(t=>t.schema==='main'&&t.name===name),infos[i],name),n=counts[i]?.[0]?.n;
        if(!Number.isSafeInteger(n)||n<0||n>10000000)throw failure();
        tables.set(name,value);result.push({...value,rows:n});
      }
    }
    if(result.reduce((n,t)=>n+t.rows,0)>10000000)throw failure();
    const sequence=(await query("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'")).length?
      await query("SELECT name,'I'||CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name"):[];
    const value={kind:'header',format:'dawar-application-snapshot',version:2,schema:current,tables:result,sequence,
      userVersion:null,applicationId:null,sourceMetadata:{engine:'cloudflare-d1',sqliteHeader:'unavailable'}};
    if(bytes(JSON.stringify(value)).length>MAXIMUM_LINE)throw failure();return [value];
  }
  async function descriptor(name) {
    if(typeof name!=='string'||!name||name.includes('\0')||bytes(name).length>1024)throw failure();
    if(!schema)await loadSchema();
    if(!schema.some(r=>r.type==='table'&&r.name===name))throw failure();
    if(tables.has(name))return tables.get(name);
    const entry=(await query('PRAGMA table_list')).find(t=>t.schema==='main'&&t.name===name);
    const xinfo=await query(`PRAGMA table_xinfo(${identifier(name)})`),value=describe(entry,xinfo,name);
    tables.set(name,value);return value;
  }
  return {async read(command) {
    if(!command||typeof command!=='object'||Array.isArray(command)||bytes(JSON.stringify(command)).length>100000)throw failure();
    if(!Object.hasOwn(command,'kind')||!['inventory','page','schema','tables','sequence-present','sequences','columns','count','sizes','rows'].includes(command.kind))throw failure();
    const allowed=['kind',...(['columns','count'].includes(command.kind)?['table']:['page','sizes','rows'].includes(command.kind)?['table','last','limit']:[])];
    if(Object.keys(command).some(k=>!allowed.includes(k)))throw failure();
    await verify();
    switch(command.kind) {
      case 'inventory':return inventory();
      case 'schema':return loadSchema();
      case 'tables':return query('PRAGMA table_list');
      case 'sequence-present':return query("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'");
      case 'sequences':return query("SELECT name,'I'||CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name");
      case 'columns':await descriptor(command.table);return query(`PRAGMA table_xinfo(${identifier(command.table)})`);
      case 'count':await descriptor(command.table);return query(`SELECT COUNT(*) AS n FROM ${identifier(command.table)}`);
      case 'page':case 'sizes':case 'rows': {
        const t=await descriptor(command.table);
        if(!Number.isInteger(command.limit)||command.limit<1||command.limit>(command.kind==='page'?1024:256)||
            command.last!==null&&(!Array.isArray(command.last)||command.last.length!==t.order.length))throw failure();
        const keys=t.order.map(identifier).join(','),comparison=command.last?
          ` WHERE (${keys}) > (${command.last.map(cellSQL).join(',')})`:'';
        if(command.kind==='page') {
          // One HTTP exchange combines bounded length discovery and data. No
          // raw SQL, projection or page-byte budget can be supplied by callers.
          const weight='('+t.columns.map(c=>`max(32,coalesce(length(CAST(${identifier(c)} AS BLOB)),0)*2+32)`).join('+')+`+${512+t.columns.length*16})`;
          const sizes=await query(`SELECT ${weight} AS bytes FROM ${identifier(t.name)}${comparison} ORDER BY ${keys} LIMIT ${command.limit}`);
          let limit=0,total=0;
          for(const row of sizes) {
            if(!Number.isSafeInteger(row.bytes)||row.bytes<0||row.bytes>MAXIMUM_LINE)throw failure();
            if(limit&&total+row.bytes>1024*1024)break;total+=row.bytes;limit++;
          }
          if(!limit)return [];
          const projected=t.columns.map((c,i)=>`CASE WHEN ${weight} <= ${MAXIMUM_LINE} THEN ${cellExpression(c)} END AS c${i}`).join(',');
          const page=await query(`SELECT ${projected} FROM ${identifier(t.name)}${comparison} ORDER BY ${keys} LIMIT ${limit}`);
          if(page.length!==limit)throw failure();for(const row of page)for(let i=0;i<t.columns.length;i++)cellSQL(row['c'+i]);
          return page;
        }
        const weight='('+t.columns.map(c=>`max(32,coalesce(length(CAST(${identifier(c)} AS BLOB)),0)*2+32)`).join('+')+`+${8192+t.columns.length*16})`;
        const projected=command.kind==='sizes'?`${weight} AS bytes,`+t.order.map((c,i)=>`CASE WHEN ${weight} <= ${MAXIMUM_LINE} THEN ${cellExpression(c)} END AS k${i}`).join(','):
          t.columns.map((c,i)=>`CASE WHEN ${weight} <= ${MAXIMUM_LINE} THEN ${cellExpression(c)} END AS c${i}`).join(',');
        return query(`SELECT ${projected} FROM ${identifier(t.name)}${comparison} ORDER BY ${keys} LIMIT ${command.limit}`);
      }
      default:throw failure();
    }
  }};
}
