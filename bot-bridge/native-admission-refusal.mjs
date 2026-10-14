// Only an in-process refusal BEFORE Codex.call allocates/writes its RPC can
// carry this evidence. A JSON-RPC error or supplied property is insufficient.
const notStarted=new WeakSet();
export function nativeAdmissionRefusal(message){
  const error=Object.assign(Error(message),{definite:true,outcome:'not-sent'});
  notStarted.add(error);return error;
}
export const nativeAdmissionNotStarted=error=>notStarted.has(error);
