import { readFileSync,writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createHash,generateKeyPairSync,createPublicKey } from 'node:crypto';
import { readPrivate,savePrivate } from '../private-file.mjs';
import { stageResources,readBundle } from './bundle.mjs';
import { signRelease,verifyRelease,validateRelease,RELEASE_KIND } from '../mac-releases.mjs';

// Owner/build-host tooling for Agent.app releases (not shipped in the app).
// Signing reads the private release key from a 0600 file; it is never an
// argument, environment variable or hub setting.
export function releaseRecord({resources,archive,edSignature,minimumMacOS='13.0',hubProtocols=[1],hubRuntimes,publishedAt=new Date().toISOString()}) {
  const {release,bundleManifestSHA256}=readBundle(resources),bytes=readFileSync(archive),name=archive.split('/').pop();
  return validateRelease({kind:RELEASE_KIND,version:1,appVersion:release.appVersion,build:release.build,agentSource:release.agentSource,protocol:release.protocol,
    runtime:release.runtime,nodeVersion:release.nodeVersion,platform:'darwin',arch:release.arch,minimumMacOS,bundleManifestSHA256,publishedAt,
    archive:{name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),edSignature},
    hub:{protocols:hubProtocols,runtimes:hubRuntimes??[release.runtime]}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [command,...args]=process.argv.slice(2),option=n=>{const i=args.indexOf('--'+n);return i<0?undefined:args[i+1];};
  const out=value=>process.stdout.write(JSON.stringify(value,null,2)+'\n');
  if(command==='stage')out(stageResources({agentDownload:option('agent-download'),nodeModules:option('node-modules'),nodeTarball:option('node-tarball'),
    out:option('out'),appVersion:option('app-version'),build:Number(option('build')),arch:option('arch')??'arm64'}));
  else if(command==='record')out(releaseRecord({resources:option('resources'),archive:option('archive'),edSignature:option('ed-signature'),minimumMacOS:option('minimum-macos')}));
  else if(command==='sign')out(signRelease(readPrivate(option('key'),8192),JSON.parse(readFileSync(option('record'),'utf8'))));
  else if(command==='verify')out(verifyRelease(readFileSync(option('public-key'),'utf8'),JSON.parse(readFileSync(option('envelope'),'utf8'))));
  else if(command==='keygen'){
    const {privateKey}=generateKeyPairSync('ed25519');
    savePrivate(option('private'),privateKey.export({format:'pem',type:'pkcs8'}).toString(),{exclusive:true});
    writeFileSync(option('public'),createPublicKey(privateKey).export({format:'pem',type:'spki'}).toString(),{flag:'wx'});
    out({private:option('private'),public:option('public')});
  }else{console.error('Use stage, record, sign, verify or keygen.');process.exitCode=2;}
}
