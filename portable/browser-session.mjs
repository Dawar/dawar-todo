import {createHash} from 'node:crypto';

const DAY=86400000, IDLE=30*DAY, ABSOLUTE=90*DAY, REFRESH=DAY;
const SESSION='__Host-dawar-session', CSRF='__Host-dawar-csrf';
const digest=value=>createHash('sha256').update(value).digest('hex');
const token=request=>(request.headers.get('cookie')??'').split(';').map(v=>v.trim()).find(v=>v.startsWith(SESSION+'='))?.slice(SESSION.length+1);
const authCookies=(value,csrf,seconds)=>[`${SESSION}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`,`${CSRF}=${csrf}; Path=/; Secure; SameSite=Strict; Max-Age=${seconds}`];
const headers={'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'};

// Shared application/control writer, not an OIDC token renewal or a new login.
// Only a proved existing human browser session can extend its own expiry.
export function createBrowserSession(config,writer,{clock=Date.now}={}) {
  const db=writer.db;
  const actor=request=>{
    if(request.headers.has('authorization')||request.headers.get('x-dawar-internal-browser-proof')!=='verified'||request.headers.get('oai-authenticated-user-email')!==config.owner.key||request.headers.get('oai-authenticated-user-id')!==config.owner.userId)throw Object.assign(Error('Browser session proof required.'),{status:403});
    const raw=token(request);
    if(!raw||!/^[A-Za-z0-9_-]{43}$/.test(raw))throw Object.assign(Error('Browser session required.'),{status:401});
    // A storage failure proves nothing about the cookie: answer unavailable
    // (503), never a sign-in prompt. Only a completed lookup can expire it.
    let row;try{row=db.prepare('SELECT * FROM portable_sessions WHERE hash=? AND expires_at>?').get(digest(raw),clock());}
    catch{throw Object.assign(Error('Browser session storage unavailable.'),{status:503});}
    if(!row||row.owner!==config.owner.key||row.user_id!==config.owner.userId||!/^[A-Za-z0-9_-]{43}$/.test(row.csrf))throw Object.assign(Error('Browser session expired.'),{status:401});
    return {raw,row};
  };
  return {read(request){
    let original;try{original=actor(request);}catch(error){const status=error.status??503;return Response.json({error:status===401?'Sign in required.':'Browser session check unavailable.',code:status===401?'AUTHENTICATION_REQUIRED':'SESSION_UNAVAILABLE'},{status,headers});}
    if(request.method!=='GET'||new URL(request.url).search)return Response.json({error:'Invalid session request.'},{status:400,headers});
    try {
      const now=clock(),result=writer.runSync(()=>{
        const fresh=actor(request);
        if(fresh.row.hash!==original.row.hash||fresh.row.csrf!==original.row.csrf)throw Error('Session changed.');
        db.exec('CREATE TABLE IF NOT EXISTS portable_browser_lifetimes(session_hash TEXT PRIMARY KEY,created_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,refreshed_at INTEGER NOT NULL)');
        // Adoption only while the original credential is still valid. Never
        // resurrect an expired, revoked, foreign or absent cookie/session.
        let life=db.prepare('SELECT * FROM portable_browser_lifetimes WHERE session_hash=?').get(fresh.row.hash);
        if(!life){
          db.prepare('DELETE FROM portable_browser_lifetimes WHERE session_hash IN (SELECT session_hash FROM portable_browser_lifetimes WHERE absolute_expires_at<=? OR NOT EXISTS(SELECT 1 FROM portable_sessions WHERE hash=session_hash) LIMIT 64)').run(now);
          if(db.prepare('SELECT count(*) n FROM portable_browser_lifetimes').get().n>=4096)throw Error('Session metadata capacity reached.');
          life={created_at:now,absolute_expires_at:now+ABSOLUTE,refreshed_at:0};db.prepare('INSERT INTO portable_browser_lifetimes VALUES(?,?,?,?)').run(fresh.row.hash,life.created_at,life.absolute_expires_at,0);
        }
        if(!Number.isSafeInteger(life.absolute_expires_at)||life.absolute_expires_at<=now||life.created_at>now) return null;
        let expiresAt=Math.min(fresh.row.expires_at,life.absolute_expires_at);
        if(life.refreshed_at+REFRESH<=now||expiresAt-now<DAY){
          expiresAt=Math.min(now+IDLE,life.absolute_expires_at);
          const updated=db.prepare('UPDATE portable_sessions SET expires_at=? WHERE hash=? AND owner=? AND user_id=? AND expires_at>?').run(expiresAt,fresh.row.hash,fresh.row.owner,fresh.row.user_id,now);
          if(updated.changes!==1)throw Error('Original session changed.');
          db.prepare('UPDATE portable_browser_lifetimes SET refreshed_at=? WHERE session_hash=?').run(now,fresh.row.hash);
        }
        return {owner:fresh.row.owner,userId:fresh.row.user_id,csrf:fresh.row.csrf,expiresAt,absoluteExpiresAt:life.absolute_expires_at,cookies:authCookies(fresh.raw,fresh.row.csrf,Math.max(1,Math.floor((expiresAt-now)/1000)))};
      });
      if(!result)return Response.json({error:'Sign in required.',code:'AUTHENTICATION_REQUIRED'},{status:401,headers});
      const {cookies,...body}=result,response=Response.json(body,{headers});for(const value of cookies)response.headers.append('Set-Cookie',value);return response;
    }catch{return Response.json({error:'Session check unavailable. Connect and try again.',code:'SESSION_UNAVAILABLE'},{status:503,headers});}
  }};
}
