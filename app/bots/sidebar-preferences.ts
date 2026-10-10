"use client";
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { MAX_SIDEBAR_TEAMS, sidebarChoice, sidebarMutation, type SidebarChoice, type SidebarChoiceMutation, type SidebarChoicesResponse, type SidebarChoiceReceipt } from '../../lib/bot-sidebar-preferences';

type Pending = { request: SidebarChoiceMutation; desired: boolean; changedAfterRequest?: boolean; intentVersion: string };
type State = { choices: Record<string, SidebarChoice>; pending: Record<string, Pending>; error: string };
const empty = (): State => ({ choices: {}, pending: {}, error: '' });
type Transport = (method: 'GET' | 'PATCH', owner: string, request?: SidebarChoiceMutation) => Promise<SidebarChoicesResponse | SidebarChoiceReceipt>;
const transport: Transport = async (method, owner, request) => {
  const response = await fetch('/api/bots/sidebar-preferences', { method, credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Dawar-Preference-Owner': owner }, body: request && JSON.stringify(request), signal: AbortSignal.timeout(8000) });
  const value: unknown = await response.json();
  if (!response.ok) {
    const message = value && typeof value === 'object' && 'error' in value && typeof value.error === 'string' ? value.error : 'Team choices could not be saved. Retry.';
    throw Error(message);
  }
  return value as SidebarChoicesResponse | SidebarChoiceReceipt;
};

/** Narrow owner-local recovery for explicit accordion choices. In-flight
 * mutations remain immutable across reload/timeout; search never writes here. */
export class SidebarPreferences {
  private state = empty(); private listeners = new Set<() => void>();
  private reading: Promise<void> | null = null; private writing = false; private alive = true;
  private key: string; private pendingPrefix: string;
  constructor(readonly owner: string, private request: Transport = transport) {
    this.key = `dawar-bots:${owner}:sidebar-choices:v1`;
    this.pendingPrefix = `${this.key}:pending:`;
    try {
      const raw = owner && localStorage.getItem(this.key);
      if (raw && raw.length <= 128 * 1024) {
        const value = JSON.parse(raw) as State;
        if (value.choices && typeof value.choices === 'object' && !Array.isArray(value.choices) && Object.keys(value.choices).length <= MAX_SIDEBAR_TEAMS &&
          Object.entries(value.choices).every(([key, choice]) => sidebarChoice(choice) && choice.teamId === key))
          this.state = { choices: value.choices, pending: {}, error: '' };
      }
    } catch { /* Corrupt or unavailable local storage never blocks the list. */ }
    try { if (owner) this.readPending(); } catch { /* Original operation keys remain for recovery. */ }
  }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  getSnapshot = () => this.state;
  private teamPending(teamId: string) { return Object.values(this.state.pending).filter(p => p.request.teamId === teamId).sort((a,b) => a.intentVersion.localeCompare(b.intentVersion)).at(-1); }
  collapsed = (teamId: string) => this.teamPending(teamId)?.desired ?? this.state.choices[teamId]?.collapsed ?? false;
  private validPending(value: Pending) { return value && sidebarMutation(value.request) && typeof value.desired === 'boolean' && typeof value.intentVersion === 'string' && /^\d{13}:[a-zA-Z0-9-]{1,100}$/.test(value.intentVersion); }
  private sameRequest(a: SidebarChoiceMutation, b: SidebarChoiceMutation) { return a.teamId === b.teamId && a.collapsed === b.collapsed && a.expectedRevision === b.expectedRevision && a.operationId === b.operationId; }
  private readPending() {
    // Each original operation has its own recovery key. A second tab saving
    // choices cannot overwrite an in-flight operation from this tab.
    const pending = { ...this.state.pending };
    for (let n = 0, seen = 0; n < localStorage.length && seen < MAX_SIDEBAR_TEAMS; n++) {
      const key = localStorage.key(n); if (!key?.startsWith(this.pendingPrefix)) continue;
      seen++;
      try {
        const raw = localStorage.getItem(key); if (!raw || raw.length > 2048) continue;
        const value = JSON.parse(raw) as Pending;
        if (this.validPending(value) && key === this.pendingPrefix + value.request.operationId && (pending[value.request.operationId] || Object.keys(pending).length < MAX_SIDEBAR_TEAMS) && (!pending[value.request.operationId] || this.sameRequest(pending[value.request.operationId].request, value.request) && pending[value.request.operationId].intentVersion < value.intentVersion)) pending[value.request.operationId] = value;
      } catch { /* An invalid record cannot change another saved operation. */ }
    }
    this.state = { ...this.state, pending };
  }
  private persist() {
    try {
      const cached = localStorage.getItem(this.key);
      if (cached && cached.length <= 128 * 1024) {
        try {
          const value = JSON.parse(cached) as State;
          if (value.choices && Object.keys(value.choices).length <= MAX_SIDEBAR_TEAMS)
            Object.entries(value.choices).forEach(([key, choice]) => { if (sidebarChoice(choice) && choice.teamId === key) this.merge(choice); });
        } catch { /* Replace only invalid disposable choice metadata. */ }
      }
      localStorage.setItem(this.key, JSON.stringify({ choices: this.state.choices }));
      for (const [operationId, value] of Object.entries(this.state.pending)) {
        const raw = localStorage.getItem(this.pendingPrefix + operationId);
        let stored: Pending | null = null;
        if (raw) {
          if (raw.length > 2048) return false;
          stored = JSON.parse(raw) as Pending;
          if (!this.validPending(stored) || !this.sameRequest(stored.request, value.request)) return false;
        }
        const next = stored && stored.intentVersion > value.intentVersion ? stored : value;
        this.state = { ...this.state, pending: { ...this.state.pending, [operationId]: next } };
        localStorage.setItem(this.pendingPrefix + operationId, JSON.stringify(next));
      }
      return true;
    }
    catch { return false; }
  }
  private publish(next: State) {
    if (!this.alive) return;
    this.state = next;
    if (!this.persist()) this.state = { ...this.state, error: 'This device could not retain unsynced team choices. Retry when storage is available.' };
    for (const fn of this.listeners) fn();
  }
  private merge(choice: SidebarChoice) {
    if ((this.state.choices[choice.teamId]?.revision ?? -1) <= choice.revision)
      this.state = { ...this.state, choices: { ...this.state.choices, [choice.teamId]: choice } };
  }
  toggle(teamId: string) {
    if (!this.owner) return;
    try { this.readPending(); } catch { /* Persistence is checked before dispatch. */ }
    if (!this.teamPending(teamId) && (Object.keys(this.state.pending).length >= MAX_SIDEBAR_TEAMS || !this.state.choices[teamId] && new Set([...Object.keys(this.state.choices), ...Object.values(this.state.pending).map(p => p.request.teamId)]).size >= MAX_SIDEBAR_TEAMS)) {
      this.publish({ ...this.state, error: 'Too many saved team choices.' }); return;
    }
    const desired = !this.collapsed(teamId), prior = this.teamPending(teamId);
    const request = prior?.request ?? { teamId, collapsed: desired, expectedRevision: this.state.choices[teamId]?.revision ?? 0, operationId: crypto.randomUUID() };
    if (!sidebarMutation(request)) return;
    const time = Math.max(Date.now(), prior ? Number(prior.intentVersion.slice(0, 13)) + 1 : 0);
    this.publish({ ...this.state, pending: { ...this.state.pending, [request.operationId]: { request, desired, changedAfterRequest: Boolean(prior), intentVersion: `${time}:${crypto.randomUUID()}` } }, error: '' });
    void this.sync();
  }
  refresh = async () => {
    if (!this.owner || !this.alive) return;
    if (this.reading) return this.reading;
    this.reading = (async () => {
      try {
        const response = await this.request('GET', this.owner) as SidebarChoicesResponse;
        if (!this.alive) return;
        if (response.version !== 1 || response.owner !== this.owner || !Array.isArray(response.choices) || response.choices.length > MAX_SIDEBAR_TEAMS || !response.choices.every(sidebarChoice) || new Set(response.choices.map(c => c.teamId)).size !== response.choices.length) throw Error('Saved team choices could not be verified. Retry.');
        response.choices.forEach(choice => this.merge(choice));
        this.publish({ ...this.state, error: '' });
      } catch (error) { if (this.alive) this.publish({ ...this.state, error: error instanceof Error ? error.message : 'Saved team choices are unavailable. Retry.' }); }
      finally { this.reading = null; }
    })();
    return this.reading;
  };
  sync = async () => {
    if (this.writing || !this.alive || !this.owner) return;
    this.writing = true;
    try {
      await this.refresh();
      // One bounded pass; a repeatedly conflicting device never spins or
      // silently renews uncertain IDs. Remaining choices keep their receipts.
      for (let count = 0; count < 8 && this.alive; count++) {
        try { this.readPending(); } catch { /* The write-ahead guard below contains storage failure. */ }
        const [operationId, pending] = Object.entries(this.state.pending).sort((a,b) => a[1].intentVersion.localeCompare(b[1].intentVersion))[0] ?? [];
        if (!pending) break;
        const teamId = pending.request.teamId;
        if (!this.persist()) throw Error('This device could not retain the original choice. Retry when storage is available.');
        const response = await this.request('PATCH', this.owner, pending.request) as SidebarChoiceReceipt;
        if (!this.alive) return;
        if (response.version !== 1 || response.owner !== this.owner || response.operationId !== pending.request.operationId || typeof response.applied !== 'boolean' || !sidebarChoice(response.choice) || response.choice.teamId !== teamId || response.applied && (response.choice.revision !== pending.request.expectedRevision + 1 || response.choice.collapsed !== pending.request.collapsed)) throw Error('Team choice acknowledgement could not be verified. Retry the same choice.');
        try { this.readPending(); } catch { /* Keep the in-memory original on unavailable storage. */ }
        this.merge(response.choice);
        const latest = this.state.pending[operationId] ?? pending, desired = latest.desired;
        const current = this.state.choices[teamId];
        const next = { ...this.state.pending };
        delete next[operationId];
        if (current.collapsed !== desired && !(current.revision > response.choice.revision && !latest.changedAfterRequest) && !Object.values(next).some(p => p.request.teamId === teamId && p.intentVersion > latest.intentVersion)) {
          if (!response.applied && response.choice.revision === pending.request.expectedRevision) throw Error('This team choice could not be saved. Retry the same choice.');
          // Only a positive response settles the original immutable operation.
          // A confirmed revision conflict can then rebase the latest choice.
          const request = { teamId, collapsed: desired, expectedRevision: current.revision, operationId: crypto.randomUUID() };
          next[request.operationId] = { request, desired, intentVersion: latest.intentVersion };
        }
        this.publish({ ...this.state, pending: next, error: '' });
        // Only the positively acknowledged immutable operation is retired.
        // If cleanup fails its receipt is safe to reconcile again on reload.
        try {
          const raw = localStorage.getItem(this.pendingPrefix + operationId), stored = raw ? JSON.parse(raw) as Pending : null;
          if (!stored || this.validPending(stored) && stored.intentVersion <= latest.intentVersion) localStorage.removeItem(this.pendingPrefix + operationId);
        } catch { /* Receipt remains authoritative. */ }
      }
      if (Object.keys(this.state.pending).length) this.publish({ ...this.state, error: 'Some team choices still await sync. Retry to continue.' });
    } catch (error) { if (this.alive) this.publish({ ...this.state, error: error instanceof Error ? error.message : 'Choices are saved on this device. Reconnect to sync.' }); }
    finally { this.writing = false; }
  };
  activate() { this.alive = true; }
  dispose() { this.alive = false; this.listeners.clear(); }
}

export function useSidebarPreferences(owner: string) {
  const store = useMemo(() => new SidebarPreferences(owner), [owner]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    store.activate();
    const refresh = () => { if (!document.hidden) void store.sync(); };
    refresh(); window.addEventListener('focus', refresh); window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    const storage = (event: StorageEvent) => { if (event.key?.startsWith(`dawar-bots:${owner}:sidebar-choices:v1`)) refresh(); };
    window.addEventListener('storage', storage);
    const timer = setInterval(refresh, 30_000);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', refresh); store.dispose(); };
  }, [store, owner]);
  return { store, state };
}
