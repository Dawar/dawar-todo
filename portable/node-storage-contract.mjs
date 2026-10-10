const actions=new Set(['registerBot','prepare','finalize','download','preview','taskQueueExport']);
const metadataKeys=['id','botId','name','size','mimeType','sha256','artifact','source','createdAt','parentId','provenance'];
export function artifactInput(action,input){
  if(!actions.has(action)||!input||Array.isArray(input))throw Error('This assigned artifact action is unavailable.');
  if(action==='prepare')return Object.fromEntries(metadataKeys.filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
  return Object.fromEntries((action==='taskQueueExport'?['botId','taskExportId']:['botId','id']).filter(k=>input[k]!==undefined).map(k=>[k,input[k]]));
}

