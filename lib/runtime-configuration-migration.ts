import {migrationIdentityResponse} from './migration-identity';
import {sealRuntimeConfiguration} from '../portable/runtime-configuration.mjs';
import {sourceInstallationBinding} from '../portable/source-installation-lineage.mjs';

const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const fail=()=>Error('Original owner configuration read unavailable.');
function exact(v:unknown,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw fail();}
export async function runtimeConfigurationMigrationResponse(request:Request,environment:unknown,build:string){
  const env=environment as Record<string,unknown>;
  if(!env.MIGRATION_RUNTIME_CONFIGURATION_READ)return Response.json({error:'Original configuration transfer is not enabled.'},{status:404,headers});
  try{
    const u=new URL(request.url);
    if(request.method!=='GET'||u.pathname!=='/api/migration/configuration/read'||u.search||u.hash||request.body||request.headers.has('Authorization')||
      request.headers.get('Origin')!==null&&request.headers.get('Origin')!==u.origin||request.headers.get('Sec-Fetch-Site')==='cross-site')throw fail();
    const raw=env.MIGRATION_RUNTIME_CONFIGURATION_READ,control=env.MIGRATION_SOURCE_CONTROL;
    if(typeof raw!=='string'||new TextEncoder().encode(raw).length>4096||typeof control!=='string'||new TextEncoder().encode(control).length>16384)throw fail();
    const c=JSON.parse(raw) as {version:number;kind:string;sourceId:string;sourceOrigin:string;readId:string;recipientPublicKey:string};
    exact(c,['version','kind','sourceId','sourceOrigin','readId','recipientPublicKey']);
    const original=JSON.parse(control);
    sourceInstallationBinding({expected:{sourceId:original.sourceId,installationId:original.journal?.installationId,producerSHA256:original.journal?.producerSHA256},build,lineage:env.MIGRATION_SOURCE_INSTALLATION_LINEAGE as string|undefined});
    if(c.version!==1||c.kind!=='dawar-runtime-configuration-read'||c.sourceId!==build||c.sourceOrigin!==u.origin||original.sourceOrigin!==u.origin||
      typeof original.credential!=='string'||!/^[-_A-Za-z0-9]{32,512}$/.test(original.credential))throw fail();
    const supplied=request.headers.get('X-Dawar-Migration-Control');
    if(!supplied||supplied.length>512)throw fail();
    const digests=await Promise.all([supplied,original.credential].map(s=>crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))));
    const a=new Uint8Array(digests[0]),b=new Uint8Array(digests[1]);let mismatch=0;for(let i=0;i<a.length;i++)mismatch|=a[i]^b[i];if(mismatch)throw fail();
    const getOwner=async()=>{
      const result=migrationIdentityResponse(new Request(request.url,{method:'GET',headers:request.headers}),env);
      if(result.status!==200)throw fail();return await result.json() as {ownerKey:string;ownerUserId:string;sourceOrigin:string};
    };
    const owner=await getOwner();request.signal.throwIfAborted();
    const result=await sealRuntimeConfiguration({environment:env,recipientPublicKey:c.recipientPublicKey,
      binding:{sourceOrigin:c.sourceOrigin,sourceId:build,readId:c.readId,ownerKey:owner.ownerKey,ownerUserId:owner.ownerUserId}});
    request.signal.throwIfAborted();const after=await getOwner();if(after.ownerKey!==owner.ownerKey||after.ownerUserId!==owner.ownerUserId)throw fail();
    return Response.json(result,{headers});
  }catch{return Response.json({error:'Original owner configuration transfer was not confirmed.'},{status:403,headers});}
}
