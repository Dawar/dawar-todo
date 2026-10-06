"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { botsClient as client } from './bots/client';
import { BotAvatar } from './bots/bot-avatar';
import type { BotQueueList } from '../lib/bots-types';
import type { TaskQueueSource, TaskQueueExportReceipt } from '../lib/task-queue-export';
import { createTransfer, readTransfers, runTransfer, saveTransfer, type TaskTransfer } from './todo-queue-transfer';
import './todo-forward.css';
export type QueueRequest = {
    id: string;
    todoIds: number[];
};
async function metadata<T>(url: string, input?: unknown): Promise<T> {
    const response = await fetch(url, { method: input ? 'POST' : 'GET', headers: input ? { 'Content-Type': 'application/json' } : undefined, body: input ? JSON.stringify(input) : undefined, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(125000) });
    const result = await response.json() as T & {
        error?: string;
    };
    if (!response.ok)
        throw Error(result.error || 'Task transfer confirmation unavailable. Keep the original intent.');
    return result as T;
}
export function TodoQueue({ request, onClose, guard, onChanged }: {
    request: QueueRequest | null;
    onClose: () => void;
    guard: (id: number, source?: TaskQueueSource) => Promise<void>;
    onChanged: () => void;
}) {
    const [, redraw] = useState(0);
    const [saved, setSaved] = useState<TaskTransfer[]>([]), [open, setOpen] = useState(false), [error, setError] = useState('');
    const read = useCallback(() => { redraw(v => v + 1); try {
        setSaved(client.owner ? readTransfers(client.owner) : []);
        setError('');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Saved transfer needs recovery.');
    } }, []);
    useEffect(() => { client.start(); queueMicrotask(read); const unsubscribe = client.subscribe(read); window.addEventListener('storage', read); return () => { unsubscribe(); window.removeEventListener('storage', read); }; }, [read]);
    const close = useCallback(() => { setOpen(false); read(); onClose(); }, [onClose, read]);
    const resume = request ? saved.find(v => v.items.some(i => request.todoIds.includes(i.todoId))) : saved[0];
    return <>{!request && resume && <button type="button" className="todo-forward-recovery" onClick={() => setOpen(true)}>Continue saved task queue transfer</button>}{error && <p role="alert">{error}</p>}
 {(request || open && resume) && <QueuePicker key={`${client.owner}:${request?.id ?? resume?.id}`} request={request} saved={resume ?? null} onClose={close} guard={guard} onChanged={onChanged}/>}</>;
}
export function QueuePicker({ request, saved, onClose, guard, onChanged }: {
    request: QueueRequest | null;
    saved: TaskTransfer | null;
    onClose: () => void;
    guard: (id: number, source?: TaskQueueSource) => Promise<void>;
    onChanged: () => void;
}) {
    const [view, setView] = useState(saved);
    const [listAttempt, retryLists] = useState(0);
    const [, redraw] = useState(0), [search, setSearch] = useState(''), [botId, setBotId] = useState(saved?.botId ?? ''), [listId, setListId] = useState<string | null>(saved?.listId ?? null), [lists, setLists] = useState<BotQueueList[] | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
    const intent = useRef(saved), inFlight = useRef(false), mounted = useRef(true), dialog = useRef<HTMLDivElement>(null), owner = client.owner;
    useEffect(() => { mounted.current = true; client.start(); const un = client.subscribe(() => redraw(v => v + 1)); return () => { mounted.current = false; un(); }; }, []);
    useEffect(() => { let live = true; queueMicrotask(() => { if (!live || saved || !owner)
        return; try {
        const last = JSON.parse(localStorage.getItem(`dawar-todo-queue:last:${owner}`) || 'null');
        if (last && client.snapshot?.bots.some(b => b.id === last.botId && !b.archived)) {
            setBotId(last.botId);
            setListId(last.listId);
        }
    }
    catch { /* picker remains available */ } }); return () => { live = false; }; }, [owner, saved]);
    useEffect(() => { let live = true; queueMicrotask(() => { if (live)
        setLists(null); }); if (!botId)
        return () => { live = false; }; client.rpc<BotQueueList[]>('queueLists.list', botId, {}, undefined, { owner, managed: true }).then(v => { if (live && client.owner === owner)
        setLists(v); }, e => { if (live)
        setError(e.message); }); return () => { live = false; }; }, [botId, owner, listAttempt]);
    useEffect(() => { const previous = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; dialog.current?.querySelector<HTMLInputElement>('input')?.focus(); const key = (e: KeyboardEvent) => { if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
    } if (e.key === 'Tab') {
        const list = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,a[href]') ?? [])].filter(x => x.getClientRects().length);
        if (e.shiftKey && document.activeElement === list[0]) {
            e.preventDefault();
            list.at(-1)?.focus();
        }
        else if (!e.shiftKey && document.activeElement === list.at(-1)) {
            e.preventDefault();
            list[0]?.focus();
        }
    } }; document.addEventListener('keydown', key, true); return () => { document.removeEventListener('keydown', key, true); document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); }; }, [onClose]);
    async function submit() {
        if (inFlight.current || !owner || client.owner !== owner)
            return;
        inFlight.current = true;
        setBusy(true);
        setError('');
        try {
            if (!client.snapshot?.capabilities?.taskQueues)
                throw Error('Task queueing is not available yet. Your tasks stay active.');
            if (!client.snapshot.bots.some(b => b.id === botId && !b.archived))
                throw Error('Original destination bot is unavailable.');
            if (!intent.current) {
                if (!lists || listId !== null && !lists.some(l => l.id === listId))
                    throw Error('Choose an existing queue list.');
                if (!navigator.locks)
                    throw Error("This browser cannot reserve a recoverable task transfer. Use a browser with Web Locks support.");
                await navigator.locks.request(`todo-queue-intent:${owner}`, () => { if (client.owner !== owner)
                    throw Error("Signed-in owner changed."); const pending = readTransfers(owner).find(v => v.items.some(i => request!.todoIds.includes(i.todoId))); if (pending)
                    throw Error("This selection already has an unfinished transfer. Close and reopen to confirm its original destination."); intent.current = createTransfer(owner, botId, listId, request!.todoIds); saveTransfer(intent.current); });
                setView(structuredClone(intent.current));
                localStorage.setItem(`dawar-todo-queue:last:${owner}`, JSON.stringify({ botId, listId }));
            }
            const current = intent.current;
            if (!current)
                throw Error("Task transfer reservation is unavailable.");
            await runTransfer(current, { currentOwner: () => client.owner, guard, source: async (id, bot) => (await metadata<{
                    source: TaskQueueSource;
                }>(`/api/todos/${id}/queue-export?botId=${encodeURIComponent(bot)}`)).source,
                export: async (id, bot, source, operationId) => (await metadata<{
                    receipt: TaskQueueExportReceipt;
                }>(`/api/todos/${id}/queue-export`, { operationId, botId: bot, sourceRevision: source.revision })).receipt,
                add: (bot, p, id) => client.rpc('queue.add', bot, p, id, { owner, managed: true }), confirm: (bot, p, id) => client.rpc('queue.taskConfirm', bot, p, id, { owner, managed: true }), persist: saveTransfer, changed: () => { if (mounted.current) {
                    setView(structuredClone(intent.current));
                    redraw(v => v + 1);
                    onChanged();
                } } });
        }
        catch (e) {
            if (mounted.current)
                setError(e instanceof Error ? e.message : 'Retain the original task transfer.');
        }
        finally {
            inFlight.current = false;
            if (mounted.current) {
                setBusy(false);
                setView(structuredClone(intent.current));
                redraw(v => v + 1);
            }
        }
    }
    const bots = (client.snapshot?.bots ?? []).filter(b => !b.archived && `${b.name} ${b.purpose}`.toLowerCase().includes(search.toLowerCase()));
    const frozen = Boolean(view), items = view?.items, complete = Boolean(items?.every(i => i.delegation || i.rejected));
    return createPortal(<div className="todo-forward-backdrop" onClick={e => { if (e.target === e.currentTarget)
        onClose(); }}><div ref={dialog} className="todo-forward-dialog todo-queue-dialog" role="dialog" aria-modal="true" aria-labelledby="todo-queue-title">
 <header><div><h2 id="todo-queue-title">Queue to bot</h2><p>{saved?.items.length ?? request?.todoIds.length} task{(saved?.items.length ?? request?.todoIds.length) !== 1 ? "s" : ""} · One message per task. Confirmed tasks leave the active list; originals stay in All.</p></div><button type="button" aria-label="Close task queue picker" onClick={onClose}><X size={20}/></button></header>
 {saved && request && <p className="todo-forward-note">Confirm this selection’s unfinished transfer at its original destination first.</p>}
 <label className="todo-forward-search"><Search size={18}/><input aria-label="Find a bot" placeholder="Find a bot" disabled={frozen || busy} value={search} onChange={e => setSearch(e.target.value)}/></label>
 <div className="todo-forward-list">{bots.slice(0, 60).map(bot => <button type="button" key={bot.id} aria-pressed={bot.id === botId} disabled={busy || frozen} onClick={() => { setBotId(bot.id); setListId(null); setError(''); }}><BotAvatar bot={bot} small/><span><strong>{bot.name}</strong><small>{bot.purpose || 'Conversation'}</small></span>{bot.id === botId ? 'Selected' : ''}</button>)}{!bots.length && <p>No matching bots.</p>}{bots.length > 60 && <p>Search to narrow {bots.length} bots.</p>}</div>
 {botId && <label className="todo-forward-note">Queue <select aria-label="Destination queue" value={listId ?? ''} disabled={busy || frozen || !lists} onChange={e => setListId(e.target.value || null)}><option value="">Queued next</option>{lists?.map(l => <option key={l.id} value={l.id}>{l.name} · {l.count} · {l.cron ? (l.enabled ? 'scheduled' : 'schedule paused') : 'unscheduled'}</option>)}{listId && !lists?.some(l => l.id === listId) && <option value={listId}>Original list unavailable</option>}</select>{!lists && ' Loading lists…'}</label>}
 {!client.online && <p className="todo-forward-note">Offline. Your original transfer is retained.</p>}{!client.snapshot?.capabilities?.taskQueues && <p className="todo-forward-note">Task queueing is not available yet. Your tasks stay active.</p>}
 <div className="todo-queue-progress" aria-live="polite">{items?.map(i => <p key={i.todoId} className="todo-forward-note">Task {i.todoId}: {i.rejected ? 'Not queued · task stays active' : i.delegation ? (i.active ? 'Queued · newer task stays active' : 'Queued · retained in All') : i.accepted ? 'Queued · confirming task list update' : i.queueRequested ? 'Awaiting queue confirmation' : i.queueParams ? 'Files ready · not queued' : 'Not queued'}{i.error && ` — ${i.error}`}</p>)}</div>
 {error && <p role="alert" className="todo-forward-error">{error}</p>}{botId && !lists && error && <button type="button" disabled={busy || !client.online} onClick={() => { setError(''); retryLists(v => v + 1); }}>Retry queue lists</button>}<footer><button type="button" disabled={!complete && (busy || !botId || !client.online || !client.snapshot?.capabilities?.taskQueues || !frozen && (!lists || listId !== null && !lists.some(l => l.id === listId)))} onClick={() => complete ? onClose() : void submit()}>{complete ? "Done" : busy ? 'Confirming…' : frozen ? 'Check original transfer' : 'Queue'}</button></footer>
 </div></div>, document.body);
}
