import {migrationIdentityResponse} from './migration-identity';
import {createApplicationFreezeController,type CompleteFreezeBinding,type ExternalWriterScope} from '../portable/application-freeze-controller.mjs';
import {createD1ApplicationReadSource} from '../portable/application-read-source.mjs';
import {createApplicationReadEndpoint} from '../portable/application-read-transport.mjs';
import {createExternalWriterObserver} from '../portable/external-writer-read.mjs';

type Environment={DB:D1Database;BOTS_OWNER_EMAIL?:string;BOTS_OWNER_USER_ID?:string;MIGRATION_SOURCE_WRITER_ADMISSION?:string;MIGRATION_APPLICATION_READ?:string};
type Configuration={version:1;kind:'dawar-original-application-reader';sourceId:string;captureId:string;recipientPublicKey:string;freeze:CompleteFreezeBinding;
  producers:Array<{scope:ExternalWriterScope;endpoint:string;publicKey:string;credential:string}>};
const scopes:ExternalWriterScope[]=['legacy-worker-lifetimes','voice-provider-effects','issued-storage-uploads','native-control-files'];
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
const failed=()=>Response.json({error:'The original owner or complete production writer freeze is unavailable. Retain the original capture.'},{status:503,headers});
function exact(value:unknown,fields:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(k=>!fields.includes(k)))throw Error('Original reader configuration differs.');
}
async function owner(request:Request,environment:Environment){
  const result=migrationIdentityResponse(new Request(request.url,{method:'GET',headers:request.headers}),environment);
  if(result.status!==200)throw Error('Original owner required.');
  const value=await result.json() as {ownerKey:string;ownerUserId:string};
  return {ownerKey:value.ownerKey,ownerUserId:value.ownerUserId};
}

// Fixed private deployment configuration, not a browser-provided proof, starts
// this read-only route. Installing/holding/releasing the controllers is separate.
export async function applicationMigrationReadResponse(request:Request,environment:Environment,build:string){
  if(!environment.MIGRATION_APPLICATION_READ)return Response.json({error:'Original production capture is not enabled.'},{status:404,headers});
  let controller:ReturnType<typeof createApplicationFreezeController>|undefined;
  let endpoint:ReturnType<typeof createApplicationReadEndpoint>|undefined;
  try{
    const identity=await owner(request,environment);
    const raw=environment.MIGRATION_APPLICATION_READ;
    if(new TextEncoder().encode(raw).length>32*1024||!/^[a-f0-9]{12}$/.test(build))throw Error('Original source differs.');
    const c=JSON.parse(raw) as Configuration;
    exact(c,['version','kind','sourceId','captureId','recipientPublicKey','freeze','producers']);
    const journal=JSON.parse(environment.MIGRATION_SOURCE_WRITER_ADMISSION??'null') as {sourceId:string;installationId:string;producerSHA256:string};
    exact(journal,['sourceId','installationId','producerSHA256']);
    if(c.version!==1||c.kind!=='dawar-original-application-reader'||c.sourceId!==build||c.freeze?.sourceId!==build||
        journal.sourceId!==build||journal.installationId!==c.freeze?.journal.installationId||journal.producerSHA256!==c.freeze?.journal.producerSHA256||
        typeof c.captureId!=='string'||!c.captureId||c.captureId.length>1024||typeof c.recipientPublicKey!=='string'||
        !Array.isArray(c.producers)||c.producers.length!==scopes.length||new Set(c.producers.map(p=>p.scope)).size!==scopes.length)throw Error('Original binding differs.');
    const producers=Object.fromEntries(scopes.map(scope=>{
      const p=c.producers.find(p=>p.scope===scope),binding=c.freeze.external.find(e=>e.scope===scope);
      exact(p,['scope','endpoint','publicKey','credential']);if(!p||!binding)throw Error('Missing original writer authority.');
      return [scope,createExternalWriterObserver({...p,controllerOperationId:c.freeze.operationId,binding})];
    })) as Parameters<typeof createApplicationFreezeController>[0]['externalObservers'];
    controller=createApplicationFreezeController({db:environment.DB,expected:c.freeze,externalObservers:producers,signal:request.signal});
    const held=controller,freeze={sourceId:c.sourceId,operationId:c.freeze.operationId,epoch:c.freeze.epoch,generation:c.freeze.epoch,expiresAt:c.freeze.expiresAt};
    const source=createD1ApplicationReadSource({db:environment.DB,expectedFreeze:freeze,verifyFreeze:()=>held.verify(),signal:request.signal});
    endpoint=createApplicationReadEndpoint({capture:{sourceOrigin:new URL(request.url).origin,captureId:c.captureId,freeze},recipientPublicKey:c.recipientPublicKey,
      expectedOwner:identity,authorizeOwner:(r:Request)=>owner(r,environment),read:(command:unknown)=>source.read(command),verifyFreeze:()=>held.verify(),signal:request.signal});
    return await endpoint.fetch(request);
  }catch{return failed();}
  finally{await endpoint?.stopAndWait();await controller?.stopAndWait();}
}
