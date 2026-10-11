import {readFileSync,lstatSync,realpathSync,mkdirSync,copyFileSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {readPrivate,savePrivate} from './private-file.mjs';
import {stageControlSnapshot} from './control-snapshot.mjs';
import {HubStore} from './control-store.mjs';
import {Store} from '../bot-bridge/store.mjs';
import {nodeKey,signature,secret,RUNTIME_VERSION,PROTOCOL_VERSION} from './protocol.mjs';
import {verifiedAgentRelease} from './runtime-release.mjs';
import {centralAgentCapabilities} from './agent-capabilities.mjs';

const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const fail=()=>Error('Original portable handover configuration or staging differs; preserve all receipts.');
export function handoverConfiguration(path,expectedSHA256,source) {
  const raw=readPrivate(path,32768);
  if(createHash('sha256').update(raw).digest('hex')!==expectedSHA256)throw fail();
  const c=JSON.parse(raw),fields=['version','kind','source','releaseDirectory','releaseManifestSHA256','baseConfigPath','baseConfigSHA256','stageDirectory',
    'applicationSource','applicationSHA256','fileStageDirectory','fileIndexSHA256','runtimeDefaults','agent'];
  if(c.version!==1||c.kind!=='dawar-portable-central-handover'||c.source!==source||Object.keys(c).length!==fields.length||Object.keys(c).some(k=>!fields.includes(k)))throw fail();
  for(const name of ['releaseDirectory','baseConfigPath','stageDirectory','applicationSource','fileStageDirectory']){
    if(typeof c[name]!=='string'||resolve(c[name])!==c[name])throw fail();
  }
  for(const name of ['releaseManifestSHA256','baseConfigSHA256','applicationSHA256','fileIndexSHA256'])if(!/^[a-f0-9]{64}$/.test(c[name]))throw fail();
  for(const [p,expected]of [[c.baseConfigPath,c.baseConfigSHA256],[c.applicationSource,c.applicationSHA256],[join(c.fileStageDirectory,'artifact-index.sqlite'),c.fileIndexSHA256]]){
    const s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||process.getuid&&s.uid!==process.getuid()||realpathSync(p)!==p||hash(p)!==expected)throw fail();
  }
  const activation={source:c.source,runtime:RUNTIME_VERSION,releaseManifestSHA256:c.releaseManifestSHA256,codexBinarySHA256:c.agent.codexBinarySHA256};
  verifiedAgentRelease({activation,entrypoint:pathToFileURL(join(c.releaseDirectory,'bot-bridge/portable-agent.mjs')),codexBinary:c.agent.codexBinary,runtime:RUNTIME_VERSION});
  return c;
}

