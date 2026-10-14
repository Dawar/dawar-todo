'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { taskRequestValues, type TaskRequestGuest, type TaskRequestValues } from '../../lib/task-requests';
import { taskRequestGuest } from '../../lib/task-request-client';
import { progressDraft, type FormIntent } from './journal';
import { GuestFormSession, protectedLink } from './guest-session';
import { SharedProgress, type OrdinaryProgress } from './progress';
import { FormShare } from './share';
import { GuestFilePreview } from './file-preview';
import { TaskRequestFields, requestStatus } from './form';
import './task-request.css';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
export default function TaskRequestGuestPage() {
    const link = useRef<ReturnType<typeof protectedLink>>(null), session = useRef<GuestFormSession | null>(null), alive = useRef(false), working = useRef(false), polling = useRef(false);
    const navigation = useRef(0), actionNavigation = useRef(0);
    const progress = useRef<SharedProgress | null>(null), editAt = useRef(0), retryAt = useRef(0), failures = useRef(0), draftScope = useRef(''), accessBlocked = useRef(false), draftWrites = useRef(Promise.resolve());
    const ordinaryFiles = useRef<Record<string, File>>({}), privateFields = useRef<Record<string, HTMLInputElement | null>>({}), images = useRef<Record<string, File>>({}), form = useRef<HTMLFormElement>(null);
    const [request, setRequest] = useState<TaskRequestGuest | null>(null), [values, setValues] = useState<TaskRequestValues>({}), [name, setName] = useState(''), [pin, setPin] = useState(''), [shareUrl, setShareUrl] = useState(''), [retained, setRetained] = useState<OrdinaryProgress | null>(null);
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [saving, setSaving] = useState(false), [needsPin, setNeedsPin] = useState(false), [sealed, setSealed] = useState(false), [modelRead, setModelRead] = useState(false), [imageNames, setImageNames] = useState<Record<string, File>>({}), [pending, setPending] = useState<FormIntent | null>(null), [hasLink, setHasLink] = useState(false), [conflicts, setConflicts] = useState<string[]>([]), [saveStatus, setSaveStatus] = useState('Loading shared progress…');
    const errorSummary = useRef<HTMLParagraphElement>(null);
    const persist = useCallback(() => {
        const p = progress.current, scope = draftScope.current;
        if (!p || !scope)
            return;
        const draft = p.snapshot(),capturedNavigation=navigation.current;
        draftWrites.current = draftWrites.current.catch(() => { }).then(async () => { await progressDraft(scope, p.request.spec, draft); }).catch(() => { if (alive.current&&capturedNavigation===navigation.current)
            setSaveStatus('Local recovery unavailable. Keep this page open until shared progress is saved.'); });
    }, []);
    const renderProgress = useCallback(() => {
        const p = progress.current;
        if (!p || !alive.current)
            return;
        setRequest(p.request);
        setValues(p.values);
        setName(p.name);
        setConflicts(p.conflicts);
        setRetained(p.dirty ? p.snapshot() : null);
        persist();
    }, [persist]);
    const receive = useCallback((r: TaskRequestGuest) => {
        if (!alive.current)
            return;
        if (progress.current)
            progress.current.receive(r);
        else
            progress.current = new SharedProgress(r);
        renderProgress();
        if (r.submission?.submittedAt) {
            Object.values(privateFields.current).forEach(node => { if (node)
                node.value = ''; });
            images.current = {};
            setImageNames({});
            session.current?.releasePrivate();
            setSealed(true);
        }
    }, [renderProgress]);
    const run = useCallback(async (action: () => Promise<void>, background = false) => {
        const capturedNavigation=navigation.current;
        if (working.current&&actionNavigation.current===capturedNavigation)
            return;
        working.current = true;actionNavigation.current=capturedNavigation;
        if (background)
            setSaving(true);
        else
            setBusy(true);
        setError('');
        try {
            await action();
            if(capturedNavigation===navigation.current){failures.current = 0;retryAt.current = 0;}
        }
        catch (e) {
            if (alive.current&&capturedNavigation===navigation.current) {
                const failure = e as {
                    request?: TaskRequestGuest;
                    message?: string;
                    status?: number;
                    code?: string;
                };
                if (progress.current && ([401, 403].includes(failure.status ?? 0) || ['scope_changed', 'revision', 'frozen'].includes(failure.code ?? ''))) {
                    accessBlocked.current = true;
                    setBlocked(true);
                }
                if (failure.request)
                    receive(failure.request);
                if (failure.code === 'frozen' && session.current) {
                    try {
                        receive(await session.current.read(false));
                    }
                    catch { /* Retain original action and local edits if current receipt is unavailable. */ }
                }
                setError(failure.message ?? 'Acknowledgement unavailable. Retain the original form.');
                setSaveStatus(navigator.onLine ? 'Save unconfirmed · original action retained' : 'Offline · ordinary edits retained on this device');
                failures.current++;
                retryAt.current = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(failures.current - 1, 4));
                if (!background)
                    errorSummary.current?.focus();
            }
        }
        finally {
            if(capturedNavigation===navigation.current)working.current = false;
            if (alive.current&&capturedNavigation===navigation.current) {
                setBusy(false);
                setSaving(false);
                setPending(session.current?.pending ?? null);
                setSealed(session.current?.sealed ?? false);
            }
        }
    }, [receive]);
    const open = useCallback(async (pinValue?: string) => {
        const capturedNavigation=navigation.current,selected = link.current;
        if (!selected)
            throw Error('Reopen the original protected link to access this form.');
        let resolved: {
            id: string;
            token: string;
            url?: string;
        };
        try {
            resolved = typeof selected.code === 'string' ? await taskRequestGuest<{
                id: string;
                token: string;
                url: string;
            }>({ action: 'resolve' }, selected.code, pinValue, AbortSignal.timeout(30000)) : selected as {
                id: string;
                token: string;
            };
        }
        catch (e) {
            if (alive.current && capturedNavigation===navigation.current && (e as {
                status?: number;
            }).status === 401)
                setNeedsPin(true);
            throw e;
        }
        if (!alive.current||capturedNavigation!==navigation.current)
            return;
        session.current?.close();
        const s = new GuestFormSession(resolved.id, resolved.token, pinValue);
        session.current = s;
        try {
            const r = await s.read();
            if (!alive.current || session.current !== s || capturedNavigation!==navigation.current)
                return;
            const p = new SharedProgress(r);
            progress.current = p;
            let editor: string;
            try {
                editor = sessionStorage.getItem('task-request-editor') ?? crypto.randomUUID();
                sessionStorage.setItem('task-request-editor', editor);
            }
            catch {
                editor = crypto.randomUUID();
            }
            draftScope.current = JSON.stringify([r.id, r.revision, r.submission!.id, editor]);
            try {
                const draft = await progressDraft(draftScope.current, r.spec);
                if (draft)
                    p.restore(draft);
            }
            catch {
                setSaveStatus('Local recovery unavailable; shared progress is still available.');
            }
            if (!alive.current || session.current !== s || capturedNavigation!==navigation.current)
                return;
            setNeedsPin(false);
            setPin('');
            accessBlocked.current = false;
            setBlocked(false);
            const url = resolved.url ?? (window.location.protocol === 'https:' ? `${window.location.origin}/task-request#${encodeURIComponent(resolved.id)}/${resolved.token}` : '');
            setShareUrl(url);
            receive(r);
            setSaveStatus(p.dirty ? 'Unsaved ordinary edits restored on this device' : 'Shared ordinary progress up to date');
            setPending(s.pending);
        }
        catch (e) {
            if (alive.current && capturedNavigation===navigation.current && (e as {
                status?: number;
            }).status === 401)
                setNeedsPin(true);
            throw e;
        }
    }, [receive]);
    useEffect(() => {
        alive.current = true;
        const fieldNodes = privateFields.current;
        if (!link.current)
            link.current = protectedLink(window.location.hash);
        if (window.location.hash)
            window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
        const switchLink=()=>{
            const next=protectedLink(window.location.hash);navigation.current++;
            session.current?.close();session.current=null;link.current=next;
            Object.values(fieldNodes).forEach(node=>{if(node)node.value='';});
            images.current={};ordinaryFiles.current={};progress.current=null;draftScope.current='';accessBlocked.current=false;
            setRequest(null);setValues({});setName('');setShareUrl('');setRetained(null);setPending(null);setConflicts([]);setBlocked(false);setSealed(false);setNeedsPin(false);setPin('');setHasLink(!!next);setModelRead(false);
            if(window.location.hash)window.history.replaceState(window.history.state,'',window.location.pathname+window.location.search);
            void run(()=>open());
        };
        window.addEventListener('hashchange',switchLink);
        queueMicrotask(() => { if (alive.current) {
            setHasLink(!!link.current);
            void run(() => open());
        } });
        return () => { alive.current = false;window.removeEventListener('hashchange',switchLink); session.current?.close(); session.current = null; Object.values(fieldNodes).forEach(node => { if (node)
            node.value = ''; }); images.current = {}; ordinaryFiles.current = {}; };
    }, [run, open]);
    const save = useCallback(async () => {
        const s = session.current, p = progress.current;
        if (!s || !p)
            return;
        if (accessBlocked.current)
            throw Error('Shared form access changed. Retain ordinary edits and reopen the original link.');
        if (s.pending) {
            if (s.pending.action.action !== 'patch')
                throw Error('Confirm the earlier original action first.');
            receive(await s.retry(p.request));
        }
        const patch = p.patch();
        if (patch) {
            setSaveStatus('Saving ordinary progress…');
            receive(await s.patch(p.request, patch));
        }
        setSaveStatus(p.dirty ? 'New ordinary edits waiting to save' : 'Saved · shared across visitors and devices');
    }, [receive]);
    useEffect(() => {
        const timer = setInterval(() => {
            const p = progress.current, s = session.current;
            if (accessBlocked.current || !alive.current || !p || !s || p.request.submission?.submittedAt || working.current || document.hidden || Date.now() < retryAt.current)
                return;
            if (!navigator.onLine) {
                if (p.dirty)
                    setSaveStatus('Offline · ordinary edits retained on this device');
                return;
            }
            if ((p.dirty || s.pending?.action.action === 'patch') && !p.conflicts.length && Date.now() - editAt.current >= 1200)
                void run(save, true);
        }, 1200);
        const poll = setInterval(() => {
            const s = session.current;
            if (accessBlocked.current || !s || !alive.current || working.current || polling.current || document.hidden || !navigator.onLine || Date.now() < retryAt.current)
                return;
            polling.current = true;
            void s.read(false).then(r => { if (alive.current && session.current === s) {
                receive(r);
                if (!progress.current?.dirty && !s.pending)
                    setSaveStatus('Saved · shared across visitors and devices');
            } }).catch(e => { if (alive.current && session.current === s) {
                if ([401, 403].includes(e.status ?? 0) || ['scope_changed', 'revision'].includes(e.code ?? '')) {
                    accessBlocked.current = true;
                    setBlocked(true);
                }
                setError(e instanceof Error ? e.message : 'Shared progress unavailable.');
                setSaveStatus('Shared progress unavailable · local changes retained');
                retryAt.current = Date.now() + 15000;
            } }).finally(() => { polling.current = false; });
        }, 5000);
        return () => { clearInterval(timer); clearInterval(poll); };
    }, [run, save, receive]);
    const current = () => { const s = session.current; if (!s || !progress.current)
        throw Error('Read the original protected form first.'); return s; };
    const changed = (id: string, value: string | string[]) => { try {
        progress.current?.change(id, value);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Ordinary answer limit exceeded.');
        return;
    } editAt.current = Date.now(); retryAt.current = 0; setSaveStatus('Ordinary changes waiting to save'); renderProgress(); };
    const submit = async () => {
        const s = current();
        await save();
        const p = progress.current!;
        let r = p.request;
        if (p.dirty || s.pending)
            throw Error('Save or resolve ordinary changes before final submission.');
        if (r.submission?.submittedAt)
            return;
        taskRequestValues(r.spec, p.values, true);
        if (r.spec.fields.some(f => f.required && ['file', 'image'].includes(f.kind) && !r.submission?.files.some(file => file.fieldId === f.id && file.ready)))
            throw Error('Complete the required ordinary uploads first.');
        let handle: string | undefined;
        if (!s.sealed && !form.current?.reportValidity())
            return;
        if (r.spec.secure) {
            const fields = Object.fromEntries(r.spec.fields.filter(f => f.kind === 'secure-text').map(f => [f.id, privateFields.current[f.id]?.value ?? '']));
            if (!s.sealed && r.spec.fields.some(f => f.required && f.kind === 'secure-image' && !images.current[f.id]))
                throw Error('Add the required private images.');
            handle = await s.privateTransfer(r, fields, images.current, modelRead);
            Object.values(privateFields.current).forEach(node => { if (node)
                node.value = ''; });
            images.current = {};
            setImageNames({});
            setSealed(true);
        }
        r = progress.current!.request;
        if (r.submission?.submittedAt)
            return;
        receive(await s.submit(r, handle));
    };
    const locked = blocked || busy || sealed || !!request?.submission?.submittedAt || !!pending;
    return <main className="task-request-page" data-no-pull-refresh><FormShare url={shareUrl} disabled={!request || blocked}/><small>Protected Task Request</small><h1>{request?.spec.title ?? 'Open a protected form'}</h1>
        <p>Anyone with this link and its optional PIN can share ordinary progress across devices and edit together. Names are self-reported. There is one final submission. Private fields stay only in this open form and need fresh entry on another device.</p>
        {error && <p ref={errorSummary} tabIndex={-1} role="alert" className="task-request-error">{error}</p>}
        {!request && needsPin && <form className="task-request-form" onSubmit={e => { e.preventDefault(); void run(() => open(pin)); }} autoComplete="off"><label>Link PIN<Input className="task-request-control" type="password" inputMode="numeric" pattern="[0-9]{4,12}" minLength={4} maxLength={12} required value={pin} autoComplete="off" onChange={e => setPin(e.target.value)}/></label><Button className="task-request-control" type="submit" disabled={busy}>Open form</Button></form>}
        {!request && !needsPin && <Button className="task-request-control" variant="outline" type="button" disabled={busy || !hasLink} onClick={() => void run(() => open())}>{busy ? 'Opening…' : 'Retry original link'}</Button>}
        {request && <>{blocked && <p role="alert">Shared access is unavailable. Ordinary edits remain on this device. Reopen the original link after the owner resolves access; no new input will be sent.</p>}<p>For {request.botName} · {requestStatus[request.submission?.submittedAt ? request.submission.status : request.status] ?? request.status}</p>{request.expiresAt && <small>Link expires {new Date(request.expiresAt).toLocaleString()}</small>}
        <p role="status" className="task-request-save-status">{saving ? 'Saving ordinary progress…' : saveStatus}</p>
        {conflicts.length > 0 && <aside><strong>Shared answer conflict</strong><p>Your edits are retained. Resolve each changed answer before saving or submitting.</p>{conflicts.map(id => <div key={id}><p>{id === '$name' ? 'Contributor name' : request.spec.fields.find(f => f.id === id)?.label}</p><p>Shared: {String(id === '$name' ? request.submission?.contributorName : request.submission?.values[id] ?? '')}</p><p>Yours: {String(id === '$name' ? name : values[id] ?? '')}</p>{['Keep mine', 'Use shared'].map((label, i) => <Button className="task-request-control" variant="outline" type="button" key={label} disabled={busy || saving || !!pending} onClick={() => { progress.current?.resolve(id, i === 0); editAt.current = Date.now(); renderProgress(); }}>{label}</Button>)}</div>)}</aside>}
        {request.submission?.submittedAt ? <section className="task-request-receipt" aria-label="Submission receipt"><h2>{requestStatus[request.submission.status]}</h2><p>Your submission has been received. Delivery and completion are separate.</p>{retained && <><p>Unsaved ordinary changes remain on this device. They cannot change the frozen submission.</p><details><summary>View retained ordinary edits</summary><pre>{JSON.stringify(retained, null, 2)}</pre></details></>}{request.submission.delivery?.reason && <p>{request.submission.delivery.reason}</p>}<Button className="task-request-control" variant="outline" type="button" disabled={busy} onClick={() => void run(async () => receive(await current().read(false)))}>Check receipt</Button></section>
                : <form className="task-request-form" ref={form} autoComplete="off" onSubmit={e => { e.preventDefault(); void run(submit); }}>
        <label>Your name · self-reported<Input className="task-request-control" disabled={locked} maxLength={100} value={name} onChange={e => { progress.current?.changeName(e.target.value); editAt.current = Date.now(); retryAt.current = 0; setSaveStatus('Ordinary changes waiting to save'); renderProgress(); }}/></label>
        <TaskRequestFields spec={request.spec} values={values} files={request.submission?.files} disabled={locked} filesDisabled={saving} privateFields={privateFields} privateImages={imageNames} onChange={changed} onPrivateImage={(id, file) => { if (file)
                    images.current[id] = file;
                else
                    delete images.current[id]; setImageNames({ ...images.current }); }} onFile={(id, file) => { ordinaryFiles.current[id] = file; void run(async () => { await current().upload(progress.current!.request, id, file); receive(await current().read(false)); }); }}/>
        {request.submission?.files.map(file => <GuestFilePreview key={file.id} file={file} download={() => current().call({ action: 'download', id: request.id, fileId: file.id })}/>)}
        {request.spec.secure && <><label className="task-request-check"><input type="checkbox" checked={modelRead} disabled={locked} onChange={e => setModelRead(e.target.checked)}/> Allow the model to read private fields/images and destination responses</label><p>Unchecked keeps content private. Private input is never autosaved or synced to another device. Explicit model/native history copies survive transfer deletion.</p></>}
        {pending && <aside><p>Original {pending.action.action} is unconfirmed. Its identity and ordinary input are retained.</p>{pending.action.action === 'upload' ? <><Button className="task-request-control" variant="outline" type="button" disabled={busy || saving} onClick={() => void run(async () => { const p = current().pending?.action; if (p?.action !== 'upload' || !ordinaryFiles.current[p.fieldId])
                    throw Error('Choose the same original file to continue.'); await current().upload(request, p.fieldId, ordinaryFiles.current[p.fieldId]); receive(await current().read(false)); })}>Retry original selected file</Button><label>Select the same original file to recover<Input className="task-request-control" type="file" disabled={busy || saving} onChange={e => { const file = e.target.files?.[0], p = current().pending?.action; if (file && p?.action === 'upload')
                    void run(async () => { await current().upload(request, p.fieldId, file); receive(await current().read(false)); }); }}/></label></> : <Button className="task-request-control" variant="outline" type="button" disabled={busy || saving} onClick={() => void run(async () => receive(await current().retry(progress.current!.request)))}>Confirm original action</Button>}</aside>}
        <div className="task-request-actions"><Button className="task-request-control" variant="outline" type="button" disabled={blocked || busy || saving || !!conflicts.length || !!pending} onClick={() => void run(save)}>Save now</Button><Button className="task-request-control" type="submit" disabled={blocked || busy || saving || !!pending || !!conflicts.length}>{busy ? 'Confirming…' : sealed ? 'Continue original submission' : 'Submit'}</Button></div>
        </form>}</>}
    </main>;
}
