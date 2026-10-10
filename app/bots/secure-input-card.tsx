'use client';
import { useEffect, useRef, useState } from 'react';
import type { useSecureInputRequests } from './secure-input-requests';
import { LockKeyhole, X, Trash2, ChevronRight } from 'lucide-react';
import { botsClient as client } from './client';
import { encryptSecureInput, secureBase64, SECURE_IMAGE_BYTES, type SecureDescriptor, type SecureEnvelope, type SecureRequest } from '../../lib/secure-input';
import { transferSecureInput } from './secure-input-transfer';
import './secure-input-card.css';
function SecureForm({ request, online, onClose, onReceived }: {
    request: SecureRequest;
    online: boolean;
    onClose: () => void;
    onReceived: (r: SecureRequest) => void;
}) {
    const owner = useRef(client.owner);
    const form = useRef<HTMLFormElement>(null), pending = useRef<SecureEnvelope | null>(null), mounted = useRef(true);
    const [images, setImages] = useState<Record<string, File>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [sealed, setSealed] = useState(false);
    useEffect(() => { mounted.current = true; const node = form.current; return () => { mounted.current = false; pending.current = null; node?.reset(); }; }, []);
    const submit = async () => {
        if (busy || !online || client.owner !== owner.current)
            return;
        const data = pending.current ? null : new FormData(form.current!);
        setBusy(true);
        setError('');
        try {
            if (!pending.current) {
                const descriptor = await client.secure<SecureDescriptor>({ action: 'key', botId: request.botId, threadId: request.threadId, requestId: request.id });
                if (!mounted.current || client.owner !== owner.current)
                    return;
                if (!descriptor.publicKey || descriptor.owner !== client.owner || descriptor.request.id !== request.id || descriptor.request.threadId !== request.threadId)
                    throw Error('This form is unavailable. Ask the bot for a fresh request.');
                const files = Object.entries(images);
                if (files.reduce((n, [, file]) => n + file.size, 0) > SECURE_IMAGE_BYTES)
                    throw Error('Use at most20 MB of images in total.');
                const payload = { fields: Object.fromEntries(request.fields.map(field => [field.name, String(data!.get(field.name) ?? '')])), modelRead: data!.get('allow-model') === 'on', images: await Promise.all(files.map(async ([slot, file]) => { if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
                        throw Error('Choose PNG, JPEG or WebP images.'); const bytes = new Uint8Array(await file.arrayBuffer()); try {
                        return { slot, mimeType: file.type, data: secureBase64(bytes) };
                    }
                    finally {
                        bytes.fill(0);
                    } })) };
                if (request.images.some(slot => slot.required && !images[slot.name]))
                    throw Error('Add the requested image.');
                const encrypted = await encryptSecureInput(descriptor, crypto.randomUUID(), payload);
                if (!mounted.current || client.owner !== owner.current)
                    return;
                pending.current = encrypted;
                setSealed(true);
            }
            if (!mounted.current || client.owner !== owner.current)
                return;
            const receipt = await transferSecureInput(client, pending.current);
            if (mounted.current && client.owner === owner.current) {
                pending.current = null;
                form.current?.reset();
                setImages({});
                onReceived(receipt);
            }
        }
        catch (reason) {
            if (mounted.current)
                setError(reason instanceof Error ? reason.message : 'Secure delivery was not confirmed.');
        }
        finally {
            if (mounted.current)
                setBusy(false);
        }
    };
    return <form ref={form} className="bots-secure-form" autoComplete="off" onSubmit={e => { e.preventDefault(); void submit(); }}>
  <button type="button" className="bots-icon-button bots-secure-close" aria-label="Close sensitive form" onClick={onClose}><X size={18}/></button>
  <p>Input stays in this open form’s memory. Closing, switching bots or reloading discards it. The bot bridge must be online.</p>
  <fieldset disabled={busy || sealed}>{request.fields.map(field => <label key={field.name}>{field.label}<input name={field.name} type={field.secret === false ? 'text' : 'password'} maxLength={4096} required={field.required} autoComplete="off" data-lpignore="true" data-1p-ignore spellCheck={false}/></label>)}
  {request.images.map(slot => <label key={slot.name}>{slot.label}<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; setImages(old => { const next = { ...old }; if (file)
        next[slot.name] = file;
    else
        delete next[slot.name]; return next; }); }}/>{images[slot.name] && <small>Image selected</small>}</label>)}
  <label className="bots-secure-opt"><input type="checkbox" name="allow-model" defaultChecked={false}/>Allow the model to read these fields/images and destination responses.</label>
  </fieldset><p className="bots-secure-limit">Unchecked keeps content private. Model/native history copies, and website/session/autofill copies, cannot be removed by deleting this transfer.</p>
  {error && <p role="alert">{error}</p>}<button type="submit" disabled={busy || !online || !client.online}>{busy ? 'Transferring…' : sealed ? 'Retry same submission' : 'Submit securely'}</button>
 </form>;
}
export function SecureInputCard({ request, online, supported = true }: {
    request: SecureRequest;
    online: boolean;
    supported?: boolean;
}) {
    const [open, setOpen] = useState(false), [receipt, setReceipt] = useState<SecureRequest | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const current = receipt?.state === 'deleted' ? receipt : request.state !== 'waiting' ? request : receipt ?? request;
    const terminal = current.state !== 'waiting';
    const stateLabel = current.state === 'waiting' ? 'Input requested' : current.state === 'received' ? 'Delivered' : current.state === 'unavailable' ? 'Unavailable' : current.state === 'expired' ? 'Expired' : 'Deleted';
    useEffect(() => { if (terminal) queueMicrotask(() => setOpen(false)); }, [terminal, current.state]);
    const remove = async () => { setBusy(true); setError(''); try {
        await client.secure({ action: 'delete', botId: request.botId, threadId: request.threadId, requestId: request.id });
        setOpen(false);
        setReceipt({ ...current, state: 'deleted' });
    }
    catch {
        setError('Deletion unconfirmed. Reconnect and retry Delete Now.');
    }
    finally {
        setBusy(false);
    } };
    return <details className={`bots-secure-card${terminal ? ' bots-secure-history' : ''}`} aria-label="Secure one-time input" open={open} onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
  <summary><ChevronRight size={15} className="bots-disclosure-chevron" aria-hidden="true"/><LockKeyhole size={16} aria-hidden="true"/><span className="bots-secure-title">{request.title}</span><span className="bots-secure-state">{stateLabel}</span></summary>
  {open && <div className="bots-secure-body"><p>{request.purpose}</p><p>Destination: {request.destination.label}{request.destination.origin && <> · {request.destination.origin}</>}</p>
  {current.state === 'waiting' ? <>{!online && <p>Reconnect to submit this secure form.</p>}{supported && <SecureForm key={request.id} request={request} online={online} onClose={() => setOpen(false)} onReceived={r => { setReceipt(r); setOpen(false); }}/>}</> : <div className="bots-secure-receipt">{current.state === 'unavailable' && <p>This transfer is unavailable. Ask the bot for a fresh request if it is still needed.</p>}{current.receivedAt && <p>Received: {new Date(current.receivedAt).toLocaleString()}</p>}{current.expiresAt && <p>Expiry: {new Date(current.expiresAt).toLocaleString()}</p>}{current.modelRead && <p>Model reading was explicitly permitted; those copies survive deletion.</p>}</div>}
  {!['deleted', 'expired'].includes(current.state) && <button disabled={!online || busy} className="bots-secure-delete" onClick={() => void remove()}><Trash2 size={14}/>Delete Now</button>}
  </div>}{error && <p role="alert">{error}</p>}
 </details>;
}
/** Active requests are reachable independently of a virtual history window. */
export function SecureInputAccess({ state }: { state: ReturnType<typeof useSecureInputRequests> }) {
    const waiting = state.requests.filter(r => r.state === 'waiting');
    const [open, setOpen] = useState(false), [selected, setSelected] = useState<string[]>([]);
    const dialog = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
    useEffect(() => {
        if (!open) return;
        const target = trigger.current; dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
        return () => { if (target?.isConnected) target.focus(); };
    }, [open]);
    if (!waiting.length && !state.error && !state.loading && !open) return null;
    const rows = state.requests.filter(r => r.state === 'waiting' || selected.includes(r.id));
    return <div className="bots-secure-access">
      {waiting.length > 0 && <button ref={trigger} type="button" onClick={() => { setSelected(waiting.map(r => r.id)); setOpen(true); }}><LockKeyhole size={15} aria-hidden="true"/>{waiting.length === 1 ? 'Open private form' : `Open ${waiting.length} private forms`}</button>}
      {state.loading && <small role="status">Checking private forms…</small>}
      {state.error && <span role="alert">{state.error} <button type="button" disabled={!state.online || !state.enabled || state.loading} onClick={state.retry}>Retry forms</button></span>}
      {!state.enabled && waiting.length > 0 && <p>This bridge does not support private forms. Update it before submitting.</p>}
      {open && <div className="bots-secure-dialog-layer"><div ref={dialog} className="bots-secure-dialog" role="dialog" aria-modal="true" aria-label="Private input forms" onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setOpen(false); }
        if (event.key === 'Tab') {
          const nodes = [...dialog.current!.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),summary,select:not([disabled]),textarea:not([disabled]),a[href]')].filter(node => node.offsetParent !== null);
          const first = nodes[0], last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      }}>
        <button type="button" className="bots-secure-close" aria-label="Close private forms" onClick={() => setOpen(false)}><X size={18}/></button>
        <h2>Private input forms</h2>
        {!state.online && <p>Reconnect to verify and submit these forms. This is their last known status.</p>}
        {!state.enabled && <p>Submission is unavailable in this bridge version.</p>}
        {state.error && <p role="alert">{state.error}</p>}
        {!rows.length && <p>No waiting private forms remain.</p>}
        {rows.map(request => <SecureInputCard key={request.id} request={request} online={state.online} supported={state.enabled}/>)}
      </div></div>}
    </div>;
}
