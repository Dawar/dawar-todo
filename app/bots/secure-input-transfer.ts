import { SECURE_CHUNK_BYTES, secureBase64, secureDecode, type SecureEnvelope, type SecureRequest } from '../../lib/secure-input.ts';
export type SecureTransport = {
    owner: string;
    secure<T>(frame: Record<string, unknown>): Promise<T>;
};
export async function transferSecureInput(client: SecureTransport, envelope: SecureEnvelope) {
    if (client.owner !== envelope.context.owner)
        throw Error('The signed-in owner changed. Close this form.');
    const bytes = secureDecode(envelope.ciphertext);
    try {
        for (let offset = 0; offset < bytes.length;) {
            const result = await client.secure<{
                received: boolean;
                nextOffset?: number;
                request?: SecureRequest;
            }>({ action: 'chunk', ...envelope.context, publicKey: envelope.publicKey, iv: envelope.iv, digest: envelope.digest, total: bytes.length, offset, data: secureBase64(bytes.subarray(offset, offset + SECURE_CHUNK_BYTES)) });
            if (result.received) {
                const r = result.request;
                if (r?.state !== 'received' || r.id !== envelope.context.requestId || r.botId !== envelope.context.botId || r.threadId !== envelope.context.threadId || !r.receivedAt || !r.expiresAt)
                    throw Error('Receipt scope was not confirmed. Retry the same encrypted submission.');
                return r;
            }
            if (!Number.isSafeInteger(result.nextOffset) || result.nextOffset! <= offset || result.nextOffset! > bytes.length)
                throw Error('Delivery unconfirmed. Retain this same encrypted submission to retry.');
            offset = result.nextOffset!;
        }
        throw Error('Receipt unconfirmed. Retry the same encrypted submission.');
    }
    finally {
        bytes.fill(0);
    }
}
