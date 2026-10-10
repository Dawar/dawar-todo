import { DatabaseSync, constants } from 'node:sqlite';
import { open, mkdir, lstat, link, unlink } from 'node:fs/promises';
import { createReadStream, constants as fileConstants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const FORMAT = 'dawar-application-snapshot';
const MAXIMUM_BYTES = 1024 * 1024 * 1024;
const MAXIMUM_LINE = 4 * 1024 * 1024;
const MAXIMUM_ROWS = 10_000_000;
const digest = () => createHash('sha256');
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const jsonLine = value => JSON.stringify(value) + '\n';
const failure = () => Error('Application snapshot is invalid, incomplete or outside its bounds.');

function boundedInteger(value, maximum = MAXIMUM_ROWS) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw failure();
  return value;
}
function name(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || Buffer.byteLength(value) > 1024) throw failure();
  return value;
}
function signedPragma(value) {
  if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw failure();
}
function schemaObject(value) {
  if (!value || !['table', 'index', 'view', 'trigger'].includes(value.type)) throw failure();
  name(value.name); name(value.tbl_name);
  if (typeof value.sql !== 'string' || Buffer.byteLength(value.sql) > MAXIMUM_LINE / 2 ||
      !new RegExp(`^\\s*CREATE\\s+(?:UNIQUE\\s+)?${value.type}\\b`, 'i').test(value.sql)) throw failure();
  return value;
}

