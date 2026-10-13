import { createHash } from 'node:crypto';
import { StorageError } from './bot-storage';
import { taskRequestId } from '../lib/task-requests';
/** Typed first-party targets only. A capability is carried in the URL fragment,
 * sent in Authorization, and persisted only as a verifier. No URL proxy exists. */
export type ShortLinkTarget = {
    kind: 'task-request';
    requestId: string;
    revision: number;
    grantId: string;
    publicationId: string;
};
export const SHORT_LINK_SCHEMA = [
    'CREATE TABLE IF NOT EXISTS app_short_links(code_hash TEXT PRIMARY KEY,owner_key TEXT NOT NULL,kind TEXT NOT NULL,target TEXT NOT NULL)',
    "CREATE UNIQUE INDEX IF NOT EXISTS app_short_link_target ON app_short_links(owner_key,kind,json_extract(target,'$.grantId'))",
];
export function shortLinkTarget(value: unknown): ShortLinkTarget {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new StorageError('Invalid short-link target.');
    const v = value as Record<string, unknown>;
    if (Object.keys(v).some(k => !['kind', 'requestId', 'revision', 'grantId', 'publicationId'].includes(k)) || v.kind !== 'task-request' || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1)
        throw new StorageError('Unsupported short-link target.');
    return { kind: 'task-request', requestId: taskRequestId(v.requestId), revision: Number(v.revision), grantId: taskRequestId(v.grantId), publicationId: taskRequestId(v.publicationId) };
}
export const shortCodeHash = (code: string) => {
    if (!/^[A-Za-z0-9_-]{22}$/.test(code))
        throw new StorageError('Short link unavailable.', 401, 'unauthorized');
    return createHash('sha256').update(code).digest('hex');
};
export function shortLinkInsert(db: D1Database, owner: string, code: string, target: ShortLinkTarget) {
    const checked = shortLinkTarget(target);
    return db.prepare('INSERT INTO app_short_links VALUES(?,?,?,?)').bind(shortCodeHash(code), owner, checked.kind, JSON.stringify(checked));
}
export async function readShortLink(db: D1Database, owner: string, code: string) {
    const row = await db.prepare('SELECT target FROM app_short_links WHERE code_hash=? AND owner_key=?').bind(shortCodeHash(code), owner).first<{
        target: string;
    }>();
    if (!row)
        throw new StorageError('Short link unavailable.', 401, 'unauthorized');
    return shortLinkTarget(JSON.parse(row.target));
}
