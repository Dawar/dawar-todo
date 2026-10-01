/** One-time registered-file backfill. Does not launch Codex, schedules or workers. */
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { createHash,randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { open,rename,unlink,readFile } from 'node:fs/promises';
import { Store } from './store.mjs';
import { BotRuntime } from './runtime.mjs';
import { BotStorageClient,localFileDigest } from './storage.mjs';

const argumentsSet=new Set(process.argv.slice(2));
if ([...argumentsSet].some(argument=>!['--apply','--verify-cloud'].includes(argument))) throw new Error('Use --apply to backfill, --verify-cloud to check every registered cloud copy, or no arguments for a read-only inventory.');
const apply=argumentsSet.has('--apply'),verify=argumentsSet.has('--verify-cloud');
const directory=process.env.BOTS_STATE_DIR ?? join(homedir(),'.local/share/dawar-todo-bots');
const db=new DatabaseSync(join(directory,'state.sqlite'),{readOnly:true});
const bots=new Map(db.prepare('SELECT json FROM bots').all().map(row=>{const bot=JSON.parse(row.json);return [bot.id,bot];}));
const files=db.prepare("SELECT json FROM records WHERE kind='attachment' AND json_extract(json,'$.ready')=1 ORDER BY rowid").all().map(row=>JSON.parse(row.json));
db.close();
const checkpointPath=join(directory,'storage-migration-checkpoint.json');
const previous=await readFile(checkpointPath,'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT') return {};throw new Error('Migration checkpoint cannot be read. Original checkpoint retained.');});
const inventory=new Map((previous.inventory??previous.results??[]).filter(entry=>entry.sha256).map(entry=>[entry.id,{id:entry.id,botId:entry.botId,size:entry.size,sha256:entry.sha256}]));
async function saveCheckpoint(value) {
  const temporary=join(directory,`.storage-checkpoint-${randomUUID()}`);let file;
  try {
    file=await open(temporary,'wx',0o600);await file.writeFile(JSON.stringify(value,null,2));await file.sync();await file.close();file=null;
    await rename(temporary,checkpointPath);
    const folder=await open(directory,'r');try {await folder.sync();}finally {await folder.close();}
  } finally {await file?.close();await unlink(temporary).catch(()=>{});}
}
let runtime,store;
if (apply || verify) {
  if (!process.env.BOTS_STORAGE_SERVICE_SECRET || !process.env.BOTS_SITE_URL) throw new Error('Load the private bridge environment; storage service credential and site URL are required.');
  store=new Store(join(directory,'state.sqlite'));
  runtime=new BotRuntime({store,codex:new EventEmitter(),root:process.env.BOTS_ROOT ?? join(homedir(),'bots')});
  runtime.storage=new BotStorageClient(runtime,{url:process.env.BOTS_SITE_URL,credential:process.env.BOTS_STORAGE_SERVICE_SECRET,machineId:process.env.BOTS_MACHINE_ID ?? 'dawar-vm'});
  await runtime.storage.registerBots();
}
const results=[];let bytes=0;
try {
  for (const snapshot of files) {
    const entry={id:snapshot.id,botId:snapshot.botId,size:snapshot.size,artifact:Boolean(snapshot.artifact),status:'pending'};
    try {
      const bot=bots.get(snapshot.botId);if (!bot) throw new Error('Registered bot identity is missing.');
      const localSha256=await localFileDigest(bot,snapshot.path,snapshot.size);
      const baseline=inventory.get(snapshot.id);
      if(baseline && (baseline.botId!==snapshot.botId || baseline.size!==snapshot.size || baseline.sha256!==localSha256)) throw new Error('Registered file changed since the retained migration inventory.');
      if (snapshot.sha256 && snapshot.sha256!==localSha256) throw new Error('Registered checksum changed.');
      entry.sha256=localSha256;entry.status='local-verified';bytes+=snapshot.size;
      inventory.set(snapshot.id,{id:snapshot.id,botId:snapshot.botId,size:snapshot.size,sha256:localSha256});
      if (apply) {
        // Stable original attachment ID is the cloud operation identity.
        const current=store.get('attachment',snapshot.id);
        if (!current || !current.ready || current.botId!==snapshot.botId || current.path!==snapshot.path || current.size!==snapshot.size) throw new Error('Registration changed since inventory.');
        await runtime.storage.publish(bot,current);entry.status='cloud-confirmed';
      }
      if (apply || verify) {
        const receipt=await runtime.storage.call('download',{id:snapshot.id,botId:snapshot.botId});
        if (receipt.attachment.size!==snapshot.size || receipt.attachment.sha256!==localSha256) throw new Error('Cloud receipt differs from registered local file.');
        const response=await fetch(receipt.url,{signal:AbortSignal.timeout(120000),redirect:'error'});
        if (!response.ok || !response.body) throw new Error('Cloud verification download unavailable.');
        const reader=response.body.getReader(),hash=createHash('sha256');let size=0;
        try {for (;;) {const chunk=await reader.read();if(chunk.done) break;size+=chunk.value.length;if(size>snapshot.size) throw new Error('Cloud verification size mismatch.');hash.update(chunk.value);}}
        finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
        if(size!==snapshot.size || hash.digest('hex')!==localSha256) throw new Error('Cloud verification checksum mismatch.');
        entry.status='cloud-verified';
      }
    } catch(error) {entry.status='failed';entry.error=error.code ? `Local file verification failed (${error.code}).` : String(error.message);process.exitCode=1;}
    results.push(entry);
    // No filenames, local paths, signed URLs or credentials in terminal logs.
    console.log(JSON.stringify(entry));
    await saveCheckpoint({at:new Date().toISOString(),mode:apply?'apply':verify?'verify':'inventory',registered:files.length,registeredBytes:files.reduce((n,a)=>n+a.size,0),inventory:[...inventory.values()],results});
  }
  if(runtime) {await runtime.storage.previewTail;await Promise.allSettled([...runtime.locks.values()]);}
  console.log(JSON.stringify({registered:files.length,verifiedBytes:bytes,failed:results.filter(entry=>entry.status==='failed').length,mode:apply?'apply':verify?'verify':'inventory'}));
} finally {store?.close();}
