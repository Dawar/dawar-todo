'use client';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { taskRequestRoute } from './task-request-route';
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
        return <p role="status">Opening…</p>;
    if (taskRequestRoute(path))
        return <Suspense fallback={<p role="status">Opening protected form…</p>}><Guest /></Suspense>;
    return children;
}
