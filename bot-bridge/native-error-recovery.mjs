import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { activityUnchanged } from './turn-state.mjs';
import { usableTurn, usableTurnId } from './native-turn.mjs';
import {isCodexAuthError} from '../lib/codex-auth-recovery.ts';
import {MaintenanceTerminalProof} from './maintenance-terminal-proof.mjs';
import {passiveLegacyManagerRejections} from './legacy-manager-rejections.mjs';

const transient = new Set(['serverOverloaded','rateLimitExceeded','internalServerError','responseStreamDisconnected','responseStreamConnectionFailed','responseTooManyFailedAttempts','httpConnectionFailed']);
const stopped = b => b.queuePaused || b.managerPaused || b.archived || b.archiving || b.deletedAt;
const iso = ms => new Date(ms).toISOString();
const failure = message => Object.assign(Error(message), {nativeRecoverySafe:true});
const nativeIdentity=pid=>{
  if(!Number.isSafeInteger(pid)||pid<1)return null;
  let start=null;try{const s=readFileSync(`/proc/${pid}/stat`,'utf8');start=s.slice(s.lastIndexOf(')')+2).split(' ')[19];}catch{}
  return {pid,start,platform:process.platform};
};
const connectionEnded=a=>{
  const old=a.nativeIdentity;if(!old||old.platform!==process.platform)return false;
  try{process.kill(old.pid,0);}catch(e){return e.code==='ESRCH';}
  const current=nativeIdentity(old.pid);return Boolean(old.start&&current?.start&&current.start!==old.start);
};
const code = error => {
  const v = error?.codexErrorInfo;
  const key=v && typeof v==='object' ? Object.keys(v).find(k=>transient.has(k)) : null;
  const http=key ? v[key]?.httpStatusCode : null;
  if(typeof http==='number' && http!==429 && !(http>=500&&http<=599))return http===401?'unauthorized':'badRequest';
  return typeof v === 'string' && /^[a-zA-Z]{1,80}$/.test(v) ? v : v && typeof v === 'object' ? Object.keys(v).find(k => transient.has(k)) ?? 'other' : 'other';
};
export function recoveryDelay(attempt, random = Math.random, retryAfterMs = 0) {
  const base = Math.min(300000, 5000 * 2 ** Math.min(6, Math.max(0, attempt - 1)));
  return Math.max(Math.min(300000, Math.round(base * (0.8 + Math.max(0, Math.min(1, random())) * 0.4))), retryAfterMs);
}
// The pinned protocol has no separate Retry-After field. Accept only a bounded
// native additionalDetails header when present; never retain the raw details.
export function retryAfter(error) {
  const s = error?.additionalDetails;
  if (typeof s !== 'string' || s.length > 4096) return 0;
  const m = s.match(/(?:^|\n)Retry-After:[ \t]*([^\r\n]{1,100})(?:\r?\n|$)/i);
  if(!m)return 0;
  const value=m[1].trim(),delay=/^\d{1,5}$/.test(value)?Number(value)*1000:Date.parse(value)-Date.now();
  return Number.isFinite(delay)?Math.max(0,Math.min(86400000,delay)):0;
}

