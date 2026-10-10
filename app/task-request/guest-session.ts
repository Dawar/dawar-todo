import { taskRequestGuest, TaskRequestPrivateClient } from '../../lib/task-request-client';
import { artifactMime } from '../../lib/bot-file-metadata.mjs';
import { taskRequestSpec, taskRequestValues, type TaskRequestGuest, type TaskRequestGuestAction, type TaskRequestFile, type TaskRequestValues, type TaskRequestSecureSession } from '../../lib/task-requests';
import { secureBase64, SECURE_IMAGE_BYTES, type SecureEnvelope } from '../../lib/secure-input';
import { formJournal, type FormIntent } from './journal';
export function protectedLink(hash: string) {
    const match = /^#([^/]+)\/([A-Za-z0-9_-]{43})$/.exec(hash);
    if (!match)
        return null;
    try {
        const id = decodeURIComponent(match[1]);
        if (!/^[A-Za-z0-9:_-]{1,180}$/.test(id))
            return null;
        return { id, token: match[2] };
    }
    catch {
        return null;
    }
}
export class GuestFormSession {
    private client: TaskRequestPrivateClient | null = null;
    private envelope: SecureEnvelope | null = null;
    private closed = false;
    private transferHandle: string | undefined;
    private transferExpires = 0;
    private scope = '';
    private action: FormIntent | null = null;
    constructor(readonly id: string, private token: string, private pin: string | undefined, private api = taskRequestGuest, private privateFactory = (session: TaskRequestSecureSession) => new TaskRequestPrivateClient(session)) { }
    async call<T>(action: TaskRequestGuestAction): Promise<T> {
        if (this.closed)
            throw Error('Protected form closed.');
        const result = await this.api<T>(action, this.token, this.pin, AbortSignal.timeout(30000));
        if (this.closed)
            throw Error('Protected form closed.');
        return result;
    }
    async read() {
        const { request } = await this.call<{
            request: TaskRequestGuest;
        }>({ action: 'read', id: this.id });
        request.spec = taskRequestSpec(request.spec);
        if (request.id !== this.id || !request.submission?.id)
            throw Error('Original form receipt unavailable.');
        const scope = JSON.stringify(['guest', request.id, request.revision, request.submission.id]);
        if (this.scope && scope !== this.scope)
            throw Error('The published form changed. Reopen its original link.');
        this.scope = scope;
        this.action = await formJournal(scope, { kind: 'read' });
        return request;
    }
    get pending() { return this.action?.state === 'pending' ? this.action : null; }
    get sealed() { return !!this.envelope || !!this.transferHandle; }
    async mutate(request: TaskRequestGuest, action: Parameters<typeof formJournal>[1] & {
        kind: 'admit';
    }) {
        if (!this.scope)
            throw Error('Read the original form first.');
        const intent = await formJournal(this.scope, { ...action, spec: request.spec });
        this.action = intent;
        if (!intent)
            throw Error('Original form action unavailable.');
        const result = await this.call<{
            request: TaskRequestGuest;
        }>(intent.action as TaskRequestGuestAction);
        if (result.request.id !== request.id || result.request.revision !== request.revision || result.request.submission?.id !== request.submission?.id)
            throw Error('Submission receipt scope changed.');
        await formJournal(this.scope, { kind: 'settle', operationId: intent.action.operationId, requestId: request.id });
        this.action = null;
        return result.request;
    }
    async retry(request: TaskRequestGuest) {
        if (!this.pending)
            throw Error('No unconfirmed original action.');
        if (this.pending.action.action === 'upload')
            throw Error('Select the same original file to continue its upload.');
        return this.mutate(request, { kind: 'admit', action: this.pending.action });
    }
    async save(request: TaskRequestGuest, contributorName: string, values: TaskRequestValues) {
        if (contributorName.length > 100 || /[\x00-\x1f]/.test(contributorName))
            throw Error('Use a name up to 100 characters without control characters.');
        return this.mutate(request, { kind: 'admit', action: { action: 'save', id: request.id, operationId: crypto.randomUUID(), expectedRevision: request.submission!.revision, contributorName, values: taskRequestValues(request.spec, values) } });
    }
    async upload(request: TaskRequestGuest, fieldId: string, file: File) {
        const field = request.spec.fields.find(f => f.id === fieldId);
        if (!field || !['image', 'file'].includes(field.kind))
            throw Error('Use an ordinary upload field from this published form.');
        if (file.size < 1 || file.size > 100 * 1024 * 1024)
            throw Error('Choose a file up to 100 MB.');
        if (file.name.length > 160 || /[\x00-\x1f\\/]/.test(file.name) || !/^[\w.+-]+\/[\w.+-]+$/.test(file.type || 'application/octet-stream'))
            throw Error('Use a supported file name up to 160 characters and MIME type.');
        const normalizedType = artifactMime(file.name, file.type);
        if ((field.kind === 'image' || normalizedType.startsWith('image/')) && !['image/png', 'image/jpeg', 'image/webp'].includes(normalizedType))
            throw Error('Use PNG, JPEG or WebP images.');
        const bytes = await file.arrayBuffer(), sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
        const old = this.pending?.action;
        const action = { action: 'upload' as const, id: request.id, operationId: old?.action === 'upload' ? old.operationId : crypto.randomUUID(), fieldId, name: file.name, size: file.size, mimeType: old?.action === 'upload' ? old.mimeType : file.type || 'application/octet-stream', sha256 };
        if (normalizedType !== artifactMime(action.name, action.mimeType))
            throw Error('Choose the same original file type to continue its upload.');
        const intent = await formJournal(this.scope, { kind: 'admit', action });
        this.action = intent;
        const result = await this.call<{
            file: TaskRequestFile;
            upload?: {
                url: string;
                fields: Record<string, string>;
            };
        }>(action);
        const valid = (f: TaskRequestFile) => f.fieldId === fieldId && f.name === file.name && f.size === file.size && f.mimeType === artifactMime(action.name, action.mimeType) && f.sha256 === sha256;
        if (!valid(result.file))
            throw Error('Original file receipt changed. Retain the file.');
        if (old?.action === 'upload' && !result.file.ready) {
            try {
                const recovered = await this.call<{
                    file: TaskRequestFile;
                }>({ action: 'finalize', id: this.id, fileId: result.file.id });
                if (!valid(recovered.file) || recovered.file.id !== result.file.id || !recovered.file.ready)
                    throw Error('Original file receipt changed.');
                await formJournal(this.scope, { kind: 'settle', operationId: action.operationId, requestId: this.id });
                this.action = null;
                return recovered.file;
            }
            catch (e) {
                if (!['not_ready', 'integrity'].includes(String((e as {
                    code?: string;
                }).code)))
                    throw Error('Original upload confirmation is unavailable. No file bytes were sent again.');
            }
        }
        if (!result.file.ready && result.upload) {
            const url = new URL(result.upload.url);
            if (url.protocol !== 'https:')
                throw Error('File upload requires TLS.');
            const body = new FormData();
            Object.entries(result.upload.fields).forEach(([k, v]) => body.append(k, v));
            body.append('file', file);
            const sent = await fetch(url, { method: 'POST', body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(120000) });
            if (!sent.ok)
                throw Error('File transfer unconfirmed. Retain the same file and retry.');
        }
        const final = await this.call<{
            file: TaskRequestFile;
        }>({ action: 'finalize', id: this.id, fileId: result.file.id });
        if (!valid(final.file) || final.file.id !== result.file.id || !final.file.ready)
            throw Error('File confirmation unavailable.');
        await formJournal(this.scope, { kind: 'settle', operationId: action.operationId, requestId: this.id });
        this.action = null;
        return final.file;
    }
    async privateTransfer(request: TaskRequestGuest, fields: Record<string, string>, images: Record<string, File>, modelRead: boolean) {
        if (this.transferHandle) {
            if (this.transferExpires <= Date.now())
                throw Error('Private transfer expired. Ordinary progress is retained; ask the owner to review the request before fresh private entry.');
            return this.transferHandle;
        }
        this.client?.close();
        const session = await this.call<TaskRequestSecureSession>({ action: 'secure-session', id: this.id, submissionId: request.submission!.id });
        if (session.binding.requestId !== request.id || session.binding.revision !== request.revision || session.binding.submissionId !== request.submission!.id)
            throw Error('Private session scope changed.');
        const client = this.privateFactory(session);
        this.client = client;
        try {
            await client.connect();
            if (this.closed)
                throw Error('Form closed.');
            if (!this.envelope) {
                const descriptor = await client.descriptor();
                if (this.closed)
                    throw Error('Form closed.');
                const expectedFields = request.spec.fields.filter(f => f.kind === 'secure-text').map(f => f.id), expectedImages = request.spec.fields.filter(f => f.kind === 'secure-image').map(f => f.id);
                if (descriptor.request.purpose !== request.spec.secure?.purpose || JSON.stringify(descriptor.request.destination) !== JSON.stringify(request.spec.secure?.destination) || JSON.stringify(descriptor.request.fields.map(f => f.name)) !== JSON.stringify(expectedFields) || JSON.stringify(descriptor.request.images.map(f => f.name)) !== JSON.stringify(expectedImages))
                    throw Error('Private form definition changed. Reopen its original link.');
                if (Object.values(images).reduce((n, f) => n + f.size, 0) > SECURE_IMAGE_BYTES)
                    throw Error('Use at most 20 MB of private images.');
                const payload = { fields, modelRead, images: await Promise.all(Object.entries(images).map(async ([slot, file]) => {
                        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type))
                            throw Error('Use PNG, JPEG or WebP private images.');
                        const data = new Uint8Array(await file.arrayBuffer());
                        try {
                            return { slot, mimeType: file.type, data: secureBase64(data) };
                        }
                        finally {
                            data.fill(0);
                        }
                    })) };
                const envelope = await client.encrypt(descriptor, payload);
                if (this.closed)
                    throw Error('Form closed.');
                this.envelope = envelope;
            }
            if (this.closed)
                throw Error('Form closed.');
            const receipt = await client.transfer(this.envelope);
            if (this.closed)
                throw Error('Form closed.');
            if (receipt.taskRequest?.requestId !== request.id || receipt.taskRequest.submissionId !== request.submission!.id || receipt.taskRequest.revision !== request.revision || receipt.id !== this.envelope.context.requestId || receipt.state !== 'received' || !receipt.expiresAt)
                throw Error('Positive private receipt unavailable. Retry the same encrypted transfer.');
            const expires = Date.parse(receipt.expiresAt);
            if (!Number.isFinite(expires) || expires <= Date.now() || expires > Date.now() + 3601000)
                throw Error('Private receipt expiry unavailable. Retain the original encrypted transfer.');
            this.transferHandle = receipt.id;
            this.transferExpires = expires;
            this.envelope = null;
            client.close();
            return receipt.id;
        }
        finally {
            client.close();
            if (this.client === client)
                this.client = null;
        }
    }
    async submit(request: TaskRequestGuest, secureHandle?: string) { return this.mutate(request, { kind: 'admit', action: { action: 'submit', id: this.id, operationId: crypto.randomUUID(), expectedRevision: request.submission!.revision, submissionId: request.submission!.id, ...(secureHandle ? { secureHandle } : {}) } }); }
    releasePrivate() { this.client?.close(); this.client = null; this.envelope = null; this.transferHandle = undefined; }
    close() { this.closed = true; this.releasePrivate(); this.token = ''; this.pin = undefined; }
}
