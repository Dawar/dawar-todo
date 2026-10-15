'use client';
import { Suspense, useEffect, useState, type ReactNode } from 'react';
import { retryingLazy } from '../lib/retrying-lazy';
import { usePathname } from 'next/navigation';
import { taskRequestRoute } from './task-request-route';
import { PortableSessionBoundary } from './portable-session-boundary';
import { ScreenLoading } from './screen-feedback';
import { SignedOut } from './signed-out';
const Guest = retryingLazy(() => import('./task-request/page'));
export function PublicRouteBoundary({ children }: {
    children: ReactNode;
}) {
    const frameworkPath = usePathname();
    const [route, setRoute] = useState<{ path: string; signInFailed: boolean } | null>(null);
    useEffect(() => {
        let alive = true;
        queueMicrotask(() => {
            if (alive)
                setRoute({ path: window.location.pathname, signInFailed: new URLSearchParams(window.location.search).get('reason') === 'sign-in' });
        });
        return () => { alive = false; };
    }, [frameworkPath]);
    // No owner markup or effect mounts before the real browser URL is known.
    if (route === null)
        return <ScreenLoading />;
    const path = route.path;
    if (taskRequestRoute(path))
        return <Suspense fallback={<ScreenLoading label="Opening protected form…" />}><Guest /></Suspense>;
    if (path === '/signout-with-chatgpt' && process.env.NEXT_PUBLIC_DAWAR_PORTABLE === '1') return <SignedOut signInFailed={route.signInFailed} />;
    return <PortableSessionBoundary>{children}</PortableSessionBoundary>;
}
