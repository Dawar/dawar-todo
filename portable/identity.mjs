import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { digest, secret } from './protocol.mjs';
import { boundedJSON } from './bounded-json.mjs';

const COOKIE = '__Host-dawar-session', LOGIN_COOKIE = '__Host-dawar-login', CSRF_COOKIE='__Host-dawar-csrf';
export const csrfCookie = (value,maxAge=12*3600) => `${CSRF_COOKIE}=${value}; Path=/; Secure; SameSite=Strict; Max-Age=${maxAge}`;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com','accounts.google.com']);
export function identityProvider(config) {
  if (config.auth0) {
    const u=new URL(config.auth0.issuer);
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||!config.auth0.clientId)throw Error('A fixed Auth0 issuer and client ID are required.');
    return {kind:'auth0',clientId:config.auth0.clientId,clientSecret:config.auth0.clientSecret,issuer:u.href,
      issuers:new Set([u.href]),authorize:new URL('authorize',u).href,token:new URL('oauth/token',u).href,keys:new URL('.well-known/jwks.json',u).href};
  }
  return {kind:'google',clientId:config.google?.clientId,clientSecret:config.google?.clientSecret,issuer:'https://accounts.google.com',
    issuers:GOOGLE_ISSUERS,authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',keys:'https://www.googleapis.com/oauth2/v3/certs'};
}
const same = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const cookies = header => Object.fromEntries((header ?? '').split(';').map(v => v.trim().split(/=(.*)/s).slice(0,2)));
const cookie = (name,value,maxAge) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const returnPath = value => typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value) ? value : '/bots';

export class OIDCIdentity {
  constructor(store, config, fetcher = fetch) { this.store = store; this.config = config; this.fetch = fetcher; this.provider=identityProvider(config); this.keys = null; this.keysAt = 0; }
  login(returnTo, now = Date.now()) {
    if (!this.provider.clientId || !this.provider.clientSecret) throw Error('Confidential OIDC application is not configured.');
    const state = secret(), nonce = secret(), verifier = secret();
    this.store.db.prepare('DELETE FROM portable_login WHERE expires_at<=?').run(now);
    this.store.db.prepare('INSERT INTO portable_login VALUES(?,?,?,?,?)').run(digest(state),nonce,verifier,returnPath(returnTo),now+300000);
    const u = new URL(this.provider.authorize);
    u.search = new URLSearchParams({ client_id:this.provider.clientId,redirect_uri:`${this.config.publicOrigin}/auth/callback`,
      response_type:'code',scope:'openid email',state,nonce,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256' }).toString();
    return { location:u.toString(),cookie:cookie(LOGIN_COOKIE,state,300) };
  }
  async validateToken(token, nonce, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 16*1024) throw Error('Invalid identity token.');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw Error('Invalid identity token.');
    const header = JSON.parse(Buffer.from(parts[0],'base64url').toString()), claims = JSON.parse(Buffer.from(parts[1],'base64url').toString());
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.kid.length > 200 || header.crit) throw Error('Unsupported identity signature.');
    if (!this.keys || this.keysAt+3600000 < now || !this.keys.some(k => k.kid === header.kid)) {
      const r = await this.fetch(this.provider.keys,{ redirect:'error',signal:AbortSignal.timeout(10000) });
      if (!r.ok || Number(r.headers.get('content-length') ?? 0) > 128*1024) throw Error('Identity verification unavailable.');
      const data = await boundedJSON(r); if (!Array.isArray(data.keys) || data.keys.length>20) throw Error('Invalid identity keys.');
      this.keys = data.keys; this.keysAt = now;
    }
    const jwk = this.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256'));
    if (!jwk || !verify('RSA-SHA256',Buffer.from(`${parts[0]}.${parts[1]}`),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(parts[2],'base64url'))) throw Error('Invalid identity signature.');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!this.provider.issuers.has(claims.iss) || !aud.includes(this.provider.clientId)
      || aud.length > 1 && claims.azp !== this.provider.clientId
      || !Number.isFinite(claims.exp) || claims.exp*1000 <= now || !Number.isFinite(claims.iat) || claims.iat*1000 > now+60000
      || !same(claims.nonce,nonce) || typeof claims.sub!=='string' || !/^[A-Za-z0-9_.|@:-]{1,256}$/.test(claims.sub) || this.provider.kind==='google'&&!/^[0-9]{1,128}$/.test(claims.sub)) throw Error('Identity claims invalid.');
    // Email/display name never creates or migrates an owner implicitly.
    // Stable subject is additionally bound to the configured exact issuer.
    const b = this.config.identityBindings.find(b => b.sub === claims.sub && (b.issuer ?? (this.provider.kind==='google'?'https://accounts.google.com':null)) === this.provider.issuer);
    if (!b) throw Error('OIDC subject is not explicitly enrolled for this owner.');
    return {owner:b.owner,userId:b.userId};
  }
  async callback(request, now = Date.now()) {
    const u = new URL(request.url), state = u.searchParams.get('state'), code = u.searchParams.get('code');
    if (!same(state,cookies(request.headers.get('cookie'))[LOGIN_COOKIE]) || !code || code.length>4096) throw Error('Login state invalid.');
    const row = this.store.transaction(() => {
      const r = this.store.db.prepare('SELECT * FROM portable_login WHERE state_hash=?').get(digest(state));
      if (!r || r.expires_at<=now) throw Error('Login expired.');
      this.store.db.prepare('DELETE FROM portable_login WHERE state_hash=?').run(digest(state)); return r;
    });
    const response = await this.fetch(this.provider.token,{ method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:this.provider.clientId,client_secret:this.provider.clientSecret,
        redirect_uri:`${this.config.publicOrigin}/auth/callback`,grant_type:'authorization_code',code_verifier:row.verifier}) });
    if (!response.ok) { await response.body?.cancel(); throw Error('OIDC login failed.'); }
    const body=await boundedJSON(response,64*1024);
    const identity = await this.validateToken(body.id_token,row.nonce,now);
    const session = secret(), csrf = secret();
    this.store.db.prepare('DELETE FROM portable_sessions WHERE expires_at<=?').run(now);
    this.store.db.prepare('INSERT INTO portable_sessions VALUES(?,?,?,?,?)').run(digest(session),identity.owner,identity.userId,csrf,now+12*3600000);
    return { location:row.return_to,cookies:[cookie(COOKIE,session,12*3600),cookie(LOGIN_COOKIE,'',0),csrfCookie(csrf)] };
  }
  session(request, now = Date.now()) {
    const token = cookies(request.headers.get('cookie'))[COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const s = this.store.db.prepare('SELECT * FROM portable_sessions WHERE hash=? AND expires_at>?').get(digest(token),now);
    return s ? {owner:s.owner,userId:s.user_id,csrf:s.csrf} : null;
  }
  csrf(request, session) {
    if (request.headers.get('origin') !== this.config.publicOrigin || !same(request.headers.get('x-dawar-csrf'),session.csrf)) throw Error('Request origin or CSRF token invalid.');
  }
  logout(request) {
    const token = cookies(request.headers.get('cookie'))[COOKIE];
    if (token) this.store.db.prepare('DELETE FROM portable_sessions WHERE hash=?').run(digest(token));
    return [cookie(COOKIE,'',0),csrfCookie('',0)];
  }
}

// Compatibility export for existing exact Google observation records.
export const GoogleIdentity=OIDCIdentity;

export function stripIdentity(headers) {
  for (const name of [...headers.keys()]) if (/^(?:oai-authenticated-|x-dawar-internal-|x-dawar-gateway-|cf-access-|x-forwarded-)/i.test(name)) headers.delete(name);
}
