const encoder=new TextEncoder();
const failure=()=>Error('The original installation and current deployed source were not confirmed.');
function exact(value,fields){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==fields.length||Object.keys(value).some(k=>!fields.includes(k)))throw failure();
}
function binding(value){
  exact(value,['sourceId','installationId','producerSHA256']);
  if(typeof value.sourceId!=='string'||!/^[a-f0-9]{12}$/.test(value.sourceId)||
      typeof value.installationId!=='string'||!value.installationId||value.installationId.includes('\0')||encoder.encode(value.installationId).length>1024||
      typeof value.producerSHA256!=='string'||!/^[a-f0-9]{64}$/.test(value.producerSHA256))throw failure();
  return {sourceId:value.sourceId,installationId:value.installationId,producerSHA256:value.producerSHA256};
}

// A reviewed deployment can retain an already installed journal and its exact
// original receipts. The environment is deployment-owned; no request supplies
// this link. The compiled current build must match explicitly, so an old link
// never authorizes the next deployment or changes any installation record.
export function sourceInstallationBinding({expected,build,lineage}){
  const original=binding(expected);
  if(typeof build!=='string'||!/^[a-f0-9]{12}$/.test(build))throw failure();
  if(lineage===undefined){if(original.sourceId!==build)throw failure();return original;}
  if(typeof lineage!=='string'||!lineage||encoder.encode(lineage).length>4096)throw failure();
  const c=JSON.parse(lineage);exact(c,['version','kind','original','deployedBuild']);
  const captured=binding(c.original);
  if(c.version!==1||c.kind!=='dawar-original-installation-lineage'||c.deployedBuild!==build||
      Object.keys(original).some(k=>captured[k]!==original[k]))throw failure();
  return original;
}
