"use client";
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ControlledDialog } from '@/components/ui/controlled-dialog';
import { RefreshCw, ExternalLink } from 'lucide-react';
import { botsClient as client, BotRpcError } from './client';
import type { Bot } from './single-thread-contract';
import { isCodexAuthError, type CodexAuthRecoveryState } from '../../lib/codex-auth-recovery';

type AuthMethod = 'auth.check' | 'auth.login.start' | 'auth.login.cancel';
type Intent = { method: AuthMethod; operationId: string; params: { threadId: string; loginId?: string } };
export function CodexAuthRecovery({ owner, bot, online, supported, setupBusy, onRetrySetup, onReturn }: {
  owner: string; bot: Bot; online: boolean; supported: boolean; setupBusy: boolean; onRetrySetup: () => void; onReturn: () => void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [state, setState] = useState<CodexAuthRecoveryState>({ status: 'unknown' });
  const alive = useRef(true), inFlight = useRef(false), intent = useRef<Intent | null>(null);
  const [original, setOriginal] = useState<Intent | null>(null);
  const valid = () => alive.current && client.owner === owner && client.snapshot?.bots.find(value => value.id === bot.id)?.threadId === bot.threadId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, [owner, bot.id, bot.threadId]);
  const read = async () => {
    if (!online || !supported || !bot.threadId) return;
    try {
      const value = await client.rpc<CodexAuthRecoveryState>('auth.read', bot.id, { threadId: bot.threadId }, undefined, { owner });
      if (valid()) setState(value);
    } catch { if (valid()) setError('Could not check sign-in. Reconnect and try again.'); }
  };
  useEffect(() => {
    const event = (value: { type: string; botId?: string | null }) => { if (value.type === 'codex.auth' && value.botId === bot.id) void read(); };
    const foreground = () => { if (open && document.visibilityState === 'visible') void read(); };
    client.events.add(event); window.addEventListener('focus', foreground); document.addEventListener('visibilitychange', foreground);
    return () => { client.events.delete(event); window.removeEventListener('focus', foreground); document.removeEventListener('visibilitychange', foreground); };
    // Native account events and foregrounding refresh this live scope. No poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, bot.id, bot.threadId, online, supported, open]);
  useEffect(() => {
    if (!state.expiresAt || !state.userCode) return;
    const expires = setTimeout(() => setState(value => ({ ...value, status: 'expired', userCode: undefined, verificationUrl: undefined })), Math.max(0, state.expiresAt - Date.now()));
    return () => clearTimeout(expires);
  }, [state.expiresAt, state.userCode]);
  const act = async (method: AuthMethod, retry = false) => {
    if (inFlight.current || !online || !supported || !bot.threadId) return;
    if (intent.current && !retry && method !== 'auth.check') { setError('The original action needs confirmation. Check its result first.'); return; }
    const preserveOriginal = Boolean(intent.current && !retry);
    const request = retry ? intent.current : { method, operationId: crypto.randomUUID(), params: { threadId: bot.threadId, ...(method === 'auth.login.cancel' && state.loginId ? { loginId: state.loginId } : {}) } };
    if (!request) return;
    if (!preserveOriginal) { intent.current = request; setOriginal(request); }
    inFlight.current = true; setBusy(true); setError('');
    try {
      const value = await client.rpc<CodexAuthRecoveryState>(request.method, bot.id, request.params, request.operationId, { owner });
      if (!valid()) return;
      if (!preserveOriginal) { intent.current = null; setOriginal(null); }
      setState(value);
      if (request.method !== 'auth.check') await read();
    } catch (cause) {
      if (!valid()) return;
      if (!preserveOriginal && cause instanceof BotRpcError && cause.outcome !== 'uncertain') {intent.current = null; setOriginal(null);}
      setError(cause instanceof Error ? cause.message : 'The action was not confirmed. Check its result.');
    } finally { inFlight.current = false; if (valid()) setBusy(false); }
  };
  const needsRecovery = isCodexAuthError(bot.error);
  if (!bot.error && !open) return null;
  return <>
    {bot.error && <div className="bots-banner">
      <span>{needsRecovery ? state.status==='connected'?'Codex sign-in verified.':'Codex sign-in needs checking.' : bot.error}</span>
      {needsRecovery && bot.threadId ? <Button variant="ghost" size="sm" disabled={!online} onClick={() => { setOpen(true); if (supported) void act('auth.check'); }}>Recover connection</Button>
        : !bot.threadId && <Button variant="ghost" size="sm" disabled={!online || setupBusy} onClick={onRetrySetup}>Retry setup</Button>}
    </div>}
    {open && <ControlledDialog title="Codex connection" description="Sign-in is shared by bots on this execution machine." onClose={() => setOpen(false)} className="max-w-md">
      <div className="grid gap-4">
        {!supported ? <p>Codex recovery is not installed on this execution machine yet.</p>
          : state.status === 'connected' ? <p role="status">Codex sign-in is ready.{state.recovered ? ' You can continue this conversation.' : ' Your conversation is retained.'}</p>
          : state.status === 'needs-sign-in' ? <p>Sign in to Codex with the account used on this execution machine.</p>
          : state.status === 'pending' && state.verificationUrl && state.userCode ? <>
            <p>Open the sign-in page and enter this one-time code.</p>
            <p className="rounded-lg bg-muted p-3 text-center font-mono text-xl tracking-widest" aria-label="Sign-in code">{state.userCode}</p>
            <Button asChild><a href={state.verificationUrl} target="_blank" rel="noopener noreferrer">Sign in to Codex <ExternalLink size={16} aria-hidden="true" /></a></Button>
          </> : <p>{state.status === 'unconfirmed' ? 'The original sign-in is unconfirmed. Check the connection before another attempt.' : state.status === 'expired' ? 'This sign-in expired. Check the connection to continue.' : state.status === 'verify' ? 'Sign-in finished. Verify the connection to return to chat.' : 'Check the current Codex connection.'}</p>}
        {error && <p role="alert" className="text-sm text-destructive break-words">{error}</p>}
        {!online && <p role="status" className="text-sm text-muted-foreground">The execution machine is offline. Reconnect to continue.</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {original && error && <Button variant="outline" disabled={!online || busy} onClick={() => void act('auth.check', true)}>Check original action</Button>}
          {state.loginId && state.status !== 'connected' && <Button variant="outline" disabled={!online || busy || Boolean(original)} onClick={() => void act('auth.login.cancel')}>Cancel sign-in</Button>}
          {state.status === 'needs-sign-in' && <Button disabled={!online || busy || Boolean(original)} onClick={() => void act('auth.login.start')}>Sign in to Codex</Button>}
          {supported && <Button variant="outline" disabled={!online || busy} onClick={() => void act('auth.check')}><RefreshCw size={16} aria-hidden="true" />{busy ? 'Checking…' : 'Check connection'}</Button>}
          {state.status === 'connected' && <Button onClick={() => { setOpen(false); onReturn(); }}>Return to chat</Button>}
        </div>
      </div>
    </ControlledDialog>}
  </>;
}
