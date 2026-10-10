import {fingerprint} from './protocol.mjs';
import {roomQuestionSource} from './control-protocol.mjs';

// A stdio response write is not a new turn/client ACK or exactly-once external
// effect. This receipt only binds the original durable local write outcome.
export function roomAnswerReceipt(command,result){
  const p=JSON.parse(command.payload).params,q=p.question;
  if(result?.state!=='written'||result.confirmation!=='native-stdio-write'||result.operationId!==command.operation_id||result.key!==q.key||result.contextId!==q.contextId||result.agentEpoch!==p.agentEpoch||result.threadId!==q.threadId||result.turnId!==q.turnId||fingerprint(roomQuestionSource(q))!==p.questionFingerprint)throw Error('Original native response write is unconfirmed.');
  return {operationId:command.operation_id,threadId:q.threadId,turnId:q.turnId,result,evidence:{kind:'original-native-response',operationId:command.operation_id,fingerprint:command.fingerprint,key:q.key,contextId:q.contextId,threadId:q.threadId,turnId:q.turnId,agentEpoch:p.agentEpoch,nativeRequestId:q.request.id,questionFingerprint:p.questionFingerprint,resultFingerprint:fingerprint(p.result)}};
}
