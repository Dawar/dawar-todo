import {migrationIdentityResponse} from './migration-identity';
import {createOriginalSourceControl} from '../portable/source-control.mjs';

type Environment={DB:D1Database;BOTS_OWNER_EMAIL?:string;BOTS_OWNER_USER_ID?:string;MIGRATION_SOURCE_WRITER_ADMISSION?:string;MIGRATION_SOURCE_CONTROL?:string};
const headers={'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
export async function applicationMigrationControlResponse(request:Request,environment:Environment,build:string){
  if(!environment.MIGRATION_SOURCE_CONTROL)return Response.json({error:'Original source control is not enabled.'},{status:404,headers});
  try{
    if(new TextEncoder().encode(environment.MIGRATION_SOURCE_CONTROL).length>16*1024)throw Error('Original control configuration differs.');
    const configuration=JSON.parse(environment.MIGRATION_SOURCE_CONTROL);
    if(environment.MIGRATION_SOURCE_WRITER_ADMISSION){
      const journal=JSON.parse(environment.MIGRATION_SOURCE_WRITER_ADMISSION);
      if(!journal||Object.keys(journal).length!==3||Object.keys(journal).some(k=>!['sourceId','installationId','producerSHA256'].includes(k))||
          journal.sourceId!==build||journal.installationId!==configuration.journal?.installationId||journal.producerSHA256!==configuration.journal?.producerSHA256)throw Error('Original admission source differs.');
    }
    const endpoint=createOriginalSourceControl({db:environment.DB,configuration,build,admissionEnabled:Boolean(environment.MIGRATION_SOURCE_WRITER_ADMISSION),authorizeOwner:async (r:Request)=>{
      const response=migrationIdentityResponse(new Request(r.url,{method:'GET',headers:r.headers}),environment);
      if(response.status!==200)throw Error('Existing signed-in owner required.');
    }});
    return await endpoint.fetch(request);
  }catch{return Response.json({error:'Original source control or owner binding is unavailable.'},{status:503,headers});}
}
