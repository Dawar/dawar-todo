import { DatabaseSync } from 'node:sqlite';
import { readdir, readFile, chmod, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { privateDatabase } from './sqlite.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
// Staging creation is explicit. A production export is imported as a whole
// into a NEW private database rather than rewritten through new schema defaults.
export async function initializeApplication(path,migrations){
  try{await lstat(path);throw Error('Application initialization never overwrites an existing database.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const db=privateDatabase(path);
  try{
    db.exec('CREATE TABLE portable_schema_migrations(name TEXT PRIMARY KEY,sha256 TEXT NOT NULL)');
    for(const name of (await readdir(migrations)).filter(n=>/^\d+_[a-z0-9_]+\.sql$/.test(n)).sort()){
      const sql=await readFile(join(migrations,name),'utf8');
      db.exec('BEGIN IMMEDIATE');
      try{db.exec(sql);db.prepare('INSERT INTO portable_schema_migrations VALUES(?,?)').run(name,hash(sql));db.exec('COMMIT');}
      catch(e){db.exec('ROLLBACK');throw e;}
    }
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Staging application integrity check failed.');
    return {initialized:true,productionDataImported:false};
  }finally{db.close();}
}

export async function importApplicationExport({sqlPath,destination,expectedSHA256}){
  const s=await lstat(sqlPath);
  if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.size>1024*1024*1024)throw Error('Private bounded export required.');
  try{await lstat(destination);throw Error('Import requires a new staging destination.');}catch(e){if(e.code!=='ENOENT')throw e;}
  const bytes=await readFile(sqlPath);
  if(hash(bytes)!==expectedSHA256)throw Error('Original export changed.');
  const db=privateDatabase(destination);
  try{
    // SQLite SQL has no extension/file/network capabilities enabled here.
    // ATTACH and extension loading would escape the supplied database scope.
    const sql=bytes.toString();
    if(/\b(?:ATTACH|DETACH|load_extension|VACUUM\s+INTO)\b/i.test(sql.replace(/'(?:''|[^'])*'/g,"''")))throw Error('Export contains an out-of-scope database operation.');
    db.exec(sql);
    if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Imported application integrity check failed.');
    return applicationInventory(db);
  }finally{db.close();await chmod(destination,0o600);}
}

export function applicationInventory(db){
  const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return tables.map(({name})=>{
    const quoted='"'+name.replaceAll('"','""')+'"';
    return {name,rows:db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get().n};
  });
}
export function inspectImportedApplication(path){
  const db=new DatabaseSync(resolve(path),{readOnly:true});
  try{return {integrity:db.prepare('PRAGMA integrity_check').get().integrity_check,tables:applicationInventory(db)};}finally{db.close();}
}
