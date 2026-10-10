// Captured original inherited settings, separate from new-bot preferences and
// each bot's explicit settings. Missing metadata keeps normal runtime defaults.
export function capturedRuntimeDefaults(value){
  if(!value||Object.keys(value).length!==3||Object.keys(value).some(k=>!['model','effort','serviceTier'].includes(k))||
      typeof value.model!=='string'||!value.model||value.model.length>120||!['minimal','low','medium','high','xhigh','max','ultra'].includes(value.effort)||
      value.serviceTier!==null&&value.serviceTier!=='priority')throw Error('The original inherited runtime settings were not confirmed.');
  return {model:value.model,effort:value.effort,serviceTier:value.serviceTier};
}
