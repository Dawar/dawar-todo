import {constants,openSync,fstatSync,readSync,writeSync,fsyncSync,closeSync,lstatSync,realpathSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../bot-bridge/store.mjs';
import {HubStore} from './control-store.mjs';
import {savePrivate} from './private-file.mjs';
import {capturedRuntimeDefaults} from './runtime-defaults.mjs';

const maximum=1024*1024*1024,sha=()=>createHash('sha256');
const failure=()=>Error('Control snapshot staging was not confirmed. Preserve the original snapshot and any new private staging directories; do not overwrite or activate them.');
const quoted=name=>'"'+name.replaceAll('"','""')+'"';
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
function privateState(path,directory=false){
  const s=lstatSync(path,{bigint:true});
  if(s.isSymbolicLink()||!(directory?s.isDirectory():s.isFile())||s.mode&0o077n||
      process.getuid&&s.uid!==BigInt(process.getuid())||realpathSync(path)!==path)throw failure();
  return s;
}
function absent(path){try{lstatSync(path);throw failure();}catch(e){if(e.code!=='ENOENT')throw e;}}
function typed(value){
  if(value===null)return ['null'];
  if(typeof value==='bigint')return ['integer',String(value)];
  if(typeof value==='number')return ['real',Object.is(value,-0)?'-0':String(value)];
  if(typeof value==='string')return ['text',value];
  if(value instanceof Uint8Array)return ['blob',Buffer.from(value).toString('base64')];
  throw failure();
}
function inventory(db,{originalTables,hubAdditions=false}={}){
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw failure();
  const tables=db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all();
  if(!tables.length||tables.length>256||tables.some(t=>typeof t.name!=='string'||typeof t.sql!=='string'))throw failure();
  const selected=originalTables?tables.filter(t=>originalTables.some(o=>o.name===t.name)):tables;
  if(originalTables&&selected.length!==originalTables.length)throw failure();
  return selected.map(table=>{
    const fields=db.prepare(`PRAGMA table_xinfo(${quoted(table.name)})`).all();
    if(!fields.length||fields.length>256)throw failure();
    const digest=sha(),order=fields.map((_,i)=>i+1).join(',');let rows=0;
    // Preserve integer precision, raw JSON bytes, blobs and original IDs. No
    // generated wording or normalized JSON stands in for the original rows.
    const filter=hubAdditions&&table.name==='meta'?" WHERE key<>'portable-defaults'":
      hubAdditions&&table.name==='sqlite_sequence'?" WHERE name NOT IN ('portable_events','portable_mailbox')":'';
    const statement=db.prepare(`SELECT ${fields.map(f=>quoted(f.name)).join(',')} FROM ${quoted(table.name)}${filter} ORDER BY ${order}`);
    statement.setReadBigInts(true);statement.setReturnArrays(true);
    for(const row of statement.iterate()){digest.update(JSON.stringify(row.map(typed))+'\n');rows++;}
    return {name:table.name,sql:table.sql,fields,rows,sha256:digest.digest('hex')};
  });
}
function readInventory(path,options){
  const db=new DatabaseSync(path,{readOnly:true});
  try{return inventory(db,options);}finally{db.close();}
}
function sync(path){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{fsyncSync(fd);}finally{closeSync(fd);}}
function hashFile(path){
  const before=privateState(path),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(1024*1024),digest=sha();
  try{
    if(!sameFile(before,fstatSync(fd,{bigint:true})))throw failure();
    let count;while((count=readSync(fd,buffer,0,buffer.length,null)))digest.update(buffer.subarray(0,count));
    if(!sameFile(before,fstatSync(fd,{bigint:true}))||!sameFile(before,privateState(path)))throw failure();
    return digest.digest('hex');
  }finally{closeSync(fd);}
}
function preserve(before,after){if(JSON.stringify(before)!==JSON.stringify(after))throw failure();}
const catalog=db=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all();
function preserveCatalog(before,db){
  const after=catalog(db);for(const entry of before)preserve(entry,after.find(e=>e.type===entry.type&&e.name===entry.name));
}

// Input is a closed, privately captured SQLite snapshot, NEVER a live database
// with WAL/SHM/journal companions. This stages roles; it cannot establish the
// production writer freeze, enroll a node, create placements or enable a turn.
export function stageControlSnapshot({source,expectedSHA256,hubDirectory,agentDirectory,runtimeDefaults}){
  if(!/^[a-f0-9]{64}$/.test(expectedSHA256??''))throw failure();
  const inherited=capturedRuntimeDefaults(runtimeDefaults),original=resolve(source),hub=resolve(hubDirectory),agent=resolve(agentDirectory);
  if(hub===agent||original===join(hub,'control.sqlite')||original===join(agent,'native-control.sqlite')||
      hub.startsWith(agent+'/')||agent.startsWith(hub+'/'))throw failure();
  const sourceState=privateState(original);
  if(sourceState.size<512n||sourceState.size>BigInt(maximum))throw failure();
  for(const suffix of ['-wal','-shm','-journal'])absent(original+suffix);
  for(const directory of [hub,agent]){absent(directory);privateState(dirname(directory),true);}
  const directories=[],copies=[];let sourceFD;
  try{
    for(const directory of [hub,agent]){mkdirSync(directory,{mode:0o700});directories.push(directory);}
    sourceFD=openSync(original,constants.O_RDONLY|constants.O_NOFOLLOW);
    if(!sameFile(sourceState,fstatSync(sourceFD,{bigint:true})))throw failure();
    const paths=[join(hub,'control.sqlite'),join(agent,'native-control.sqlite')];
    for(const path of paths)copies.push(openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600));
    const digest=sha(),buffer=Buffer.alloc(1024*1024);let bytes=0,count;
    while((count=readSync(sourceFD,buffer,0,buffer.length,null))){
      if(bytes===0&&!buffer.subarray(0,16).equals(Buffer.from('SQLite format 3\0')))throw failure();
      bytes+=count;if(bytes>maximum)throw failure();digest.update(buffer.subarray(0,count));
      for(const fd of copies){let offset=0;while(offset<count)offset+=writeSync(fd,buffer,offset,count-offset);}
    }
    if(bytes!==Number(sourceState.size)||digest.digest('hex')!==expectedSHA256||
        !sameFile(sourceState,fstatSync(sourceFD,{bigint:true}))||!sameFile(sourceState,privateState(original)))throw failure();
    for(const fd of copies){fsyncSync(fd);closeSync(fd);}copies.length=0;closeSync(sourceFD);sourceFD=undefined;
    const before=readInventory(paths[0]);
    for(const name of ['bots','records','operations','events','meta'])if(!before.some(t=>t.name===name))throw failure();
    if(before.some(t=>t.name.startsWith('portable_')))throw failure();
    preserve(before,readInventory(paths[1]));
    const originalMeta=new DatabaseSync(paths[0],{readOnly:true});let eventFloor,originalCatalog;
    try{
      originalCatalog=catalog(originalMeta);
      if(originalMeta.prepare("SELECT 1 FROM meta WHERE key='portable-defaults'").get())throw failure();
      const max=originalMeta.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events');max.setReadBigInts(true);
      const sequence=originalMeta.prepare("SELECT seq AS n FROM sqlite_sequence WHERE name='events'");sequence.setReadBigInts(true);
      const values=[max.get().n,sequence.get()?.n??0n];eventFloor=values.reduce((a,b)=>a>b?a:b,0n);
      if(eventFloor<0n||eventFloor>=BigInt(Number.MAX_SAFE_INTEGER))throw failure();
    }finally{originalMeta.close();}
    // Initialize schemas with the actual production constructors. Original
    // rows must survive byte-for-byte; constructor repair is not permission
    // to normalize or replace a malformed historical snapshot.
    const hubStore=new HubStore(paths[0]);
    try{
      preserve(before,inventory(hubStore.db,{originalTables:before}));
      if(hubStore.db.prepare('SELECT COUNT(*) AS n FROM portable_authority').get().n!==0)throw failure();
      hubStore.db.prepare("INSERT INTO meta(key,json) VALUES('portable-defaults',?)").run(JSON.stringify(inherited));
      // Existing clients retain the original event cursor. Reserve that floor
      // for the new hub journal without inventing an event or replaying history.
      hubStore.db.prepare("INSERT INTO sqlite_sequence(name,seq) VALUES('portable_events',?)").run(eventFloor);
      preserve(before,inventory(hubStore.db,{originalTables:before,hubAdditions:true}));
      preserveCatalog(originalCatalog,hubStore.db);
      hubStore.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }finally{hubStore.db.close();}
    const nativeStore=new Store(paths[1]);
    try{
      preserve(before,inventory(nativeStore.db,{originalTables:before}));
      nativeStore.meta('portable-defaults',inherited);
      preserve(before,inventory(nativeStore.db,{originalTables:before,hubAdditions:true}));
      preserveCatalog(originalCatalog,nativeStore.db);nativeStore.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    }finally{nativeStore.db.close();}
    // Recheck the captured source, including auxiliary files, after every
    // awaited-free local step; never label a changed source a complete stage.
    if(!sameFile(sourceState,privateState(original))||hashFile(original)!==expectedSHA256)throw failure();
    for(const suffix of ['-wal','-shm','-journal'])absent(original+suffix);
    for(const path of paths){sync(path);privateState(path);}
    const receipt={version:1,kind:'dawar-control-role-staging',sourceSHA256:expectedSHA256,sourceBytes:bytes,
      sourceTables:before.map(({name,rows,sha256})=>({name,rows,sha256})),sourceSchemaSHA256:sha().update(JSON.stringify(originalCatalog)).digest('hex'),runtimeDefaults:inherited,
      hub:{path:paths[0],sha256:hashFile(paths[0])},agent:{path:paths[1],sha256:hashFile(paths[1])},
      originalEventCursorFloor:Number(eventFloor),
      originalRowsPreserved:true,executionEnabled:false,productionWriterFreezeEstablished:false,
      placementsCreated:0,nativeProcessesStarted:0,createdAt:new Date().toISOString()};
    for(const directory of directories){savePrivate(join(directory,'control-stage.json'),JSON.stringify(receipt,null,2)+'\n',{exclusive:true});sync(directory);}
    return receipt;
  }catch{
    // Retain partial private stages for review. No recursive deletion, restore,
    // retry, activation or editing of the source/another installation occurs.
    for(const directory of directories){try{savePrivate(join(directory,'stage-failed.json'),JSON.stringify({version:1,kind:'dawar-control-role-staging',status:'failed',executionEnabled:false})+'\n',{exclusive:true});}catch{}}
    throw failure();
  }finally{for(const fd of copies)try{closeSync(fd);}catch{}if(sourceFD!==undefined)closeSync(sourceFD);}
}
