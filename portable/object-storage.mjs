import { createHmac, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdir, open, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import busboy from 'busboy';
import { digest } from './protocol.mjs';
import { RegisteredArtifacts } from './artifacts.mjs';
import { privateDatabase } from './sqlite.mjs';
import { join } from 'node:path';

const MAX=250*1024*1024;
const keyId=key=>{
  if(typeof key!=='string'||!key||Buffer.byteLength(key)>2048||/[\x00-\x1f\x7f]/.test(key))throw Error('Invalid registered object identity.');
  return `object:${digest(key)}`;
};
export class ObjectStorage {
  constructor(config){this.config=config;this.db=privateDatabase(join(config.dataDirectory,'artifact-index.sqlite'));this.files=new RegisteredArtifacts(this.db,join(config.dataDirectory,'registered-files'));}
  token(value){const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',this.config.gatewaySecret).update('object:'+body).digest('base64url');}
  verify(token,method,now=Date.now()){
    if(typeof token!=='string'||token.length>6000)throw Error('Invalid object grant.');
    const [body,proof,extra]=token.split('.'),signature=createHmac('sha256',this.config.gatewaySecret).update('object:'+body).digest('base64url');
    if(extra||!proof||proof.length!==signature.length||!timingSafeEqual(Buffer.from(proof),Buffer.from(signature)))throw Error('Invalid object grant.');
    const v=JSON.parse(Buffer.from(body,'base64url'));
    if(v.owner!==this.config.owner.key||v.method!==method||!Number.isSafeInteger(v.expires)||v.expires<=now||v.expires>now+3600000)throw Error('Expired or foreign object grant.');
    keyId(v.key);return v;
  }
  url(key,query={}){const u=new URL('/storage/object',this.config.publicOrigin);if(key)u.searchParams.set('key',key);for(const [n,v] of Object.entries(query))u.searchParams.set(n,v);return u;}
  row(key){return this.files.record(this.config.owner.key,keyId(key),'application');}
  async response(key,method='GET',headers=new Headers()){
    try{return await this.files.response(this.config.owner.key,keyId(key),'application',new Request(this.url(key),{method,headers}));}
    catch(e){if(/not found|absent/i.test(e.message))return new Response(null,{status:404});throw e;}
  }
  async put(key,body,{type,minimum=1,maximum=MAX}){
    keyId(key);if(!Number.isSafeInteger(minimum)||!Number.isSafeInteger(maximum)||minimum<1||maximum<minimum||maximum>MAX)throw Error('Invalid upload bound.');
    if(!(body instanceof Blob)||body.size<minimum||body.size>maximum)throw Error('Upload size is outside the original grant.');
    const bytes=new Uint8Array(await body.arrayBuffer()),sha256=digest(bytes);
    return this.files.register({owner:this.config.owner.key,botId:'application',artifactId:keyId(key),name:'Registered attachment',mime:type,hash:sha256,size:bytes.length},Readable.from([bytes]));
  }
  async serve(request){
    const u=new URL(request.url),method=request.method==='HEAD'?'GET':request.method;
    const v=this.verify(u.searchParams.get('grant'),method);
    if(method==='GET'){
      const r=await this.response(v.key,request.method,request.headers);
      if(v.download)r.headers.set('content-disposition',`attachment; filename*=UTF-8''${encodeURIComponent(v.download)}`);
      return r;
    }
    if(method==='POST'){
      // Multipart parsing is bounded by the gateway before allocation. The
      // exact original key/content type is signed; it is never a local path.
      const form=await request.formData(),file=form.get('file');
      if(form.get('key')!==v.key||form.get('Content-Type')!==v.type)throw Error('Upload grant changed.');
      await this.put(v.key,file,v);return new Response(null,{status:204});
    }
    throw Error('Unsupported object method.');
  }
  async serveNode(req,url){
    if(req.method!=='POST')return this.serve(new Request(url,{method:req.method,headers:req.headers}));
    const v=this.verify(new URL(url).searchParams.get('grant'),'POST');
    if(!Number.isSafeInteger(v.maximum)||v.maximum<1||v.maximum>MAX||!Number.isSafeInteger(v.minimum)||v.minimum<1||v.minimum>v.maximum)throw Error('Invalid original upload bounds.');
    const length=Number(req.headers['content-length']);
    if(req.headers['content-length']&&(!Number.isSafeInteger(length)||length<1||length>v.maximum+65536))throw Error('Upload exceeds declared bound.');
    await mkdir(this.files.directory,{recursive:true,mode:0o700});
    const temporary=join(this.files.directory,`.upload-${randomUUID()}`),handle=await open(temporary,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    let fileTask=null,size=0,bodySize=0;const sha=createHash('sha256'),fields=new Map(),abort=new AbortController();
    const timer=setTimeout(()=>abort.abort(Error('Upload deadline expired.')),15*60*1000);
    const aborted=()=>abort.abort(Error('Upload interrupted.'));req.once('aborted',aborted);
    try{
      const parser=busboy({headers:req.headers,limits:{files:1,fields:2,parts:4,fieldSize:2048,fieldNameSize:32,fileSize:v.maximum+1,headerPairs:20}});
      parser.on('field',(name,value,info)=>{
        if(!['key','Content-Type'].includes(name)||fields.has(name)||info.valueTruncated||info.nameTruncated)parser.destroy(Error('Upload fields changed.'));else fields.set(name,value);
      });
      for(const event of ['filesLimit','fieldsLimit','partsLimit'])parser.on(event,()=>parser.destroy(Error('Upload part bound exceeded.')));
      parser.on('file',(name,file)=>{
        file.on('error',()=>{});
        if(name!=='file'||fileTask||fields.get('key')!==v.key||fields.get('Content-Type')!==v.type){file.resume();parser.destroy(Error('Upload identity changed.'));return;}
        fileTask=pipeline(file,new Transform({transform(chunk,e,cb){size+=chunk.length;if(size>v.maximum)return cb(Error('File exceeds original grant.'));sha.update(chunk);cb(null,chunk);}}),handle.createWriteStream({autoClose:true}),{signal:abort.signal});
        // Preserve rejection without leaving an unhandled Promise while the
        // bounded multipart parser is still consuming its final delimiter.
        void fileTask.catch(e=>parser.destroy(e));
      });
      await pipeline(req,new Transform({transform(chunk,e,cb){bodySize+=chunk.length;if(bodySize>v.maximum+65536)return cb(Error('Multipart body exceeds bound.'));cb(null,chunk);}}),parser,{signal:abort.signal});
      if(!fileTask)throw Error('Upload file missing.');await fileTask;
      if(size<v.minimum||fields.get('key')!==v.key||fields.get('Content-Type')!==v.type)throw Error('Original upload size or fields differ.');
      this.verify(new URL(url).searchParams.get('grant'),'POST');
      const source=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW);
      try{await this.files.register({owner:this.config.owner.key,botId:'application',artifactId:keyId(v.key),name:'Registered attachment',mime:v.type,hash:sha.digest('hex'),size},source.createReadStream({autoClose:true}));}finally{await source.close();}
      return new Response(null,{status:204});
    }finally{clearTimeout(timer);req.removeListener('aborted',aborted);abort.abort();await fileTask?.catch(()=>{});await handle.close().catch(()=>{});await rm(temporary,{force:true});}
  }
  adapter(){
    const storageUrl=(key,query)=>this.url(key,query);
    const signedStorageResponse=async(url,init={})=>{
      const u=new URL(url),key=u.searchParams.get('key');
      if(u.origin!==this.config.publicOrigin||u.pathname!=='/storage/object')throw Error('Foreign storage URL.');
      const h=new Headers(init.headers),method=init.method??'GET';
      if(method==='GET'||method==='HEAD')return this.response(key,method,h);
      if(method==='PUT'){
        const source=h.get('x-amz-copy-source');
        if(!source)throw Error('Direct object overwrite is unsupported.');
        const parts=source.split('/');parts.splice(0,2);const sourceKey=parts.map(decodeURIComponent).join('/');
        const r=await this.response(sourceKey);if(!r.ok)return r;
        if(r.headers.get('etag')!==h.get('x-amz-copy-source-if-match'))return new Response(null,{status:412});
        const row=this.row(sourceKey);await this.put(key,await r.blob(),{type:row.mime,maximum:MAX});
        return new Response('<CopyObjectResult/>',{headers:{'content-type':'application/xml'}});
      }
      if(method==='DELETE'){this.files.db.prepare('DELETE FROM portable_artifacts WHERE owner=? AND bot_id=? AND id=?').run(this.config.owner.key,'application',keyId(key));return new Response(null,{status:204});}
      throw Error('Unsupported local storage operation.');
    };
    const storageResponseError=async()=>Error('Private registered storage verification failed; retain the original attachment.');
    return {storageUrl,signedStorageResponse,storageResponseError,
      storageFetch:async(url,init)=>{const r=await signedStorageResponse(url,init);if(!r.ok)throw await storageResponseError();return r;},
      signedObjectUrl:async(key,download)=>{this.row(key);const u=this.url();u.searchParams.set('grant',this.token({key,download,owner:this.config.owner.key,method:'GET',expires:Date.now()+3600000}));return u.toString();},
      signedPostTarget:async(key,type,maximum,minimum=1)=>{keyId(key);const u=this.url();u.searchParams.set('grant',this.token({key,type,maximum,minimum,owner:this.config.owner.key,method:'POST',expires:Date.now()+900000}));return {url:u.toString(),fields:{key,'Content-Type':type}};},
      copyObject:async(source,target,etag,signal)=>{signal?.throwIfAborted();const r=await this.response(source);if(!r.ok||r.headers.get('etag')!==etag)throw Error('Original copy source changed.');await this.put(target,await r.blob(),{type:this.row(source).mime,maximum:MAX});signal?.throwIfAborted();},
      deleteKeys:async keys=>{for(const k of new Set(keys))await signedStorageResponse(this.url(k),{method:'DELETE'});},
      readBucketCors:async()=>({http:200,code:null,configured:true,rules:[{allowedOrigins:[this.config.publicOrigin],allowedMethods:['GET','HEAD','POST'],allowedHeaders:['Content-Type'],exposeHeaders:['ETag','Content-Length','Content-Range'],maxAgeSeconds:0}]}) };
  }
  close(){this.db.close();}
}
