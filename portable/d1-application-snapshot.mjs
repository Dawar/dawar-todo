// Cloudflare-compatible: no filesystem, Node APIs, raw-SQL input or writes.
// Discovery only constructs a bounded query. The authoritative schema, versions,
// sequences and ALL selected table data come from one SQLite SELECT statement.
const encoder = new TextEncoder();
const bytes = value => encoder.encode(value).byteLength;
const quoted = value => '"' + value.replaceAll('"', '""') + '"';
const text = value => "'" + value.replaceAll("'", "''") + "'";
const TABLE_BYTES = 1024 * 1024;
const TOTAL_BYTES = 8 * 1024 * 1024;
const SCHEMA = "type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND lower(substr(name,1,7)) <> 'sqlite_' AND name <> '_cf_KV' ORDER BY type,name";
const XINFO = "SELECT s.name AS table_name,p.cid,p.name,p.pk,p.hidden FROM sqlite_schema s,pragma_table_xinfo(s.name) p WHERE s.type='table' AND lower(substr(s.name,1,7)) <> 'sqlite_' AND s.name <> '_cf_KV' ORDER BY s.name,p.cid";
const objects = "json_object('type',type,'name',name,'tbl_name',tbl_name,'sql',sql)";
const columns = "json_object('table_name',table_name,'cid',cid,'name',name,'pk',pk,'hidden',hidden)";
const bad = (code='snapshot-shape',phase='capture') => Object.assign(
  Error('Complete D1 snapshot unavailable: schema, data or response exceeds the verified bounds.'),{snapshotCode:code,snapshotPhase:phase});
const line = record => JSON.stringify(record) + '\n';
async function sha(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(hash, b => b.toString(16).padStart(2, '0')).join('');
}
function cell(column) {
  const c = quoted(column);
  // SQLite concatenation converts signed integers to exact decimal text; hex()
  // reads TEXT's original bytes, including embedded NUL/invalid UTF-8. Neither
  // value crosses a JavaScript number/string conversion before this encoding.
  return `CASE typeof(${c})WHEN'null'THEN'N'WHEN'integer'THEN'I'||${c}` +
    ` WHEN'real'THEN'R'||printf('%!.26g',${c})WHEN'text'THEN'T'||hex(${c})ELSE'B'||hex(${c})END`;
}
async function rows(db, sql, maximum,phase) {
  if (bytes(sql) > 100000) throw bad('query-text-bound',phase);
  let result;
  try {result = await db.prepare(sql).all();} catch {throw bad('d1-query-refused',phase);}
  if (result.success !== true || !Array.isArray(result.results) || result.results.length > maximum) throw bad('d1-response-bound',phase);
  return result.results;
}
function json(value, maximum) {
  if (typeof value !== 'string' || bytes(value) > maximum) throw bad();
  return JSON.parse(value);
}
function validName(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || bytes(value) > 1024) throw bad();
  return value;
}

// Fixed compatibility probes for this capture only. They expose no table names,
// counts, values, SQL strings or provider errors; caller supplies no SQL.
export async function probeD1Application(db,signal) {
  const queries={
    schema:"SELECT type FROM sqlite_schema WHERE sql IS NOT NULL LIMIT 1",
    columns:"SELECT p.cid FROM sqlite_schema s,pragma_table_xinfo(s.name) p WHERE s.type='table' LIMIT 1",
    tables:"SELECT wr FROM pragma_table_list LIMIT 1",
    userVersion:"SELECT user_version FROM pragma_user_version",
    applicationId:"SELECT application_id FROM pragma_application_id",
    materialized:"WITH d AS MATERIALIZED (SELECT 1 AS n) SELECT row_number() OVER(ORDER BY n) FROM d",
    json:"SELECT json_group_array(json(record)) FROM (SELECT json_object('kind','row','cells',json_array('I1','N')) AS record)",
    encoding:"SELECT 'I'||9223372036854775807,printf('%!.26g',1.5),hex(CAST(X'610062FF' AS TEXT))",
  };
  const supported={};
  for(const [phase,sql] of Object.entries(queries)) {
    signal?.throwIfAborted();
    try{const result=await db.prepare(sql).all();supported[phase]=result.success===true&&Array.isArray(result.results)&&result.results.length<=1;}catch{supported[phase]=false;}
  }
  signal?.throwIfAborted();
  return {version:1,kind:'dawar-snapshot-compatibility',supported,applicationDataReturned:false,writerFreezeEstablished:false};
}

