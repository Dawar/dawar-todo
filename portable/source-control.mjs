import {installSourceWriterAdmission,readSourceWriterAdmission,readSourceWriterControlReceipt,beginSourceWriterDrain,observeSourceWriterDrain,releaseSourceWriterDrain} from './source-writer-admission.mjs';
import {planD1WriteFence,installD1WriteFence,readD1WriteFenceInstallation,readD1WriteFenceControlReceipt,freezeD1Writes,readD1WriteFence,releaseD1Writes} from './d1-write-fence.mjs';

export const SOURCE_CONTROL_PATH='/api/migration/source/control';
const encoder=new TextEncoder(),headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const failure=()=>Error('The original source migration control was not confirmed. Preserve its operation and receipt.');
const exact=(v,fields)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==fields.length||Object.keys(v).some(k=>!fields.includes(k)))throw failure();};
const id=v=>{if(typeof v!=='string'||!v||v.includes('\0')||encoder.encode(v).length>1024)throw failure();return v;};
const sha=v=>{if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw failure();return v;};
const actions={
  'journal.install':['action','operationId'],
  'journal.read':['action','operationId'],
  'journal.receipt':['action','operationId','receiptKind','expiresAt','generation'],
  'database.plan':['action','operationId'],
  'database.install':['action','operationId','schemaSHA256'],
  'database.read':['action','operationId','schemaSHA256'],
  'database.receipt':['action','operationId','schemaSHA256','receiptKind','expiresAt','generation'],
  'journal.drain':['action','operationId','schemaSHA256','expiresAt'],
  'journal.observe':['action','operationId'],
  'database.freeze':['action','operationId','schemaSHA256','expiresAt'],
  'database.observe':['action','operationId','schemaSHA256'],
  'database.release':['action','operationId','schemaSHA256','generation'],
  'journal.release':['action','operationId','schemaSHA256','generation'],
};
const writes=new Set(['journal.install','database.install','journal.drain','database.freeze','database.release','journal.release']);
async function input(request){
  if(!request.body)throw failure();const signal=AbortSignal.any([request.signal,AbortSignal.timeout(5000)]),reader=request.body.getReader();
  let size=0,done=false;const chunks=[];const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
    for(;;){signal.throwIfAborted();const row=await reader.read();signal.throwIfAborted();if(row.done){done=true;break;}
      if(!(row.value instanceof Uint8Array)||(size+=row.value.length)>4096||chunks.length>=64)throw failure();chunks.push(row.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }finally{signal.removeEventListener('abort',abort);if(!done)void reader.cancel().catch(()=>{});reader.releaseLock();}
}
async function sameCredential(actual,expected){
  if(typeof actual!=='string'||actual.length>512)return false;
  const values=await Promise.all([actual,expected].map(s=>crypto.subtle.digest('SHA-256',encoder.encode(s))));
  const a=new Uint8Array(values[0]),b=new Uint8Array(values[1]);let difference=0;
  for(let i=0;i<a.length;i++)difference|=a[i]^b[i];return difference===0;
}

// Private deployment configuration and the existing authenticated owner are
// both required. Commands cannot supply SQL, source bindings or writer counts.
// This endpoint controls two component fences; it never proves a full cutover.
export function createOriginalSourceControl({db,configuration,build,authorizeOwner,admissionEnabled=false}){
  exact(configuration,['version','kind','sourceOrigin','sourceId','credential','journal','database','cutoverId','databaseReleaseId','journalReleaseId']);
  exact(configuration.journal,['installationId','producerSHA256']);exact(configuration.database,['installId']);
  const c=JSON.parse(JSON.stringify(configuration)),origin=new URL(c.sourceOrigin);
  if(c.version!==1||c.kind!=='dawar-original-source-control'||origin.protocol!=='https:'||origin.origin!==c.sourceOrigin||origin.username||origin.password||
      !/^[a-f0-9]{12}$/.test(build??'')||c.sourceId!==build||typeof c.credential!=='string'||!/^[A-Za-z0-9_-]{32,512}$/.test(c.credential)||typeof authorizeOwner!=='function'||typeof admissionEnabled!=='boolean')throw failure();
  const journal={sourceId:build,installationId:id(c.journal.installationId),producerSHA256:sha(c.journal.producerSHA256)};
  const installId=id(c.database.installId),cutoverId=id(c.cutoverId),dbReleaseId=id(c.databaseReleaseId),journalReleaseId=id(c.journalReleaseId);
  if(new Set([journal.installationId,installId,cutoverId,dbReleaseId,journalReleaseId]).size!==5)throw failure();
  const originalId=action=>action.startsWith('journal.')?(action==='journal.release'?journalReleaseId:['journal.drain','journal.observe'].includes(action)?cutoverId:journal.installationId):
    action==='database.release'?dbReleaseId:['database.freeze','database.observe'].includes(action)?cutoverId:installId;
  return {async fetch(request){
    let command,mayHaveWritten=false,authenticated=false;
    try{
      const url=new URL(request.url),originHeader=request.headers.get('Origin'),site=request.headers.get('Sec-Fetch-Site');
      if(request.method!=='POST'||url.origin!==c.sourceOrigin||url.pathname!==SOURCE_CONTROL_PATH||url.search||url.hash||
          originHeader!==null&&originHeader!==c.sourceOrigin||site==='cross-site'||request.headers.has('Authorization')||
          request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase()!=='application/json'||
          !await sameCredential(request.headers.get('X-Dawar-Migration-Control'),c.credential))throw failure();
      await authorizeOwner(request);request.signal.throwIfAborted();authenticated=true;
      command=await input(request);if(!Object.hasOwn(actions,command?.action))throw failure();exact(command,actions[command.action]);
      const receipt=command.action.endsWith('.receipt');
      if(receipt){
        const family=command.action.split('.')[0],allowed=family==='journal'?['install','drain','release']:['install','freeze','release'];
        if(!allowed.includes(command.receiptKind)||command.operationId!==originalId(`${family}.${command.receiptKind}`))throw failure();
        if(command.receiptKind==='install'&&(command.expiresAt!==0||command.generation!==0)||
            command.receiptKind==='release'&&(command.expiresAt!==0||!Number.isSafeInteger(command.generation)||command.generation<1)||
            ['drain','freeze'].includes(command.receiptKind)&&(!Number.isSafeInteger(command.expiresAt)||command.expiresAt<1||command.generation!==0))throw failure();
      }else if(command.operationId!==originalId(command.action))throw failure();
      if('schemaSHA256' in command)sha(command.schemaSHA256);
      if(!receipt&&'generation' in command&&(!Number.isSafeInteger(command.generation)||command.generation<1))throw failure();
      if(!receipt&&'expiresAt' in command&&(!Number.isSafeInteger(command.expiresAt)||command.expiresAt<=Date.now()||command.expiresAt-Date.now()>900000))throw failure();
      request.signal.throwIfAborted();
      const expected={sourceId:build,installId,schemaSHA256:command.schemaSHA256};let result;
      switch(command.action){
        case 'journal.install':mayHaveWritten=true;result=await installSourceWriterAdmission({db,expected:journal});break;
        case 'journal.read':result=await readSourceWriterAdmission({db,expected:journal});break;
        case 'journal.receipt':result=await readSourceWriterControlReceipt({db,expected:journal,kind:command.receiptKind,operationId:command.operationId,expiresAt:command.expiresAt,generation:command.generation,drainId:cutoverId});break;
        case 'database.plan':await readSourceWriterAdmission({db,expected:journal});result=await planD1WriteFence(db);break;
        case 'database.install':await readSourceWriterAdmission({db,expected:journal});mayHaveWritten=true;result=await installD1WriteFence({db,...expected});break;
        case 'database.read':result=await readD1WriteFenceInstallation({db,expected});break;
        case 'database.receipt':result=await readD1WriteFenceControlReceipt({db,expected,kind:command.receiptKind,operationId:command.operationId,expiresAt:command.expiresAt,generation:command.generation,freezeId:cutoverId});break;
        case 'journal.drain':{
          if(!admissionEnabled)throw failure();
          const database=await readD1WriteFenceInstallation({db,expected});
          if(database.phase!=='open')throw failure();mayHaveWritten=true;result=await beginSourceWriterDrain({db,expected:journal,operationId:cutoverId,expiresAt:command.expiresAt});break;
        }
        case 'journal.observe':result=await observeSourceWriterDrain({db,expected:journal,operationId:cutoverId});break;
        case 'database.freeze':{
          if(!admissionEnabled)throw failure();
          const held=await observeSourceWriterDrain({db,expected:journal,operationId:cutoverId});
          if(held.status!=='idle'||held.activeWriters!==0||held.unknownWriters!==0||held.expiresAt!==command.expiresAt)throw failure();
          mayHaveWritten=true;result=await freezeD1Writes({db,expected,operationId:cutoverId,expiresAt:command.expiresAt});break;
        }
        case 'database.observe':result=await readD1WriteFence({db,expected,operationId:cutoverId});break;
        case 'database.release':mayHaveWritten=true;result=await releaseD1Writes({db,expected,freezeId:cutoverId,releaseId:dbReleaseId,generation:command.generation});break;
        case 'journal.release':{
          const database=await readD1WriteFenceInstallation({db,expected});
          if(database.phase!=='open')throw failure();mayHaveWritten=true;result=await releaseSourceWriterDrain({db,expected:journal,drainId:cutoverId,releaseId:journalReleaseId,generation:command.generation});break;
        }
        default:throw failure();
      }
      request.signal.throwIfAborted();
      const text=JSON.stringify({version:1,kind:'dawar-original-source-control-result',sourceId:build,action:command.action,operationId:command.operationId,result,
        componentScopeOnly:true,requestAdmissionEnabled:admissionEnabled,fullProductionWriterFreezeEstablished:false,nativeActivationAuthorized:false});
      if(encoder.encode(text).length>16*1024)throw failure();return new Response(text,{headers:{...headers,'Content-Type':'application/json'}});
    }catch{
      const unknown=mayHaveWritten&&command&&writes.has(command.action);
      return Response.json({error:'Original source control was not confirmed. Retain the original operation; do not blindly retry.',
        ...(unknown?{operationId:command.operationId,outcome:'unknown'}:{outcome:'not-started'})},{status:authenticated?503:403,headers});
    }
  }};
}
