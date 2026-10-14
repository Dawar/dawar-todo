'use client';
import { useId, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { Button } from '@/components/ui/button';
export function shareQr(url: string) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || url.length > 2048)
        throw Error('A configured HTTPS form link is required.');
    const qr = qrcode(0, 'M');
    qr.addData(url, 'Byte');
    qr.make();
    const count = qr.getModuleCount();
    let path = '';
    for (let row = 0; row < count; row++)
        for (let col = 0; col < count; col++)
            if (qr.isDark(row, col))
                path += `M${col + 4},${row + 4}h1v1h-1z`;
    return { size: count + 8, path };
}
/** Locally generated SVG. No third-party requests, URL embedding in image endpoints or HTML injection. */
export function FormShare({ url, disabled = false }: {
    url?: string;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false), [notice, setNotice] = useState('');
    const toggle = useRef<HTMLButtonElement>(null), id = useId();
    const qr = useMemo(() => { try {
        return url ? shareQr(url) : null;
    }
    catch {
        return null;
    } }, [url]);
    return <aside className="task-request-share" aria-label="Form sharing" onKeyDown={e => { if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            toggle.current?.focus();
        } }}>
        <Button ref={toggle} className="task-request-control" type="button" variant="outline" aria-expanded={open} aria-controls={id} disabled={disabled || !qr} onClick={() => setOpen(v => !v)}>Share / QR</Button>
        {!qr && !disabled && <small>Publish this form to create its link and QR.</small>}
        {open && qr && !disabled && <section id={id} className="task-request-share-panel">
            <strong>Protected link · anyone with this link can access shared ordinary progress</strong>
            <svg role="img" aria-label="QR code for this protected form" viewBox={`0 0 ${qr.size} ${qr.size}`} width="192" height="192" shapeRendering="crispEdges"><rect width={qr.size} height={qr.size} fill="white"/><path d={qr.path} fill="black"/></svg>
            <div className="task-request-actions"><Button className="task-request-control" type="button" variant="outline" onClick={() => void navigator.clipboard.writeText(url!).then(() => setNotice('Link copied.')).catch(() => setNotice('Copy unavailable. Use Open form.'))}>Copy link</Button><a className="task-request-control task-request-open" href={url} target="_blank" rel="noreferrer">Open form</a><Button className="task-request-control" type="button" variant="outline" onClick={() => { setOpen(false); toggle.current?.focus(); }}>Close QR</Button></div>
            {notice && <p role="status">{notice}</p>}
        </section>}
    </aside>;
}
