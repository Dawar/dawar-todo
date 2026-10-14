import {migrationIdentityResponse} from './migration-identity';
import {createApplicationFreezeController,type CompleteFreezeBinding,type ExternalWriterScope} from '../portable/application-freeze-controller.mjs';
import {createD1ApplicationReadSource} from '../portable/application-read-source.mjs';
import {createApplicationReadEndpoint} from '../portable/application-read-transport.mjs';
import {createExternalWriterObserver} from '../portable/external-writer-read.mjs';
import {sourceInstallationBinding} from '../portable/source-installation-lineage.mjs';
import {readD1WriteFence} from '../portable/d1-write-fence.mjs';

type Environment={DB:D1Database;BOTS_OWNER_EMAIL?:string;BOTS_OWNER_USER_ID?:string;MIGRATION_SOURCE_WRITER_ADMISSION?:string;MIGRATION_APPLICATION_READ?:string;MIGRATION_SOURCE_INSTALLATION_LINEAGE?:string};
type Configuration={version:1;kind:'dawar-original-application-reader';sourceId:string;captureId:string;recipientPublicKey:string;freeze:CompleteFreezeBinding;
  producers:Array<{scope:ExternalWriterScope;endpoint:string;publicKey:string;credential:string}>};
type DatabaseConfiguration=Omit<Configuration,'kind'|'producers'|'freeze'> & {kind:'dawar-original-database-reader';recentTailLossAccepted:true;freeze:Omit<CompleteFreezeBinding,'journal'|'external'>};
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
    const c=JSON.parse(raw) as Configuration|DatabaseConfiguration;
    const databaseOnly=c.kind==='dawar-original-database-reader';
    exact(c,['version','kind','sourceId','captureId','recipientPublicKey','freeze',...(databaseOnly?['recentTailLossAccepted']:['producers'])]);
    if(new TextEncoder().encode(environment.MIGRATION_SOURCE_WRITER_ADMISSION??'').length>4096)throw Error('Original admission configuration differs.');
    const journal=sourceInstallationBinding({expected:JSON.parse(environment.MIGRATION_SOURCE_WRITER_ADMISSION??'null'),build,lineage:environment.MIGRATION_SOURCE_INSTALLATION_LINEAGE});
    if(c.version!==1||(!databaseOnly&&c.kind!=='dawar-original-application-reader')||c.sourceId!==journal.sourceId||c.freeze?.sourceId!==journal.sourceId||
        typeof c.captureId!=='string'||!c.captureId||c.captureId.length>1024||typeof c.recipientPublicKey!=='string'||
        !Number.isSafeInteger(c.freeze.epoch)||c.freeze.epoch<1||!Number.isSafeInteger(c.freeze.expiresAt))throw Error('Original binding differs.');
    if(databaseOnly){
      if(c.recentTailLossAccepted!==true)throw Error('Recent-tail acceptance required.');
      exact(c.freeze,['sourceId','operationId','epoch','expiresAt','database']);
      exact(c.freeze.database,['installId','schemaSHA256','guardSHA256','operationId','generation']);
      if(c.freeze.database.operationId!==c.freeze.operationId||c.freeze.database.generation!==c.freeze.epoch)throw Error('Database binding differs.');
      let actualExpiry:number|undefined;
      const verifyFreeze=async()=>{
        const proof=await readD1WriteFence({db:environment.DB,expected:{sourceId:c.sourceId,installId:c.freeze.database.installId,schemaSHA256:c.freeze.database.schemaSHA256},operationId:c.freeze.operationId});
        if(proof.guardSHA256!==c.freeze.database.guardSHA256||proof.generation!==c.freeze.epoch||
            c.freeze.expiresAt!==0&&proof.expiresAt!==c.freeze.expiresAt||actualExpiry!==undefined&&proof.expiresAt!==actualExpiry)throw Error('Database fence changed.');
        actualExpiry??=proof.expiresAt;
        return proof;
      };
      // Zero in private deployment configuration means capture the deadline
      // from the real original freeze receipt; never from browser input.
      const original=await verifyFreeze();
      const freeze={sourceId:c.sourceId,operationId:c.freeze.operationId,epoch:c.freeze.epoch,generation:c.freeze.epoch,expiresAt:original.expiresAt,scope:'d1-database-writes'};
      const source=createD1ApplicationReadSource({db:environment.DB,expectedFreeze:freeze,verifyFreeze,signal:request.signal});
      endpoint=createApplicationReadEndpoint({capture:{sourceOrigin:new URL(request.url).origin,captureId:c.captureId,freeze},recipientPublicKey:c.recipientPublicKey,
        expectedOwner:identity,authorizeOwner:(r:Request)=>owner(r,environment),read:(command:unknown)=>source.read(command),verifyFreeze,signal:request.signal});
      return await endpoint.fetch(request);
    }
    if(journal.installationId!==c.freeze.journal.installationId||journal.producerSHA256!==c.freeze.journal.producerSHA256||
        !Array.isArray(c.producers)||c.producers.length!==scopes.length||new Set(c.producers.map(p=>p.scope)).size!==scopes.length)throw Error('Original writer authority differs.');
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
