import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

export class ResticRepository {
  constructor({repository,passwordFile,accessKeyId,secretAccessKey,region='us-east-1',dedicated=false},fixtures=false) {
    if(!dedicated||typeof repository!=='string'||!isAbsolute(passwordFile))throw Error('Explicit dedicated backup repository and separate private password file required.');
    if(!fixtures){const u=new URL(repository.replace(/^s3:/,''));if(!repository.startsWith('s3:https://')||u.username||u.password||u.search||u.hash||u.pathname==='/')throw Error('Use a dedicated HTTPS S3 backup destination.');}
    this.passwordFile=passwordFile;
    this.environment={...process.env,RESTIC_REPOSITORY:repository,RESTIC_PASSWORD_FILE:passwordFile,AWS_DEFAULT_REGION:region};
    delete this.environment.RESTIC_PASSWORD;delete this.environment.RESTIC_PASSWORD_COMMAND;
    if(accessKeyId)this.environment.AWS_ACCESS_KEY_ID=accessKeyId;if(secretAccessKey)this.environment.AWS_SECRET_ACCESS_KEY=secretAccessKey;
  }
  async run(args) {
    const s=await stat(this.passwordFile);if(!s.isFile()||s.mode&0o077||process.getuid&&s.uid!==process.getuid())throw Error('Recovery password file must be private.');
    return new Promise((resolve,reject)=>{
      const child=spawn('restic',['--json',...args],{env:this.environment,stdio:['ignore','pipe','pipe']});let output='',bytes=0;
      const deadline=setTimeout(()=>child.kill('SIGTERM'),30*60*1000);
      child.stdout.on('data',c=>{bytes+=c.length;if(bytes>4*1024*1024)child.kill('SIGTERM');else output+=c;});
      // Restic errors may mention private repository information. Only an exit
      // category leaves this boundary; no raw diagnostic enters normal chat.
      child.stderr.on('data',()=>{});child.on('error',()=>{clearTimeout(deadline);reject(Error('Restic is unavailable.'));});
      child.on('exit',code=>{clearTimeout(deadline);if(code!==0)return reject(Error(`Encrypted backup operation failed (exit ${code}).`));
        try{resolve(output.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)));}catch{reject(Error('Backup receipt was not valid JSON.'));}});
    });
  }
  initialize(){return this.run(['init']);}
  save(path){return this.run(['backup','--tag','dawar-hub','--host','dawar-hub',path]);}
  retain(){return this.run(['forget','--tag','dawar-hub','--group-by','host,tags','--keep-daily','7','--keep-weekly','4']);}
  check(){return this.run(['check','--read-data']);}
  restore(snapshot,target){if(!/^[a-f0-9]{8,64}$/.test(snapshot)||!isAbsolute(target))throw Error('Exact snapshot and isolated restore target required.');return this.run(['restore',snapshot,'--target',target]);}
}

export async function captureHubSnapshot({application,control,artifacts,configurationManifest,withWriteFreeze,destination}) {
  if(typeof withWriteFreeze!=='function')throw Error('The authoritative writers must supply a bounded write freeze.');
  const path=join(destination,`snapshot-${randomUUID()}`);await mkdir(path,{recursive:true,mode:0o700});
  await withWriteFreeze(async(signal)=>{
    signal?.throwIfAborted();
    const options={progress:()=>signal?.throwIfAborted()};
    await backup(application.sqlite,join(path,'application.sqlite'),options);
    signal?.throwIfAborted();
    await backup(control.db,join(path,'control.sqlite'),options);
    for(const name of ['application.sqlite','control.sqlite'])await chmod(join(path,name),0o600);
    const files=await artifacts.snapshot(join(path,'registered-files'),signal);
    // No credentials or executable service units are part of a restore image.
    const configuration=Object.fromEntries(['source','protocol','runtime','publicOrigin','nodeIds','ownerIds'].filter(k=>Object.hasOwn(configurationManifest,k)).map(k=>[k,configurationManifest[k]]));
    const manifest={version:1,automaticExecutionDisabled:true,createdAt:new Date().toISOString(),configuration,
      registeredFiles:files.map(f=>({id:f.id,owner:f.owner,botId:f.bot_id,hash:f.hash,size:f.size})),databases:{}};
    for(const name of ['application.sqlite','control.sqlite']){
      const file=await hashFile(join(path,name),signal);manifest.databases[name]={sha256:file.hash,bytes:file.size};
    }
    signal?.throwIfAborted();await writeFile(join(path,'restore-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
    await writeFile(join(path,'AUTOMATIC_EXECUTION_DISABLED'),'Restore inspection only. No scheduler, agent, model or provider work may start.\n',{mode:0o600});
  });
  return path;
}

export async function inspectRestore(path) {
  const m=JSON.parse(await readFile(join(path,'restore-manifest.json'),'utf8'));
  if(m.version!==1||m.automaticExecutionDisabled!==true||!(await readdir(path)).includes('AUTOMATIC_EXECUTION_DISABLED'))throw Error('Restore is not isolated from automatic execution.');
  for(const name of ['application.sqlite','control.sqlite']){
    const file=await hashFile(join(path,name));if(file.hash!==m.databases[name]?.sha256||file.size!==m.databases[name]?.bytes)throw Error('Restored database differs.');
    const db=new DatabaseSync(join(path,name),{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Restored SQLite integrity failed.');}finally{db.close();}
  }
  for(const f of m.registeredFiles){if(!/^[a-f0-9]{64}$/.test(f.hash))throw Error('Invalid registered recovery file.');
    const file=await hashFile(join(path,'registered-files',f.hash));if(file.size!==f.size||file.hash!==f.hash)throw Error('Restored file differs.');}
  return {verified:true,databases:2,registeredFiles:m.registeredFiles.length,automaticExecutionDisabled:true};
}
async function hashFile(path,signal){const sha=createHash('sha256');let size=0;for await(const chunk of createReadStream(path,{signal})){size+=chunk.length;sha.update(chunk);}return {size,hash:sha.digest('hex')};}
