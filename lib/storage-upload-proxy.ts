import {createStorageUploadProxy} from '../portable/storage-upload-proxy.mjs';
import type {S3Environment} from './s3-storage';
declare const __DAWAR_BUILD__:string;
export function originalStorageUploadProxy(env:S3Environment){
  if(!env.MIGRATION_STORAGE_UPLOAD_PROXY)return null;
  const failure=()=>Error('The original storage upload admission is unavailable. Retain the original attachment.');
  const config=JSON.parse(env.MIGRATION_STORAGE_UPLOAD_PROXY),admission=JSON.parse(env.MIGRATION_SOURCE_WRITER_ADMISSION??'null');
  if(!config||Object.keys(config).length!==2||Object.keys(config).some(k=>!['sourceId','publicOrigin'].includes(k))||
      typeof __DAWAR_BUILD__!=='string'||!/^[a-f0-9]{12}$/.test(__DAWAR_BUILD__)||config.sourceId!==__DAWAR_BUILD__||
      !admission||Object.keys(admission).length!==3||admission.sourceId!==config.sourceId||
      typeof admission.installationId!=='string'||!admission.installationId||!/^[a-f0-9]{64}$/.test(admission.producerSHA256))throw failure();
  const endpoint=new URL(/^https?:\/\//i.test(env.S3_ENDPOINT_URL)?env.S3_ENDPOINT_URL:`https://${env.S3_ENDPOINT_URL}`);
  if(endpoint.hostname.startsWith(env.S3_BUCKET+'.'))endpoint.hostname=endpoint.hostname.slice(env.S3_BUCKET.length+1);
  return createStorageUploadProxy({sourceId:config.sourceId,publicOrigin:config.publicOrigin,
    providerOrigin:new URL(`https://${env.S3_BUCKET}.${endpoint.hostname}/`).origin,secret:env.S3_ACCESS_KEY});
}
