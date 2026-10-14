import { constants, createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { id } from './protocol.mjs';

export class RegisteredArtifacts {
  constructor(db,directory,{writer=null}={}) {
    this.writer=writer;
    this.db=db;this.directory=directory;
    db.exec('CREATE TABLE IF NOT EXISTS portable_artifacts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,bot_id TEXT,hash TEXT NOT NULL,size INTEGER NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,created_at INTEGER NOT NULL)');
  }
  async register({artifactId,owner,botId=null,hash,size,name,mime},source,{guard=()=>{},commit=work=>this.writer?this.writer.runSync(work):work()}={}) {
    if(this.writer)return this.writer.runWork('artifact-register',()=>this.registerAdmitted({artifactId,owner,botId,hash,size,name,mime},source,{guard:()=>{this.writer.assertWriter();guard();},commit}));
    return this.registerAdmitted({artifactId,owner,botId,hash,size,name,mime},source,{guard,commit});
  }
  async registerAdmitted({artifactId,owner,botId=null,hash,size,name,mime},source,{guard,commit}) {
    if(!id(artifactId)||!owner||botId!==null&&!id(botId)||!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(size)||size<0||size>250*1024*1024
      ||typeof name!=='string'||name.length>240||/[\r\n\0]/.test(name)||typeof mime!=='string'||!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(mime))throw Error('Invalid registered artifact.');
    guard();
    const old=this.db.prepare('SELECT * FROM portable_artifacts WHERE id=?').get(artifactId);
    if(old){
      if(old.owner!==owner||old.bot_id!==botId||old.hash!==hash||old.size!==size||old.name!==name||old.mime!==mime)throw Error('Artifact identity changed.');
      return old;
    }
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const temporary=join(this.directory,`.pending-${randomUUID()}`),handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    const sha=createHash('sha256');let bytes=0;
    const bound=new Transform({transform(chunk,encoding,callback){bytes+=chunk.length;if(bytes>size)return callback(Error('Artifact exceeds declared size.'));sha.update(chunk);callback(null,chunk);}});
    try{
      await pipeline(source,bound,handle.createWriteStream({autoClose:true}));
      if(bytes!==size||sha.digest('hex')!==hash)throw Error('Artifact hash or length mismatch.');
      const completed=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{await completed.sync();}finally{await completed.close();}
      // Content addressing supplies filenames; a message-supplied path is
      // never a filesystem read capability. Original public IDs stay intact.
      guard();await rename(temporary,join(this.directory,hash));
      const directory=await open(this.directory,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{await directory.sync();}finally{await directory.close();}
      return commit(()=>{
        guard();const current=this.db.prepare('SELECT * FROM portable_artifacts WHERE id=?').get(artifactId);
        if(current){if(current.owner!==owner||current.bot_id!==botId||current.hash!==hash||current.size!==size||current.name!==name||current.mime!==mime)throw Error('Artifact identity changed.');return current;}
        this.db.prepare('INSERT INTO portable_artifacts VALUES(?,?,?,?,?,?,?,?)').run(artifactId,owner,botId,hash,size,name,mime,Date.now());
        return this.db.prepare('SELECT * FROM portable_artifacts WHERE id=?').get(artifactId);
      });
    }catch(error){await handle.close().catch(()=>{});await rm(temporary,{force:true});throw error;}
  }
  record(owner,artifactId,botId=null) {
    const r=this.db.prepare('SELECT * FROM portable_artifacts WHERE id=? AND owner=?').get(artifactId,owner);
    if(!r||r.bot_id!==botId)throw Error('Registered artifact not found in this scope.');return r;
  }
  async response(owner,artifactId,botId,request) {
    const r=this.record(owner,artifactId,botId),handle=await open(join(this.directory,r.hash),constants.O_RDONLY|constants.O_NOFOLLOW),s=await handle.stat();
    if(!s.isFile()||s.size!==r.size){await handle.close();throw Error('Registered artifact changed.');}
    let start=0,end=r.size-1,status=200;
    const range=request.headers.get('range');
    if(range){
      const match=range.match(/^bytes=(\d+)-(\d*)$/);
      if(!match){await handle.close();return new Response(null,{status:416,headers:{'content-range':`bytes */${r.size}`}});}
      start=Number(match[1]);end=match[2]?Number(match[2]):end;status=206;
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=r.size){await handle.close();return new Response(null,{status:416,headers:{'content-range':`bytes */${r.size}`}});}end=Math.min(end,r.size-1);
    }
    const headers=new Headers({'content-type':r.mime,'content-length':String(Math.max(0,end-start+1)),etag:`"${r.hash}"`,'x-content-type-options':'nosniff','cache-control':'private, no-store','accept-ranges':'bytes',
      'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(r.name)}`});
    if(status===206)headers.set('content-range',`bytes ${start}-${end}/${r.size}`);
    if(request.method==='HEAD'){await handle.close();return new Response(null,{status,headers});}
    if(r.size===0){await handle.close();return new Response(new Uint8Array(),{status,headers});}
    return new Response(Readable.toWeb(handle.createReadStream({start,end,autoClose:true})),{status,headers});
  }
  async snapshot(destination,signal) {
    await mkdir(destination,{recursive:true,mode:0o700});
    const rows=this.db.prepare('SELECT * FROM portable_artifacts ORDER BY id').all();
    const copied=new Set();
    for(const r of rows){
      signal?.throwIfAborted();
      if(copied.has(r.hash))continue;
      const source=await open(join(this.directory,r.hash),constants.O_RDONLY|constants.O_NOFOLLOW),temporary=join(destination,r.hash),sha=createHash('sha256');
      try{
        const s=await source.stat();if(!s.isFile()||s.size!==r.size)throw Error('Registered backup source changed.');
        const target=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
        try{await pipeline(source.createReadStream({autoClose:true}),new Transform({transform(c,e,cb){sha.update(c);cb(null,c);}}),target.createWriteStream({autoClose:true}),{signal});
          const completed=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);try{await completed.sync();}finally{await completed.close();}}
        finally{await target.close();}
        if(sha.digest('hex')!==r.hash||(await stat(temporary)).size!==r.size)throw Error('Registered backup hash differs.');
        copied.add(r.hash);
      }finally{await source.close();}
    }
    return rows;
  }
  streamHash(hash){if(!/^[a-f0-9]{64}$/.test(hash))throw Error('Invalid content identity.');return createReadStream(join(this.directory,hash),{flags:constants.O_RDONLY|constants.O_NOFOLLOW});}
}
