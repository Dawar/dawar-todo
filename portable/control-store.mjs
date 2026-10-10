import { privateDatabase } from './sqlite.mjs';
import { boundedFrame, canonical, compatible, digest, fingerprint, id, originalNativeProof,originalLocalControlProof,publicFingerprint, secret, verifySignature } from './protocol.mjs';

const transitions = {
  // A later immutable receipt proves node receipt even when that earlier ACK
  // was lost. It never authorizes the hub to re-execute the command.
  queued: ['received','native-accepted','unknown','terminal'], received: ['native-accepted', 'unknown', 'terminal'],
  'native-accepted': ['running', 'terminal', 'unknown'], running: ['terminal', 'unknown'], terminal: [], unknown: ['native-accepted','terminal'],
};

export class HubStore {
  constructor(path) {
    this.db = privateDatabase(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portable_nodes(id TEXT PRIMARY KEY, owner TEXT NOT NULL, public_key TEXT NOT NULL, fingerprint TEXT NOT NULL UNIQUE, hello TEXT NOT NULL, revoked_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS portable_enrollment(id TEXT PRIMARY KEY, owner TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER, challenge TEXT, public_key TEXT, challenge_at INTEGER);
      CREATE TABLE IF NOT EXISTS portable_placements(bot_id TEXT PRIMARY KEY, owner TEXT NOT NULL, node_id TEXT NOT NULL REFERENCES portable_nodes(id), epoch INTEGER NOT NULL, control_revision INTEGER NOT NULL DEFAULT 1, stopped INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS portable_mailbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, bot_id TEXT NOT NULL, node_id TEXT NOT NULL, epoch INTEGER NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT, receipt_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS portable_mailbox_node ON portable_mailbox(node_id, sequence);
      CREATE TABLE IF NOT EXISTS portable_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL, event_id TEXT NOT NULL, bot_id TEXT NOT NULL, epoch INTEGER NOT NULL, fingerprint TEXT NOT NULL, event TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(node_id,event_id));
      CREATE TABLE IF NOT EXISTS portable_sessions(hash TEXT PRIMARY KEY, owner TEXT NOT NULL, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS portable_login(state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, return_to TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS portable_authority(id INTEGER PRIMARY KEY CHECK(id=1), writer_id TEXT NOT NULL, epoch INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS portable_rpc_cache(owner TEXT NOT NULL,bot_id TEXT NOT NULL,epoch INTEGER NOT NULL,method TEXT NOT NULL,params_hash TEXT NOT NULL,result TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(owner,bot_id,epoch,method,params_hash));
      CREATE TABLE IF NOT EXISTS portable_tickets(jti TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
    `);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  grantEnrollment(owner, approvedFingerprint, now = Date.now(), operationId = null, retryToken = null) {
    if (!owner || !/^[a-f0-9]{64}$/.test(approvedFingerprint)) throw Error('Owner and confirmed node fingerprint required.');
    if(operationId && (!id(operationId)||typeof retryToken!=='string'||retryToken.length>100))throw Error('Invalid enrollment operation.');
    const token = retryToken ?? secret(), grantId = operationId ? `enroll:${operationId}` : `enroll:${secret()}`;
    const old=this.db.prepare('SELECT * FROM portable_enrollment WHERE id=?').get(grantId);
    if(old){
      if(old.owner!==owner||old.fingerprint!==approvedFingerprint||old.token_hash!==digest(token))throw Error('Original enrollment identity changed.');
      if(old.consumed_at)throw Error('Original enrollment was consumed. Refresh the machine list; no new grant was made.');
      if(old.expires_at<=now)throw Error('Original grant expired. Explicitly start a new pairing attempt.');
      return {grantId,token,expiresAt:old.expires_at};
    }
    this.db.prepare('INSERT INTO portable_enrollment(id,owner,token_hash,fingerprint,expires_at) VALUES(?,?,?,?,?)')
      .run(grantId, owner, digest(token), approvedFingerprint, now + 300000);
    return { grantId, token, expiresAt: now + 300000 };
  }
  enrollmentChallenge(token, publicKey, now = Date.now()) {
    if (typeof token !== 'string' || token.length > 100 || typeof publicKey !== 'string' || publicKey.length > 1000) throw Error('Invalid enrollment.');
    return this.transaction(() => {
      const grant = this.db.prepare('SELECT * FROM portable_enrollment WHERE token_hash=?').get(digest(token));
      if (!grant || grant.consumed_at || grant.expires_at <= now || grant.fingerprint !== publicFingerprint(publicKey)) throw Error('Enrollment expired or fingerprint mismatch.');
      const challenge = secret();
      this.db.prepare('UPDATE portable_enrollment SET challenge=?,public_key=?,challenge_at=? WHERE id=?').run(challenge, publicKey, now, grant.id);
      return { grantId: grant.id, challenge, expiresAt: Math.min(grant.expires_at, now + 60000) };
    });
  }
  enrollmentStatus({ token, publicKey, hello, nonce, issuedAt, proof }, now = Date.now()) {
    compatible(hello);
    if (typeof token !== 'string' || token.length > 100 || typeof publicKey !== 'string' || publicKey.length > 1000
      || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !Number.isSafeInteger(issuedAt) || Math.abs(now-issuedAt)>60000
      || !verifySignature(publicKey,{purpose:'enrollment-status',tokenHash:digest(token),publicKey,hello,nonce,issuedAt},proof)) throw Error('Invalid original enrollment status proof.');
    const g=this.db.prepare('SELECT * FROM portable_enrollment WHERE token_hash=?').get(digest(token));
    if (!g || g.fingerprint!==publicFingerprint(publicKey)) throw Error('Original enrollment identity not found.');
    if (!g.consumed_at) return {state:g.expires_at>now?'pending':'expired',grantId:g.id,expiresAt:g.expires_at};
    const n=this.db.prepare('SELECT * FROM portable_nodes WHERE owner=? AND fingerprint=?').get(g.owner,g.fingerprint);
    if (!n || n.public_key!==publicKey || n.hello!==canonical(hello)) throw Error('Consumed enrollment cannot be reconciled to the same node.');
    if (n.revoked_at) throw Error('Original node enrollment was revoked.');
    return {state:'accepted',grantId:g.id,nodeId:n.id,owner:n.owner,fingerprint:n.fingerprint};
  }
  enroll(grantId, hello, proof, now = Date.now()) {
    compatible(hello);
    return this.transaction(() => {
      const g = this.db.prepare('SELECT * FROM portable_enrollment WHERE id=?').get(grantId);
      if (!g || g.consumed_at || g.expires_at <= now || !g.challenge || g.challenge_at + 60000 <= now
        || !verifySignature(g.public_key, { grantId, challenge: g.challenge, hello }, proof)) throw Error('Enrollment proof invalid or expired.');
      const nodeId = `node:${secret()}`;
      this.db.prepare('INSERT INTO portable_nodes(id,owner,public_key,fingerprint,hello,created_at) VALUES(?,?,?,?,?,?)')
        .run(nodeId, g.owner, g.public_key, g.fingerprint, canonical(hello), now);
      this.db.prepare('UPDATE portable_enrollment SET consumed_at=?,challenge=NULL WHERE id=? AND consumed_at IS NULL').run(now, grantId);
      return { nodeId, owner: g.owner, fingerprint: g.fingerprint };
    });
  }
  node(nodeId) {
    const n = this.db.prepare('SELECT * FROM portable_nodes WHERE id=?').get(nodeId);
    if (!n || n.revoked_at) throw Error('Unknown or revoked node.');
    return n;
  }
  revoke(owner, nodeId, now = Date.now()) {
    const n = this.node(nodeId); if (n.owner !== owner) throw Error('Foreign node.');
    this.db.prepare('UPDATE portable_nodes SET revoked_at=? WHERE id=?').run(now, nodeId);
  }
  place(owner, botId, nodeId, expectedEpoch = null) {
    if (!id(botId)) throw Error('Invalid bot identity.');
    return this.transaction(() => {
      const n = this.node(nodeId); if (n.owner !== owner) throw Error('Foreign node.');
      const previous = this.db.prepare('SELECT * FROM portable_placements WHERE bot_id=?').get(botId);
      if (previous && (previous.owner !== owner || previous.epoch !== expectedEpoch)) throw Error('Placement changed.');
      if (previous && this.db.prepare("SELECT 1 FROM portable_mailbox WHERE bot_id=? AND state NOT IN ('terminal') LIMIT 1").get(botId)) throw Error('Placement has unfinished or unknown operations.');
      const epoch = (previous?.epoch ?? 0) + 1;
      this.db.prepare('INSERT INTO portable_placements(bot_id,owner,node_id,epoch) VALUES(?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET node_id=excluded.node_id,epoch=excluded.epoch,control_revision=control_revision+1,stopped=1')
        .run(botId, owner, nodeId, epoch);
      return this.placement(owner, botId);
    });
  }
  placement(owner, botId) {
    const p = this.db.prepare('SELECT * FROM portable_placements WHERE bot_id=?').get(botId);
    if (!p || p.owner !== owner) throw Error('Foreign or unassigned bot.');
    this.node(p.node_id); return p;
  }
  stop(owner, botId, stopped) {
    this.placement(owner, botId);
    if (typeof stopped !== 'boolean') throw Error('Explicit Stop state required.');
    this.db.prepare('UPDATE portable_placements SET stopped=?,control_revision=control_revision+1 WHERE bot_id=?').run(Number(stopped), botId);
    return this.placement(owner, botId);
  }
  enqueue(owner, botId, operationId, payload, now = Date.now()) {
    return this.transaction(()=>this.enqueueOn(this.db,owner,botId,operationId,payload,now));
  }
  enqueueOn(db,owner,botId,operationId,payload,now=Date.now()) {
    if (!id(operationId)) throw Error('Original operation identity required.');
    const text = boundedFrame(payload);
    if(Buffer.byteLength(text)>512*1024)throw Error('Command exceeds the bounded transport payload. Use registered attachments.');
      const p=db.prepare('SELECT * FROM portable_placements WHERE owner=? AND bot_id=?').get(owner,botId);
      const n=p&&db.prepare('SELECT owner,revoked_at FROM portable_nodes WHERE id=?').get(p.node_id);
      if(!p||!n||n.revoked_at||n.owner!==owner)throw Error('Foreign or revoked placement.');
      const binding = { owner, botId, nodeId: p.node_id, epoch: p.epoch, payload };
      const hash = fingerprint(binding), old = db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
      if (old) { if (old.fingerprint !== hash) throw Error('Operation identity or placement differs.'); return old; }
      if(payload.method==='turn.interrupt')db.prepare('UPDATE portable_placements SET stopped=1,control_revision=control_revision+1 WHERE bot_id=?').run(botId);
      db.prepare('INSERT INTO portable_mailbox(operation_id,owner,bot_id,node_id,epoch,fingerprint,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,\'queued\',?,?)')
        .run(operationId, owner, botId, p.node_id, p.epoch, hash, text, now, now);
      return db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
  }
  sync(nodeId, cursor = 0) {
    this.node(nodeId);
    if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error('Invalid reconnect cursor.');
    const value={
      controls: this.db.prepare('SELECT * FROM portable_placements WHERE node_id=? ORDER BY bot_id').all(nodeId),
      // Pending commands are always included after a lost receipt. A cursor
      // describes observed history; it never silently discards queued work.
      commands: this.db.prepare("SELECT * FROM portable_mailbox WHERE node_id=? AND (sequence>? OR state IN ('queued','received')) ORDER BY sequence LIMIT 40").all(nodeId, cursor),
    };
    const selected=[];let bytes=Buffer.byteLength(JSON.stringify({...value,commands:[]}));
    for(const command of value.commands){const size=Buffer.byteLength(JSON.stringify(command))+1;if(bytes+size>900*1024)break;selected.push(command);bytes+=size;}
    return {...value,commands:selected};
  }
  receipt(nodeId, operationId, hash, state, receipt, now = Date.now()) {
    this.node(nodeId); const text = boundedFrame(receipt);
    if(receipt?.operationId!==operationId)throw Error('Receipt must bind its original operation.');
    return this.transaction(() => {
      const r = this.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
      if (!r || r.node_id !== nodeId || r.fingerprint !== hash) throw Error('Foreign receipt.');
      const p = this.placement(r.owner, r.bot_id);
      if (p.node_id !== nodeId || p.epoch !== r.epoch) throw Error('Stale placement receipt.');
      if (r.state === state && r.receipt_hash === digest(text)) return r;
      if (!transitions[r.state]?.includes(state)) throw Error('Receipt state regressed or contradicts original outcome.');
      if(r.state==='unknown'&&!originalNativeProof(receipt,operationId)&&!(state==='terminal'&&originalLocalControlProof(receipt,operationId,r.fingerprint,JSON.parse(r.payload))))throw Error('Unknown delivery requires exact original acceptance evidence, never a retry.');
      if (['native-accepted','running'].includes(state) && (!id(receipt?.threadId) || !id(receipt?.turnId) || receipt?.operationId !== operationId)) throw Error('Positive native receipt required.');
      this.db.prepare('UPDATE portable_mailbox SET state=?,receipt=?,receipt_hash=?,updated_at=? WHERE operation_id=?')
        .run(state, text, digest(text), now, operationId);
      return this.db.prepare('SELECT * FROM portable_mailbox WHERE operation_id=?').get(operationId);
    });
  }
  event(nodeId, eventId, botId, epoch, event, now = Date.now()) {
    const n = this.node(nodeId), p = this.placement(n.owner, botId);
    if (!id(eventId) || p.node_id !== nodeId || p.epoch !== epoch) throw Error('Foreign event.');
    if(event?.botId!==botId||typeof event.type!=='string'||!Number.isSafeInteger(event.seq)||event.seq<1)throw Error('Native event scope or sequence invalid.');
    const text = boundedFrame(event), hash = digest(text);
    const old = this.db.prepare('SELECT * FROM portable_events WHERE node_id=? AND event_id=?').get(nodeId, eventId);
    if (old) { if (old.fingerprint !== hash || old.bot_id !== botId || old.epoch !== epoch) throw Error('Event identity changed.'); return old.sequence; }
    return Number(this.db.prepare('INSERT INTO portable_events(node_id,event_id,bot_id,epoch,fingerprint,event,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(nodeId, eventId, botId, epoch, hash, text, now).lastInsertRowid);
  }
  eventCursor() { return this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM portable_events').get().n; }
  events(owner,cursor,limit=40) {
    if(!Number.isSafeInteger(cursor)||cursor<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid event cursor.');
    const rows=this.db.prepare('SELECT e.* FROM portable_events e JOIN portable_placements p ON p.bot_id=e.bot_id AND p.node_id=e.node_id AND p.epoch=e.epoch WHERE p.owner=? AND e.sequence>? ORDER BY e.sequence LIMIT ?').all(owner,cursor,limit);
    const selected=[];let bytes=2;
    for(const row of rows){const event={...JSON.parse(row.event),seq:row.sequence};const size=Buffer.byteLength(boundedFrame(event))+1;if(bytes+size>900*1024)break;selected.push(event);bytes+=size;}
    return {events:selected,cursor:selected.at(-1)?.seq??cursor};
  }
  close() { this.db.close(); }
}

export class NodeJournal {
  constructor(path) {
    this.db = privateDatabase(path);
    this.db.exec(`CREATE TABLE IF NOT EXISTS node_commands(operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,command TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS node_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT NOT NULL UNIQUE,event TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS node_controls(bot_id TEXT PRIMARY KEY,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,stopped INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS node_metadata(key TEXT PRIMARY KEY,value INTEGER NOT NULL);`);
    this.online = false; this.syncedAt = 0; this.syncedMonotonic = 0;
  }
  synchronize(controls, now = Date.now()) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of controls) {
        const old = this.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(c.bot_id);
        if (!id(c.bot_id) || !Number.isSafeInteger(c.epoch) || !Number.isSafeInteger(c.control_revision) || ![0,1].includes(c.stopped)
          || old && (old.epoch > c.epoch || old.epoch === c.epoch && (old.revision > c.control_revision || old.revision===c.control_revision&&old.stopped!==c.stopped))) throw Error('Control state stale or invalid.');
      }
      this.db.exec('DELETE FROM node_controls');
      for (const c of controls) this.db.prepare('INSERT INTO node_controls VALUES(?,?,?,?)').run(c.bot_id,c.epoch,c.control_revision,c.stopped);
      this.db.exec('COMMIT'); this.online = true; this.syncedAt = now; this.syncedMonotonic = performance.now();
    } catch (error) { this.db.exec('ROLLBACK'); this.disconnect(); throw error; }
  }
  disconnect() { this.online = false; this.syncedAt = 0; this.syncedMonotonic = 0; }
  canAdmit(command, now = Date.now()) {
    return this.currentControl(command,now)?.stopped === 0;
  }
  currentControl(command, now = Date.now()) {
    const c = this.db.prepare('SELECT * FROM node_controls WHERE bot_id=?').get(command.bot_id);
    return this.online && now>=this.syncedAt && now-this.syncedAt<15000 && performance.now()-this.syncedMonotonic<15000 && c?.epoch === command.epoch ? c : null;
  }
  cursor() { return this.db.prepare("SELECT value FROM node_metadata WHERE key='mailbox-cursor'").get()?.value ?? 0; }
  observe(sequence) {
    if(!Number.isSafeInteger(sequence)||sequence<1)throw Error('Invalid durable command cursor.');
    this.db.prepare("INSERT INTO node_metadata VALUES('mailbox-cursor',?) ON CONFLICT(key) DO UPDATE SET value=MAX(value,excluded.value)").run(sequence);
  }
  receive(command) {
    if(!id(command.operation_id)||!id(command.bot_id)||!id(command.node_id)||!Number.isSafeInteger(command.epoch)||command.epoch<1)throw Error('Invalid command identity.');
    const text = boundedFrame(command), old = this.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id);
    if (fingerprint({ owner: command.owner, botId: command.bot_id, nodeId: command.node_id, epoch: command.epoch, payload: JSON.parse(command.payload) }) !== command.fingerprint) throw Error('Command fingerprint invalid.');
    if (old) { if (old.fingerprint !== command.fingerprint) throw Error('Original node command changed.'); return old; }
    this.db.prepare("INSERT INTO node_commands VALUES(?,?,?,'received',NULL)").run(command.operation_id, command.fingerprint, text);
    return this.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(command.operation_id);
  }
  prepare(operationId) {
    const result=this.db.prepare("UPDATE node_commands SET state='dispatching' WHERE operation_id=? AND state='received'").run(operationId);
    if(result.changes!==1)throw Error('Command already attempted.');
  }
  settle(operationId, state, receipt) {
    const old = this.db.prepare('SELECT * FROM node_commands WHERE operation_id=?').get(operationId);
    if (!old || !(old.state==='dispatching'?['native-accepted','terminal','unknown']:transitions[old.state])?.includes(state)) throw Error('Invalid node settlement.');
    const command=JSON.parse(old.command);
    if(old.state==='unknown'&&!originalNativeProof(receipt,operationId)&&!(state==='terminal'&&originalLocalControlProof(receipt,operationId,old.fingerprint,JSON.parse(command.payload))))throw Error('Unknown outcome requires exact original receipt proof.');
    this.db.prepare('UPDATE node_commands SET state=?,receipt=? WHERE operation_id=?').run(state,boundedFrame(receipt),operationId);
  }
  recordEvent(eventId, event) {
    const text = boundedFrame(event), old = this.db.prepare('SELECT * FROM node_events WHERE event_id=?').get(eventId);
    if (old) { if (old.event !== text) throw Error('Event identity differs.'); return old.sequence; }
    return Number(this.db.prepare('INSERT INTO node_events(event_id,event) VALUES(?,?)').run(eventId,text).lastInsertRowid);
  }
  pendingEvents() { return this.db.prepare('SELECT * FROM node_events WHERE acked=0 ORDER BY sequence LIMIT 40').all(); }
  acknowledgeEvent(eventId) { this.db.prepare('UPDATE node_events SET acked=1 WHERE event_id=?').run(eventId); }
  close() { this.db.close(); }
}
