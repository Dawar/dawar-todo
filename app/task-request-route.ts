/** Public form documents never bootstrap an owner surface, even on root-cache fallback. */
export function taskRequestRoute(path: string | null | undefined) {
    return path === '/task-request' || path?.startsWith('/task-request/') === true;
}
