import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';
import {fingerprint} from './protocol.mjs';
import {OPERATOR_READS,OPERATOR_MUTATIONS} from './operator-source.mjs';
const content=(at,body)=>JSON.stringify({purpose:'portable-operator-v1',path:'/internal/operator',at,hash:fingerprint(body)});
export function signOperator(secret,body,at=Date.now()){
  return {at:String(at),proof:createHmac('sha256',secret).update(content(at,body)).digest('hex')};
}
export function verifyOperator(secret,body,headers,now=Date.now()){
  const at=Number(headers.get('x-dawar-operator-at')),proof=headers.get('x-dawar-operator-proof');
  if(!Number.isSafeInteger(at)||Math.abs(now-at)>5000||!/^[a-f0-9]{64}$/.test(proof??''))return false;
  return timingSafeEqual(Buffer.from(proof,'hex'),createHmac('sha256',secret).update(content(at,body)).digest());
}
// Application-only fixed loopback transport. No token, owner or URL is
// selected by model input; no redirect or ambiguous write retry is allowed.
export function operatorClient(config){
  const url=`http://127.0.0.1:${config.gatewayPort??3210}/internal/operator`;
  return async(owner,method,params,operationId)=>{
    if(owner!==config.owner.key||!OPERATOR_READS.has(method)&&!OPERATOR_MUTATIONS.has(method))throw Error('Invalid application Operator authority.');
    const body={owner,request:{id:`operator-site:${randomUUID()}`,method,params,...(operationId?{operationId}:{})}},encoded=JSON.stringify(body);
    if(Buffer.byteLength(encoded)>128*1024)throw Error('Operator input exceeds its bounded application transport.');
    const proof=signOperator(config.gatewaySecret,JSON.parse(encoded));
    let response;
    try{response=await fetch(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-dawar-operator-at':proof.at,'x-dawar-operator-proof':proof.proof},body:encoded,signal:AbortSignal.timeout(35000)});}
    catch{throw Object.assign(Error('Original Operator application acknowledgement is unconfirmed; retain its original identity.'),{outcome:operationId?'uncertain':'not-sent'});}
    const reader=response.body?.getReader(),parts=[];let size=0;
    try{if(reader)for(;;){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>512*1024)throw Error('Operator read exceeds its bound.');parts.push(Buffer.from(chunk.value));}}
    finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();}
    const result=JSON.parse(Buffer.concat(parts).toString('utf8'));
    if(!response.ok)throw Object.assign(Error(result.error??'Operator request unavailable.'),{outcome:result.outcome??(operationId?'uncertain':'not-sent')});
    return result.result;
  };
}
