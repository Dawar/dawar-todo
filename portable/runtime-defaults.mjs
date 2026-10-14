// Captured original inherited settings, separate from new-bot preferences and
// each bot's explicit settings. Missing metadata keeps normal runtime defaults.
export function capturedRuntimeDefaults(value){
  if(!value||Object.keys(value).length!==3||Object.keys(value).some(k=>!['model','effort','serviceTier'].includes(k))||
      typeof value.model!=='string'||!value.model||value.model.length>120||!['minimal','low','medium','high','xhigh','max','ultra'].includes(value.effort)||
      value.serviceTier!==null&&value.serviceTier!=='priority')throw Error('The original inherited runtime settings were not confirmed.');
  return {model:value.model,effort:value.effort,serviceTier:value.serviceTier};
}

export function storedRuntimeDefaults(store){
  // Store.meta returns null both for an absent row and stored JSON null.
  // Only absence may retain normal defaults; malformed captured data refuses.
  const row=store.db.prepare('SELECT json FROM meta WHERE key=?').get('portable-defaults');
  return row===undefined?undefined:capturedRuntimeDefaults(JSON.parse(row.json));
}
