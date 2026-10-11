'use client';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { taskRequestRoute } from './task-request-route';
import { PortableSessionBoundary } from './portable-session-boundary';
import { ScreenLoading } from './screen-feedback';
import { SignedOut } from './signed-out';
const Guest = lazy(() => import('./task-request/page'));
export function PublicRouteBoundary({ children }: {
    children: ReactNode;
}) {
    const frameworkPath = usePathname();
    const [path, setPath] = useState<string | null>(null);
    useEffect(() => {
        let alive = true;
        queueMicrotask(() => {
            if (alive)
                setPath(window.location.pathname);
        });
        return () => { alive = false; };
    }, [frameworkPath]);
    // No owner markup or effect mounts before the real browser URL is known.
    if (path === null)
        return <ScreenLoading />;
    if (taskRequestRoute(path))
        return <Suspense fallback={<ScreenLoading label="Opening protected form…" />}><Guest /></Suspense>;
    if (path === '/signout-with-chatgpt' && process.env.NEXT_PUBLIC_DAWAR_PORTABLE === '1') return <SignedOut />;
    return <PortableSessionBoundary>{children}</PortableSessionBoundary>;
}
