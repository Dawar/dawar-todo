import { MacAgentController } from './controller.mjs';

// Entry point for Agent.app: `node cli.mjs <command> --resources DIR [...]`.
// Always prints one JSON object; credentials never appear in arguments.
const args=process.argv.slice(2),command=args.shift(),option=n=>{const i=args.indexOf('--'+n);return i<0?undefined:args[i+1];};
const controller=new MacAgentController({resources:option('resources'),timeZone:option('time-zone')});
const commands={
  install:()=>controller.install(),status:()=>controller.status(),fingerprint:()=>controller.fingerprint(),
  'verify-runtime':()=>controller.verifyRuntime(),pair:()=>controller.pair(option('pairing-file')),
  'enable-execution':()=>controller.enableExecution(),start:()=>controller.start(),stop:()=>controller.stop({force:args.includes('--force')}),
  reconnect:()=>controller.reconnect(),'apply-staged':()=>controller.applyStaged(),'check-health':()=>controller.checkHealth(),
  'check-update':()=>controller.checkUpdate(),'stage-update':()=>controller.stageAppUpdate(),diagnostics:()=>controller.diagnostics(),
};
try{
  if(!commands[command])throw Error(`Unknown command. Use one of: ${Object.keys(commands).join(', ')}.`);
  process.stdout.write(JSON.stringify({ok:true,result:await commands[command]()})+'\n');
}catch(error){
  process.stdout.write(JSON.stringify({ok:false,error:error.message,diagnostics:error.diagnostics??null})+'\n');process.exitCode=1;
}
