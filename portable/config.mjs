import { isAbsolute, resolve } from 'node:path';
import { readPrivate } from './private-file.mjs';
import {centralLoopback} from './central-loopback.mjs';

export function loadConfig(path = process.env.DAWAR_HUB_CONFIG) {
  if (!path || !isAbsolute(path)) throw Error('DAWAR_HUB_CONFIG must name a private absolute configuration file.');
  const c = JSON.parse(readPrivate(path));
  if (c.version !== 1 || !['hub','agent','both'].includes(c.mode) || !isAbsolute(c.dataDirectory)) throw Error('Invalid portable configuration.');
  c.dataDirectory = resolve(c.dataDirectory);
  centralLoopback(c);
  if(c.agent?.centralRouting!==undefined&&typeof c.agent.centralRouting!=='boolean')throw Error('Invalid central routing configuration.');
  if(c.agent?.desktops!==undefined){
    const d=c.agent.desktops;
    if(!d||typeof d.enabled!=='boolean'||Object.keys(d).some(k=>!['enabled','base','launcher','adopt'].includes(k))||
      ['base','launcher'].some(k=>d[k]!==undefined&&(!isAbsolute(d[k])||d[k].includes('\0')))||
      d.adopt!==undefined&&(!d.adopt||Array.isArray(d.adopt)||Object.entries(d.adopt).some(([slug,name])=>
        !/^[A-Za-z0-9_-]{1,180}$/.test(slug)||typeof name!=='string'||!/^[A-Za-z0-9_-]{1,180}$/.test(name))))
      throw Error('Invalid scoped Linux desktop configuration.');
  }
  if (c.mode !== 'agent') {
    const u = new URL(c.publicOrigin);
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw Error('A fixed HTTPS public origin is required.');
    for (const port of [c.gatewayPort ?? 3210,c.sitePort ?? 3211]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid loopback port.');
    if (c.gatewayPort === c.sitePort) throw Error('Gateway and site ports must differ.');
    if (!c.owner?.key || !c.owner?.userId || !Array.isArray(c.identityBindings)) throw Error('Explicit original owner mapping is required.');
    if(typeof c.gatewaySecret!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(c.gatewaySecret))throw Error('A private random gateway secret is required.');
    if(c.voice){
      if(typeof c.voice.enabled!=='boolean'||c.voice.scheduleMinute!==undefined&&typeof c.voice.scheduleMinute!=='boolean'||Object.keys(c.voice).some(k=>!['enabled','scheduleMinute'].includes(k)))throw Error('Invalid portable voice activation configuration.');
      if(c.voice.enabled&&(!c.hub?.activationReceipt||!/^[a-f0-9]{40}$/.test(c.hub.source)))throw Error('Voice hosting requires exact reviewed hub activation.');
      if(c.voice.scheduleMinute&&(!c.voice.enabled||typeof c.applicationEnvironment?.TODO_MAINTENANCE_SECRET!=='string'||!c.applicationEnvironment.TODO_MAINTENANCE_SECRET.trim()))throw Error('Minute scheduling requires explicit voice hosting and its existing maintenance secret.');
    }
    if(c.auth0){
      const issuer=new URL(c.auth0.issuer);
      if(issuer.protocol!=='https:'||issuer.pathname!=='/'||issuer.username||issuer.password||issuer.search||issuer.hash||typeof c.auth0.clientId!=='string'||!c.auth0.clientId)throw Error('Invalid Auth0 application configuration.');
      if(c.auth0.clientSecretFile){
        const secretPath=c.auth0.clientSecretFile;
        if(!isAbsolute(secretPath))throw Error('OIDC client secret file must be absolute.');
        c.auth0.clientSecret=readPrivate(secretPath,4096).trim();
      }
    }
    const issuer=c.auth0?.issuer??'https://accounts.google.com';
    for (const b of c.identityBindings) if (!/^[A-Za-z0-9_.|@:-]{1,256}$/.test(b.sub) || (b.issuer??(c.auth0?null:'https://accounts.google.com'))!==issuer || b.owner !== c.owner.key || b.userId !== c.owner.userId) throw Error('Unapproved OIDC owner mapping.');
  }
  return c;
}
