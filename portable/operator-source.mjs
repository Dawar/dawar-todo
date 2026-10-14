import {fingerprint,id} from './protocol.mjs';

export const OPERATOR_READS=new Set(['operator.find','operator.context','operator.read','operator.cards','operator.segment']);
export const OPERATOR_MUTATIONS=new Set(['operator.open','operator.select','operator.submit','operator.stop','operator.answer','operator.cancel','operator.transcript','operator.end']);
export const OPERATOR_NATIVE=Symbol('original-operator-native-action');
export const OPERATOR_NODE_READS=new Set(['portable.operatorContext','portable.operatorStatus','portable.operatorQuestion']);
export const operatorSource=r=>({id:r.id,callId:r.callId,segmentId:r.segmentId,botId:r.botId,threadId:r.threadId,text:r.text,nativeMethod:r.nativeMethod,nativeParams:r.nativeParams,nativeOperationId:r.nativeOperationId,createdAt:r.createdAt});
export function validateOperatorSource(r,botId,threadId,nativeId=null){
  if(!r||!id(r.id)||!id(r.callId)||!id(r.segmentId)||r.botId!==botId||r.threadId!==threadId||r.nativeOperationId!==`${r.id}:native`||nativeId&&r.nativeOperationId!==nativeId||
    !['turn.send','queue.add','queue.delete','turn.interrupt','requests.respond'].includes(r.nativeMethod)||typeof r.text!=='string'||r.text.length>16000||!Number.isFinite(Date.parse(r.createdAt))||!r.nativeParams||typeof r.nativeParams!=='object'||Array.isArray(r.nativeParams)||Buffer.byteLength(JSON.stringify(r.nativeParams))>96*1024)throw Error('Original Operator request is outside its captured call, bot or native identity.');
  return fingerprint(operatorSource(r));
}
export function operatorCapable(hub,connections,placement){
  const node=hub.node(placement.node_id),hello=JSON.parse(node.hello),ws=connections.get(placement.node_id);
  return hello.platform==='linux'&&ws?.readyState===1&&ws.portableHello?.capabilities?.centralOperator===true;
}