export async function captureD1Application(db, signal) {
  signal?.throwIfAborted();
  const plannedSchema = await rows(db, `SELECT ${SCHEMA}`, 1000,'schema');
  const plannedColumns = await rows(db, XINFO, 4000,'columns');
  const plannedTables = await rows(db, 'PRAGMA table_list', 1000,'tables');
  const hasSequence = (await rows(db, "SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'", 1,'sequence')).length;
  const tables = plannedSchema.filter(s => s.type === 'table').map(s => {
    validName(s.name);
    const t = plannedTables.find(t => t.schema === 'main' && t.name === s.name);
    if (!t || t.type !== 'table') throw bad();
    const info = plannedColumns.filter(c => c.table_name === s.name);
    const names = info.filter(c => c.hidden === 0).map(c => validName(c.name));
    let order;
    if (t.wr) order = info.filter(c => c.pk).sort((a,b) => a.pk-b.pk).map(c => c.name);
    else {
      const key = ['_rowid_', 'rowid', 'oid'].find(n => !info.some(c => c.name.toLowerCase() === n));
      if (!key) throw bad();
      names.unshift(key); order = [key];
    }
    if (!names.length || !order.length || names.length > 2000) throw bad();
    return { name:s.name, columns:names, order };
  });
  if (tables.length > 100 || tables.length !== new Set(tables.map(t => t.name)).size) throw bad();
  for (const s of plannedSchema) {
    validName(s.name); validName(s.tbl_name);
    if (!['table','index','view','trigger'].includes(s.type) || typeof s.sql !== 'string' || bytes(s.sql) > TABLE_BYTES) throw bad();
  }
  // Short, unique SQL aliases keep the complete checked-in schema within D1's
  // statement limit. Original names and ordering remain in the snapshot header.
  const declarations = tables.map((t,i) => {
    const aliases=t.columns.map((_,j)=>`c${j}`);
    const projection=t.columns.map((c,j)=>`${quoted(c)} AS ${quoted(aliases[j])}`).join(',');
    const order=t.order.map(c=>quoted(aliases[t.columns.indexOf(c)])).join(',');
    return `t${i} AS MATERIALIZED (SELECT row_number() OVER (ORDER BY ${order}) AS ord,` +
      `json_object('kind','row','table',${text(t.name)},'cells',json_array(${aliases.map(cell).join(',')})) AS record FROM (SELECT ${projection} FROM ${quoted(t.name)}))`;
  });
  const sizes = tables.map((t,i) => `SELECT ${text(t.name)} AS name,count(*) AS n,coalesce(sum(length(CAST(record AS BLOB))+1),0) AS bytes FROM t${i}`);
  const ctes = [...declarations, `sizes AS (${sizes.length ? sizes.join(' UNION ALL ') : "SELECT '' AS name,0 AS n,0 AS bytes WHERE 0"})`,
    `allowed AS (SELECT coalesce(max(bytes),0)<=${TABLE_BYTES} AND coalesce(sum(bytes),0)<=${TOTAL_BYTES} AND coalesce(sum(n),0)<=100000 AS ok FROM sizes)`];
  const sequence = hasSequence ? "SELECT json_group_array(json_object('name',name,'seq','I'||CAST(seq AS TEXT))) FROM (SELECT name,seq FROM sqlite_sequence ORDER BY name)" : "SELECT '[]'";
  const metadata = `json_object('schema',json((SELECT json_group_array(${objects}) FROM (SELECT ${SCHEMA}))),` +
    `'xinfo',json((SELECT json_group_array(${columns}) FROM (${XINFO}))),` +
    "'tableList',json((SELECT json_group_array(json_object('schema',schema,'name',name,'type',type,'wr',wr)) FROM pragma_table_list))," +
    `'sequence',json((${sequence})),'sizes',json((SELECT json_group_array(json_object('name',name,'rows',n,'bytes',bytes)) FROM sizes)),` +
    "'userVersion',(SELECT user_version FROM pragma_user_version),'applicationId',(SELECT application_id FROM pragma_application_id),'allowed',(SELECT ok FROM allowed))";
  const data = tables.map((t,i) => `SELECT 'table' AS kind,${text(t.name)} AS name,json_group_array(json(record)) AS payload FROM (SELECT record FROM t${i} ORDER BY ord) WHERE (SELECT ok FROM allowed)=1`);
  const query = `WITH ${ctes.join(',')} SELECT 'metadata' AS kind,'' AS name,${metadata} AS payload` + (data.length ? ' UNION ALL ' + data.join(' UNION ALL ') : '');
  signal?.throwIfAborted();
  const captured = await rows(db, query, tables.length+1,'snapshot');
  signal?.throwIfAborted();
  const meta = json(captured[0]?.payload, TABLE_BYTES);
  // A schema mutation during discovery cannot silently add/omit/reinterpret data.
  if(meta.allowed!==1)throw bad('application-data-bound','snapshot');
  if (JSON.stringify(meta.schema) !== JSON.stringify(plannedSchema) ||
      JSON.stringify(meta.xinfo) !== JSON.stringify(plannedColumns) ||
      JSON.stringify(meta.tableList.filter(t => tables.some(p => p.name === t.name)).map(t => [t.name,t.type,t.wr]).sort()) !==
      JSON.stringify(plannedTables.filter(t => tables.some(p => p.name === t.name)).map(t => [t.name,t.type,t.wr]).sort())) throw bad('schema-changed','snapshot');
  const header = { kind:'header',format:'dawar-application-snapshot',version:1,schema:meta.schema,
    tables:tables.map(t => ({...t,rows:meta.sizes.find(s => s.name === t.name)?.rows})), sequence:meta.sequence,
    userVersion:meta.userVersion,applicationId:meta.applicationId };
  const lines = [line(header)]; const inventory = [];
  for (let i=0;i<tables.length;i++) {
    const t = header.tables[i], item = captured[i+1];
    if (!Number.isSafeInteger(t.rows) || t.rows<0 || t.rows>100000 || item?.name !== t.name || item.kind !== 'table') throw bad();
    const records = json(item.payload, TABLE_BYTES+2);
    if (!Array.isArray(records) || records.length !== t.rows) throw bad();
    const content = records.map(r => {
      if (r.kind !== 'row' || r.table !== t.name || !Array.isArray(r.cells) || r.cells.length !== t.columns.length || r.cells.some(c => typeof c !== 'string')) throw bad();
      return line(r);
    }).join('');
    inventory.push({name:t.name,rows:t.rows,sha256:await sha(content)}); lines.push(content);
  }
  const content = lines.join('');
  if (bytes(content)>TOTAL_BYTES+TABLE_BYTES) throw bad();
  const snapshot = content + line({kind:'footer',tables:inventory,sha256:await sha(content)});
  return { snapshot, sha256:await sha(snapshot), bytes:bytes(snapshot), tables:inventory,
    consistentRead:'single-sqlite-statement',productionWriterFreezeEstablished:false };
}