// Called exactly once by the original exclusive handoff AFTER its private
// backup. It creates NEW role databases. It never edits the old service data,
// restarts a process, replays input, or acquires another restart claim.
export function prepareHandover({configuration,configurationSHA256,source,backup,backupSHA256}) {
  process.umask(0o077);
  const c=handoverConfiguration(configuration,configurationSHA256,source);
  try{lstatSync(c.stageDirectory);throw fail();}catch(error){if(error.code!=='ENOENT')throw error;}
  const parent=lstatSync(resolve(c.stageDirectory,'..'));
  if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077||process.getuid&&parent.uid!==process.getuid())throw fail();
  mkdirSync(c.stageDirectory,{mode:0o700});
  const hubDirectory=join(c.stageDirectory,'hub'),agentDirectory=join(c.stageDirectory,'agent');
  const staged=stageControlSnapshot({source:backup,expectedSHA256:backupSHA256,hubDirectory,agentDirectory,runtimeDefaults:c.runtimeDefaults});
  copyFileSync(c.applicationSource,join(hubDirectory,'application.sqlite'));
  copyFileSync(join(c.fileStageDirectory,'artifact-index.sqlite'),join(hubDirectory,'artifact-index.sqlite'));
  cpSync(join(c.fileStageDirectory,'registered-files'),join(hubDirectory,'registered-files'),{recursive:true,errorOnExist:true,force:false});
  const base=JSON.parse(readPrivate(c.baseConfigPath)),hub=new HubStore(join(hubDirectory,'control.sqlite'));
  const native=new Store(join(agentDirectory,'native-control.sqlite')),key=nodeKey(join(agentDirectory,'node-key.pem'));
  const hello={protocol:PROTOCOL_VERSION,runtime:RUNTIME_VERSION,platform:process.platform,arch:process.arch,
    capabilities:{text:true,localStdio:true,registeredArtifacts:true,profileReads:true,memoryCompaction:true,pdfPreview:true,
      desktop:c.agent.desktops?.enabled===true,secureTransfer:true,centralBursts:true,voice:false,...centralAgentCapabilities({agent:{centralRouting:true}}),autonomousGoals:false}};
  let enrollment;const writerId=`migration:${source}`,epoch=1;
  try{
    // The original human migration authority approves moving the existing
    // central bots to this locally generated key. Still use the same one-use
    // five-minute grant and fresh Ed25519 challenge/proof as remote enrollment.
    const grant=hub.grantEnrollment(base.owner.key,key.fingerprint,Date.now(),'dwight-central-linux-migration-enrollment-v1',secret());
    const challenge=hub.enrollmentChallenge(grant.token,key.publicKey);
    enrollment=hub.enroll(challenge.grantId,hello,signature(key.privateKey,{grantId:challenge.grantId,challenge:challenge.challenge,hello}));
    for(const bot of native.bots({includeDeleted:true})){
      hub.place(base.owner.key,bot.id,enrollment.nodeId);
      if(bot.queuePaused)hub.stop(base.owner.key,bot.id,true);
    }
    hub.db.prepare('INSERT INTO portable_authority(id,writer_id,epoch,frozen) VALUES(1,?,?,0)').run(writerId,epoch);
    hub.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');native.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }finally{hub.close();native.close();}
  // Original D1 copy guards belong to the OLD source. Release their copied
  // local state only in this new database; no original receipt is rewritten.
  const application=new DatabaseSync(join(hubDirectory,'application.sqlite'));
  try{
    if(application.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='__dawar_migration_write_state'").get())
      application.prepare("UPDATE __dawar_migration_write_state SET phase='open',operation_id=NULL,expires_at=0 WHERE singleton=1").run();
    if(application.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw fail();
  }finally{application.close();}
  const hubActivation=join(c.stageDirectory,'hub-activation.json'),agentActivation=join(c.stageDirectory,'agent-activation.json');
  savePrivate(hubActivation,JSON.stringify({kind:'portable-hub-activation',executionEnabled:true,writerId,epoch,source})+'\n',{exclusive:true});
  savePrivate(agentActivation,JSON.stringify({kind:'portable-agent-activation',executionEnabled:true,nodeId:enrollment.nodeId,runtime:RUNTIME_VERSION,
    source,releaseManifestSHA256:c.releaseManifestSHA256,codexBinarySHA256:c.agent.codexBinarySHA256})+'\n',{exclusive:true});
  savePrivate(join(agentDirectory,'node-enrollment.json'),JSON.stringify({nodeId:enrollment.nodeId,owner:enrollment.owner,fingerprint:key.fingerprint,hub:base.publicOrigin})+'\n',{exclusive:true});
  const agentConfig=join(c.stageDirectory,'agent.json'),hubConfig=join(c.stageDirectory,'hub.json');
  savePrivate(agentConfig,JSON.stringify({version:1,mode:'agent',dataDirectory:agentDirectory,agent:{...c.agent,nodeId:enrollment.nodeId,
    centralRouting:true,loopbackHubPort:base.gatewayPort??3210,activationReceipt:agentActivation}},null,2)+'\n',{exclusive:true});
  const env={...base.applicationEnvironment,TWILIO_MEDIA_STREAM_URL:`wss://${new URL(base.publicOrigin).host}/api/voice/stream`,VOICE_RELAY_URL:base.publicOrigin+'/api/voice'};
  savePrivate(hubConfig,JSON.stringify({...base,mode:'both',dataDirectory:hubDirectory,agentConfigFile:agentConfig,healthPort:47821,
    hub:{source,activationReceipt:hubActivation},voice:{enabled:true,scheduleMinute:true},applicationEnvironment:env},null,2)+'\n',{exclusive:true});
  const receipt={version:1,kind:'dawar-portable-handover-prepared',source,configurationSHA256,backupSHA256,staging:staged,
    hubConfig,agentConfig,hubConfigSHA256:hash(hubConfig),agentConfigSHA256:hash(agentConfig),nodeId:enrollment.nodeId,nodeFingerprint:key.fingerprint,
    originalStopPreserved:true,processesStarted:0,preparedAt:new Date().toISOString()};
  savePrivate(join(c.stageDirectory,'handover-prepared.json'),JSON.stringify(receipt,null,2)+'\n',{exclusive:true});
  return {source,nodeId:enrollment.nodeId,hubConfig,hubConfigSHA256:receipt.hubConfigSHA256,agentConfigSHA256:receipt.agentConfigSHA256,
    receipt:join(c.stageDirectory,'handover-prepared.json'),receiptSHA256:hash(join(c.stageDirectory,'handover-prepared.json')),processesStarted:0};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [configuration,configurationSHA256,source,backup,backupSHA256]=process.argv.slice(2);
  console.log(JSON.stringify(prepareHandover({configuration,configurationSHA256,source,backup,backupSHA256})));
}
