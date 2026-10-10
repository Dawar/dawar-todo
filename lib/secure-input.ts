export const SECURE_IMAGE_BYTES = 20 * 1024 * 1024;
export const SECURE_WIRE_BYTES = 29 * 1024 * 1024;
export const SECURE_CHUNK_BYTES = 192 * 1024;
export type SecureField = {
    name: string;
    label: string;
    secret?: boolean;
    required?: boolean;
};
export type SecureImageSlot = {
    name: string;
    label: string;
    required?: boolean;
};
export type SecureRequest = {
    taskRequest?: import('./task-requests').TaskRequestSecureBinding;
    id: string;
    botId: string;
    threadId: string;
    title: string;
    purpose: string;
    destination: {
        kind: 'desktop' | 'https';
        label: string;
        origin?: string;
    };
    fields: SecureField[];
    images: SecureImageSlot[];
    state: 'waiting' | 'received' | 'deleted' | 'expired' | 'unavailable';
    createdAt: string;
    receivedAt?: string;
    expiresAt?: string;
    modelRead?: boolean;
};
export type SecureContext = {
    owner: string;
    botId: string;
    threadId: string;
    requestId: string;
    submissionId: string;
};
export type SecureDescriptor = {
    request: SecureRequest;
    owner: string;
    publicKey: JsonWebKey;
};
export type SecureEnvelope = {
    context: SecureContext;
    publicKey: JsonWebKey;
    iv: string;
    ciphertext: string;
    digest: string;
};
export type SecurePayload = {
    fields: Record<string, string>;
    images: {
        slot: string;
        mimeType: string;
        data: string;
    }[];
    modelRead: boolean;
};
export const secureContextBytes = (context: SecureContext) => new TextEncoder().encode(JSON.stringify(['dawar-secure-v1', context.owner, context.botId, context.threadId, context.requestId, context.submissionId]));
export function secureBase64(bytes: Uint8Array) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 8192)
        text += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(text);
}
export const secureDecode = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0));
export async function secureDerivedKey(privateKey: CryptoKey, publicKey: JsonWebKey, context: SecureContext) {
    const peer = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256));
    try {
        const key = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
        const salt = await crypto.subtle.digest('SHA-256', secureContextBytes(context));
        return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('dawar-secure-input-v1') }, key, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    finally {
        shared.fill(0);
    }
}
export async function encryptSecureInput(descriptor: SecureDescriptor, submissionId: string, payload: SecurePayload): Promise<SecureEnvelope> {
    const context = { owner: descriptor.owner, botId: descriptor.request.botId, threadId: descriptor.request.threadId, requestId: descriptor.request.id, submissionId };
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const key = await secureDerivedKey(pair.privateKey, descriptor.publicKey, context), iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    try {
        if (plain.length > SECURE_WIRE_BYTES - 1024)
            throw Error('Sensitive input is too large.');
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: secureContextBytes(context), tagLength: 128 }, key, plain);
        const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', ciphertext))].map(byte => byte.toString(16).padStart(2, '0')).join('');
        return { context, publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey), iv: secureBase64(iv), ciphertext: secureBase64(new Uint8Array(ciphertext)), digest };
    }
    finally {
        plain.fill(0);
    }
}
