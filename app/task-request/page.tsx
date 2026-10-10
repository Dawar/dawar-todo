'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskRequestGuest, TaskRequestValues } from '../../lib/task-requests';
import { taskRequestValues } from '../../lib/task-requests';
import type { FormIntent } from './journal';
import { GuestFormSession, protectedLink } from './guest-session';
import { GuestFilePreview } from './file-preview';
import { mergeFormReceipt } from './receipts';
import { TaskRequestFields, requestStatus } from './form';
import './task-request.css';
export default function TaskRequestGuestPage() {
    const link = useRef<ReturnType<typeof protectedLink>>(null), session = useRef<GuestFormSession | null>(null), alive = useRef(false), working = useRef(false);
    const observed = useRef<TaskRequestGuest | null>(null), ordinaryFiles = useRef<Record<string, File>>({});
    const privateFields = useRef<Record<string, HTMLInputElement | null>>({}), images = useRef<Record<string, File>>({}), form = useRef<HTMLFormElement>(null);
    const [request, setRequest] = useState<TaskRequestGuest | null>(null), [values, setValues] = useState<TaskRequestValues>({}), [name, setName] = useState(''), [pin, setPin] = useState('');
    const [error, setError] = useState(''), [busy, setBusy] = useState(false), [needsPin, setNeedsPin] = useState(false), [sealed, setSealed] = useState(false), [modelRead, setModelRead] = useState(false), [imageNames, setImageNames] = useState<Record<string, File>>({}), [saved, setSaved] = useState(false), [pending, setPending] = useState<FormIntent | null>(null), [hasLink, setHasLink] = useState(false);
    const run = useCallback(async (action: () => Promise<void>) => {
        if (working.current)
            return;
        working.current = true;
        setBusy(true);
        setError('');
        try {
            await action();
        }
        catch (e) {
            if (alive.current)
                setError(e instanceof Error ? e.message : 'Acknowledgement unavailable. Retain the original form.');
        }
        finally {
            working.current = false;
            if (alive.current) {
                setBusy(false);
                setSealed(session.current?.sealed ?? false);
                if (session.current?.sealed) {
                    Object.values(privateFields.current).forEach(node => {
                        if (node)
                            node.value = '';
                    });
                    images.current = {};
                    setImageNames({});
                }
                setPending(session.current?.pending ?? null);
            }
        }
    }, []);
    const receive = useCallback((r: TaskRequestGuest, replaceAnswers = false) => {
        if (!alive.current)
            return;
        const next = mergeFormReceipt(observed.current, r);
        observed.current = next;
        setRequest(next);
        if (replaceAnswers) {
            setValues(next.submission?.values ?? {});
            setName(next.submission?.contributorName ?? '');
        }
        if (r.submission?.submittedAt) {
            Object.values(privateFields.current).forEach(node => {
                if (node)
                    node.value = '';
            });
            images.current = {};
            setImageNames({});
            session.current?.releasePrivate();
            setSealed(true);
        }
    }, []);
    const open = useCallback(async (pinValue?: string) => {
        if (!link.current)
            throw Error('Reopen the original protected link to access this form.');
        session.current?.close();
        const s = new GuestFormSession(link.current.id, link.current.token, pinValue);
        session.current = s;
        try {
            const r = await s.read();
            if (!alive.current)
                return;
            setNeedsPin(false);
            setPin('');
            receive(r, true);
        }
        catch (e) {
            if (alive.current && (e as {
                status?: number;
            }).status === 401)
                setNeedsPin(true);
            throw e;
        }
    }, [receive]);
    useEffect(() => {
        alive.current = true;
        link.current = protectedLink(window.location.hash);
        if (window.location.hash)
            window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
        queueMicrotask(() => {
            if (alive.current) {
                setHasLink(!!link.current);
                void run(() => open());
            }
        });
        return () => {
            alive.current = false;
            session.current?.close();
            session.current = null;
            link.current = null;
            Object.values(privateFields.current).forEach(node => {
                if (node)
                    node.value = '';
            });
            privateFields.current = {};
            images.current = {};
            ordinaryFiles.current = {};
            observed.current = null;
        };
    }, [run, open]);
    const current = () => {
        const s = session.current;
        if (!s || !request)
            throw Error('Read the original protected form first.');
        return s;
    };
    const save = async () => {
        if (!request)
            return;
        const r = await current().save(request, name, values);
        receive(r);
        if (alive.current)
            setSaved(true);
    };
    const submit = async () => {
        if (!request || request.submission?.submittedAt)
            return;
        const s = current();
        if (s.pending)
            throw Error('Confirm the original saved action before final submission.');
        taskRequestValues(request.spec, values, true);
        if (request.spec.fields.some(f => f.required && ['file', 'image'].includes(f.kind) && !request.submission?.files.some(file => file.fieldId === f.id && file.ready)))
            throw Error('Complete the required ordinary uploads first.');
        let r = request, handle: string | undefined;
        if (!s.sealed) {
            if (!form.current?.reportValidity())
                return;
            r = await s.save(request, name, values);
            receive(r);
        }
        if (request.spec.secure) {
            const fields = Object.fromEntries(request.spec.fields.filter(f => f.kind === 'secure-text').map(f => [f.id, privateFields.current[f.id]?.value ?? '']));
            if (!s.sealed && request.spec.fields.some(f => f.required && f.kind === 'secure-image' && !images.current[f.id]))
                throw Error('Add the required private images.');
            handle = await s.privateTransfer(r, fields, images.current, modelRead);
            if (alive.current) {
                Object.values(privateFields.current).forEach(node => {
                    if (node)
                        node.value = '';
                });
                images.current = {};
                setImageNames({});
                setSealed(true);
            }
        }
        const result = await s.submit(r, handle);
        receive(result);
    };
    const locked = busy || sealed || !!request?.submission?.submittedAt || !!pending;
    return <main className="task-request-page" data-no-pull-refresh><small>Protected Task Request</small><h1>{request?.spec.title ?? 'Open a protected form'}</h1>
    <p>This link permits one contributor to submit this form. Link possession grants access; the contributor name is not verified identity.</p>
    {error && <p role="alert" className="task-request-error">{error}</p>}
    {!request && needsPin && <form onSubmit={e => { e.preventDefault(); void run(() => open(pin)); }} autoComplete="off"><label>Link PIN<input type="password" inputMode="numeric" pattern="[0-9]{4,12}" minLength={4} maxLength={12} required value={pin} autoComplete="off" onChange={e => setPin(e.target.value)}/></label><button type="submit" disabled={busy}>Open form</button></form>}
    {!request && !needsPin && <button type="button" disabled={busy || !hasLink} onClick={() => void run(() => open())}>{busy ? 'Opening…' : 'Retry original link'}</button>}
    {request && <><p>For {request.botName} · {requestStatus[request.submission?.submittedAt ? request.submission.status : request.status] ?? request.status}</p>{request.expiresAt && <small>Link expires {new Date(request.expiresAt).toLocaleString()}</small>}
      {request.submission?.submittedAt ? <section><h2>{requestStatus[request.submission.status]}</h2><p>Your submission has been received. Delivery and completion are separate.</p>{request.submission.delivery?.reason && <p>{request.submission.delivery.reason}</p>}<button type="button" disabled={busy} onClick={() => void run(async () => { receive(await current().read()); })}>Check receipt</button></section>
                : <form className="task-request-form" ref={form} autoComplete="off" onSubmit={e => { e.preventDefault(); void run(submit); }}>
        <label>Your name · self-reported<input disabled={locked} maxLength={100} value={name} onChange={e => { setName(e.target.value); setSaved(false); }}/></label>
        <TaskRequestFields spec={request.spec} values={values} files={request.submission?.files} disabled={locked} privateFields={privateFields} privateImages={imageNames} onChange={(id, v) => { setValues(old => ({ ...old, [id]: v })); setSaved(false); }} onPrivateImage={(id, file) => {
                        if (file)
                            images.current[id] = file;
                        else
                            delete images.current[id];
                        setImageNames({ ...images.current });
                    }} onFile={(id, file) => { ordinaryFiles.current[id] = file; void run(async () => { await current().upload(request, id, file); receive(await current().read()); }); }}/>
        {request.submission?.files.map(file => <GuestFilePreview key={file.id} file={file} download={() => current().call({ action: 'download', id: request.id, fileId: file.id })}/>)}
        {request.spec.secure && <><label><input type="checkbox" checked={modelRead} disabled={locked} onChange={e => setModelRead(e.target.checked)}/> Allow the model to read private fields/images and destination responses</label><p>Unchecked keeps content private. Explicit model/native history copies, website/session/autofill copies survive deletion of the transfer. Private content is held in memory and submitted over the dedicated encrypted channel.</p></>}
        {pending && <aside><p>Original {pending.action.action} is unconfirmed. Its identity and ordinary input are retained.</p>{pending.action.action === 'upload' ? <><button type="button" disabled={busy} onClick={() => void run(async () => { const p = session.current?.pending?.action; if (p?.action !== 'upload' || !ordinaryFiles.current[p.fieldId])
                            throw Error('Choose the same original file to continue.'); await current().upload(request, p.fieldId, ordinaryFiles.current[p.fieldId]); receive(await current().read()); })}>Retry original selected file</button><label>Select the same original file to recover<input type="file" disabled={busy} onChange={e => {
                                const file = e.target.files?.[0], p = session.current?.pending?.action;
                                if (file && p?.action === 'upload')
                                    void run(async () => { await current().upload(request, p.fieldId, file); receive(await current().read()); });
                            }}/></label></> : <button type="button" disabled={busy} onClick={() => void run(async () => receive(await current().retry(request), true))}>Confirm original action</button>}</aside>}
        <div className="task-request-actions"><button type="button" disabled={locked} onClick={() => void run(save)}>Save ordinary progress</button><button type="submit" disabled={busy || !!pending}>{busy ? 'Confirming…' : sealed ? 'Continue original submission' : 'Submit'}</button></div>{saved && <p role="status">Ordinary progress saved. Private input remains only in this open form.</p>}
      </form>}</>}
  </main>;
}
