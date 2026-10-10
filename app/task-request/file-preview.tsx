'use client';
import { useEffect, useEffectEvent, useState } from 'react';
import type { TaskRequestFile } from '../../lib/task-requests';
export function GuestFilePreview({ file, download }: {
    file: TaskRequestFile;
    download: () => Promise<{
        file: TaskRequestFile;
        url: string;
    }>;
}) {
    const [url, setUrl] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [open, setOpen] = useState(false);
    const read = useEffectEvent(() => download());
    useEffect(() => {
        let alive = true, objectUrl = '';
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30000);
        if (open) {
            queueMicrotask(() => {
                if (alive)
                    setBusy(true);
            });
            void read().then(async (r) => {
                if (r.file.id !== file.id || r.file.sha256 !== file.sha256 || r.file.size !== file.size || r.file.mimeType !== file.mimeType || !r.file.ready || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 100 * 1024 * 1024)
                    throw Error('Original file receipt unavailable.');
                const location = new URL(r.url);
                if (location.protocol !== 'https:')
                    throw Error('File preview requires TLS.');
                const response = await fetch(location, { credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal });
                if (!response.ok)
                    throw Error('File preview unavailable.');
                const reader = response.body?.getReader();
                if (!reader)
                    throw Error('File preview unavailable.');
                const bytes = new Uint8Array(file.size);
                let length = 0;
                try {
                    for (;;) {
                        const chunk = await reader.read();
                        if (chunk.done)
                            break;
                        if (length + chunk.value.length > bytes.length)
                            throw Error('File preview exceeds its original size.');
                        bytes.set(chunk.value, length);
                        length += chunk.value.length;
                    }
                    if (length !== file.size)
                        throw Error('File preview is incomplete.');
                }
                finally {
                    await reader.cancel().catch(() => { });
                }
                const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2, '0')).join('');
                if (digest !== file.sha256)
                    throw Error('File preview integrity changed.');
                if (!alive)
                    return;
                objectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
                setUrl(objectUrl);
            }).catch(e => {
                if (alive)
                    setError(e instanceof Error ? e.message : 'File preview unavailable.');
            }).finally(() => {
                if (alive)
                    setBusy(false);
                clearTimeout(timeout);
            });
        }
        return () => {
            alive = false;
            clearTimeout(timeout);
            controller.abort();
            if (objectUrl)
                URL.revokeObjectURL(objectUrl);
        };
    }, [open, file]);
    if (!file.ready)
        return <small>{file.name} · Awaiting confirmation</small>;
    const image = ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType), pdf = file.mimeType === 'application/pdf';
    return <div><button type="button" disabled={busy} onClick={() => { setOpen(v => !v); setUrl(''); setError(''); }}>{open ? 'Close preview' : 'Preview/download'} · {file.name}</button>{error && <p role="alert">{error}</p>}{url && open && <>{image ?
                // Viewer-owned verified blob URLs cannot use the Next image proxy.
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url} alt={file.name} style={{ maxWidth: '100%', maxHeight: 300 }}/> : pdf ? <iframe title={`PDF: ${file.name}`} src={`${url}#view=FitH`} style={{ width: '100%', height: 300 }}/> : null}<a href={url} download={file.name}>Download original file</a>{pdf && <a href={url} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 8 }}>Open PDF</a>}</>}</div>;
}
