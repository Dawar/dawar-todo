'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { botsClient as client } from './client';
import { LazyDetails } from './lazy-details';
import type { BotOperations } from '../../lib/bots-operations';
import type { Bot, BotEvent } from '../../lib/bots-types';
import { taskRequestOwner } from '../../lib/task-request-client';
import { taskRequestSpec, type TaskRequest, type TaskRequestSource, type TaskRequestSpec, type TaskRequestField, type TaskRequestOwnerAction } from '../../lib/task-requests';
import { formJournal, formDraft, bindFormJournal, type FormIntent, type StoredFormAction } from '../task-request/journal';
import { mergeFormReceipt } from '../task-request/receipts';
import { TaskRequestFields, FormMarkdown, requestStatus } from '../task-request/form';
import '../task-request/task-request.css';
type SourceParams = {
    threadId: string;
    turnId?: string;
    itemId?: string;
    questionKey?: string;
    cursor?: string | null;
};
type Seed = {
    source: TaskRequestSource;
    spec: TaskRequestSpec;
    request?: TaskRequest;
};
type Ui = {
    supported: boolean;
    online: boolean;
    requests: TaskRequest[];
    openSource: (p: SourceParams) => void;
    openRequest: (r: TaskRequest) => void;
    loading: boolean;
    error: string;
    older: () => void;
    latest: () => void;
    cursor: string | null;
};
const Context = createContext<Ui | null>(null);
export function useTaskRequests() { return useContext(Context); }
export function CreateTaskRequest({ params }: {
    params: SourceParams;
}) {
    const ui = useTaskRequests();
    if (!ui?.supported)
        return null;
    return <button type="button" disabled={!ui.online || ui.loading} onClick={() => ui.openSource(params)}>Create Task Request</button>;
}
export function TaskRequestWorkspace({ owner, bot, online, supported, children }: {
    owner: string;
    bot: Bot | undefined;
    online: boolean;
    supported: boolean;
    children: ReactNode;
}) {
    const [requests, setRequests] = useState<TaskRequest[]>([]), [loading, setLoading] = useState(false), [error, setError] = useState(''), [cursor, setCursor] = useState<string | null>(null), [seed, setSeed] = useState<Seed | null>(null), [open, setOpen] = useState(false), [lookup, setLookup] = useState<SourceParams | null>(null);
    const alive = useRef(false), generation = useRef(0), sourceBusy = useRef(false), load = useRef<(before?: string) => void>(() => { }), opener = useRef<HTMLElement | null>(null);
    const valid = useCallback(() => !!(alive.current && client.owner === owner && client.snapshot?.bots.some(b => b.id === bot?.id && b.threadId === bot?.threadId)), [owner, bot?.id, bot?.threadId]);
    useEffect(() => {
        alive.current = true;
        let pending = false, dirty = false;
        const scope = ++generation.current;
        const refresh = (before?: string) => {
            if (!valid() || !online || !supported || !bot?.threadId)
                return;
            if (pending) {
                dirty = true;
                return;
            }
            pending = true;
            setLoading(true);
            void taskRequestOwner<{
                requests: TaskRequest[];
                nextCursor: string | null;
            }>({ action: 'list', botId: bot.id, threadId: bot.threadId, ...(before ? { before } : {}), limit: 40 }, AbortSignal.timeout(30000)).then(r => {
                if (!valid() || scope !== generation.current)
                    return;
                if (r.requests.length > 40 || r.requests.some(row => row.source.botId !== bot.id || row.source.threadId !== bot.threadId))
                    throw Error('Form page scope unavailable.');
                setRequests(old => r.requests.map(row => mergeFormReceipt(old.find(v => v.id === row.id) ?? null, row)));
                setCursor(r.nextCursor);
                setError('');
            }).catch(e => {
                if (valid())
                    setError(e instanceof Error ? e.message : 'Protected forms could not be read.');
            }).finally(() => {
                pending = false;
                if (valid()) {
                    setLoading(false);
                    if (dirty) {
                        dirty = false;
                        refresh();
                    }
                }
            });
        };
        load.current = refresh;
        const event = (e: BotEvent) => {
            if (e.botId === bot?.id && ['task-request', 'task-request.private'].includes(e.type) && (e.data as {
                threadId?: string;
            }).threadId === bot?.threadId)
                refresh();
        };
        client.events.add(event);
        queueMicrotask(() => refresh());
        return () => { alive.current = false; client.events.delete(event); load.current = () => { }; };
    }, [owner, bot?.id, bot?.threadId, online, supported, valid]);
    const resolve = async (params: SourceParams) => {
        if (!valid() || !online || !supported || params.threadId !== bot?.threadId || loading || sourceBusy.current)
            return;
        sourceBusy.current = true;
        const capturedGeneration = generation.current;
        setLoading(true);
        setError('');
        try {
            const r = await client.rpc<BotOperations['taskRequests.source']['result']>('taskRequests.source', bot!.id, params, undefined, { owner });
            if (!valid() || capturedGeneration !== generation.current)
                return;
            if (!r.source || !r.spec) {
                setLookup(r.nextCursor ? { ...params, cursor: r.nextCursor } : null);
                throw Error(r.nextCursor ? 'More source history remains. Continue the same lookup.' : 'This exact source is unavailable. Existing answers and drafts are retained.');
            }
            if (r.source.botId !== bot!.id || r.source.threadId !== params.threadId || params.questionKey && r.source.question?.key !== params.questionKey || params.itemId && (r.source.itemId !== params.itemId || r.source.turnId !== params.turnId))
                throw Error('Original form source changed.');
            setSeed({ source: r.source, spec: taskRequestSpec(r.spec) });
            setLookup(null);
            setOpen(true);
        }
        catch (e) {
            if (valid())
                setError(e instanceof Error ? e.message : 'Source lookup unavailable.');
        }
        finally {
            sourceBusy.current = false;
            if (valid())
                setLoading(false);
        }
    };
    const onSaved = useCallback((r: TaskRequest) => setRequests(old => [mergeFormReceipt(old.find(v => v.id === r.id) ?? null, r), ...old.filter(v => v.id !== r.id)].slice(0, 40)), []);
    const ui: Ui = { supported, online: online && !!bot && !bot.archived && !bot.queuePaused, requests, loading, error, cursor, openSource: p => { opener.current = document.activeElement as HTMLElement; void resolve(p); }, openRequest: r => {
            if (r.source.botId !== bot?.id || r.source.threadId !== bot.threadId)
                return;
            opener.current = document.activeElement as HTMLElement;
            setSeed({ source: r.source, spec: r.spec, request: r });
            setOpen(true);
        }, older: () => {
            if (cursor)
                load.current(cursor);
        }, latest: () => load.current() };
    return <Context.Provider value={ui}>{children}{error && <div className="task-request-error" role="alert">{error}{lookup && <button type="button" disabled={loading || !online} onClick={() => void resolve(lookup)}>Continue source lookup</button>}</div>}{seed && <TaskRequestEditor key={JSON.stringify([owner, seed.source, seed.request?.id])} owner={owner} seed={seed} open={open} available={online && !!bot && !bot.archived && !bot.queuePaused && supported} onClose={() => {
                setOpen(false);
                if (opener.current?.isConnected)
                    opener.current.focus({ preventScroll: true });
            }} onSaved={onSaved}/>}</Context.Provider>;
}
function TaskRequestEditor({ owner, seed, open, available, onClose, onSaved }: {
    owner: string;
    seed: Seed;
    open: boolean;
    available: boolean;
    onClose: () => void;
    onSaved: (r: TaskRequest) => void;
}) {
    const [request, setRequest] = useState(seed.request ?? null);
    const scope = JSON.stringify(['owner', owner, seed.source, request?.id ?? 'new']), [spec, setSpec] = useState(seed.spec), [preview, setPreview] = useState(false), [pin, setPin] = useState(''), [expiry, setExpiry] = useState(7), [link, setLink] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [pending, setPending] = useState<FormIntent | null>(null), [ready, setReady] = useState(false), [revoke, setRevoke] = useState(false);
    const mounted = useRef(false), recoveryGeneration = useRef(0), working = useRef(false), dialog = useRef<HTMLDivElement>(null), pinInput = useRef<HTMLInputElement>(null), writes = useRef(Promise.resolve());
    const stillHere = useCallback(() => !!(mounted.current && client.owner === owner && client.snapshot?.bots.some(b => b.id === seed.source.botId && b.threadId === seed.source.threadId)), [owner, seed.source.botId, seed.source.threadId]);
    const apply = (next: TaskRequestSpec) => {
        setSpec(next);
        writes.current = writes.current.catch(() => { }).then(() => formDraft(scope, next)).then(() => { }).catch(() => {
            if (mounted.current)
                setError('Editable draft could not be saved locally. Keep this editor open.');
        });
    };
    useEffect(() => {
        mounted.current = true;
        const capturedGeneration = ++recoveryGeneration.current;
        const current = () => mounted.current && capturedGeneration === recoveryGeneration.current && stillHere();
        queueMicrotask(() => {
            if (!current())
                return;
            setReady(false);
            void Promise.all([formJournal(scope, { kind: 'read' }), formDraft(scope)]).then(([intent, draft]) => {
                if (!current())
                    return;
                setPending(intent);
                if (draft && (!seed.request || seed.request.status === 'draft'))
                    setSpec(draft);
                if (intent?.requestId && !seed.request)
                    void taskRequestOwner<{
                        request: TaskRequest;
                    }>({ action: 'read', id: intent.requestId }, AbortSignal.timeout(30000)).then(({ request }) => {
                        if (current() && JSON.stringify(request.source) === JSON.stringify(seed.source)) {
                            setRequest(old => mergeFormReceipt(old, request));
                            if (request.status !== 'draft')
                                setSpec(request.spec);
                            onSaved(request);
                        }
                    }).catch(() => {
                        if (current())
                            setError('Saved request receipt could not be read. Retry the original action.');
                    });
                setReady(true);
            }).catch(() => {
                if (current())
                    setError('Form recovery storage unavailable. Nothing new was sent.');
            });
        });
        return () => { mounted.current = false; };
    }, [scope, seed.request, seed.source, onSaved, stillHere]);
    useEffect(() => {
        if (seed.request)
            queueMicrotask(() => {
                if (!stillHere())
                    return;
                setRequest(old => mergeFormReceipt(old, seed.request!));
                if (seed.request!.status !== 'draft')
                    setSpec(seed.request!.spec);
            });
    }, [seed.request, stillHere]);
    useEffect(() => {
        if (open)
            dialog.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    }, [open]);
    const invoke = async (action: StoredFormAction, recover = false) => {
        if (working.current || !available || !ready || !stillHere())
            return;
        working.current = true;
        setBusy(true);
        setError('');
        try {
            const pinRequired = action.action === 'publish' && (recover ? !!pending?.pinRequired : !!pin);
            if (pinRequired && !/^\d{4,12}$/.test(pin))
                throw Error('Re-enter the original PIN (4–12 digits) before confirming publication.');
            const intent = await formJournal(scope, { kind: 'admit', action, pinRequired });
            if (!intent)
                throw Error('Original form action unavailable.');
            setPending(intent);
            if (!stillHere())
                return;
            const result = await taskRequestOwner<{
                request: TaskRequest;
                url?: string;
            }>({ ...intent.action, ...(pinRequired ? { pin } : {}) } as TaskRequestOwnerAction, AbortSignal.timeout(30000));
            if (result.request.source.botId !== seed.source.botId || result.request.source.threadId !== seed.source.threadId || JSON.stringify(result.request.source) !== JSON.stringify(seed.source))
                throw Error('Original request source receipt changed.');
            await formJournal(scope, { kind: 'settle', operationId: intent.action.operationId, requestId: result.request.id });
            await bindFormJournal(scope, JSON.stringify(['owner', owner, seed.source, result.request.id]), intent.action.operationId);
            if (!mounted.current || !stillHere())
                return;
            setPending({ ...intent, state: 'accepted', requestId: result.request.id });
            setRequest(old => mergeFormReceipt(old, result.request));
            onSaved(result.request);
            if (result.url) {
                setLink(result.url);
                setPin('');
                if (pinInput.current)
                    pinInput.current.value = '';
            }
            setRevoke(false);
        }
        catch (e) {
            if (mounted.current && stillHere())
                setError(e instanceof Error ? e.message : 'Original action is unconfirmed.');
        }
        finally {
            working.current = false;
            if (mounted.current)
                setBusy(false);
        }
    };
    const save = () => {
        try {
            const valid = taskRequestSpec(spec);
            void invoke(request ? { action: 'edit', id: request.id, operationId: crypto.randomUUID(), expectedRevision: request.revision, spec: valid } : { action: 'draft', operationId: crypto.randomUUID(), source: seed.source, spec: valid });
        }
        catch (e) {
            setError((e as Error).message);
        }
    };
    const changeField = (id: string, change: Partial<TaskRequestField>) => apply({ ...spec, fields: spec.fields.map(f => f.id === id ? { ...f, ...change } : f) });
    const saved = request && JSON.stringify(request.spec) === JSON.stringify(spec), frozen = request && request.status !== 'draft', locked = busy || pending?.state === 'pending';
    const close = () => { setPin(''); setLink(''); onClose(); };
    if (!open)
        return null;
    return <div className="task-request-dialog-layer"><div className="task-request-editor" ref={dialog} role="dialog" aria-modal="true" aria-label="Task Request editor" onKeyDown={e => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
            if (e.key === 'Tab') {
                const nodes = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]')];
                const first = nodes[0], last = nodes.at(-1);
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last?.focus();
                }
                else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first?.focus();
                }
            }
        }}>
    <header className="task-request-actions"><h2>Task Request</h2><button type="button" onClick={close}>Close</button></header><p>Only the instructions and fields below are shared. Existing answer drafts and the conversation stay private.</p>
    {error && <p role="alert" className="task-request-error">{error}</p>}{!available && <p>Reconnect to this supported conversation and resolve Stop before owner actions.</p>}
    {pending?.state === 'pending' && <aside><p>Original {pending.action.action} is unconfirmed. Recover it before a new action.</p><button type="button" disabled={busy || !available} onClick={() => void invoke(pending.action, true)}>Confirm original action</button></aside>}
    <button type="button" onClick={() => setPreview(v => !v)}>{preview ? 'Edit fields' : 'Preview entire guest form'}</button>
    {preview || frozen ? <section className="task-request-preview"><h2>{spec.title}</h2><label>Your name · self-reported<input disabled/></label><TaskRequestFields spec={spec} values={{}} preview/>{spec.secure && <><label className="task-request-check"><input type="checkbox" disabled defaultChecked={false}/>Allow the model to read private fields/images and destination responses</label><p>Unchecked keeps content private. Explicit model/native history copies, website/session/autofill copies survive deletion of the transfer.</p></>}<p>One contributor · one final submission · {frozen ? request.expiresAt ? `Link expires ${new Date(request.expiresAt).toLocaleString()}` : 'Link expiry unavailable' : `${expiry} day link expiry`}{(frozen ? request.pinRequired : !!pin) ? ' · PIN protected' : ''}. Possession of the link permits access.</p></section> : <>
      <label>Title<input maxLength={100} disabled={locked} value={spec.title} onChange={e => apply({ ...spec, title: e.target.value })}/></label><label>Public instructions<textarea rows={4} maxLength={12000} disabled={locked} value={spec.instructions} onChange={e => apply({ ...spec, instructions: e.target.value })}/></label><label>Selected shared context<textarea rows={3} maxLength={12000} disabled={locked} value={spec.context} onChange={e => apply({ ...spec, context: e.target.value })}/></label>
      {spec.groups.map(g => <fieldset key={g.id}><legend>Requirement group</legend><label>Group label<input maxLength={200} disabled={locked} value={g.label} onChange={e => apply({ ...spec, groups: spec.groups.map(v => v.id === g.id ? { ...v, label: e.target.value } : v) })}/></label><label>Notes<textarea maxLength={2000} disabled={locked} value={g.notes ?? ''} onChange={e => apply({ ...spec, groups: spec.groups.map(v => v.id === g.id ? { ...v, notes: e.target.value } : v) })}/></label></fieldset>)}
      <button type="button" disabled={locked || spec.groups.length >= 12} onClick={() => apply({ ...spec, groups: [...spec.groups, { id: crypto.randomUUID(), label: 'New requirement group' }] })}>Add group</button>
      {spec.fields.map(f => <fieldset className="task-request-field-edit" key={f.id}><header><legend>{f.label || 'Field'}</legend><button type="button" disabled={locked || spec.fields.length === 1} onClick={() => apply({ ...spec, fields: spec.fields.filter(v => v.id !== f.id), ...(spec.fields.filter(v => v.id !== f.id).some(v => v.kind.startsWith('secure-')) ? {} : { secure: undefined }) })}>Remove field</button></header>
        <label>Label<input disabled={locked} maxLength={f.kind.startsWith('secure-') ? 100 : 200} value={f.label} onChange={e => changeField(f.id, { label: e.target.value })}/></label>
        <label>Type<select disabled={locked} value={f.kind} onChange={e => { const kind = e.target.value as TaskRequestField['kind']; const fields = spec.fields.map(v => v.id !== f.id ? v : { ...v, kind, choices: kind === 'choice' ? (v.choices ?? [{ id: 'option_1', label: 'Option 1' }]) : undefined }); apply({ ...spec, fields, secure: fields.some(v => v.kind.startsWith('secure-')) ? (spec.secure ?? { purpose: '', destination: { kind: 'desktop', label: '' } }) : undefined }); }}>{['text', 'long-text', 'choice', 'image', 'file', 'secure-text', 'secure-image'].map(k => <option key={k} value={k}>{{ text: 'Short text', 'long-text': 'Long text', choice: 'Choice', image: 'Image', file: 'File/PDF', 'secure-text': 'Private text', 'secure-image': 'Private image' }[k]}</option>)}</select></label>
        <label className="task-request-check"><input type="checkbox" disabled={locked} checked={f.required} onChange={e => changeField(f.id, { required: e.target.checked })}/>Required</label><label>Notes<textarea maxLength={2000} disabled={locked} value={f.notes ?? ''} onChange={e => changeField(f.id, { notes: e.target.value })}/></label>
        <label>Group<select disabled={locked} value={f.groupId ?? ''} onChange={e => changeField(f.id, { groupId: e.target.value || undefined })}><option value="">No group</option>{spec.groups.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}</select></label>
        {f.kind === 'choice' && <><p>Choices</p>{f.choices?.map(c => <label key={c.id}>Choice<input disabled={locked} value={c.label} maxLength={200} onChange={e => changeField(f.id, { choices: f.choices?.map(v => v.id === c.id ? { ...v, label: e.target.value } : v) })}/></label>)}<button type="button" disabled={locked || (f.choices?.length ?? 0) >= 20} onClick={() => changeField(f.id, { choices: [...(f.choices ?? []), { id: crypto.randomUUID(), label: 'New option' }] })}>Add choice</button></>}
      </fieldset>)}<button type="button" disabled={locked || spec.fields.length >= 32} onClick={() => apply({ ...spec, fields: [...spec.fields, { id: 'field_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12), kind: 'text', label: 'New field', required: false }] })}>Add field</button>
      {spec.secure && <fieldset><legend>Private purpose and destination · owner review</legend><label>Purpose<textarea maxLength={500} disabled={locked} value={spec.secure.purpose} onChange={e => apply({ ...spec, secure: { ...spec.secure!, purpose: e.target.value } })}/></label><label>Destination<select disabled={locked} value={spec.secure.destination.kind} onChange={e => apply({ ...spec, secure: { ...spec.secure!, destination: { kind: e.target.value as 'desktop' | 'https', label: spec.secure!.destination.label, ...(e.target.value === 'https' ? { origin: 'https://' } : {}) } } })}><option value="desktop">Desktop</option><option value="https">HTTPS</option></select></label><label>Destination label<input maxLength={200} disabled={locked} value={spec.secure.destination.label} onChange={e => apply({ ...spec, secure: { ...spec.secure!, destination: { ...spec.secure!.destination, label: e.target.value } } })}/></label>{spec.secure.destination.kind === 'https' && <label>Exact HTTPS origin<input disabled={locked} value={spec.secure.destination.origin ?? ''} onChange={e => apply({ ...spec, secure: { ...spec.secure!, destination: { ...spec.secure!.destination, origin: e.target.value } } })}/></label>}</fieldset>}
    </>}
    {!frozen && <button type="button" disabled={locked || !available || !ready} onClick={save}>{request ? 'Save reviewed draft' : 'Save request draft'}</button>}
    {!frozen && <><label>Link expiry in days<input type="number" min={1} max={30} disabled={locked} value={expiry} onChange={e => setExpiry(Number(e.target.value))}/></label><label>Optional PIN · memory only<input ref={pinInput} type="password" autoComplete="off" inputMode="numeric" pattern="[0-9]{4,12}" maxLength={12} disabled={busy} value={pin} onChange={e => setPin(e.target.value)}/></label><button type="button" disabled={locked || !available || !saved || !preview || !Number.isInteger(expiry) || expiry < 1 || expiry > 30} onClick={() => request && void invoke({ action: 'publish', id: request.id, operationId: crypto.randomUUID(), expectedRevision: request.revision, expirySeconds: expiry * 86400 })}>Generate link</button>{!saved && <small>Save the current draft before publishing.</small>}</>}
    {link && <section><strong>Protected link · keep private</strong><a className="task-request-link" href={link} target="_blank" rel="noreferrer">Open protected form</a><button type="button" onClick={() => void navigator.clipboard.writeText(link).catch(() => setError('Copy unavailable. Open the protected link directly.'))}>Copy link</button></section>}
    {frozen && pending?.action.action === 'publish' && <><label>Original PIN, if used · memory only<input type="password" autoComplete="off" inputMode="numeric" value={pin} onChange={e => setPin(e.target.value)}/></label>{pending.state === 'accepted' && <button type="button" disabled={busy || !available} onClick={() => void invoke(pending.action, true)}>Recover original link</button>}</>}
    {request && frozen && <><p>{requestStatus[request.status]}</p>{request.status === 'published' && <><button type="button" disabled={!available || locked} onClick={() => setRevoke(true)}>Revoke link</button>{revoke && <aside><p>Revoke access to this link. Received ordinary submissions remain available for review.</p><button type="button" disabled={locked} onClick={() => void invoke({ action: 'revoke', id: request.id, operationId: crypto.randomUUID(), expectedRevision: request.revision })}>Confirm revoke</button><button type="button" onClick={() => setRevoke(false)}>Keep link</button></aside>}</>}</>}
  </div></div>;
}
export function TaskRequestCard({ request, capture }: {
    request: TaskRequest;
    capture?: () => void;
}) {
    const ui = useTaskRequests(), s = request.submission;
    return <div data-task-request-id={request.id}><LazyDetails className="task-request-card" beforeToggle={capture} summary={<>Task Request · {request.spec.title} · {requestStatus[s?.submittedAt ? s.status : request.status]}</>}>{() => <><small>{new Date(request.createdAt).toLocaleString()}</small><FormMarkdown text={request.spec.instructions}/><p>Source: {request.source.question ? 'Original question' : request.source.itemId ? 'Original bot response' : 'Bot-authored request draft'} · {request.source.turnId ?? request.source.question?.turnId ?? request.source.threadId}</p>{s?.submittedAt && <><p>Contributor: {s.contributorName || 'Unnamed'} · self-reported</p><dl>{request.spec.fields.filter(f => !f.kind.startsWith('secure-')).map(f => <div key={f.id}><dt>{f.label}</dt><dd>{Array.isArray(s.values[f.id]) ? (s.values[f.id] as string[]).map(id => f.choices?.find(c => c.id === id)?.label ?? id).join(', ') : s.values[f.id]}</dd>{s.files.filter(v => v.fieldId === f.id).map(file => <small key={file.id}>{file.name} · {file.ready ? 'Ready' : 'Unconfirmed'}</small>)}</div>)}</dl>{s.secure && <p>Private receipt · {s.secure.modelRead ? 'Model reading permitted' : 'Private use only'} · expires {new Date(s.secure.expiresAt).toLocaleString()}</p>}{s.delivery?.reason && <p>{s.delivery.reason}</p>}<small>Received input does not prove work completion.</small></>}{ui && <button type="button" disabled={!ui.online} onClick={() => ui.openRequest(request)}>{request.status === 'draft' ? 'Review and publish' : 'Owner details'}</button>}</>}</LazyDetails></div>;
}
export function TaskRequestAccess({ capture }: {
    capture?: () => void;
} = {}) {
    const ui = useTaskRequests();
    if (!ui?.supported)
        return null;
    return <details className="task-request-card"><summary onClick={capture}>Task Requests{ui.requests.length ? ` · ${ui.requests.length} on this page` : ''}</summary>{ui.loading && <p role="status">Checking requests…</p>}{ui.error && <p role="alert">{ui.error}</p>}{ui.requests.map(r => <button key={r.id} type="button" onClick={() => ui.openRequest(r)}>{r.spec.title} · {requestStatus[r.submission?.submittedAt ? r.submission.status : r.status]}</button>)}<div className="task-request-actions"><button type="button" disabled={!ui.online || ui.loading} onClick={ui.latest}>Latest requests</button>{ui.cursor && <button type="button" disabled={!ui.online || ui.loading} onClick={ui.older}>Earlier requests</button>}</div></details>;
}
