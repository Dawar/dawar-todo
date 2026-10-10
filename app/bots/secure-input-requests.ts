'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { botsClient as client } from './client';
import type { SecureRequest } from '../../lib/secure-input';
import type { BotEvent } from '../../lib/bots-types';

export function mergeSecureMetadata(before: SecureRequest[], next: SecureRequest[]) {
  const rank = { waiting: 0, received: 1, unavailable: 2, expired: 3, deleted: 4 };
  const rows = new Map(before.map(r => [r.id, r]));
  for (const r of next) { const old = rows.get(r.id); if (!old || rank[r.state] >= rank[old.state]) rows.set(r.id, r); }
  return [...rows.values()].slice(0, 100);
}

export function useSecureInputRequests({ owner, botId, threadId, online, enabled }: {
  owner: string; botId: string; threadId: string | null; online: boolean; enabled: boolean;
}) {
  const key = JSON.stringify([owner, botId, threadId]);
  const [state, setState] = useState<{ key: string; requests: SecureRequest[]; loading: boolean; error: string }>({ key: '', requests: [], loading: false, error: '' });
  const refreshRef = useRef<() => void>(() => {});
  const retry = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let alive = true, pending = false, dirty = false, version = 0;
    const valid = () => alive && client.owner === owner;
    const scoped = (rows: SecureRequest[]) => rows.filter(r => r.botId === botId && r.threadId === threadId).slice(0, 100);
    const update = (change: (old: typeof state) => typeof state) => { if (valid()) setState(old => change(old.key === key ? old : { key, requests: [], loading: false, error: '' })); };
    const seed = () => {
      if (!valid()) return;
      const rows = scoped(client.snapshot?.secureInputs ?? []);
      if (rows.length) update(old => ({ ...old, requests: mergeSecureMetadata(old.requests, rows) }));
    };
    const refresh = () => {
      if (!valid() || !online || !enabled || !threadId) return;
      if (pending) { dirty = true; return; }
      pending = true; const startedVersion = version;
      update(old => ({ ...old, loading: true }));
      void client.rpc<SecureRequest[]>('secure.list', botId, {}, undefined, { owner }).then(rows => {
        if (!Array.isArray(rows)) throw Error('Invalid private form metadata.');
        if (startedVersion === version) update(old => ({ ...old, requests: mergeSecureMetadata(old.requests.filter(r => rows.some(next => next.id === r.id)), scoped(rows)), error: '' }));
        else dirty = true;
      }).catch(() => update(old => ({ ...old, error: 'Private forms could not be checked. Retry forms when connected.' }))).finally(() => {
        pending = false; update(old => ({ ...old, loading: false }));
        if (dirty && valid()) { dirty = false; refresh(); }
      });
    };
    const event = (event: BotEvent) => {
      if (event.type !== 'secure.status' || event.botId !== botId || !valid()) return;
      const request = event.data as SecureRequest;
      if (request.botId !== botId || request.threadId !== threadId) return;
      version++;
      update(old => ({ ...old, requests: mergeSecureMetadata(old.requests, [request]) }));
      refresh();
    };
    refreshRef.current = refresh;
    const unsubscribe = client.subscribe(seed);
    client.events.add(event);
    queueMicrotask(() => { update(old => ({ ...old, loading: false })); seed(); refresh(); });
    const timer = setInterval(refresh, 10000);
    return () => { alive = false; refreshRef.current = () => {}; unsubscribe(); client.events.delete(event); clearInterval(timer); };
  }, [key, owner, botId, threadId, online, enabled]);
  return { requests: state.key === key ? state.requests : [], loading: state.key === key && state.loading,
    error: state.key === key ? state.error : '', retry, enabled, online };
}
