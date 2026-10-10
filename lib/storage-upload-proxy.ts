import {createStorageUploadProxy} from '../portable/storage-upload-proxy.mjs';
import type {S3Environment} from './s3-storage';
import {sourceInstallationBinding} from '../portable/source-installation-lineage.mjs';
declare const __DAWAR_BUILD__:string;
export function originalStorageUploadProxy(env:S3Environment){
  if(!env.MIGRATION_STORAGE_UPLOAD_PROXY)return null;
  const failure=()=>Error('The original storage upload admission is unavailable. Retain the original attachment.');
  if(new TextEncoder().encode(env.MIGRATION_SOURCE_WRITER_ADMISSION??'').length>4096)throw failure();
  const config=JSON.parse(env.MIGRATION_STORAGE_UPLOAD_PROXY),admission=sourceInstallationBinding({expected:JSON.parse(env.MIGRATION_SOURCE_WRITER_ADMISSION??'null'),build:__DAWAR_BUILD__,lineage:env.MIGRATION_SOURCE_INSTALLATION_LINEAGE});
  if(!config||Object.keys(config).length!==2||Object.keys(config).some(k=>!['sourceId','publicOrigin'].includes(k))||
      admission.sourceId!==config.sourceId)throw failure();
  const endpoint=new URL(/^https?:\/\//i.test(env.S3_ENDPOINT_URL)?env.S3_ENDPOINT_URL:`https://${env.S3_ENDPOINT_URL}`);
  if(endpoint.hostname.startsWith(env.S3_BUCKET+'.'))endpoint.hostname=endpoint.hostname.slice(env.S3_BUCKET.length+1);
  return createStorageUploadProxy({sourceId:config.sourceId,publicOrigin:config.publicOrigin,
    providerOrigin:new URL(`https://${env.S3_BUCKET}.${endpoint.hostname}/`).origin,secret:env.S3_ACCESS_KEY});
}
