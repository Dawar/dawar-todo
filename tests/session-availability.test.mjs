import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createBrowserSession} from '../portable/browser-session.mjs';

const OWNER={key:'owner@example.test',userId:'user-1'};
const raw='a'.repeat(43),csrf='c'.repeat(43);
function setup(){
  const db=new DatabaseSync(':memory:');
  db.exec('CREATE TABLE portable_sessions(hash TEXT PRIMARY KEY,owner TEXT,user_id TEXT,csrf TEXT,expires_at INTEGER)');
  db.prepare('INSERT INTO portable_sessions VALUES(?,?,?,?,?)').run(createHash('sha256').update(raw).digest('hex'),OWNER.key,OWNER.userId,csrf,Date.now()+86400000*5);
  const writer={db,runSync:fn=>fn()};
  return {db,writer,session:createBrowserSession({owner:OWNER},writer)};
}
const request=(cookie=`__Host-dawar-session=${raw}`)=>new Request('https://work.example.test/api/auth/browser-session',{headers:{cookie,'x-dawar-internal-browser-proof':'verified','oai-authenticated-user-email':OWNER.key,'oai-authenticated-user-id':OWNER.userId}});

test('a valid persistent session renews and stays signed in',async()=>{
  const {session}=setup();
  const response=session.read(request());
  assert.equal(response.status,200);
  assert.equal((await response.json()).owner,OWNER.key);
  assert.ok(response.headers.get('set-cookie'));
});

test('missing or expired sessions require sign-in',async()=>{
  const {session,db}=setup();
  assert.equal(session.read(request('')).status,401);
  db.exec('UPDATE portable_sessions SET expires_at=1');
  const expired=session.read(request());
  assert.equal(expired.status,401);
  assert.equal((await expired.json()).code,'AUTHENTICATION_REQUIRED');
});

test('a storage outage during the session check is not a sign-out',async()=>{
  const {session,db}=setup();
  const prepare=db.prepare.bind(db);
  db.prepare=sql=>{if(/portable_sessions/.test(sql))throw Object.assign(Error('database is locked'),{code:'ERR_SQLITE_ERROR',errcode:5});return prepare(sql);};
  const response=session.read(request());
  assert.equal(response.status,503,'connectivity/storage failure is distinct from session expiry');
  assert.equal((await response.json()).code,'SESSION_UNAVAILABLE');
});
