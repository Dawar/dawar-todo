import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { installDefinitions } from './services.mjs';
const args=process.argv.slice(2),command=args.shift(),option=n=>args[args.indexOf('--'+n)+1];
const configPath=option('config'),c=loadConfig(configPath);
if(command==='pair'){
 const {pairAgent}=await import('./enrollment-client.mjs');
 console.log(JSON.stringify(await pairAgent(c,option('token-file'))));
}else if(command==='install'){
 console.log(JSON.stringify({definitions:await installDefinitions({mode:'agent',releaseDirectory:fileURLToPath(new URL('..',import.meta.url)),configPath}),started:false}));
}else if(command==='run'){
 const {runAgent}=await import('../bot-bridge/portable-agent.mjs');await runAgent(c);
}else throw Error('Use pair, install or run with --config PRIVATE_PATH.');
