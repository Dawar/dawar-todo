import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url), root = resolve(dirname(new URL(import.meta.url).pathname),'../..');
export function loadTypeScript(path,cache=new Map()) {
  path=resolve(root,path); if (cache.has(path)) return cache.get(path).exports;
  const loaded={exports:{}}; cache.set(path,loaded);
  const source=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{module:loaded,exports:loaded.exports,require:(name)=>name.startsWith('.')?(name.endsWith('.mjs')?require(resolve(dirname(path),name)):loadTypeScript(resolve(dirname(path),`${name}.ts`),cache)):require(name),
    Request,Response,Headers,URL,URLSearchParams,crypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,FormData,File,Blob,AbortSignal,btoa,atob,console,fetch:(...args)=>globalThis.fetch(...args)}, {filename:path});
  return loaded.exports;
}
export function d1() {
  const sqlite=new DatabaseSync(':memory:');
  const db={sqlite,prepare(sql) {
    let args=[]; const statement=()=>sqlite.prepare(sql);
    return { bind(...values) {args=values;return this;},async first(){return statement().get(...args)??null;},async all(){return {results:statement().all(...args)};},async run(){const result=statement().run(...args);return {success:true,meta:{changes:Number(result.changes)}};}, execute(){statement().run(...args);} };
  },async batch(statements){sqlite.exec('BEGIN');try {for(const statement of statements) statement.execute();sqlite.exec('COMMIT');return [];}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return db;
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function signingKey(secret,scope) { const [date,region,service,end]=scope.split('/'); return hmac(hmac(hmac(hmac(`AWS4${secret}`,date),region),service),end); }
export function provider(environment) {
  const objects=new Map(); let copyCount=0, failDownload=0, corruptDownload=false, interruptUpload=false, mutateOnCopy=false;
  const keyOf=url=>decodeURIComponent(url.pathname.replace(url.hostname.startsWith(`${environment.S3_BUCKET}.`)?/^\//:new RegExp(`^/${environment.S3_BUCKET}/`),''));
  const etag=bytes=>`"${sha(bytes)}"`;
  async function fetch(input,init={}) {
    const url=new URL(input instanceof Request?input.url:input),method=init.method??(input instanceof Request?input.method:'GET');
    const headers=new Headers(init.headers??(input instanceof Request?input.headers:undefined));
    if (method==='POST') {
      if (interruptUpload) { interruptUpload=false; throw new Error('Synthetic network interruption'); }
      const form=init.body, fields=Object.fromEntries([...form].filter(([name])=>name!=='file'));
      const policy=JSON.parse(Buffer.from(fields.policy,'base64').toString()), credential=String(fields['x-amz-credential']),scope=credential.slice(credential.indexOf('/')+1);
      if (hmac(signingKey(environment.S3_ACCESS_KEY,scope),fields.policy).toString('hex')!==fields['x-amz-signature']) return new Response('invalid signature',{status:403});
      const bytes=Buffer.from(await form.get('file').arrayBuffer());
      for (const condition of policy.conditions) {
        if (Array.isArray(condition)) { if (bytes.length<condition[1]||bytes.length>condition[2]) return new Response('size rejected',{status:403}); }
        else for (const [name,value] of Object.entries(condition)) if ((name==='bucket'?environment.S3_BUCKET:fields[name])!==value) return new Response('policy rejected',{status:403});
      }
      objects.set(fields.key,bytes);return new Response(null,{status:204});
    }
    const authorization=headers.get('authorization');
    if (authorization) {
      const match=authorization.match(/Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([a-f0-9]+)/);
      if (!match || match[1]!==environment.S3_ACCESS_KEY_ID) return new Response('invalid auth',{status:403});
      const [, ,scope,names,signature]=match;
      const canonicalHeaders=names.split(';').map(name=>`${name}:${name==='host'?url.host:headers.get(name).trim().replace(/\s+/g,' ')}\n`).join('');
      const query=[...url.searchParams].map(([name,value])=>[encode(name),encode(value)]).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([name,value])=>`${name}=${value}`).join('&');
      const canonical=[method,url.pathname,query,canonicalHeaders,names,headers.get('x-amz-content-sha256')].join('\n');
      const toSign=['AWS4-HMAC-SHA256',headers.get('x-amz-date'),scope,sha(canonical)].join('\n');
      if (hmac(signingKey(environment.S3_ACCESS_KEY,scope),toSign).toString('hex')!==signature) return new Response('invalid header signature',{status:403});
    } else if (url.searchParams.has('X-Amz-Signature')) {
      if (failDownload) {failDownload--;return new Response('expired',{status:403});}
      const signature=url.searchParams.get('X-Amz-Signature');url.searchParams.delete('X-Amz-Signature');
      const credential=url.searchParams.get('X-Amz-Credential'),scope=credential.slice(credential.indexOf('/')+1);
      const query=[...url.searchParams].map(([name,value])=>[encode(name),encode(value)]).sort(([a,av],[b,bv])=>a<b?-1:a>b?1:av<bv?-1:av>bv?1:0).map(([name,value])=>`${name}=${value}`).join('&');
      const canonical=[method,url.pathname,query,`host:${url.host}\n`,'host','UNSIGNED-PAYLOAD'].join('\n');
      const toSign=['AWS4-HMAC-SHA256',url.searchParams.get('X-Amz-Date'),scope,sha(canonical)].join('\n');
      if (hmac(signingKey(environment.S3_ACCESS_KEY,scope),toSign).toString('hex')!==signature) return new Response('invalid query signature',{status:403});
    } else return new Response('unsigned',{status:403});
    const key=keyOf(url);
    if (method==='PUT') {
      const source=decodeURIComponent(headers.get('x-amz-copy-source')).slice(environment.S3_BUCKET.length+2);
      if (mutateOnCopy) {mutateOnCopy=false;objects.set(source,Buffer.from('changed after hash'));}
      const bytes=objects.get(source);
      if (!bytes || etag(bytes)!==headers.get('x-amz-copy-source-if-match')) return new Response('copy precondition',{status:412});
      if (!authorization.includes('x-amz-copy-source-if-match')) throw new Error('Copy precondition was not signed');
      objects.set(key,Buffer.from(bytes));copyCount++;return new Response('<CopyObjectResult><ETag>ok</ETag></CopyObjectResult>');
    }
    if (method==='DELETE') {objects.delete(key);return new Response(null,{status:204});}
    const bytes=objects.get(key);if (!bytes) return new Response(null,{status:404});
    return new Response(method==='HEAD'?null:corruptDownload&&!authorization?Buffer.from('corrupt'):bytes,{headers:{etag:etag(bytes),'Content-Length':String(bytes.length)}});
  }
  return {fetch,objects,get copyCount(){return copyCount;},set failDownload(n){failDownload=n;},set corruptDownload(value){corruptDownload=value;},set interruptUpload(value){interruptUpload=value;},set mutateOnCopy(value){mutateOnCopy=value;}};
}
