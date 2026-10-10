// Sensitive traffic is an authenticated in-flight envelope, never ordinary RPC.
export function secureBrowserFrame(message: Record<string, unknown>, owner: string, clientId: string) {
    const identity = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(v);
    if (!identity(message.id) || !identity(message.botId) || !identity(message.requestId) || !identity(message.threadId) || !['key', 'chunk', 'status', 'delete'].includes(String(message.action)))
        throw Error('Invalid secure frame.');
    const base = { type: 'secure', id: message.id, botId: message.botId, threadId: message.threadId, requestId: message.requestId, action: message.action, owner, clientId };
    if (message.action !== 'chunk')
        return base;
    if (!identity(message.submissionId) || typeof message.data !== 'string' || message.data.length > 262144 || !Number.isSafeInteger(message.total) || Number(message.total) > 29 * 1024 * 1024 || Number(message.total) < 16 || !Number.isSafeInteger(message.offset) || Number(message.offset) < 0 || typeof message.iv !== 'string' || message.iv.length > 24 || typeof message.digest !== 'string' || !/^[a-f0-9]{64}$/.test(message.digest))
        throw Error('Invalid secure chunk.');
    const key = message.publicKey as JsonWebKey;
    if (!key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || key.x.length !== 43 || key.y.length !== 43 || key.d)
        throw Error('Invalid secure public key.');
    return { ...base, submissionId: message.submissionId, data: message.data, total: message.total, offset: message.offset, iv: message.iv, digest: message.digest, publicKey: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, ext: true } };
}
