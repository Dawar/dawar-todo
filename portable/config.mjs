import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

export function loadConfig(path = process.env.DAWAR_HUB_CONFIG) {
  if (!path || !isAbsolute(path)) throw Error('DAWAR_HUB_CONFIG must name a private absolute configuration file.');
  const s = statSync(path);
  if (!s.isFile() || s.mode & 0o077 || process.getuid && s.uid !== process.getuid()) throw Error('Configuration must be owner-only.');
  if (s.size > 128 * 1024) throw Error('Configuration exceeds its bound.');
  const c = JSON.parse(readFileSync(path, 'utf8'));
  if (c.version !== 1 || !['hub','agent','both'].includes(c.mode) || !isAbsolute(c.dataDirectory)) throw Error('Invalid portable configuration.');
  c.dataDirectory = resolve(c.dataDirectory);
  if (c.mode !== 'agent') {
    const u = new URL(c.publicOrigin);
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw Error('A fixed HTTPS public origin is required.');
    for (const port of [c.gatewayPort ?? 3210,c.sitePort ?? 3211]) if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid loopback port.');
    if (c.gatewayPort === c.sitePort) throw Error('Gateway and site ports must differ.');
    if (!c.owner?.key || !c.owner?.userId || !Array.isArray(c.identityBindings)) throw Error('Explicit original owner mapping is required.');
    if(typeof c.gatewaySecret!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(c.gatewaySecret))throw Error('A private random gateway secret is required.');
    for (const b of c.identityBindings) if (!/^[0-9]{1,128}$/.test(b.sub) || b.owner !== c.owner.key || b.userId !== c.owner.userId) throw Error('Unapproved OIDC owner mapping.');
  }
  return c;
}
