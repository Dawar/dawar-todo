"use client";
import { useEffect, useRef, useState } from 'react';
import { botsClient as client } from './client';

import { queueActionPrefix, readQueueAction, type QueueActionMethod as Method, type PendingQueueAction as Pending } from './queue-action-store';
const message = (error: unknown) => error instanceof Error ? error.message : 'Queue action could not be confirmed.';
/** Exact action ID/parameters survive a lost response. No automatic retry after reload; the transport may replay an in-memory
 * request on reconnect with the same ID/parameters.
 * a matching queue list is not proof that this particular operation finished. */
export function useQueueAction(owner: string, botId: string, refresh: () => Promise<void>) {
  const prefix = queueActionPrefix(owner, botId);
  const [initial] = useState(() => readQueueAction(owner, botId));
  const [pending, setPending] = useState(initial.pending), [error, setError] = useState(initial.error), [busy, setBusy] = useState(false), [readBlocked, setReadBlocked] = useState(Boolean(initial.error));
  const [notSaved, setNotSaved] = useState(false);
  const pendingRef = useRef(pending), active = useRef(true), inFlight = useRef(false);
  const owned = () => client.owner === owner;
  const valid = () => active.current && owned();
  useEffect(() => {
    active.current = true;
    // React Activity disconnects effects without discarding state. Settlement
    // below remains origin-owned while hidden; resume mirrors actual refs too.
    void Promise.resolve().then(() => { if (active.current && client.owner === owner) { setPending(pendingRef.current); setBusy(inFlight.current); } });
    return () => { active.current = false; };
  }, [owner]);
  const adoptStored = () => {
    const stored = readQueueAction(owner, botId);
    pendingRef.current = stored.pending;
    if (owned()) { setPending(stored.pending); setNotSaved(false); setReadBlocked(Boolean(stored.error)); setError(stored.error); }
  };
  const send = async (next: Pending) => {
    if (!valid() || !client.online || inFlight.current) return false;
    const stored = readQueueAction(owner, botId);
    if (stored.error) { setError(stored.error); setReadBlocked(true); return false; }
    if (stored.pending && stored.pending.id !== next.id && !pendingRef.current) {
      pendingRef.current = stored.pending; setPending(stored.pending); setNotSaved(false); setError('Another tab has a queue action awaiting confirmation. Check that same action first.'); return false;
    }
    pendingRef.current = next; setPending(next);
    // Separate keys preserve both receipts if two tabs act concurrently. Neither
    // can overwrite the other's uncertain operation or exact parameters.
    try { localStorage.setItem(prefix+next.id, JSON.stringify(next)); }
    catch { setNotSaved(true); setError('This queue action was not sent because it could not be saved on this device. Retry after browser storage is available.'); return false; }
    inFlight.current = true; setNotSaved(false); setBusy(true); setError('');
    try {
      await client.rpc(next.method, botId, next.params, next.id, { owner, managed: true });
      localStorage.removeItem(prefix+next.id);
      adoptStored();
      return true;
    } catch (reason) {
      if ((reason as { outcome?: string }).outcome === 'rejected') {
        try { localStorage.removeItem(prefix+next.id); adoptStored(); }
        catch { if (owned()) setError('The server rejected this action, but its local receipt could not be cleared. Retry the same action to recover it.'); return false; }
      }
      if (owned()) setError(message(reason));
      return false;
    } finally {
      inFlight.current = false;
      if (owned()) setBusy(false);
      if (valid()) { try { await refresh(); } catch (reason) { if (valid()) setError(message(reason)); } }
    }
  };
  return { pending, error, busy, notSaved, blocked: Boolean(pending || readBlocked),
    run(method: Method, params: Record<string, unknown> = {}) {
      if (pendingRef.current || readBlocked) return Promise.resolve(false);
      return send({ id: crypto.randomUUID(), method, params, owner, botId });
    },
    retry() { if (pendingRef.current) void send(pendingRef.current); },
    recover() { if (valid() && !inFlight.current) adoptStored(); },
  };
}
