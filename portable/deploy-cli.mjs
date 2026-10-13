import { isAbsolute } from 'node:path';
import { readPrivate } from './private-file.mjs';
import { runDeployment } from './deployment-transaction.mjs';
import { linuxDeployment } from './deployment-linux.mjs';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--plan'||!isAbsolute(args[1]))throw Error('Use deploy-cli.mjs --plan PRIVATE_ABSOLUTE_PLAN.');
process.umask(0o077);
const spec=JSON.parse(readPrivate(args[1]));
try{
  const receipt=await runDeployment(spec,linuxDeployment(spec));
  console.log(JSON.stringify({operationId:receipt.operationId,source:receipt.source,phase:receipt.phase,outcome:receipt.outcome}));
  if(receipt.outcome!=='healthy')process.exitCode=1;
}catch{console.error('Deployment stopped. Inspect its original private transaction receipt; no ambiguous lifecycle effect is retried.');process.exitCode=1;}