// Value encoding takes place inside SQLite, before the D1/JavaScript boundary.
// Text uses its raw UTF-8 bytes: quote() and JS strings alone lose embedded NUL
// or invalid UTF-8. Integer values never pass through a JS number.
function cellExpression(column) {
  const c = identifier(column);
  return `CASE typeof(${c}) WHEN 'null' THEN 'N' WHEN 'integer' THEN 'I'||CAST(${c} AS TEXT) ` +
    `WHEN 'real' THEN 'R'||printf('%!.26g',${c}) WHEN 'text' THEN 'T'||hex(CAST(${c} AS BLOB)) ` +
    `WHEN 'blob' THEN 'B'||hex(${c}) END`;
}
function cellSQL(cell) {
  if (typeof cell !== 'string' || Buffer.byteLength(cell) > MAXIMUM_LINE / 2) throw failure();
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

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) throw failure();
}
async function privateHandle(path) {
  const f = await open(resolve(path), fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  try {
    const [s, linked] = await Promise.all([f.stat(), lstat(path)]);
    if (!s.isFile() || linked.isSymbolicLink() || s.ino !== linked.ino || s.dev !== linked.dev ||
        s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) throw failure();
    return f;
  } catch (error) { await f.close(); throw error; }
}

function validateHeader(h) {
  if (!h || h.kind !== 'header' || h.format !== FORMAT || ![1,2].includes(h.version) ||
      !Array.isArray(h.tables) || h.tables.length > 1000 || !Array.isArray(h.schema) || h.schema.length > 4000) throw failure();
  if (h.version===1) {
    signedPragma(h.userVersion); signedPragma(h.applicationId);
    if (h.sourceMetadata!==undefined) throw failure();
  } else if (h.userVersion!==null || h.applicationId!==null ||
      JSON.stringify(h.sourceMetadata)!==JSON.stringify({engine:'cloudflare-d1',sqliteHeader:'unavailable'})) throw failure();
  const objects = new Set();
  for (const object of h.schema) {
    schemaObject(object);
    const key = `${object.type === 'trigger' ? 'trigger' : 'schema'}:${object.name}`;
    if (object.name.toLowerCase().startsWith('sqlite_') || objects.has(key)) throw failure();
    objects.add(key);
  }
  const tables = new Set(); let totalRows=0;
  for (const t of h.tables) {
    name(t.name); boundedInteger(t.rows);
    totalRows+=t.rows;boundedInteger(totalRows);
    if (tables.has(t.name) || !Array.isArray(t.columns) || !t.columns.length || t.columns.length > 2000 ||
        !Array.isArray(t.order) || !t.order.length || t.order.some(k => !t.columns.includes(k))) throw failure();
    const columns = new Set(t.columns.map(name));
    if (columns.size !== t.columns.length || !h.schema.some(s => s.type === 'table' && s.name === t.name)) throw failure();
    tables.add(t.name);
  }
  if (h.schema.filter(s => s.type === 'table').length !== tables.size) throw failure();
  if (!Array.isArray(h.sequence) || h.sequence.length > h.tables.length || h.sequence.some(s =>
    !tables.has(s.name) || typeof s.seq !== 'string' || !s.seq.startsWith('I'))) throw failure();
  for (const s of h.sequence) cellSQL(s.seq);
  return h;
}

async function describeSnapshot(query, engine='sqlite') {
  const platform = engine==='cloudflare-d1' ? " AND lower(name) NOT IN ('_cf_kv','_cf_metadata')" : '';
  const schema = (await query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND lower(substr(name,1,7)) <> 'sqlite_'"+platform+" ORDER BY type,name"))
    .map(schemaObject);
  const tableList = await query('PRAGMA table_list');
  const tables = [];
  for (const object of schema.filter(s => s.type === 'table')) {
    const t = tableList.find(t => t.schema === 'main' && t.name === object.name);
    if (!t || t.type !== 'table') throw Error('Virtual or shadow tables require an explicit migration adapter.');
    const xinfo = await query(`PRAGMA table_xinfo(${identifier(object.name)})`);
    const columns = xinfo.filter(c => c.hidden === 0).map(c => c.name);
    let order;
    if (t.wr) order = xinfo.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
    else {
      const rowid = ['_rowid_', 'rowid', 'oid'].find(n => !xinfo.some(c => c.name.toLowerCase() === n));
      if (!rowid) throw Error('A fully shadowed rowid requires an explicit migration adapter.');
      columns.unshift(rowid); order = [rowid];
    }
    const count = await query(`SELECT COUNT(*) AS n FROM ${identifier(object.name)}`);
    tables.push({ name: object.name, columns, order, rows: boundedInteger(count[0]?.n) });
  }
  const userVersion = engine==='cloudflare-d1' ? null : (await query('PRAGMA user_version'))[0]?.user_version;
  const applicationId = engine==='cloudflare-d1' ? null : (await query('PRAGMA application_id'))[0]?.application_id;
  const hasSequence = (await query("SELECT name FROM sqlite_schema WHERE name='sqlite_sequence'")).length;
  const sequence = hasSequence ? await query("SELECT name,'I'||CAST(seq AS TEXT) AS seq FROM sqlite_sequence ORDER BY name") : [];
  return validateHeader({ kind: 'header', format: FORMAT, version:engine==='cloudflare-d1'?2:1, schema, tables, sequence, userVersion, applicationId,
    ...(engine==='cloudflare-d1'?{sourceMetadata:{engine:'cloudflare-d1',sqliteHeader:'unavailable'}}:{}) });
}

// Internal adapter boundary, not a public arbitrary-SQL endpoint. withSnapshot
// must hold one REAL database snapshot for its complete callback and each query.
// A D1 session/bookmark, unchanged counts or an unfenced dashboard read is not
// such a snapshot. No original Cloudflare writer freeze is implied here.
export async function exportApplicationSnapshot({ withSnapshot, destination, signal, pageRows = 128, sourceEngine='sqlite' }) {
  if (typeof withSnapshot !== 'function' || !Number.isInteger(pageRows) || pageRows < 1 || pageRows > 256 ||
      !['sqlite','cloudflare-d1'].includes(sourceEngine)) throw failure();
  destination = resolve(destination);
  await privateDirectory(dirname(destination));
  const temporary = `${destination}.${randomUUID()}.partial`;
  const file = await open(temporary, 'wx', 0o600);
  let bytes = 0;
  const whole = digest(); const content = digest();
  const write = async (record, covered = true) => {
    signal?.throwIfAborted();
    const line = jsonLine(record); const n = Buffer.byteLength(line);
    if (n > MAXIMUM_LINE || bytes + n > MAXIMUM_BYTES) throw failure();
    await file.writeFile(line); bytes += n; whole.update(line);
    if (covered) content.update(line);
  };
  try {
    const inventory = await withSnapshot(async query => {
      if (typeof query !== 'function') throw failure();
      const h = await describeSnapshot(query,sourceEngine); await write(h);
      const inventory = [];
      for (const t of h.tables) {
        let rows = 0, last = null; const tableHash = digest();
        for (;;) {
          signal?.throwIfAborted();
          const keys = t.order.map(identifier).join(',');
          const comparison = last ? ` WHERE (${keys}) > (${t.order.map(k => cellSQL(last[t.columns.indexOf(k)])).join(',')})` : '';
          // Read lengths and bounded order keys first. The next data query is
          // limited by bytes as well as row count; an oversized cell never gets
          // expanded into an unbounded hex payload at the driver boundary.
          const weight = '(' + t.columns.map(c => `max(32,coalesce(length(CAST(${identifier(c)} AS BLOB)),0)*2+32)`).join('+') + `+${8192 + t.columns.length * 16})`;
          const orderCells = t.order.map((c, i) => `CASE WHEN ${weight} <= ${MAXIMUM_LINE} THEN ${cellExpression(c)} END AS k${i}`).join(',');
          const sizes = await query(`SELECT ${weight} AS bytes,${orderCells} FROM ${identifier(t.name)}${comparison} ORDER BY ${keys} LIMIT ${pageRows}`);
          if (!Array.isArray(sizes) || sizes.length > pageRows) throw failure();
          let limit = 0, total = 0;
          for (const row of sizes) {
            if (!Number.isSafeInteger(row.bytes) || row.bytes > MAXIMUM_LINE) throw failure();
            t.order.forEach((c, i) => cellSQL(row[`k${i}`]));
            if (limit && total + row.bytes > 1024 * 1024) break;
            total += row.bytes; limit++;
          }
          if (!limit) break;
          const projected = t.columns.map((c, i) => `CASE WHEN ${weight} <= ${MAXIMUM_LINE} THEN ${cellExpression(c)} END AS c${i}`).join(',');
          const page = await query(`SELECT ${projected} FROM ${identifier(t.name)}${comparison} ORDER BY ${keys} LIMIT ${limit}`);
          if (!Array.isArray(page) || page.length > pageRows) throw failure();
          if (page.length !== limit) throw failure();
          for (const row of page) {
            const cells = t.columns.map((c, i) => row[`c${i}`]);
            cells.forEach(cellSQL);
            if (++rows > t.rows) throw failure();
            const record = { kind: 'row', table: t.name, cells };
            tableHash.update(jsonLine(record)); await write(record); last = cells;
          }
        }
        if (rows !== t.rows) throw failure();
        inventory.push({ name: t.name, rows, sha256: tableHash.digest('hex') });
      }
      // Re-read metadata inside the same snapshot. This also detects an adapter
      // which accidentally reconfigured schema or counts while exporting.
      if (JSON.stringify(await describeSnapshot(query,sourceEngine)) !== JSON.stringify(h)) throw failure();
      await write({ kind: 'footer', tables: inventory, sha256: content.digest('hex') }, false);
      return inventory;
    });
    signal?.throwIfAborted();
    await file.sync(); await file.close();
    // link is exclusive: another result or a symlink at destination is retained.
    await link(temporary, destination); await unlink(temporary);
    const directory = await open(dirname(destination), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return { format: FORMAT, version:sourceEngine==='cloudflare-d1'?2:1, bytes, sha256: whole.digest('hex'), tables: inventory,
      productionWriterFreezeEstablished: false, automaticExecutionDisabled: true };
  } catch (error) {
    await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error;
  }
}

// Private Node migration boundary. The configured source adapter must hold the
// ORIGINAL D1 writer freeze for the complete callback, including other writers,
// scheduled jobs, provider/file consumers and outstanding requests. A caller's
// assertion alone is not evidence of production coverage; the result keeps that
// rollout gate false. No public arbitrary-SQL API or source writes are added.
export async function exportFrozenD1Application({withFrozenSource,expectedFreeze,...options}) {
  if(typeof withFrozenSource!=='function'||!expectedFreeze||typeof expectedFreeze.sourceId!=='string'||
      !expectedFreeze.sourceId||typeof expectedFreeze.operationId!=='string'||!expectedFreeze.operationId||
      !Number.isSafeInteger(expectedFreeze.epoch)||expectedFreeze.epoch<1)throw failure();
  const expected={sourceId:expectedFreeze.sourceId,operationId:expectedFreeze.operationId,epoch:expectedFreeze.epoch};
  return exportApplicationSnapshot({...options,sourceEngine:'cloudflare-d1',withSnapshot:async callback=>{
    let called=false,completed=false,reading=true,inventory;
    try {
      await withFrozenSource(async({db,verifyFreeze})=>{
        if(called||!reading)throw failure();called=true;
        if(typeof db?.prepare!=='function'||typeof verifyFreeze!=='function')throw failure();
        let binding,wall,observed,monotonicDeadline;
        const verify=async()=>{
          options.signal?.throwIfAborted();
          const proof=await verifyFreeze();
          options.signal?.throwIfAborted();
          const now=Date.now();
          if(!reading||!proof||proof.version!==1||proof.kind!=='dawar-application-writer-freeze'||proof.status!=='frozen'||
              proof.scope!=='all-application-writers'||proof.sourceId!==expected.sourceId||
              proof.operationId!==expected.operationId||proof.epoch!==expected.epoch||
              typeof proof.sourceId!=='string'||!proof.sourceId||proof.sourceId.length>1024||
              typeof proof.operationId!=='string'||!proof.operationId||proof.operationId.length>1024||
              !Number.isSafeInteger(proof.epoch)||proof.epoch<1||
              !Number.isSafeInteger(proof.generation)||proof.generation<1||
              !Number.isSafeInteger(proof.expiresAt)||proof.expiresAt<=now||proof.expiresAt-now>900000||
              !Number.isSafeInteger(proof.observedAt)||Math.abs(proof.observedAt-now)>5000||
              wall!==undefined&&now<wall||observed!==undefined&&proof.observedAt<observed||
              proof.admittedWriters!==0||proof.unknownWriters!==0)throw failure();
          const current=JSON.stringify([proof.sourceId,proof.operationId,proof.epoch,proof.generation,proof.expiresAt]);
          if(binding!==undefined&&binding!==current)throw failure();binding=current;
          monotonicDeadline??=performance.now()+proof.expiresAt-now;
          if(performance.now()>=monotonicDeadline)throw failure();wall=now;observed=proof.observedAt;
        };
        await verify();
        inventory=await callback(async sql=>{
          await verify();
          if(Buffer.byteLength(sql)>100000)throw failure();
          const result=await db.prepare(sql).all();
          await verify();
          if(result.success!==true||!Array.isArray(result.results)||result.results.length>4000)throw failure();
          return result.results;
        });
        await verify();completed=true;return inventory;
      });
      if(!called||!completed)throw failure();return inventory;
    }finally{reading=false;}
  }});
}

// The local adapter uses one read-only connection and a SQLite read transaction.
// Concurrent WAL writes do not alter this snapshot. A multi-store production
// cutover still needs the independently established writer/control/file fence.
export async function exportSQLiteApplication({ source, ...options }) {
  source = resolve(source);
  const handle = await privateHandle(source); const original = await handle.stat();
  let db;
  try {
    db = new DatabaseSync(source, { readOnly: true, allowExtension: false });
    const current = await lstat(source);
    if (current.isSymbolicLink() || current.ino !== original.ino || current.dev !== original.dev) throw failure();
    return await exportApplicationSnapshot({ ...options, withSnapshot: async callback => {
      db.exec('PRAGMA query_only=ON; BEGIN');
      try {
        const result = await callback(async sql => db.prepare(sql).all());
        db.exec('COMMIT'); return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } });
  } finally { db?.close(); await handle.close(); }
}

// This importer executes only generated row expressions and the captured schema
// in a NEW private database. Native authorization denies attachment, temporary
// stores, virtual tables, extension loading and all unapproved pragmas, including
// malicious schema containing statements after a legitimate CREATE.
export async function importApplicationSnapshot({ source, destination, expectedSHA256, signal }) {
  if (!/^[a-f0-9]{64}$/.test(expectedSHA256)) throw failure();
  source = resolve(source); destination = resolve(destination);
  const input = await privateHandle(source);
  const stat = await input.stat();
  if (stat.size > MAXIMUM_BYTES) { await input.close(); throw failure(); }
  let reservation, db, identity, succeeded = false;
  try {
    await privateDirectory(dirname(destination));
    reservation = await open(destination, 'wx', 0o600); identity = await reservation.stat();
    db = new DatabaseSync(destination, { allowExtension: false });
    if (typeof db.setAuthorizer !== 'function') throw Error('Snapshot import requires Node 24 with SQLite native authorization support.');
    const current = await lstat(destination);
    if (current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) throw failure();
    db.exec('PRAGMA synchronous=FULL');
    db.setAuthorizer((action, a, b, database) => {
      if (database && database !== 'main') return constants.SQLITE_DENY;
      if ([constants.SQLITE_ATTACH, constants.SQLITE_DETACH, constants.SQLITE_CREATE_VTABLE,
        constants.SQLITE_CREATE_TEMP_TABLE, constants.SQLITE_CREATE_TEMP_INDEX,
        constants.SQLITE_CREATE_TEMP_VIEW, constants.SQLITE_CREATE_TEMP_TRIGGER].includes(action)) return constants.SQLITE_DENY;
      if (action === constants.SQLITE_FUNCTION && ['load_extension', 'readfile', 'writefile'].includes(b?.toLowerCase())) return constants.SQLITE_DENY;
      if (action === constants.SQLITE_PRAGMA && !['foreign_keys', 'user_version', 'application_id', 'integrity_check', 'foreign_key_check', 'table_xinfo', 'table_list'].includes(a?.toLowerCase())) return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    let header, footer, index = 0, rows = 0, tableHash = digest();
    const inventory = []; const whole = digest(); const content = digest(); let bytes = 0;
    // A bounded byte scanner, rather than readline's unbounded pending string.
    // UTF-8 decoder is only used for JSON syntax; stored text bytes stay hex.
    for await (const line of boundedLines(input, signal)) {
      bytes += line.length; whole.update(line);
      const record = JSON.parse(line.toString('utf8'));
      if (footer) throw failure();
      if (!header) {
        header = validateHeader(record);
        for (const s of header.schema.filter(s => s.type === 'table')) db.exec(s.sql);
      } else if (record.kind === 'row') {
        while (index < header.tables.length && rows === header.tables[index].rows) {
          inventory.push({ name: header.tables[index].name, rows, sha256: tableHash.digest('hex') });
          index++; rows = 0; tableHash = digest();
        }
        const t = header.tables[index];
        if (!t || record.table !== t.name || !Array.isArray(record.cells) || record.cells.length !== t.columns.length) throw failure();
        db.exec(`INSERT INTO ${identifier(t.name)} (${t.columns.map(identifier).join(',')}) VALUES (${record.cells.map(cellSQL).join(',')})`);
        tableHash.update(jsonLine(record)); rows++;
      } else if (record.kind === 'footer') {
        while (index < header.tables.length && rows === header.tables[index].rows) {
          inventory.push({ name: header.tables[index].name, rows, sha256: tableHash.digest('hex') });
          index++; rows = 0; tableHash = digest();
        }
        if (index !== header.tables.length || JSON.stringify(inventory) !== JSON.stringify(record.tables) ||
            record.sha256 !== content.digest('hex')) throw failure();
        footer = record;
      } else throw failure();
      if (!footer) content.update(line);
    }
    if (!footer || bytes !== stat.size || whole.digest('hex') !== expectedSHA256) throw failure();
    if (header.sequence.length) {
      db.exec('DELETE FROM sqlite_sequence');
      for (const s of header.sequence) db.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES(?,?)').run(s.name, BigInt(s.seq.slice(1)));
    }
    // Restore indexes and views, then triggers, only after all original rows.
    for (const type of ['index', 'view', 'trigger']) for (const s of header.schema.filter(s => s.type === type)) db.exec(s.sql);
    // v2 is specifically D1's unavailable file-header evidence. New SQLite file
    // defaults are selected here, never attributed to the original database.
    const localHeader = header.version===2 ? {userVersion:0,applicationId:0} : header;
    db.exec(`PRAGMA user_version=${localHeader.userVersion}; PRAGMA application_id=${localHeader.applicationId}`);
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw failure();
    // Re-encode the restored database. This catches changed affinity, generated
    // columns/order, incomplete schema and values beyond a mere row-count match.
    const restored = await describeSnapshot(async sql => db.prepare(sql).all());
    if (restored.userVersion!==localHeader.userVersion || restored.applicationId!==localHeader.applicationId) throw failure();
    const comparable = header.version===2 ? {...restored,version:2,userVersion:null,applicationId:null,sourceMetadata:header.sourceMetadata} : restored;
    if (JSON.stringify(comparable) !== JSON.stringify(header)) throw failure();
    for (const t of restored.tables) {
      const q = db.prepare(`SELECT ${t.columns.map((c, i) => `${cellExpression(c)} AS c${i}`).join(',')} FROM ${identifier(t.name)} ORDER BY ${t.order.map(identifier).join(',')}`);
      const h = digest(); let n = 0;
      for (const row of q.iterate()) { h.update(jsonLine({ kind: 'row', table: t.name, cells: t.columns.map((c, i) => row[`c${i}`]) })); n++; }
      const original = inventory.find(i => i.name === t.name);
      if (n !== original.rows || h.digest('hex') !== original.sha256) throw failure();
    }
    signal?.throwIfAborted();
    db.exec('COMMIT');
    const directory = await open(dirname(destination), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    succeeded = true;
    return { imported: true, tables: inventory, automaticExecutionDisabled: true, productionAuthorityChanged: false,
      sqliteHeader:{source:header.version===2?'unavailable': 'captured',target:{userVersion:localHeader.userVersion,applicationId:localHeader.applicationId}} };
  } finally {
    if (db) { if (!succeeded) { try { db.exec('ROLLBACK'); } catch {} } db.close(); }
    await reservation?.close(); await input.close();
    if (!succeeded && identity) {
      const current = await lstat(destination).catch(() => null);
      if (current && !current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev) await unlink(destination);
    }
  }
}

async function* boundedLines(handle, signal) {
  const stream = createReadStream(null, { fd: handle.fd, autoClose: false, highWaterMark: 64 * 1024, signal });
  let pending = Buffer.alloc(0), bytes = 0;
  for await (const chunk of stream) {
    signal?.throwIfAborted(); bytes += chunk.length;
    if (bytes > MAXIMUM_BYTES) throw failure();
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end + 1 > MAXIMUM_LINE) throw failure();
      yield pending.subarray(0, end + 1); pending = pending.subarray(end + 1);
    }
    if (pending.length > MAXIMUM_LINE) throw failure();
  }
  if (pending.length) throw failure();
}
