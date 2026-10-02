import { randomUUID, createHash } from 'node:crypto';
import { SECURE_IMAGE_BYTES, SECURE_WIRE_BYTES, secureContextBytes, secureDerivedKey } from '../lib/secure-input.ts';
const now = () => new Date().toISOString(), hour = 3600000;
const id = value => typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,180}$/.test(value);
const fail = () => Error('Secure input rejected. No sensitive contents were returned.');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const label = (value, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value))
    throw fail(); return value.trim(); };
const origin = value => { const u = new URL(value); if (u.protocol !== 'https:' || u.username || u.password || u.hash)
    throw fail(); return u; };
const decode = (value, max) => { if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw fail(); const b = Buffer.from(value, 'base64'); if (b.length > max || b.toString('base64') !== value)
    throw fail(); return b; };
export class SecureInputs {
    constructor(runtime, { fetcher = fetch, clock = Date.now } = {}) {
        Object.assign(this, { runtime, fetcher, clock });
        this.live = new Map();
        this.transfers = new Map();
        this.pendingStates = new Map();
        for (const row of runtime.store.list('secureInput'))
            if (['waiting', 'received'].includes(row.state))
                this.save({ ...row, state: 'unavailable' });
        this.timer = setInterval(() => this.sweep(), 5000);
        this.timer.unref?.();
    }
    save(row) {
        try { this.runtime.store.transaction(() => { this.runtime.store.put('secureInput', row); this.runtime.emitEvent('secure.status', row, row.botId); }); }
        catch { if (fingerprint(this.runtime.store.get('secureInput', row.id)) !== fingerprint(row)) throw fail(); }
        this.pendingStates.delete(row.id);
        return row;
    }
    receipt(value) {
        const received = this.save(value.receipt);
        if (!value.notified) {
            value.notified = true;
            void Promise.resolve().then(() => this.runtime.secureReceived?.(received)).catch(() => { value.notified = false; });
        }
        return { received: true, request: received };
    }
    row(bot, handle) {
        const row = this.runtime.store.get('secureInput', handle);
        if (!bot || !row || row.botId !== bot.id || row.threadId !== bot.threadId || bot.archived || bot.archiving || bot.deletedAt) throw fail();
        return this.pendingStates.has(handle) ? { ...row, state: this.pendingStates.get(handle) } : row;
    }
    list(bot) {
        this.sweep();
        return this.runtime.store.list('secureInput', bot.id).filter(r => r.threadId === bot.threadId).slice(-20).map(r => this.pendingStates.has(r.id) ? { ...r, state: this.pendingStates.get(r.id) } : r);
    }
    async request(bot, p, callId) {
        if(this.runtime.primary && !this.runtime.primary.single(bot))throw Error('Secure input requires this named bot’s persistent native thread.');
        if (this.runtime.relayOnline === false)
            throw Error('Connect the bot bridge before requesting secure input.');
        if (!bot.threadId || bot.archived || bot.archiving || bot.deletedAt || !id(p.operationId ?? callId) || !plain(p.destination) || !['desktop', 'https'].includes(p.destination.kind))
            throw fail();
        const fields = p.fields ?? [], images = p.images ?? [];
        if (!Array.isArray(fields) || !Array.isArray(images) || fields.length > 6 || images.length > 2 || !fields.length && !images.length)
            throw fail();
        const names = new Set();
        const slots = (list, field) => list.map(s => { if (!plain(s) || typeof s.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(s.name) || names.has(s.name) || s.name === 'allow-model')
            throw fail(); names.add(s.name); return { name: s.name, label: label(s.label, 100), required: s.required !== false, ...(field ? { secret: s.secret !== false } : {}) }; });
        const description = { title: label(p.title, 100), purpose: label(p.purpose), destination: { kind: p.destination.kind, label: label(p.destination.label, 200), ...(p.destination.kind === 'https' ? { origin: origin(p.destination.origin).origin } : {}) }, fields: slots(fields, true), images: slots(images, false) };
        const operation = `${bot.id}:${bot.threadId}:${p.operationId ?? callId}`, existing = this.runtime.store.list('secureInput', bot.id).find(r => r.operation === operation);
        if (existing) {
            if (existing.descriptionHash !== fingerprint(description))
                throw fail();
            return { request: existing, handle: existing.id };
        }
        if (this.live.size >= 32 || this.list(bot).filter(r => ['waiting', 'received'].includes(r.state)).length >= 8)
            throw Error('Finish or delete an earlier secure request first.');
        const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
        // Key generation yields. Reconcile this original request identity again
        // before publishing a card so concurrent same-ID calls cannot fork it.
        const concurrent = this.runtime.store.list('secureInput', bot.id).find(r => r.operation === operation);
        if (concurrent) {
            if (concurrent.descriptionHash !== fingerprint(description)) throw fail();
            return { request: concurrent, handle: concurrent.id };
        }
        if (this.live.size >= 32 || this.list(bot).filter(r => ['waiting', 'received'].includes(r.state)).length >= 8)
            throw Error('Finish or delete an earlier secure request first.');
        const row = { id: `secure:${randomUUID()}`, botId: bot.id, threadId: bot.threadId, ...description, state: 'waiting', createdAt: now(), operation, descriptionHash: fingerprint(description) };
        const value = { pair, operations: new Map(), responses: new Map(), aborts: new Set() };
        this.live.set(row.id, value);
        this.retain(row.id, value, this.clock() + hour);
        try { this.save(row); } catch { clearTimeout(value.expiryTimer); value.pair=null; this.live.delete(row.id); throw fail(); }
        return { request: row, handle: row.id };
    }
    retain(handle, value, deadline) { clearTimeout(value.expiryTimer); value.deadline = deadline; value.expiryTimer = setTimeout(() => this.clear(handle, 'expired'), Math.max(0, deadline - this.clock())); value.expiryTimer.unref?.(); }
    clear(handle, state = 'deleted') {
        const value = this.live.get(handle);
        if (value) {
            clearTimeout(value.expiryTimer);
            for (const abort of value.aborts)
                abort.abort();
            value.aborts.clear();
            value.operations.clear();
            value.plain?.fill(0);
            for (const image of value.payload?.images ?? [])
                image.bytes.fill(0);
            for (const response of value.responses.values())
                response.bytes.fill(0);
            value.pair = null;
            value.payload = null;
            value.plain = null;
            value.responses.clear();
            this.live.delete(handle);
        }
        for (const [key, transfer] of this.transfers)
            if (transfer.requestId === handle) {
                transfer.bytes.fill(0);
                this.transfers.delete(key);
            }
        const row = this.runtime.store.get('secureInput', handle);
        if (row && !['deleted', 'expired', 'unavailable'].includes(row.state))
            try { this.save({ ...row, state }); } catch { this.pendingStates.set(handle,state); }
        return { deleted: true };
    }
    sweep() {
        for (const [handle, state] of this.pendingStates) {
            const row = this.runtime.store.get('secureInput', handle);
            if (row) try { this.save({ ...row, state }); } catch { /* RAM already cleared; retry metadata only. */ }
        }
        for (const [handle, value] of this.live) {
            if (value.deadline <= this.clock()) this.clear(handle, 'expired');
            else if (value.receipt && (!value.notified || this.runtime.store.get('secureInput', handle)?.state === 'waiting')) {
                try { this.receipt(value); } catch { /* Keep the same RAM receipt and ciphertext identity. */ }
            }
        }
        for (const [key, t] of this.transfers) if (t.deadline <= this.clock()) { t.bytes.fill(0); this.transfers.delete(key); }
    }
    close() { clearInterval(this.timer); for (const key of [...this.live.keys()])
        this.clear(key, 'unavailable'); }
    async channel(message) {
        this.sweep();
        const { owner, botId, threadId, requestId, action } = message;
        if (!id(botId) || !id(requestId) || typeof owner !== 'string' || owner.length > 320 || !owner)
            throw fail();
        const bot = this.runtime.store.bot(botId), row = this.row(bot, requestId);
        if (row.threadId !== threadId)
            throw fail();
        let value = this.live.get(row.id);
        if (value?.owner && value.owner !== owner)
            throw fail();
        if (action === 'delete') {
            if (value?.owner && value.owner !== owner)
                throw fail();
            return this.clear(row.id);
        }
        if (action === 'status')
            return { request: row };
        if (!value || !['waiting', 'received'].includes(row.state))
            throw Error('Secure input unavailable after expiry or service restart. Ask for a fresh request.');
        if (value.owner && value.owner !== owner)
            throw fail();
        value.owner ??= owner;
        if (action === 'key') {
            if (row.state !== 'waiting')
                return { request: row };
            return { request: row, owner, publicKey: await crypto.subtle.exportKey('jwk', value.pair.publicKey) };
        }
        if (action !== 'chunk' || !id(message.submissionId) || !plain(message.publicKey) || typeof message.iv !== 'string' || typeof message.digest !== 'string' || !/^[a-f0-9]{64}$/.test(message.digest))
            throw fail();
        const context = { owner, botId, threadId, requestId, submissionId: message.submissionId };
        const total = message.total, offset = message.offset;
        if (!Number.isSafeInteger(total) || total < 16 || total > SECURE_WIRE_BYTES || !Number.isSafeInteger(offset) || offset < 0)
            throw fail();
        const chunk = decode(message.data, 192 * 1024), header = fingerprint({ context, publicKey: message.publicKey, iv: message.iv, total, digest: message.digest });
        if (row.state === 'received' || value.receipt) {
            // Duplicate ciphertext is verified against the retained per-chunk digest, never re-used.
            if (value.submissionId !== message.submissionId || value.header !== header || value.chunks.get(offset) !== fingerprint(chunk))
                throw fail();
            return this.receipt(value);
        }
        const key = `${row.id}:${message.submissionId}`;
        let t = this.transfers.get(key);
        if (!t) {
            if (offset !== 0 || this.transfers.size >= 4 || [...this.transfers.values()].reduce((n, t) => n + t.bytes.length, 0) + total > 64 * 1024 * 1024 || [...this.transfers.values()].some(t => t.requestId === row.id))
                throw fail();
            t = { requestId: row.id, owner, header, bytes: Buffer.alloc(total), received: 0, chunks: new Map(), deadline: this.clock() + 60000 };
            this.transfers.set(key, t);
        }
        if (t.owner !== owner || t.header !== header || offset > t.received || offset + chunk.length > total || !chunk.length)
            throw fail();
        if (offset < t.received) {
            if (t.chunks.get(offset) !== fingerprint(chunk))
                throw fail();
            return { received: false, nextOffset: t.received };
        }
        chunk.copy(t.bytes, offset);
        t.chunks.set(offset, fingerprint(chunk));
        t.received += chunk.length;
        t.deadline = this.clock() + 60000;
        chunk.fill(0);
        if (t.received < total)
            return { received: false, nextOffset: t.received };
        if (value.receiving) {
            await value.receiving;
            return { received: true, request: this.row(bot, row.id) };
        }
        value.receiving = this.accept(row, value, t, message, context);
        try {
            return await value.receiving;
        }
        finally {
            t.bytes.fill(0);
            this.transfers.delete(key);
            value.receiving = null;
        }
    }
    async accept(row, value, t, message, context) {
        let bytes;
        try {
            if (createHash('sha256').update(t.bytes).digest('hex') !== message.digest)
                throw fail();
            const iv = decode(message.iv, 12);
            if (iv.length !== 12)
                throw fail();
            const key = await secureDerivedKey(value.pair.privateKey, message.publicKey, context);
            bytes = Buffer.from(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: secureContextBytes(context), tagLength: 128 }, key, t.bytes));
            const payload = JSON.parse(bytes.toString('utf8'));
            this.validate(row, payload);
            if ([...this.live.values()].reduce((n, v) => n + (v.payload?.images ?? []).reduce((sum, image) => sum + image.bytes.length, 0), 0) + payload.images.reduce((n, image) => n + Buffer.byteLength(image.data, 'base64'), 0) > 64 * 1024 * 1024)
                throw fail();
            if (this.live.get(row.id) !== value || this.row(this.runtime.store.bot(row.botId), row.id).state !== 'waiting')
                throw fail();
            value.payload = { fields: payload.fields, images: payload.images.map(image => ({ ...image, bytes: decode(image.data, SECURE_IMAGE_BYTES), data: undefined })), modelRead: payload.modelRead };
            value.submissionId = context.submissionId;
            value.header = t.header;
            value.chunks = t.chunks;
            this.retain(row.id, value, this.clock() + hour);
            value.pair = null;
            value.receipt = { ...row, state: 'received', receivedAt: new Date(this.clock()).toISOString(), expiresAt: new Date(value.deadline).toISOString(), modelRead: payload.modelRead };
            return this.receipt(value);
        }
        catch {
            throw fail();
        }
        finally {
            bytes?.fill(0);
        }
    }
    validate(row, p) {
        if (!plain(p) || !plain(p.fields) || !Array.isArray(p.images) || p.images.length > 2 || typeof p.modelRead !== 'boolean')
            throw fail();
        if (Object.keys(p.fields).some(k => !row.fields.some(f => f.name === k)))
            throw fail();
        for (const field of row.fields) {
            const v = p.fields[field.name];
            if (v !== undefined && (typeof v !== 'string' || v.length > 4096) || field.required && (!v || typeof v !== 'string'))
                throw fail();
        }
        let total = 0;
        const seen = new Set();
        for (const image of p.images) {
            if (!plain(image) || seen.has(image.slot) || !row.images.some(s => s.name === image.slot) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType))
                throw fail();
            seen.add(image.slot);
            const b = decode(image.data, SECURE_IMAGE_BYTES);
            total += b.length;
            const valid = image.mimeType === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : image.mimeType === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[b.length - 2] === 255 && b[b.length - 1] === 217 : b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP';
            b.fill(0);
            if (!valid || total > SECURE_IMAGE_BYTES)
                throw fail();
        }
        if (row.images.some(s => s.required && !seen.has(s.name)))
            throw fail();
    }
    async tool(bot, name, p, callId) {
        this.sweep();
        if (name === 'bots_request_secure_input')
            return this.request(bot, p, callId);
        const row = this.row(bot, p.handle);
        if (name === 'bots_delete_secure_input')
            return this.clear(row.id);
        if (p.mode === 'status')
            return { request: row, handle: row.id };
        const value = this.live.get(row.id);
        if (row.state !== 'received' || !value?.payload)
            throw Error('No live secure submission. Ask for a fresh request if unavailable.');
        if (p.mode === 'model-read') {
            if (!value.payload.modelRead)
                throw Error('Private submission: model reading was not approved by the human.');
            if (p.source === 'response') {
                const response = value.responses.get(p.responseId);
                if (!response)
                    throw fail();
                return { __secureModelContent: [{ type: 'text', text: response.bytes.toString('utf8') }] };
            }
            return { __secureModelContent: [{ type: 'text', text: JSON.stringify(value.payload.fields) }, ...value.payload.images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.bytes.toString('base64') }))] };
        }
        if (!id(p.operationId ?? callId))
            throw fail();
        const operation = p.operationId ?? callId, hash = fingerprint(p), prior = value.operations.get(operation);
        if (prior) {
            if (prior.hash !== hash)
                throw fail();
            return prior.promise;
        }
        if (value.operations.size >= 32)
            throw Error('Secure use limit reached. Finish and delete this transfer.');
        const run = { hash };
        run.promise = this.use(bot, row, value, p);
        value.operations.set(operation, run);
        return run.promise;
    }
    async use(bot, row, value, p) {
        let begun = false;
        try {
            if (p.mode === 'desktop') {
                if (row.destination.kind !== 'desktop' || !/^0x[0-9a-fA-F]{1,8}$/.test(p.window_id))
                    throw fail();
                const text = value.payload.fields[p.field];
                if (typeof text !== 'string' || !text.length || text.length > 1000 || /[^\x20-\x7e]/.test(text))
                    throw Error('Desktop entry requires a named printable ASCII field of1–1000 characters.');
                begun = true;
                const result = await this.runtime.desktops.call(bot, 'type', { text, interval: 0, window_id: p.window_id }, () => { this.sweep(); if (this.live.get(row.id) !== value || this.row(this.runtime.store.bot(bot.id), row.id).state !== 'received')
                    throw fail(); });
                if (result?.isError)
                    throw fail();
                return { state: 'used', destination: 'desktop', verify: 'Observe this bot’s desktop normally to verify entry. Delete when finished.' };
            }
            if (p.mode !== 'https' || row.destination.kind !== 'https')
                throw fail();
            const url = origin(p.url);
            if (url.origin !== row.destination.origin)
                throw fail();
            const replace = (v, depth = 0) => { if (depth > 20)
                throw fail(); if (plain(v) && Object.hasOwn(v, 'field')) {
                if (Object.keys(v).length !== 1 || typeof value.payload.fields[v.field] !== 'string')
                    throw fail();
                return value.payload.fields[v.field];
            } if (Array.isArray(v))
                return v.map(x => replace(x, depth + 1)); if (plain(v))
                return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x, depth + 1)])); if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null)
                return v; throw fail(); };
            const text = v => { const result = replace(v); if (Array.isArray(result) && result.every(x => typeof x === 'string'))
                return result.join(''); if (typeof result !== 'string')
                throw fail(); return result; };
            const headers = new Headers();
            for (const [key, v] of Object.entries(p.headers ?? {})) {
                if (/^(host|content-length|connection|transfer-encoding)$/i.test(key))
                    throw fail();
                headers.set(key, text(v));
            }
            let body;
            if (p.json !== undefined) {
                body = JSON.stringify(replace(p.json));
                headers.set('Content-Type', 'application/json');
            }
            if (p.form !== undefined) {
                if (body)
                    throw fail();
                body = new URLSearchParams(Object.fromEntries(Object.entries(p.form).map(([k, v]) => [k, text(v)])));
            }
            if (p.images?.length) {
                if (body && p.form === undefined || p.images.length > 2)
                    throw fail();
                const form = new FormData();
                for (const [k, v] of Object.entries(p.form ?? {}))
                    form.set(k, text(v));
                for (const item of p.images) {
                    const image = value.payload.images.find(image => image.slot === item.slot);
                    if (!image)
                        throw fail();
                    form.set(label(item.field, 100), new Blob([image.bytes], { type: image.mimeType }), `image.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType.split('/')[1]}`);
                }
                body = form;
                headers.delete('Content-Type');
            }
            const method = p.method ?? 'POST';
            if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || method === 'GET' && body)
                throw fail();
            const abort = new AbortController();
            value.aborts.add(abort);
            const timer = setTimeout(() => abort.abort(), 30000);
            timer.unref?.();
            try {
                begun = true;
                const response = await this.fetcher(url, { method, headers, body, redirect: 'manual', signal: abort.signal });
                if (response.status >= 300 && response.status < 400) {
                    await response.body?.cancel();
                    return { state: 'redirect-rejected', status: response.status };
                }
                if (this.live.get(row.id) !== value) {
                    await response.body?.cancel();
                    return { state: 'unavailable' };
                }
                const reader = response.body?.getReader();
                let size = 0;
                const chunks = [];
                if (reader)
                    for (;;) {
                        const { value: chunk, done } = await reader.read();
                        if (done)
                            break;
                        size += chunk.length;
                        if (size > 1024 * 1024) {
                            await reader.cancel();
                            for (const chunk of chunks)
                                chunk.fill(0);
                            return { state: 'used', status: response.status, response: 'too-large-withheld' };
                        }
                        chunks.push(chunk);
                    }
                const bytes = Buffer.concat(chunks);
                for (const chunk of chunks)
                    chunk.fill(0);
                if (this.live.get(row.id) !== value) {
                    bytes.fill(0);
                    return { state: 'unavailable' };
                }
                if (value.responses.size >= 16 || [...this.live.values()].reduce((sum, v) => sum + [...v.responses.values()].reduce((n, r) => n + r.bytes.length, 0), 0) + bytes.length > 64 * 1024 * 1024) {
                    bytes.fill(0);
                    return { state: 'used', status: response.status, response: 'capacity-withheld' };
                }
                const responseId = `response:${randomUUID()}`;
                value.responses.set(responseId, { bytes });
                return { state: 'used', status: response.status, responseId, modelRead: row.modelRead === true };
            }
            finally {
                clearTimeout(timer);
                value.aborts.delete(abort);
            }
        }
        catch {
            return { state: begun ? 'unconfirmed' : 'rejected', detail: 'Private operation failed or its outcome is unconfirmed. Inspect the destination; retry this same operation ID only to retrieve its receipt. No values returned.' };
        }
    }
}
// Explicitly approved model reads may live in native/model history, but are
// never copied into DawarTodo's ordinary event/WAL journal or output indexing.
export function redactSecureNotification(data) {
    if (data.method === 'rawResponseItem/completed')
        return { ...data, params: { threadId: data.params?.threadId, turnId: data.params?.turnId, item: { type: 'other' } } }; // Raw upstream hidden contents have no application display role.
    const sanitize = item => {
        if (!item || !['dynamicToolCall', 'mcpToolCall'].includes(item.type) || !/(^|__)bots_use_secure_input$/.test(String(item.tool ?? '')))
            return item;
        return { ...item, arguments: { handle: '[private handle]' }, content: [], result: null, error: null, contentItems: [{ type: 'inputText', text: 'Secure tool output withheld from application storage.' }] };
    };
    if (data.params?.item)
        return { ...data, params: { ...data.params, item: sanitize(data.params.item) } };
    if (data.params?.turn?.items)
        return { ...data, params: { ...data.params, turn: { ...data.params.turn, items: data.params.turn.items.map(sanitize) } } };
    return data;
}
