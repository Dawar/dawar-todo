import {sealApplicationSnapshot,unsealApplicationSnapshot} from './snapshot-sealing.mjs';

// Existing application bindings only. Native credentials, private migration
// capabilities and arbitrary caller-selected environment names never transfer.
export const RUNTIME_CONFIGURATION_KEYS=Object.freeze([
  'BOTS_MACHINE_ID','BOTS_NOTIFICATION_SECRET','BOTS_OWNER_EMAIL','BOTS_OWNER_USER_ID',
  'BOTS_RELAY_URL','BOTS_STORAGE_CATALOG_READY','BOTS_STORAGE_ENABLED',
  'BOTS_STORAGE_SERVICE_SECRET','BOTS_TICKET_SECRET','JINA_AI_READER',
  'OPENAI_API_KEY','OPENAI_ASSISTANT_MODEL','OPENAI_PROJECT_ID','OPENAI_REALTIME_MODEL',
  'OPENAI_REALTIME_VOICE','S3_ACCESS_KEY','S3_ACCESS_KEY_ID','S3_BUCKET','S3_CDN_URL',
  'S3_ENDPOINT_URL','SERPER_API_KEY','TODO_MAINTENANCE_SECRET','TODO_PROFILE_PHONE_KEY',
  'TODO_PUBLIC_URL','TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_MEDIA_STREAM_URL',
  'TWILIO_PHONE_NUMBER','TWILIO_PHONE_TRANSPORT','VAPID_PRIVATE_KEY','VAPID_PUBLIC_KEY','VAPID_SUBJECT',
]);
const failure=()=>Error('Original runtime configuration was not confirmed.');
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k)))throw failure();};
function identity(v){
  exact(v,['sourceOrigin','sourceId','readId','ownerKey','ownerUserId']);
  const u=new URL(v.sourceOrigin);
  if(u.protocol!=='https:'||u.origin!==v.sourceOrigin||u.username||u.password||!/^[a-f0-9]{12}$/.test(v.sourceId)||
    ['readId','ownerKey','ownerUserId'].some(k=>typeof v[k]!=='string'||!v[k]||new TextEncoder().encode(v[k]).length>1024||v[k].includes('\0')))throw failure();
  return {...v};
}
function configuration(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!RUNTIME_CONFIGURATION_KEYS.includes(k)))throw failure();
  const result={};let size=0;
  for(const name of RUNTIME_CONFIGURATION_KEYS){
    if(!Object.hasOwn(value,name))continue;const text=value[name];
    if(typeof text!=='string'||text.includes('\0')||new TextEncoder().encode(text).length>8192)throw failure();
    size+=new TextEncoder().encode(text).length;if(size>65536)throw failure();result[name]=text;
  }
  return result;
}
export async function sealRuntimeConfiguration({environment,recipientPublicKey,binding}){
  binding=identity(binding);const values={};
  for(const name of RUNTIME_CONFIGURATION_KEYS){const v=environment[name];if(v!==undefined)values[name]=v;}
  const payload={version:1,kind:'dawar-runtime-configuration',...binding,capturedAt:Date.now(),environment:configuration(values)};
  // Reuse the existing reviewed ECDH/AES-GCM envelope, without claiming any
  // application database capture or writer-freeze evidence.
  const envelope=await sealApplicationSnapshot(JSON.stringify(payload),recipientPublicKey,binding.sourceOrigin);
  return {version:1,kind:'dawar-runtime-configuration-sealed',sourceId:binding.sourceId,readId:binding.readId,envelope};
}
export async function unsealRuntimeConfiguration({sealed,recipient,expected}){
  expected=identity(expected);exact(sealed,['version','kind','sourceId','readId','envelope']);
  if(sealed.version!==1||sealed.kind!=='dawar-runtime-configuration-sealed'||sealed.sourceId!==expected.sourceId||sealed.readId!==expected.readId)throw failure();
  const raw=await unsealApplicationSnapshot(sealed.envelope,recipient,expected.sourceOrigin),p=JSON.parse(raw.snapshot);
  exact(p,['version','kind',...Object.keys(expected),'capturedAt','environment']);
  if(p.version!==1||p.kind!=='dawar-runtime-configuration'||Object.keys(expected).some(k=>p[k]!==expected[k])||
      !Number.isSafeInteger(p.capturedAt)||p.capturedAt<1)throw failure();
  return {environment:configuration(p.environment),capturedAt:p.capturedAt,contentSHA256:raw.sha256,sourceAuthenticationEstablished:false};
}
