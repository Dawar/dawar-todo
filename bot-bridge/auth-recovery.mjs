import { isCodexAuthError } from '../lib/codex-auth-recovery.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { captureActivity, activityUnchanged } from './turn-state.mjs';
import { inspectNativeIdle } from './native-idle.mjs';
const same = (a, b) => a.threadId === b.threadId && a.updatedAt === b.updatedAt && a.error === b.error && a.activeTurnId === b.activeTurnId;
const validLink = value => {
  const u = new URL(value);
  if (u.protocol !== 'https:' || !['chatgpt.com', 'auth.openai.com', 'login.auth.openai.com'].includes(u.hostname) || u.username || u.password) throw Error('Native sign-in returned an unsupported destination.');
  return u.href;
};

// The owner interface is the only caller. Device codes stay in RAM and are
// returned only by a live scoped read; neither operation receipts nor events
// contain codes, OAuth tokens, or the native login response.
export class AuthRecovery {
  constructor(runtime, { clock = Date.now } = {}) {
    this.runtime = runtime; this.clock = clock; this.flow = null; this.proof = null;
    this.timer = null; this.checking = false; this.phase = 'unknown'; this.scope = null; this.completed = new Map();
    this.recoveryScope = new AsyncLocalStorage(); this.restoring = false;
  }
  get active() { return Boolean(this.checking || this.flow); }
  guardAdmission() {
    if (this.flow || this.restoring) throw Object.assign(Error('Codex connection recovery is in progress on this execution machine. Your input was not submitted; keep it until recovery finishes.'), { outcome: 'rejected' });
  }
  native(method, params = {}) {
    if (method === 'thread/resume' && this.restoring && this.recoveryScope.getStore()?.threadId === params.threadId) return;
    if (method === 'thread/resume' && this.runtime.store.list('nativeThreadRecovery').some(r => r.threadId === params.threadId && ['dispatching','uncertain'].includes(r.phase)))
      throw Error('The original native conversation recovery is unconfirmed. Check its current state before another resume.');
    if (['turn/start','turn/steer','thread/start','thread/fork','thread/resume','thread/queue/add','thread/queue/start','thread/compact/start'].includes(method) || method === 'thread/goal/set' && (params.objective !== undefined || params.status === 'active')) this.guardAdmission();
  }
  async idle() {
    const r = this.runtime, counts = r.maintenance.counts();
    if (counts.requests > 1 || ['admissions','nativeRpc','localActive','auxiliaryActive','activeGoals','volatileSecure','secureTransfers','desktopToolRequests'].some(k => counts[k] > 0) ||
        r.store.list('pending').some(p => p.request?.params?.isBlocking !== false)) throw Error('Running work must finish before changing Codex sign-in.');
    const generation = r.maintenance.generation;
    const deadline = this.clock() + 20000;
    const read = (method, params) => { const remaining = deadline-this.clock(); if(remaining < 1) throw Error('Native activity check expired.'); return r.codex.call(method,params,Math.min(12000,remaining)); };
    const extraThreads = r.store.bots().filter(b => b.threadId && !b.archived && !b.deletedAt && r.activityUnresolved(b.id)).map(b => b.threadId);
    const proof = await inspectNativeIdle(r, read, { terminalErrors: true, extraThreads });
    if (!proof.safe) throw Error('Native work must settle before changing Codex sign-in.');
    if (generation !== r.maintenance.generation || r.maintenance.counts().requests > 1) throw Error('Native activity changed. Check the connection again.');
    return proof;
  }
  bot(botId, p) {
    const b = this.runtime.store.bot(String(botId));
    if (b.archived || b.archiving || b.deletedAt || !b.threadId || p.threadId !== b.threadId) throw Object.assign(Error('The selected conversation changed. Reopen recovery.'), { outcome: 'rejected' });
    return b;
  }
  emit(botId) { this.runtime.emitEvent('codex.auth', { phase: this.phase }, botId); }
  read(botId, p) {
    const b = this.bot(botId, p), f = this.flow;
    if (f && f.botId === b.id && f.threadId === b.threadId) return {
      status: this.phase, loginId: f.loginId ?? null, expiresAt: f.expiresAt,
      ...(this.phase === 'pending' && f.expiresAt > this.clock() ? { verificationUrl: f.url, userCode: f.code } : {}),
    };
    return { status: this.scope?.botId === b.id && this.scope.threadId === b.threadId ? this.phase : 'unknown' };
  }
  async check(botId, p, attempt, operationId) {
    const before = this.bot(botId, p);
    if (this.checking) throw Object.assign(Error('A Codex connection check is already running. Check again after it finishes.'), { outcome: 'rejected' });
    this.checking = true; this.scope = {botId: before.id, threadId: before.threadId};
    try {
      let account;
      try { account = await this.runtime.codex.call('account/read', { refreshToken: true }, 12000); }
      catch (e) {
        if (!isCodexAuthError(e.message)) throw Object.assign(Error('Could not verify the Codex connection. Try again when the execution machine is online.'), { outcome: 'rejected' });
        account = { account: null, requiresOpenaiAuth: true };
      }
      this.bot(botId, p);
      const connected = Boolean(account.account) || account.requiresOpenaiAuth === false;
      const pending = this.flow;
      if(connected && pending?.loginId) {
        const closed = await this.runtime.submitNative('account/login/cancel', {loginId:pending.loginId}, attempt);
        if(!['canceled','notFound'].includes(closed?.status))throw Error('The original sign-in closure was not confirmed.');
        if(this.flow===pending)this.clear();
      }
      this.phase = connected && !this.flow ? 'connected' : this.flow ? this.phase : 'needs-sign-in';
      this.proof = { botId: before.id, threadId: before.threadId, at: this.clock(), connected };
      this.runtime.account = { authenticated: connected };
      let recovered = false;
      if (connected && !this.flow && this.runtime.activityUnresolved(before.id) &&
          (isCodexAuthError(before.error) || this.runtime.store.get('botActivity', before.id)?.recoveryKind === 'native-system-error') && operationId)
        recovered = await this.restoreConversation(botId, p, operationId, attempt);
      // Clear only the bot's current display error, never its failed native
      // turn, input, queue, receipt, Stop, or Goal. Unknown/current work blocks
      // recovery. A fresh native metadata read never resumes a thread.
      if (connected && isCodexAuthError(before.error) && !before.activeTurnId && !this.runtime.activityUnresolved(before.id)) {
        let thread;
        try { ({thread} = await this.runtime.codex.call('thread/read', { threadId: before.threadId, includeTurns: false }, 12000)); }
        catch { throw Object.assign(Error('Codex sign-in was verified, but this conversation is not ready yet. Check the connection again.'), { outcome:'rejected' }); }
        const current = this.bot(botId, p);
        if (thread?.id === before.threadId && thread.status?.type === 'idle' && same(before, current) && !this.runtime.activityUnresolved(current.id)) {
          if (attempt) attempt.started = true;
          this.runtime.saveBot(current, { status: 'idle', error: null }); recovered = true;
        }
      }
      this.emit(before.id);
      if (recovered) this.runtime.emitEvent('history.refresh', { reason: 'native-connection-recovered' }, before.id);
      return { status: this.phase, recovered, checkedAt: new Date(this.clock()).toISOString() };
    } finally { this.checking = false; }
  }
  async restoreConversation(botId, p, operationId, attempt) {
    const r = this.runtime, before = this.bot(botId, p);
    if (!/^[A-Za-z0-9:_-]{1,180}$/.test(operationId) || before.activeTurnId || before.status === 'running') return false;
    const token = captureActivity(r, botId);
    this.restoring = true;
    try {
      await this.idle();
      if (!same(before, this.bot(botId, p)) || !activityUnchanged(r, botId, token)) throw Object.assign(Error('Conversation state changed during recovery. Check again.'), { outcome: 'rejected' });
      const { thread } = await r.codex.call('thread/read', { threadId: before.threadId, includeTurns: false }, 12000);
      if (thread?.id !== before.threadId) throw Object.assign(Error('Original conversation identity changed.'), { outcome: 'rejected' });
      if (!same(before, this.bot(botId, p)) || !activityUnchanged(r, botId, token))
        throw Object.assign(Error('Conversation state changed during recovery. Check again.'), { outcome: 'rejected' });
      const originals = r.store.list('nativeThreadRecovery', botId).filter(v => v.threadId === before.threadId && ['dispatching','uncertain'].includes(v.phase));
      if (thread.status?.type !== 'idle') {
        if (!['systemError','notLoaded'].includes(thread.status?.type) || originals.length)
          throw Object.assign(Error('The original conversation recovery needs inspection. No native resume was repeated.'), { outcome: 'rejected' });
        const params = r.resumeParams(before), fingerprint = createHash('sha256').update(JSON.stringify(params)).digest('hex');
        const row = { id: operationId, botId, threadId: before.threadId, fingerprint, phase: 'dispatching', createdAt: new Date(this.clock()).toISOString() };
        r.store.put('nativeThreadRecovery', row);
        try {
          const result = await this.recoveryScope.run({ threadId: before.threadId }, () => r.submitNative('thread/resume', params, attempt));
          if (result?.thread?.id !== before.threadId) throw Error('Native resume did not confirm the original conversation.');
          r.store.put('nativeThreadRecovery', { ...row, phase: 'resumed' });
        } catch (error) {
          r.store.put('nativeThreadRecovery', { ...row, phase: error.definite ? 'rejected' : 'uncertain' });
          throw error;
        }
      } else for (const original of originals) r.store.put('nativeThreadRecovery', { ...original, phase: 'observed-idle', observedAt: new Date(this.clock()).toISOString() });
      r.loaded.add(before.threadId);
      if (!await r.reconcileCurrentActivity(botId)) return false;
      const current = this.bot(botId, p);
      if (current.activeTurnId || r.activityUnresolved(botId)) return false;
      r.saveBot(current, { error: null });
      return true;
    } finally { this.restoring = false; }
  }
  async start(botId, p, operationId, attempt) {
    const bot = this.bot(botId, p);
    if (this.checking) throw Object.assign(Error('Wait for the current connection check to finish.'),{outcome:'rejected'});
    if (this.flow) throw Object.assign(Error('The original sign-in is still pending or unconfirmed. Check it before starting another.'), { outcome: 'rejected' });
    if (this.proof?.botId !== bot.id || this.proof.threadId !== bot.threadId || this.proof.connected || this.clock() - this.proof.at > 60000)
      throw Object.assign(Error('Check the Codex connection before signing in.'), { outcome: 'rejected' });
    const proof = this.proof;
    if (this.runtime.store.bots().some(b => b.activeTurnId || b.status === 'running'))
      throw Object.assign(Error('Wait for running work on this execution machine to finish before changing Codex sign-in.'), { outcome: 'rejected' });
    const f = { botId: bot.id, threadId: bot.threadId, operationId, loginId: null, url: '', code: '', expiresAt: this.clock() + 600000 };
    this.flow = f; this.scope = {botId: bot.id, threadId: bot.threadId}; this.phase = 'starting';
    try { await this.idle(); this.bot(botId,p); if(this.proof !== proof || this.clock()-proof.at > 60000) throw Error('Sign-in proof changed.'); }
    catch { this.clear(); this.phase='needs-sign-in'; throw Object.assign(Error('Wait for native work, Goals and tools on this execution machine to settle, then check the connection again.'), {outcome:'rejected'}); }
    try {
      const r = await this.runtime.submitNative('account/login/start', { type: 'chatgptDeviceCode' }, attempt);
      if (r?.type !== 'chatgptDeviceCode' || typeof r.loginId !== 'string' || !/^[a-zA-Z0-9:_-]{1,180}$/.test(r.loginId) || typeof r.userCode !== 'string' || !/^[A-Za-z0-9 -]{4,32}$/.test(r.userCode)) throw Error('Native sign-in response could not be verified.');
      f.loginId = r.loginId; f.url = validLink(r.verificationUrl); f.code = r.userCode;
      this.bot(botId, p); this.phase = 'pending';
      const completed = this.completed.get(f.loginId); if(completed){this.completed.delete(f.loginId);this.notification(completed);return {status:this.phase,loginId:f.loginId,expiresAt:f.expiresAt};}
      this.timer = setTimeout(() => void this.expire(f), Math.max(0, f.expiresAt-this.clock())); this.timer.unref?.();
      this.emit(bot.id);
      // This is the durable reply. Sensitive display data is a separate live
      // read, so lost ACK/reconnect cannot put it into the node journal/cache.
      return { status: 'pending', loginId: f.loginId, expiresAt: f.expiresAt };
    } catch (e) {
      f.code = ''; f.url = ''; if(e.definite){this.clear();this.phase='needs-sign-in';}else this.phase = 'unconfirmed'; this.emit(bot.id);
      throw Object.assign(Error(e.definite ? 'Codex could not start device sign-in. Device-code login may need enabling in your ChatGPT security settings.' : 'Sign-in could not be confirmed. Check the original connection before trying again.'), { outcome: e.definite ? 'rejected' : 'uncertain' });
    }
  }
  async cancel(botId, p, attempt) {
    this.bot(botId, p); const f = this.flow;
    if (!f || f.botId !== botId || f.threadId !== p.threadId || !f.loginId || p.loginId !== f.loginId) throw Object.assign(Error('The original sign-in is unavailable. Check the connection.'), { outcome: 'rejected' });
    const r = await this.runtime.submitNative('account/login/cancel', { loginId: f.loginId }, attempt);
    if (!['canceled', 'notFound'].includes(r?.status)) throw Error('Cancellation was not confirmed.');
    this.clear(); this.phase = 'unknown'; this.proof = null; this.emit(botId);
    return { status: 'cancelled' };
  }
  async expire(f) {
    if (this.flow !== f) return;
    f.code = ''; f.url = ''; this.phase = 'unconfirmed'; this.emit(f.botId);
    try {
      const r = await this.runtime.maintenance.track(() => this.runtime.codex.call('account/login/cancel', { loginId: f.loginId }, 10000));
      if (this.flow === f && ['canceled', 'notFound'].includes(r?.status)) { this.clear(); this.phase = 'expired'; this.emit(f.botId); }
    } catch { /* Retain the unresolved flow and its cutover fence; no retry. */ }
  }
  notification(m) {
    const f = this.flow;
    if(m.method==='account/login/completed' && f && !f.loginId && typeof m.params?.loginId==='string'){this.completed.set(m.params.loginId,m);if(this.completed.size>8)this.completed.delete(this.completed.keys().next().value);return;}
    if (m.method === 'account/login/completed' && f && m.params?.loginId === f.loginId) {
      const botId = f.botId; this.clear(); this.phase = m.params.success === true ? 'verify' : 'unknown'; this.proof = null; this.emit(botId);
    } else if (m.method === 'account/updated') {
      this.proof = null;
      if (!f) this.phase = 'unknown';
    }
  }
  clear() { clearTimeout(this.timer); this.timer = null; if (this.flow) { this.flow.code = ''; this.flow.url = ''; } this.flow = null; this.completed.clear(); }
  disconnect() { this.clear(); this.phase = 'unknown'; this.proof = null; }
}
