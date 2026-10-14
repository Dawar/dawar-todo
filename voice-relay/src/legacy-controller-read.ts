import type {VoiceBinding} from './migration-ledger.mjs';

type Environment={VOICE_LEGACY_CONTROLLER_READ?:string;SIP_CONTROLLERS?:DurableObjectNamespace};
type Controller={callSid:string;providerCallId:string};
const failure=()=>Error('Original SIP controller observation is unavailable.');
function exact(value:unknown,keys:string[]){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw failure();
}

// Deployment configuration fixes the original controllers. The authenticated
// control request cannot select another controller or expose call credentials.
export async function readLegacySipControllers(environment:Environment,expected:VoiceBinding){
  if(typeof environment.VOICE_LEGACY_CONTROLLER_READ!=='string'||!environment.SIP_CONTROLLERS||
    new TextEncoder().encode(environment.VOICE_LEGACY_CONTROLLER_READ).length>16*1024)throw failure();
  const config=JSON.parse(environment.VOICE_LEGACY_CONTROLLER_READ) as VoiceBinding & {version:number;controllers:Controller[]};
  exact(config,['version','sourceId','installationId','producerSHA256','controllers']);
  if(config.version!==1||Object.entries(expected).some(([k,v])=>config[k as keyof VoiceBinding]!==v)||
    !Array.isArray(config.controllers)||config.controllers.length<1||config.controllers.length>32)throw failure();
  const configured=config.controllers.map(value=>{
    exact(value,['callSid','providerCallId']);
    if(!/^CA[a-f0-9]{32}$/i.test(value.callSid)||!/^rtc_[A-Za-z0-9_-]{8,200}$/.test(value.providerCallId))throw failure();
    return {...value};
  });
  if(new Set(configured.map(v=>v.callSid)).size!==configured.length||new Set(configured.map(v=>v.providerCallId)).size!==configured.length)throw failure();
  const rows=[];
  // Bound two concurrent actual controller reads; each returns only metadata.
  for(let offset=0;offset<configured.length;offset+=2){
    const page=await Promise.all(configured.slice(offset,offset+2).map(async c=>{
      const stub=environment.SIP_CONTROLLERS!.get(environment.SIP_CONTROLLERS!.idFromName(c.providerCallId));
      const response=await stub.fetch('https://sip-controller/migration/status',{method:'GET',signal:AbortSignal.timeout(4000)});
      if(response.status!==200)throw failure();
      const raw=await response.text();if(new TextEncoder().encode(raw).length>4096)throw failure();
      const v=JSON.parse(raw) as {callSid:string|null;providerCallId:string|null;ended:boolean|null;connected:boolean;connecting:boolean;alarmPending:boolean;observedAt:number;fullEffectSettlementEstablished:boolean};
      exact(v,['callSid','providerCallId','ended','connected','connecting','alarmPending','observedAt','fullEffectSettlementEstablished']);
      if(v.callSid!==c.callSid||v.providerCallId!==c.providerCallId||typeof v.ended!=='boolean'||
        [v.connected,v.connecting,v.alarmPending].some(x=>typeof x!=='boolean')||
        !Number.isSafeInteger(v.observedAt)||Math.abs(Date.now()-v.observedAt)>5000||v.fullEffectSettlementEstablished!==false)throw failure();
      return {...c,ended:v.ended,connected:v.connected,connecting:v.connecting,alarmPending:v.alarmPending,observedAt:v.observedAt};
    }));rows.push(...page);
  }
  return {version:1,kind:'dawar-original-sip-controller-read',...expected,rows,
    recordedControllersInactive:rows.every(v=>v.ended&&!v.connected&&!v.connecting&&!v.alarmPending),
    fullEffectSettlementEstablished:false,legacyMediaSocketCoverageEstablished:false,fullWriterFreezeEstablished:false};
}
