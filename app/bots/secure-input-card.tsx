'use client';
import { useEffect, useRef, useState } from 'react';
import { LockKeyhole, X, Trash2 } from 'lucide-react';
import { botsClient as client } from './client';
import { encryptSecureInput, secureBase64, SECURE_IMAGE_BYTES, type SecureDescriptor, type SecureEnvelope, type SecureRequest } from '../../lib/secure-input';
import { transferSecureInput } from './secure-input-transfer';
import './secure-input-card.css';
function SecureForm({ request, onClose, onReceived }: {
    request: SecureRequest;
    onClose: () => void;
    onReceived: (r: SecureRequest) => void;
}) {
    const form = useRef<HTMLFormElement>(null), pending = useRef<SecureEnvelope | null>(null), mounted = useRef(true);
    const [images, setImages] = useState<Record<string, File>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [sealed, setSealed] = useState(false);
    useEffect(() => { mounted.current = true; const node = form.current; return () => { mounted.current = false; pending.current = null; node?.reset(); }; }, []);
    const submit = async () => {
        if (busy)
            return;
        const data = pending.current ? null : new FormData(form.current!);
        setBusy(true);
        setError('');
        try {
            if (!pending.current) {
                const descriptor = await client.secure<SecureDescriptor>({ action: 'key', botId: request.botId, threadId: request.threadId, requestId: request.id });
                if (!mounted.current)
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
                if (!mounted.current)
                    return;
                pending.current = encrypted;
                setSealed(true);
            }
            if (!mounted.current)
                return;
            const receipt = await transferSecureInput(client, pending.current);
            if (mounted.current) {
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
  {error && <p role="alert">{error}</p>}<button type="submit" disabled={busy || !client.online}>{busy ? 'Transferring…' : sealed ? 'Retry same submission' : 'Submit securely'}</button>
 </form>;
}
function SecureCard({ request, online }: {
    request: SecureRequest;
    online: boolean;
}) {
    const [open, setOpen] = useState(false), [receipt, setReceipt] = useState<SecureRequest | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const current = receipt?.state === 'deleted' ? receipt : request.state !== 'waiting' ? request : receipt ?? request;
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
    return <section className="bots-secure-card" aria-label="Secure one-time input"><div className="bots-secure-title"><LockKeyhole size={17}/><strong>{request.title}</strong></div><p>{request.purpose}</p><p>Destination: {request.destination.label}{request.destination.origin && <> · {request.destination.origin}</>}</p>
  {current.state === 'waiting' ? open ? <SecureForm request={request} onClose={() => setOpen(false)} onReceived={r => { setReceipt(r); setOpen(false); }}/> : <button disabled={!online} onClick={() => setOpen(true)}>Open secure form</button> : <div className="bots-secure-receipt"><strong>{current.state === 'received' ? 'Delivered' : current.state === 'unavailable' ? 'Unavailable · ask for a fresh request' : current.state === 'expired' ? 'Expired' : 'Deleted'}</strong>{current.receivedAt && <p>Received: {new Date(current.receivedAt).toLocaleString()}</p>}{current.expiresAt && <p>Expiry: {new Date(current.expiresAt).toLocaleString()}</p>}{current.modelRead && <p>Model reading was explicitly permitted; those copies survive deletion.</p>}</div>}
  {!['deleted', 'expired'].includes(current.state) && <button disabled={!online || busy} className="bots-secure-delete" onClick={() => void remove()}><Trash2 size={14}/>Delete Now</button>}{error && <p role="alert">{error}</p>}
 </section>;
}
export function SecureInputCards({ botId, threadId, online, enabled }: {
    botId: string;
    threadId: string | null;
    online: boolean;
    enabled: boolean;
}) {
    const [requests, setRequests] = useState<SecureRequest[]>([]);
    useEffect(() => { let mounted = true; const refresh = () => { if (online && enabled)
        void client.rpc<SecureRequest[]>('secure.list', botId, {}).then(rows => { if (mounted)
            setRequests(rows); }).catch(() => { }); }; refresh(); const listener = (event: import('../../lib/bots-types').BotEvent) => { if (event.type === 'secure.status' && event.botId === botId)
        refresh(); }; client.events.add(listener); const timer = setInterval(refresh, 10000); return () => { mounted = false; client.events.delete(listener); clearInterval(timer); }; }, [botId, threadId, online, enabled]);
    return <>{requests.filter(request => request.threadId === threadId).map(request => <SecureCard key={request.id} request={request} online={online}/>)}</>;
}
