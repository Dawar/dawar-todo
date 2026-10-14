import {id,fingerprint} from './protocol.mjs';

// Captured by the assigned agent from actual native observation, never model
// parameters. Include terminal ordering even when no hub command started it.
export const foregroundSource=a=>({id:a.id,botId:a.botId,threadId:a.threadId,
  generation:a.generation,activeTurnId:a.activeTurnId??null,unresolved:a.unresolved===true});
export function validateForeground(source,botId,threadId,turnId=null){
  if(!source||source.id!==botId||source.botId!==botId||source.threadId!==threadId||
      !id(threadId)||!Number.isSafeInteger(source.generation)||source.generation<0||
      typeof source.unresolved!=='boolean'||source.activeTurnId!==null&&!id(source.activeTurnId)||
      turnId&&(source.activeTurnId!==turnId||source.unresolved))throw Error('Captured foreground activity is unavailable or outside its original turn.');
  if(fingerprint(source)!==fingerprint(foregroundSource(source)))throw Error('Foreground proof cannot carry additional authority.');
  return source;
}
