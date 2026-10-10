import {migrationIdentityResponse} from './migration-identity';
import {createOriginalSourceControl} from '../portable/source-control.mjs';
import {sourceInstallationBinding} from '../portable/source-installation-lineage.mjs';

type Environment={DB:D1Database;BOTS_OWNER_EMAIL?:string;BOTS_OWNER_USER_ID?:string;MIGRATION_SOURCE_WRITER_ADMISSION?:string;MIGRATION_SOURCE_CONTROL?:string;MIGRATION_SOURCE_INSTALLATION_LINEAGE?:string;MIGRATION_APPLICATION_READ?:string};
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
export async function applicationMigrationControlResponse(request:Request,environment:Environment,build:string){
  if(!environment.MIGRATION_SOURCE_CONTROL)return Response.json({error:'Original source control is not enabled.'},{status:404,headers});
  try{
    if(new TextEncoder().encode(environment.MIGRATION_SOURCE_CONTROL).length>16*1024)throw Error('Original control configuration differs.');
    const configuration=JSON.parse(environment.MIGRATION_SOURCE_CONTROL);
    const original=sourceInstallationBinding({expected:{sourceId:configuration.sourceId,installationId:configuration.journal?.installationId,producerSHA256:configuration.journal?.producerSHA256},build,lineage:environment.MIGRATION_SOURCE_INSTALLATION_LINEAGE});
    if(environment.MIGRATION_SOURCE_WRITER_ADMISSION){
      if(new TextEncoder().encode(environment.MIGRATION_SOURCE_WRITER_ADMISSION).length>4096)throw Error('Original admission configuration differs.');
      const journal=sourceInstallationBinding({expected:JSON.parse(environment.MIGRATION_SOURCE_WRITER_ADMISSION),build,lineage:environment.MIGRATION_SOURCE_INSTALLATION_LINEAGE});
      if(journal.sourceId!==original.sourceId||journal.installationId!==original.installationId||journal.producerSHA256!==original.producerSHA256)throw Error('Original admission source differs.');
    }
    let databaseCopy=null;
    if(environment.MIGRATION_APPLICATION_READ){
      if(new TextEncoder().encode(environment.MIGRATION_APPLICATION_READ).length>16384)throw Error('Database reader configuration differs.');
      const reader=JSON.parse(environment.MIGRATION_APPLICATION_READ);
      if(reader.kind==='dawar-original-database-reader'){
        if(reader.version!==1||reader.recentTailLossAccepted!==true||reader.sourceId!==original.sourceId||reader.freeze?.sourceId!==original.sourceId||
          reader.freeze?.operationId!==configuration.cutoverId||reader.freeze?.database?.installId!==configuration.database.installId)throw Error('Database-only staging differs.');
        databaseCopy={sourceId:reader.sourceId,operationId:reader.freeze.operationId,schemaSHA256:reader.freeze.database.schemaSHA256,recentTailLossAccepted:true};
      }
    }
    const endpoint=createOriginalSourceControl({db:environment.DB,configuration,build:original.sourceId,admissionEnabled:Boolean(environment.MIGRATION_SOURCE_WRITER_ADMISSION),databaseCopy,authorizeOwner:async (r:Request)=>{
      const response=migrationIdentityResponse(new Request(r.url,{method:'GET',headers:r.headers}),environment);
      if(response.status!==200)throw Error('Existing signed-in owner required.');
    }});
    const response=await endpoint.fetch(request);
    response.headers.set('X-Dawar-Migration-Deployed-Build',build);
    return response;
  }catch{return Response.json({error:'Original source control or owner binding is unavailable.'},{status:503,headers});}
}
