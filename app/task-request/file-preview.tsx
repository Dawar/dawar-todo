'use client';
import { useEffect, useEffectEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Download, ExternalLink, File, LoaderCircle } from 'lucide-react';
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
    return <GuestFilePreviewView file={file} busy={busy} open={open} url={url} error={error} onToggle={() => { setOpen(v => !v); setUrl(''); setError(''); }} />;
}

export function GuestFilePreviewView({ file, busy, open, url, error, onToggle }: {
    file: TaskRequestFile; busy: boolean; open: boolean; url: string; error: string; onToggle: () => void;
}) {
    const image = ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimeType), pdf = file.mimeType === 'application/pdf';
    return <section className="space-y-3 rounded-lg border border-border bg-card p-3" aria-label={`File: ${file.name}`}>
      <div className="flex min-w-0 items-start gap-2"><File aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">{file.name}</span></div>
      {!file.ready ? <p role="status" className="text-sm text-muted-foreground">Awaiting confirmation</p> : <>
        <Button className="task-request-control" variant="outline" type="button" disabled={busy} aria-expanded={open} onClick={onToggle}>{busy && <LoaderCircle aria-hidden="true" className="motion-safe:animate-spin" />}{busy ? 'Loading preview…' : open ? 'Close preview' : 'Preview file'}</Button>
        {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        {url && open && <>{image ?
          // Viewer-owned verified blob URLs cannot use the Next image proxy.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={file.name} className="max-h-80 w-full rounded-md object-contain" /> : pdf ? <iframe title={`PDF: ${file.name}`} src={`${url}#view=FitH`} className="h-80 w-full rounded-md border border-border" /> : null}
          <div className="flex flex-wrap gap-2"><Button className="task-request-control" variant="outline" asChild><a href={url} download={file.name}><Download aria-hidden="true" />Download original</a></Button>{pdf && <Button className="task-request-control" variant="outline" asChild><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />Open PDF</a></Button>}</div>
        </>}
      </>}
    </section>;
}