/** One durable same-thread recovery, no model probe, input replay or service kill. */
export class NativeErrorRecovery {
  verifiedAuthentication(botId, proof) {
    const b=this.runtime.store.bot(botId),row=this.get(botId);
    if(!row||!row.terminalConfirmed||row.threadId!==b.threadId||!(row.authenticationFailure||/^unauthorized$/i.test(row.errorCode)||isCodexAuthError(b.error))||
        proof?.botId!==botId||proof.threadId!==b.threadId||proof.connected!==true||this.clock()-proof.at>60000)return false;
    this.save(row,{authVerifiedEpoch:this.runtime.epoch,authVerifiedAt:iso(this.clock()),phase:row.releaseActionId?row.phase:'pending',nextRetryAt:iso(this.clock())});
    return true;
  }
  constructor(runtime, { clock = Date.now, random = Math.random } = {}) {
    Object.assign(this, { runtime, clock, random });
    this.eventVersions = new Map();
    this.terminalCache = new Map();
    this.scope = new AsyncLocalStorage();
    runtime.codex.on?.('recoveryReceipt',p=>this.receipt(p));
    // These actions only affect the original stdio connection/subscription.
    // Preserve their uncertain outcome, but a proven exited native process
    // cannot later unsubscribe the replacement connection. Other work is not
    // exempted by this narrowly scoped transport reconciliation.
    for(const a of runtime.store.list('nativeRecoveryAction'))if(['dispatching','uncertain','acknowledged'].includes(a.state)&&connectionEnded(a))
      runtime.store.put('nativeRecoveryAction',{...a,state:'connection-ended',outcome:a.state==='acknowledged'?'acknowledged':'uncertain',priorState:a.state,evidence:'original-native-process-ended'});
    runtime.codex.on?.('disconnect',()=>{
      for(const a of runtime.store.list('nativeRecoveryAction'))if(a.epoch===runtime.epoch&&['dispatching','uncertain','acknowledged'].includes(a.state))
        runtime.store.put('nativeRecoveryAction',{...a,state:'connection-ended',outcome:a.state==='acknowledged'?'acknowledged':'uncertain',priorState:a.state,evidence:'original-stdio-child-exit'});
    });
  }
  get(botId) { return this.runtime.store.get('nativeErrorRecovery', botId); }
  summary(row) {
    return row ? { threadId:row.threadId, failedTurnId:row.failedTurnId, phase:row.phase,
      attempts:row.attempts, nextRetryAt:row.nextRetryAt ?? null, reason:row.reason ?? null,
      errorCode:row.errorCode, nativeRetry:row.nativeRetry, updatedAt:row.updatedAt } : null;
  }
  save(row, changes = {}) {
    const next = { ...row, ...changes, updatedAt:iso(this.clock()) };
    this.runtime.store.put('nativeErrorRecovery', next);
    const b = this.runtime.store.bot(row.botId);
    if (b.threadId === next.threadId) {
      const message = next.phase === 'recovered' || next.phase === 'superseded' ? null :
        next.phase === 'action-required' ? transient.has(next.errorCode) ? `Recovery needs attention. ${next.reason ?? 'Check the original native connection.'}` : null :
        `Recovering conversation · attempt ${next.attempts}${next.nextRetryAt ? ` · next check ${next.nextRetryAt}` : ''}. ${next.reason ?? 'Checking the original native thread.'}`;
      this.runtime.saveBot(b, { nativeRecovery:this.summary(next),
        ...(message && next.nativeRetry !== true ? {error:message} : {}) });
    }
    return next;
  }
  note(botId, message, currentMetadata = false) {
    if(!currentMetadata)this.eventVersions.set(botId,(this.eventVersions.get(botId)??0)+1);
    const b = this.runtime.store.bot(botId), p = message.params ?? {}, row = this.get(botId);
    if(row?.threadId===b.threadId && !['recovered','superseded'].includes(row.phase) && row.releaseActionId && (message.method==='thread/closed' || message.method==='thread/status/changed' && p.status?.type==='notLoaded')) {
      this.save(row,{nextRetryAt:iso(this.clock()),reason:'Native unloading was observed; checking the original thread before reopening.',lastNativeStatus:'notLoaded',lastObservedAt:iso(this.clock())});return;
    }
    if (message.method === 'turn/started' && row?.threadId === b.threadId && usableTurn(p.turn) && p.turn.status === 'inProgress' && p.turn.id!==row.failedTurnId) {
      this.save(row, {phase:'superseded',nextRetryAt:null,reason:null,nativeRetry:false,nativeRetryEpoch:null}); return;
    }
    if (message.method === 'thread/started' && row?.threadId === b.threadId && p.thread?.id === b.threadId && row.resumeActionId) {
      const a = this.runtime.store.get('nativeRecoveryAction',row.resumeActionId);
      if (a?.epoch === this.runtime.epoch && ['dispatching','uncertain'].includes(a.state))
        this.runtime.store.put('nativeRecoveryAction',{...a,state:'acknowledged',evidence:'same-connection-thread-started'});
      return;
    }
    const terminal = message.method === 'turn/completed' && usableTurn(p.turn) && p.turn.status === 'failed';
    const turnId = terminal ? p.turn.id : p.turnId;
    if ((!terminal && message.method !== 'error') || !usableTurnId(turnId) || p.threadId && p.threadId !== b.threadId || b.activeTurnId && b.activeTurnId !== turnId) return;
    if (!currentMetadata && !b.activeTurnId && row?.failedTurnId !== turnId) return;
    if (!currentMetadata && row?.failedTurnId === turnId && ['recovered','superseded'].includes(row.phase)) return;
    const error = terminal ? p.turn.error : p.error;
    const errorCode = code(error), same = row?.threadId === b.threadId && row.failedTurnId === turnId;
    this.save(same ? row : { id:botId, botId, threadId:b.threadId, failedTurnId:turnId,
      attempts:0, createdAt:iso(this.clock()), originalOperationId:this.runtime.store.get('botActivity',botId)?.dispatchOperationId ?? null }, {
      errorCode:errorCode === 'other' && same ? row.errorCode : errorCode,
      authenticationFailure:isCodexAuthError(error?.message??'')||same&&row.authenticationFailure===true,
      retryAfterMs:Math.max(retryAfter(error),same ? row.retryAfterMs ?? 0 : 0),
      nativeRetry:!terminal && p.willRetry === true,
      nativeRetryEpoch:!terminal && p.willRetry===true ? this.runtime.epoch : null,
      phase:!terminal && p.willRetry === true ? 'native-retrying' : transient.has(errorCode === 'other' && same ? row.errorCode : errorCode) ? same && row.releaseActionId ? row.phase : 'pending' : 'action-required',
      nextRetryAt:iso(Math.max(same ? Date.parse(row.nextRetryAt??'')||this.clock() : this.clock(),this.clock()+retryAfter(error))),
      terminalConfirmed:terminal || same && row.terminalConfirmed === true,
      reason:!terminal && p.willRetry === true ? 'Codex owns the retry of the active turn.' : null,
    });
  }
  recoverable(row) { return transient.has(row?.errorCode)||row?.authenticationFailure===true&&row.authVerifiedEpoch===this.runtime.epoch&&this.runtime.account?.authenticated===true; }
  waiting(botId) { const r=this.get(botId); return r?.threadId===this.runtime.store.bot(botId).threadId && !(r.nativeRetry && r.nativeRetryEpoch===this.runtime.epoch) && this.recoverable(r) && !['recovered','superseded'].includes(r.phase) &&
    (Boolean(r.releaseActionId) || !this.runtime.loaded.has(r.threadId)); }
  needsRecovery(botId,turnId) {const r=this.get(botId);return r?.failedTurnId===turnId && this.recoverable(r) && !r.nativeRetry;}
  publish(botId) {const row=this.get(botId);if(row)this.save(row);}
  async qualifyRetained(botId,token) {
    const r=this.runtime,b=r.store.bot(botId);
    if(!activityUnchanged(r,botId,token)||stopped(b)||r.maintenance.holding()||r.authRecovery?.active)throw failure('Recovery state changed before retained-record observation.');
    const proof=new MaintenanceTerminalProof({db:r.store.db,bots:()=>[r.store.bot(botId)]},{botId}),before=proof.snapshot();
    this.terminalCache.delete(botId);
    if(!before)return;
    const native=await proof.read(before.input,6000),after=proof.snapshot();
    if(!activityUnchanged(r,botId,token)||before.fingerprint!==after?.fingerprint||!proof.matches(before,native)||!proof.fresh(native))
      throw failure('Original retained native evidence changed.');
    const records=[...before.input.accepted.map(row=>({kind:'primaryInbox',id:row.id})),...before.input.questions.map(row=>({kind:'pending',id:row.id}))];
    this.terminalCache.set(botId,{generation:token.generation,threadId:b.threadId,at:this.clock(),records:records.map(row=>({...row,raw:JSON.stringify(r.store.get(row.kind,row.id))}))});
  }
  async awaitUnload(botId,token,call) {
    const row=this.get(botId),r=this.runtime;
    if(row?.threadId!==r.store.bot(botId).threadId || !this.waiting(botId) || !row.releaseActionId)return;
    await this.qualifyRetained(botId,token);
    const resumed=row.resumeActionId && r.store.get('nativeRecoveryAction',row.resumeActionId);
    if(resumed?.epoch===r.epoch && ['dispatching','uncertain','acknowledged'].includes(resumed.state))return;
    const action=r.store.get('nativeRecoveryAction',row.releaseActionId);
    if(!action || ['not-submitted','unsupported','connection-ended'].includes(action.state))return;
    // Poll the global loaded-ID registry, not the unsubscribed thread. The
    // official contract requires inactivity; target RPCs must not keep that
    // session warm while we are waiting for its unload grace period.
    const control=this.localFence(botId,token),seen=new Set();let cursor=null;
    for(let page=0;page<4;page++) {
      const result=await call('thread/loaded/list',{cursor,limit:100});
      if(this.localFence(botId,token)!==control)throw failure('Recovery controls changed during the unload observation.');
      if(!Array.isArray(result?.data) || result.data.length>100 || result.data.some(id=>typeof id!=='string'||id.length>180))throw failure('The bounded native loaded-thread registry is unavailable.');
      if(result.data.includes(row.threadId))throw failure('Waiting for native unloading; observing loaded IDs without touching the failed thread.');
      if(result.nextCursor===null)return;
      if(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>500||seen.has(result.nextCursor))break;
      cursor=result.nextCursor;seen.add(cursor);
    }
    throw failure('Native unload could not be established within the bounded loaded-thread pages.');
  }
  native(method,p={}) {
    if(!['turn/start','turn/steer','thread/resume','thread/fork','thread/queue/add','thread/queue/start','thread/compact/start','thread/shellCommand'].includes(method) &&
      !(method==='thread/goal/set' && (p.objective!==undefined || p.status==='active')))return;
    const bot=this.runtime.store.bots().find(b=>b.threadId===p.threadId);
    if(!bot || !this.waiting(bot.id))return;
    const permit=this.scope.getStore(),row=this.get(bot.id),a=permit && this.runtime.store.get('nativeRecoveryAction',permit.actionId);
    if(method==='thread/resume' && permit?.actionId===row.resumeActionId && a?.epoch===this.runtime.epoch && a.state==='dispatching' && a.threadId===p.threadId)return;
    throw Object.assign(failure('The original conversation is recovering. Your new input was not submitted; retain it until recovery finishes.'),{outcome:'rejected',recoveryNotSubmitted:true});
  }
  localFence(botId, token) {
    const r=this.runtime,b=r.store.bot(botId);
    if (!activityUnchanged(r,botId,token) || stopped(b) || r.maintenance.holding() || r.authRecovery?.active)
      throw failure('Stop, maintenance, sign-in or changed native activity prevents recovery.');
    const control = r.nativeRecoveryControl?.(botId);
    if (r.nativeRecoveryControl && !control) throw failure('The assigned node control is offline or stopped.');
    let barrier = r.store.db.prepare(`SELECT count(*) n FROM records WHERE bot_id=? AND (
      kind IN ('pending','managerRequest','runPending') OR
      (kind IN ('primaryInbox','promptQueue','runIntake','answerExecution','managerOperation','managerExecution','burstBatch','messageBurst') AND json_extract(json,'$.state') IN ('dispatching','uncertain','native-queued','accepted') AND json_extract(json,'$.terminalStatus') IS NULL) OR
      (kind IN ('managerTask','runLane') AND (json_extract(json,'$.activeTurnId') IS NOT NULL OR json_extract(json,'$.state') IN ('running','starting','uncertain','provisioning'))) OR
      (kind='operatorCall' AND json_extract(json,'$.endedAt') IS NULL))`).get(botId).n;
    barrier-=passiveLegacyManagerRejections(r.store,botId).length;
    const retained=this.terminalCache.get(botId);
    if(retained?.threadId===b.threadId&&retained.generation===token.generation&&this.clock()-retained.at<10000&&
        retained.records.every(row=>JSON.stringify(r.store.get(row.kind,row.id))===row.raw))barrier-=retained.records.length;
    const uncertain=r.store.db.prepare("SELECT count(*) n FROM operations WHERE status IN ('dispatching','uncertain') AND json_extract(json,'$.botId')=?").get(botId).n;
    if (barrier!==0 || uncertain || b.activeTurnId || [...(r.codex.pending?.values() ?? [])].some(p=>p.threadId===b.threadId)) throw failure('Original pending work, tools or unknown acceptance must settle first.');
    if(r.secure?.live.size && (!r.secure.recoveryBusy || r.secure.recoveryBusy(botId)))throw failure('An in-flight private use or transfer must settle before thread recovery.');
    const privateHandles=[...(r.secure?.live.keys()??[])].filter(id=>r.store.get('secureInput',id)?.botId===botId).sort();
    for (const t of r.secure?.transfers.values() ?? []) { const s=r.store.get('secureInput',t.requestId);if(!s || s.botId===botId)throw failure('A private transfer is still in flight.'); }
    if(r.desktops?.browserMaintenance?.has(botId))throw failure('This bot has active browser maintenance.');
    if ([...(r.desktops?.sessions.values() ?? [])].some(s=>!s.bot || s.bot.id===botId)) throw failure('The existing desktop session must remain connected.');
    return JSON.stringify([control ?? null,this.eventVersions.get(botId)??0,privateHandles]);
  }
  async guards(botId, token, read, expectedStatus,call=(m,p)=>this.runtime.codex.call(m,p,12000)) {
    const r=this.runtime,b=r.store.bot(botId),control=this.localFence(botId,token);
    const check=()=>{if(this.localFence(botId,token)!==control)throw failure('Assigned control changed during recovery.');};
    const goal=await call('thread/goal/get',{threadId:b.threadId});check();
    if(!goal || !Object.hasOwn(goal,'goal') || goal.goal && (goal.goal.threadId!==b.threadId || !['paused','blocked','usageLimited','budgetLimited','complete'].includes(goal.goal.status))) throw failure('An active or unknown native Goal prevents recovery.');
    const queue=await call('thread/queue/list',{threadId:b.threadId,cursor:null,limit:1});check();
    if(!Array.isArray(queue?.data) || queue.data.length || queue.nextCursor!==null)throw failure('An accepted or unknown native queue prevents recovery.');
    if(expectedStatus!=='notLoaded') {
      const terminals=await call('thread/backgroundTerminals/list',{threadId:b.threadId,cursor:null,limit:1});check();
      if(!Array.isArray(terminals?.data) || terminals.data.length || terminals.nextCursor!==null)throw failure('Background terminal work or its unknown state prevents unloading this thread.');
    }
    const current=await read();check();
    if(current.status.type!==expectedStatus)throw failure('Native thread changed before the recovery action.');
    return control;
  }
  async action(row, kind, fn) {
    const r=this.runtime,id=`recovery:${createHash('sha256').update(`${row.botId}:${row.threadId}:${row.failedTurnId}:${kind}:${r.epoch}`).digest('hex')}`;
    const prior=r.store.get('nativeRecoveryAction',id);
    if(prior){if(prior.state==='acknowledged')return prior.result;if(prior.state!=='not-submitted')throw failure('Original recovery action is unconfirmed; it will not be repeated.');}
    if(r.maintenance.holding() || r.authRecovery?.active)throw failure('Recovery is held by maintenance or sign-in.');
    const record={id,botId:row.botId,threadId:row.threadId,failedTurnId:row.failedTurnId,kind,epoch:r.epoch,nativeIdentity:nativeIdentity(r.codex.process?.pid),state:'dispatching',createdAt:iso(this.clock())};
    r.store.put('nativeRecoveryAction',record);
    this.save(row,{[kind==='unsubscribe'?'releaseActionId':'resumeActionId']:id,phase:kind==='unsubscribe'?'releasing':'resuming'});
    try {
      const tracking={retainRecoveryReceipt:true,onRequestId:requestId=>r.store.put('nativeRecoveryAction',{...record,requestId})};
      const result=await this.scope.run({actionId:id},()=>fn(id,tracking));
      r.store.put('nativeRecoveryAction',{...r.store.get('nativeRecoveryAction',id),state:'acknowledged',result,finishedAt:iso(this.clock())});return result;
    } catch(error) {
      const observed=r.store.get('nativeRecoveryAction',id);
      if(observed?.state!=='acknowledged')r.store.put('nativeRecoveryAction',{...observed,state:error.recoveryNotSubmitted?'not-submitted':error.rpcCode===-32601?'unsupported':'uncertain',finishedAt:iso(this.clock())});
      throw failure(error.rpcCode===-32601?'The pinned native recovery operation is unsupported.':'Original recovery acknowledgement is unconfirmed; checking its original state without repeating it.');
    }
  }
  async systemError(botId, token, read,call=(m,p,t)=>this.runtime.codex.call(m,p,12000,t)) {
    const r=this.runtime,b=r.store.bot(botId);
    await this.qualifyRetained(botId,token);
    const page=await call('thread/turns/list',{threadId:b.threadId,cursor:null,limit:2,sortDirection:'desc',itemsView:'notLoaded'});
    this.localFence(botId,token);
    const last=page?.data?.[0];
    if(!Array.isArray(page?.data)||!usableTurn(last)||last.status!=='failed'||page.data.some(t=>t.status==='inProgress'))throw failure('The original latest failed native turn is not confirmed.');
    let row=this.get(botId);
    if(!row || row.threadId!==b.threadId || row.failedTurnId!==last.id || !row.terminalConfirmed) {
      this.note(botId,{method:'turn/completed',params:{threadId:b.threadId,turn:last}},true);row=this.get(botId);
    }
    this.runtime.store.put('nativeErrorRecovery',{...row,lastNativeStatus:'systemError',lastObservedAt:iso(this.clock())});
    const verifiedAuth=row.authVerifiedEpoch===r.epoch&&r.account?.authenticated===true&&row.authenticationFailure===true;
    if(row.nativeRetry || !transient.has(row.errorCode)&&!verifiedAuth)throw failure('This failure needs owner attention; safe current-state checks will continue.');
    if(row.releaseActionId) {
      const action=r.store.get('nativeRecoveryAction',row.releaseActionId);
      if(action?.state==='unsupported' && action.epoch===r.epoch)throw failure('The pinned recovery operation is unsupported; a compatible runtime update is required.');
      if(!['not-submitted','connection-ended'].includes(action?.state) && !(action?.state==='unsupported' && action.epoch!==r.epoch))throw failure('Waiting for the original native thread to unload; no input is being replayed.');
    }
    const control=await this.guards(botId,token,read,'systemError',call);
    await this.action(row,'unsubscribe',async(_id,tracking)=>{
      try{if(this.localFence(botId,token)!==control)throw failure('Recovery control changed before unsubscribe.');}catch(e){e.recoveryNotSubmitted=true;throw e;}
      const result=await call('thread/unsubscribe',{threadId:b.threadId},tracking);
      if(!['unsubscribed','notSubscribed','notLoaded'].includes(result?.status))throw failure('Native unsubscribe returned an unconfirmed state.');
      return {status:result.status};
    });
    // Keep the positive original action receipt even when controls or native
    // activity change while it is awaiting its acknowledgement.
    if(this.localFence(botId,token)!==control)throw failure('Recovery state changed after unsubscribe; the original acknowledgement is retained.');
    const current=this.get(botId);
    if(current.threadId===b.threadId && current.failedTurnId===row.failedTurnId && current.phase!=='superseded')this.save(current,{phase:'waiting-unload',reason:'Native unloading may require its 30-minute inactivity grace period.'});
    throw failure('Waiting for native unloading before reopening the same conversation.');
  }
  async resume(botId, token, read, expectedStatus='notLoaded',call=(m,p,t)=>this.runtime.codex.call(m,p,12000,t)) {
    const row=this.get(botId),r=this.runtime,b=r.store.bot(botId);
    await this.qualifyRetained(botId,token);
    const released=row.releaseActionId?r.store.get('nativeRecoveryAction',row.releaseActionId):null;
    // Current-state metadata is not the missing action ACK. A live-process
    // unknown request could still complete after a reload, so never race it.
    if(['dispatching','uncertain'].includes(released?.state))throw failure('The original unsubscribe acknowledgement must settle before reopening this thread.');
    const control=await this.guards(botId,token,read,expectedStatus,call);
    if(row.authenticationFailure){
      const account=await call('account/read',{refreshToken:true});
      r.account={authenticated:Boolean(account.account)||account.requiresOpenaiAuth===false};
      if(!r.account.authenticated)throw failure('Codex sign-in is required before reopening this conversation.');
      if(this.localFence(botId,token)!==control)throw failure('Recovery control changed during authentication verification.');
    }
    r.loaded.delete(b.threadId);
    await this.action(row,'resume',async(id,tracking)=>{await r.load(b,{nativeRecoveryActionId:id,nativeRecoveryTracking:tracking,nativeRecoveryCall:call,
      nativeRecoveryBeforeSubmit:()=>{if(this.localFence(botId,token)!==control)throw failure('Recovery control changed before resume.');}});return {threadId:b.threadId};});
    if(this.localFence(botId,token)!==control)throw failure('Recovery state changed after resume; the original acknowledgement is retained.');
    // A same-connection thread/started notification may confirm a lost ACK.
    const latest=this.get(botId),a=latest.resumeActionId?r.store.get('nativeRecoveryAction',latest.resumeActionId):null;
    if(a?.epoch===r.epoch && a.state==='acknowledged' && r.store.bot(botId).threadId===b.threadId)r.loaded.add(b.threadId);
  }
  failed(botId, error) {
    const row=this.get(botId);if(!row || ['superseded','recovered'].includes(row.phase))return null;
    const attempts=(row.attempts??0)+1,next=iso(this.clock()+recoveryDelay(attempts,this.random,row.retryAfterMs??0));
    const unsupported=error.rpcCode===-32601 || [row.releaseActionId,row.resumeActionId].filter(Boolean).some(id=>{const a=this.runtime.store.get('nativeRecoveryAction',id);return a?.state==='unsupported'&&a.epoch===this.runtime.epoch;});
    return this.save(row,{attempts,nextRetryAt:next,...(unsupported?{phase:'action-required'}:{}),reason:unsupported ? 'A required native recovery operation is unsupported; a compatible runtime is needed.' : error.nativeRecoverySafe ? error.message : 'Native current-state recovery is unavailable; checking again without replaying input.'});
  }
  complete(botId) {
    const row=this.get(botId),b=this.runtime.store.bot(botId);
    if(!row || row.threadId!==b.threadId || ['recovered','superseded'].includes(row.phase))return;
    const transientError=transient.has(row.errorCode)||row.authVerifiedEpoch===this.runtime.epoch&&this.runtime.account?.authenticated===true&&row.authenticationFailure===true;
    this.save(row,{phase:'recovered',nextRetryAt:null,reason:null,nativeRetry:false,nativeRetryEpoch:null});
    if(transientError)this.runtime.saveBot(this.runtime.store.bot(botId),{error:null});
  }
  retry(botId,p) {
    const row=this.get(botId),b=this.runtime.store.bot(botId);
    if(Object.keys(p).some(k=>!['threadId','failedTurnId'].includes(k)) || !row || p.threadId!==b.threadId || row.threadId!==b.threadId || p.failedTurnId!==row.failedTurnId)throw Object.assign(Error('The original recovery changed. Refresh this conversation.'),{outcome:'rejected'});
    return this.summary(this.save(row,{nextRetryAt:iso(this.clock())}));
  }
  receipt(p) {
    const r=this.runtime,a=r.store.list('nativeRecoveryAction').find(a=>a.epoch===r.epoch && a.requestId===p.requestId && a.threadId===p.threadId &&
      (a.kind==='unsubscribe'?'thread/unsubscribe':'thread/resume')===p.method && ['dispatching','uncertain'].includes(a.state));
    if(!a)return;
    if(p.rpcCode===-32601){r.store.put('nativeRecoveryAction',{...a,state:'unsupported',evidence:'original-late-native-method-rejection',finishedAt:iso(this.clock())});return;}
    const valid=a.kind==='unsubscribe'?['unsubscribed','notSubscribed','notLoaded'].includes(p.status):p.resumedThreadId===a.threadId;
    if(!valid)return; // malformed/error ACK retains its original uncertainty
    r.store.put('nativeRecoveryAction',{...a,state:'acknowledged',result:a.kind==='unsubscribe'?{status:p.status}:{threadId:a.threadId},evidence:'original-late-native-request-id',finishedAt:iso(this.clock())});
  }
  uncertain() {return this.runtime.store.list('nativeRecoveryAction').filter(a=>['dispatching','uncertain'].includes(a.state)).length;}
}
