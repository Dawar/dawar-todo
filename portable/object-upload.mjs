import { constants } from 'node:fs';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { digest } from './protocol.mjs';

export const UPLOAD_CHUNK_BYTES=4*1024*1024;
const MAX=250*1024*1024, LIFETIME=24*3600000;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
function stopped(pid){if(!Number.isSafeInteger(pid)||pid<1||pid>2147483647)throw Error('Original upload process binding is unavailable.');try{process.kill(pid,0);return false;}catch(e){return e.code==='ESRCH';}}

// This journal records local immutable file writes, not native execution or
// external provider effects. A lost response is reconciled by the same grant,
// manifest and original object identity before another bounded write.
export class ObjectUpload {
  constructor(objects,keyId){
    this.objects=objects;this.db=objects.db;this.keyId=keyId;
    this.directory=join(objects.files.directory,'upload-parts');
    this.db.exec(`CREATE TABLE IF NOT EXISTS portable_object_uploads(
      id TEXT PRIMARY KEY,identity TEXT NOT NULL,manifest TEXT NOT NULL,size INTEGER NOT NULL,hash TEXT,
      state TEXT NOT NULL,deadline INTEGER NOT NULL,claim TEXT,pid INTEGER,result_hash TEXT);
      CREATE TABLE IF NOT EXISTS portable_object_parts(upload_id TEXT NOT NULL,part INTEGER NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,PRIMARY KEY(upload_id,part));
      CREATE TABLE IF NOT EXISTS portable_object_receiving(id TEXT PRIMARY KEY,upload_id TEXT NOT NULL,part INTEGER NOT NULL,pid INTEGER NOT NULL,UNIQUE(upload_id,part));`);
  }
  transaction(work){return this.objects.writeSync(work);}
  scope(v){
    if(v.uploadVersion!==1||!Number.isSafeInteger(v.minimum)||!Number.isSafeInteger(v.maximum)||v.minimum<0||v.maximum<v.minimum||v.maximum>MAX||typeof v.type!=='string'||!/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(v.type)||v.hash!==undefined&&!hex(v.hash))throw Error('Invalid original upload scope.');
    return JSON.stringify({owner:v.owner,key:v.key,type:v.type,minimum:v.minimum,maximum:v.maximum,node:v.node??null,hash:v.hash??null});
  }
  guard(token,row=null){
    if(typeof this.objects.assertWriter!=='function')throw Error('Storage writer authority is unavailable.');
    this.objects.assertWriter();const v=this.objects.verify(token,'POST');
    if(row&&(row.identity!==this.scope(v)||row.deadline<=Date.now()))throw Error('Original upload scope changed or expired.');
    if(row){const current=this.db.prepare('SELECT * FROM portable_object_uploads WHERE id=?').get(row.id);if(!current||['identity','manifest','size','hash','deadline'].some(k=>current[k]!==row[k]))throw Error('Original persisted upload identity changed.');}
    return v;
  }
  claim(row,claim){const current=this.db.prepare('SELECT state,claim,pid FROM portable_object_uploads WHERE id=?').get(row.id);if(current?.state!=='assembling'||current.claim!==claim||current.pid!==process.pid)throw Error('Original assembly claim changed.');}
  row(v){const row=this.db.prepare('SELECT * FROM portable_object_uploads WHERE id=?').get(this.keyId(v.key));if(!row||row.identity!==this.scope(v))throw Error('Original upload session is unavailable.');return row;}
  partPath(row,index){return join(this.directory,`${digest(row.id)}-${index}-${JSON.parse(row.manifest)[index]}`);}
  async directoryReady(){
    await mkdir(this.directory,{recursive:true,mode:0o700});const s=await lstat(this.directory);
    if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||process.getuid&&s.uid!==process.getuid())throw Error('Private upload directory is unavailable.');
  }
  async metadata(req){
    let size=0;const chunks=[];for await(const c of req){size+=c.length;if(size>8192)throw Error('Upload metadata is too large.');chunks.push(c);}
    return JSON.parse(Buffer.concat(chunks).toString()||'{}');
  }
  status(row){
    const parts=this.db.prepare('SELECT part,hash,size FROM portable_object_parts WHERE upload_id=? ORDER BY part').all(row.id);
    return {version:1,uploadId:digest(row.identity+'\0'+row.manifest+'\0'+row.size+'\0'+row.hash),state:row.state,size:row.size,sha256:row.result_hash,chunkBytes:UPLOAD_CHUNK_BYTES,parts};
  }
  async removeParts(row,token){for(let i=0;i<JSON.parse(row.manifest).length;i++){this.guard(token,row);await rm(this.partPath(row,i),{force:true});}}
  async cleanStopped(){
    return this.objects.runWork('object-cleanup',()=>this.cleanStoppedAdmitted());
  }
  async cleanStoppedAdmitted(){
    // PID reuse or inaccessible process identity remains busy. No time-based
    // takeover of an in-flight receiver/assembler is permitted.
    for(const c of this.db.prepare('SELECT * FROM portable_object_receiving LIMIT 16').all()){
      if(!/^[a-f0-9-]{36}$/.test(c.id))throw Error('Original receiving claim identity changed.');
      if(!stopped(c.pid))continue;await rm(join(this.directory,`.part-${c.id}`),{force:true});
      this.transaction(()=>this.db.prepare('DELETE FROM portable_object_receiving WHERE id=? AND pid=?').run(c.id,c.pid));
    }
    for(const row of this.db.prepare("SELECT * FROM portable_object_uploads WHERE state='uploading' AND deadline<=? LIMIT 8").all(Date.now())){
      if(this.db.prepare('SELECT 1 FROM portable_object_receiving WHERE upload_id=?').get(row.id))continue;
      this.transaction(()=>this.db.prepare("UPDATE portable_object_uploads SET state='expired' WHERE id=? AND state='uploading' AND deadline<=?").run(row.id,Date.now()));
      for(let i=0;i<JSON.parse(row.manifest).length;i++)await rm(this.partPath(row,i),{force:true});
    }
  }
  async begin(req,token,v){
    return this.objects.runWork('object-upload',()=>this.beginAdmitted(req,token,v));
  }
  async beginAdmitted(req,token,v){
    const input=await this.metadata(req);this.guard(token);
    if(!input||Array.isArray(input)||Object.keys(input).sort().join(',')!=='chunks,hash,size'||!Number.isSafeInteger(input.size)||input.size<v.minimum||input.size>v.maximum||!Array.isArray(input.chunks)||input.chunks.length!==Math.ceil(input.size/UPLOAD_CHUNK_BYTES)||input.chunks.some(h=>!hex(h))||input.hash!==null&&!hex(input.hash)||v.hash&&v.hash!==input.hash)throw Error('Original upload manifest differs.');
    const identity=this.scope(v),manifest=JSON.stringify(input.chunks),id=this.keyId(v.key);
    const row=this.transaction(()=>{
      this.guard(token);const old=this.db.prepare('SELECT * FROM portable_object_uploads WHERE id=?').get(id);
      if(old){if(old.identity!==identity||old.manifest!==manifest||old.size!==input.size||old.hash!==input.hash)throw Error('Original file upload changed; retain its original bytes.');this.guard(token,old);return old;}
      const capacity=this.db.prepare("SELECT count(*) AS n,coalesce(sum(size),0) AS bytes FROM portable_object_uploads WHERE state IN ('uploading','assembling')").get();
      if(capacity.n>=8||capacity.bytes+input.size>8*MAX)throw Error('Private upload capacity is busy; retain the original file.');
      this.db.prepare("INSERT INTO portable_object_uploads VALUES(?,?,?,?,?,'uploading',?,NULL,NULL,NULL)").run(id,identity,manifest,input.size,input.hash,Date.now()+LIFETIME);
      return this.db.prepare('SELECT * FROM portable_object_uploads WHERE id=?').get(id);
    });return json(this.status(row));
  }
  async chunk(req,token,row,index){
    return this.objects.runWork('object-upload',()=>this.chunkAdmitted(req,token,row,index));
  }
  async chunkAdmitted(req,token,row,index){
    const hashes=JSON.parse(row.manifest),size=Math.min(UPLOAD_CHUNK_BYTES,row.size-index*UPLOAD_CHUNK_BYTES);
    if(!Number.isSafeInteger(index)||index<0||index>=hashes.length||req.headers['x-dawar-chunk-sha256']!==hashes[index]||!/^\d+$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])!==size||req.headers['content-type']!=='application/octet-stream')throw Error('Original chunk identity or length differs.');
    const claim=randomUUID();
    this.transaction(()=>{
      this.guard(token,row);const current=this.row(this.objects.verify(token,'POST'));
      if(current.state!=='uploading'||this.db.prepare('SELECT count(*) AS n FROM portable_object_receiving').get().n>=16)throw Error('Private upload is busy; reconcile its original receipt.');
      this.db.prepare('INSERT INTO portable_object_receiving VALUES(?,?,?,?)').run(claim,row.id,index,process.pid);
    });
    const path=join(this.directory,`.part-${claim}`);let handle;
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(Error('Upload chunk deadline expired.')),120000),interrupted=()=>abort.abort(Error('Upload chunk interrupted.'));
    const validate=this.objects.writer.bindWork(()=>this.guard(token,row));
    req.once('aborted',interrupted);
    try{
      handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      let received=0;const sha=createHash('sha256');
      await pipeline(req,new Transform({transform:(c,e,cb)=>{try{validate();received+=c.length;if(received>size)throw Error('Chunk exceeds original size.');sha.update(c);cb(null,c);}catch(error){cb(error);}}}),handle.createWriteStream({autoClose:true}),{signal:abort.signal});
      if(received!==size||sha.digest('hex')!==hashes[index])throw Error('Upload chunk checksum differs.');
      // fs.WriteStream closes before pipeline settles. Reopen the exact private
      // temporary file for fsync; autoClose:false would leave pipeline waiting.
      const persisted=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{await persisted.sync();}finally{await persisted.close();}handle=null;this.guard(token,row);
      const receiving=this.db.prepare('SELECT * FROM portable_object_receiving WHERE id=?').get(claim);if(receiving?.upload_id!==row.id||receiving.part!==index||receiving.pid!==process.pid)throw Error('Original receiving claim changed.');
      const prior=this.db.prepare('SELECT * FROM portable_object_parts WHERE upload_id=? AND part=?').get(row.id,index);
      if(!prior){await rename(path,this.partPath(row,index));const d=await open(this.directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await d.sync();}finally{await d.close();}}
      this.transaction(()=>{
        this.guard(token,row);const current=this.row(this.objects.verify(token,'POST'));
        if(current.state!=='uploading')throw Error('Upload was superseded before chunk persistence.');
        this.db.prepare('INSERT OR IGNORE INTO portable_object_parts VALUES(?,?,?,?)').run(row.id,index,hashes[index],size);
        const saved=this.db.prepare('SELECT * FROM portable_object_parts WHERE upload_id=? AND part=?').get(row.id,index);
        if(saved.hash!==hashes[index]||saved.size!==size)throw Error('Original chunk receipt changed.');
      });return json(this.status(this.row(this.objects.verify(token,'POST'))));
    }finally{
      clearTimeout(timer);req.removeListener('aborted',interrupted);abort.abort();await handle?.close().catch(()=>{});await rm(path,{force:true});
      this.transaction(()=>this.db.prepare('DELETE FROM portable_object_receiving WHERE id=? AND pid=?').run(claim,process.pid));
    }
  }
  async *bytes(row,token){
    const hashes=JSON.parse(row.manifest);
    for(let i=0;i<hashes.length;i++){
      this.guard(token,row);const h=await open(this.partPath(row,i),constants.O_RDONLY|constants.O_NOFOLLOW);let size=0;const sha=createHash('sha256');
      try{
        const s=await h.stat();if(!s.isFile()||s.size!==Math.min(UPLOAD_CHUNK_BYTES,row.size-i*UPLOAD_CHUNK_BYTES))throw Error('Private upload chunk changed.');
        for await(const c of h.createReadStream({autoClose:false})){this.guard(token,row);size+=c.length;sha.update(c);yield c;}
        if(size!==s.size||sha.digest('hex')!==hashes[i])throw Error('Private upload chunk checksum differs.');
      }finally{await h.close();}
    }
  }
  async finish(req,token,row,v){
    return this.objects.runWork('object-upload',()=>this.finishAdmitted(req,token,row,v));
  }
  async finishAdmitted(req,token,row,v){
    const b=await this.metadata(req);if(!b||Array.isArray(b)||Object.keys(b).length)throw Error('Upload completion body changed.');this.guard(token,row);
    if(row.state==='done'){await this.removeParts(row,token);return json(this.status(row));}
    if(row.state==='assembling'){
      const saved=this.db.prepare('SELECT * FROM portable_artifacts WHERE id=?').get(row.id);
      if(saved){
        if(!hex(row.result_hash)||saved.owner!==v.owner||saved.bot_id!=='application'||saved.hash!==row.result_hash||saved.size!==row.size||saved.mime!==v.type)throw Error('Original completion receipt is unconfirmed.');
        const sha=createHash('sha256');let size=0;for await(const c of this.objects.files.streamHash(saved.hash)){this.guard(token,row);sha.update(c);size+=c.length;}
        if(size!==saved.size||sha.digest('hex')!==saved.hash)throw Error('Registered completion bytes changed.');
        this.transaction(()=>{this.guard(token,row);this.db.prepare("UPDATE portable_object_uploads SET state='done',claim=NULL,pid=NULL WHERE id=? AND state='assembling' AND claim=?").run(row.id,row.claim);});
        const result=this.row(v);if(result.state!=='done')throw Error('Original completion changed.');await this.removeParts(result,token);return json(this.status(result));
      }
      if(!stopped(row.pid))throw Error('Original upload completion is still busy; retain its receipt.');
      this.transaction(()=>{this.guard(token,row);this.db.prepare("UPDATE portable_object_uploads SET state='uploading',claim=NULL,pid=NULL WHERE id=? AND state='assembling' AND claim=? AND pid=?").run(row.id,row.claim,row.pid);});row=this.row(v);
    }
    const claim=randomUUID(),hashes=JSON.parse(row.manifest);
    this.transaction(()=>{
      this.guard(token,row);const parts=this.db.prepare('SELECT part,hash,size FROM portable_object_parts WHERE upload_id=? ORDER BY part').all(row.id);
      if(parts.length!==hashes.length||parts.some((p,i)=>p.part!==i||p.hash!==hashes[i]||p.size!==Math.min(UPLOAD_CHUNK_BYTES,row.size-i*UPLOAD_CHUNK_BYTES)))throw Error('Upload chunks are not all persisted.');
      if(this.db.prepare('SELECT 1 FROM portable_object_receiving WHERE upload_id=?').get(row.id)||this.db.prepare("SELECT 1 FROM portable_object_uploads WHERE state='assembling'").get())throw Error('Private file completion is busy.');
      const changed=this.db.prepare("UPDATE portable_object_uploads SET state='assembling',claim=?,pid=? WHERE id=? AND state='uploading'").run(claim,process.pid,row.id);
      if(changed.changes!==1)throw Error('Original upload completion state changed.');
    });
    try{
      const sha=createHash('sha256');let size=0;for await(const c of this.bytes(row,token)){this.claim(row,claim);sha.update(c);size+=c.length;}const hash=sha.digest('hex');
      if(size!==row.size||row.hash&&hash!==row.hash)throw Error('Original file checksum differs.');
      this.transaction(()=>{this.guard(token,row);this.claim(row,claim);this.db.prepare("UPDATE portable_object_uploads SET result_hash=? WHERE id=? AND claim=? AND state='assembling'").run(hash,row.id,claim);});
      await this.objects.files.register({owner:v.owner,botId:'application',artifactId:row.id,name:'Registered attachment',mime:v.type,hash,size},Readable.from(this.bytes(row,token)),{guard:()=>{this.guard(token,row);this.claim(row,claim);},commit:work=>this.objects.writeSync(work)});
      this.transaction(()=>{this.guard(token,row);this.db.prepare("UPDATE portable_object_uploads SET state='done',claim=NULL,pid=NULL WHERE id=? AND claim=? AND state='assembling'").run(row.id,claim);});
      const result=this.row(v);if(result.state!=='done')throw Error('Original file completion is unconfirmed.');
      await this.removeParts(result,token);return json(this.status(result));
    }catch(error){
      // Do not reset after a possibly committed registration. Its immutable
      // row and bytes must be read back, never overwritten or blindly replayed.
      this.transaction(()=>{if(!this.db.prepare('SELECT 1 FROM portable_artifacts WHERE id=?').get(row.id))this.db.prepare("UPDATE portable_object_uploads SET state='uploading',claim=NULL,pid=NULL WHERE id=? AND claim=? AND state='assembling'").run(row.id,claim);});
      throw error;
    }
  }
  async serve(req,url){
    if(req.method!=='GET')return this.objects.runWork('object-upload',()=>this.serveAdmitted(req,url));
    return this.serveAdmitted(req,url);
  }
  async serveAdmitted(req,url){
    const u=new URL(url),action=u.searchParams.get('action'),token=u.searchParams.get('grant');
    if([...u.searchParams.keys()].some(k=>!['grant','action','part'].includes(k))||[...new Set(u.searchParams.keys())].some(k=>u.searchParams.getAll(k).length!==1)||req.headers.origin&&req.headers.origin!==this.objects.config.publicOrigin||req.headers['transfer-encoding'])throw Error('Upload request scope changed.');
    const v=this.objects.verify(token,'POST');this.scope(v);
    if(!['begin','status','chunk','finish'].includes(action)||req.method!==({begin:'POST',status:'GET',chunk:'PUT',finish:'POST'}[action])||action!=='chunk'&&u.searchParams.has('part'))throw Error('Unsupported upload request.');
    if(action==='status'){const row=this.row(v);if(row.deadline<=Date.now())throw Error('Original upload session expired.');return json(this.status(row));}
    this.guard(token);await this.directoryReady();await this.cleanStopped();this.guard(token);
    if(action==='begin')return this.begin(req,token,v);
    const row=this.row(v);this.guard(token,row);
    if(action==='chunk'){const raw=u.searchParams.get('part');if(!/^(0|[1-9]\d*)$/.test(raw??''))throw Error('Original chunk position is required.');return this.chunk(req,token,row,Number(raw));}
    return this.finish(req,token,row,v);
  }
}
