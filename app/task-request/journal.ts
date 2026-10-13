/** Only allowlisted ordinary form data and opaque receipts enter this journal. */
import { taskRequestSource, taskRequestSpec, taskRequestValues, type TaskRequestOwnerAction, type TaskRequestGuestAction, type TaskRequestSpec } from '../../lib/task-requests';
import type { OrdinaryProgress } from './progress';
export type StoredFormAction = Exclude<TaskRequestOwnerAction, {
    action: 'list' | 'read';
}> | Exclude<TaskRequestGuestAction, {
    action: 'resolve' | 'read' | 'finalize' | 'download' | 'secure-session';
}>;
export type FormIntent = {
    action: StoredFormAction;
    pinRequired?: boolean;
    state: 'pending' | 'accepted' | 'conflict';
    requestId?: string;
};
let connection: Promise<IDBDatabase> | undefined;
function database() { return connection ??= new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('dawar-task-request-actions-v1', 1); r.onupgradeneeded = () => r.result.createObjectStore('intents'); r.onerror = () => reject(r.error); r.onblocked = () => reject(Error('Form recovery storage is blocked. Nothing new was sent.')); r.onsuccess = () => { r.result.onversionchange = () => { r.result.close(); connection = undefined; }; resolve(r.result); }; }).catch(e => { connection = undefined; throw e; }); }
export function ordinaryAction(a: StoredFormAction, spec?: TaskRequestSpec): StoredFormAction {
    if ('pin' in a)
        throw Error('PINs cannot enter saved form recovery.');
    const base = { action: a.action, operationId: a.operationId };
    if (a.action === 'draft')
        return { ...base, action: 'draft', source: taskRequestSource(a.source), spec: taskRequestSpec(a.spec) };
    if (a.action === 'edit')
        return { ...base, action: 'edit', id: a.id, expectedRevision: a.expectedRevision, spec: taskRequestSpec(a.spec) };
    if (a.action === 'publish')
        return { ...base, action: 'publish', id: a.id, expectedRevision: a.expectedRevision, ...(a.expirySeconds === undefined ? {} : { expirySeconds: a.expirySeconds }) };
    if (a.action === 'revoke')
        return { ...base, action: 'revoke', id: a.id, expectedRevision: a.expectedRevision };
    if (a.action === 'patch') {
        if (!spec) throw Error('Ordinary answer scope required.');
        const changes=taskRequestValues(spec,a.changes),baseValues=taskRequestValues(spec,a.baseValues);
        if(Object.keys(baseValues).some(k=>!Object.prototype.hasOwnProperty.call(changes,k)))throw Error('Invalid progress base.');
        return {...base,action:'patch',id:a.id,expectedRevision:a.expectedRevision,changes,baseValues,...(a.name?{name:{value:a.name.value,base:a.name.base}}:{})};
    }
    if (a.action === 'save') {
        if (!spec)
            throw Error('Ordinary answer scope required.');
        return { ...base, action: 'save', id: a.id, expectedRevision: a.expectedRevision, contributorName: a.contributorName, values: taskRequestValues(spec, a.values) };
    }
    if (a.action === 'submit')
        return { ...base, action: 'submit', id: a.id, expectedRevision: a.expectedRevision, submissionId: a.submissionId, ...(a.secureHandle ? { secureHandle: a.secureHandle } : {}) };
    return { ...base, action: 'upload', id: a.id, fieldId: a.fieldId, name: a.name, size: a.size, mimeType: a.mimeType, sha256: a.sha256 };
}
export async function formJournal(scope: string, command: {
    kind: 'read';
} | {
    kind: 'admit';
    action: StoredFormAction;
    spec?: TaskRequestSpec;
    pinRequired?: boolean;
} | {
    kind: 'settle' | 'conflict';
    operationId: string;
    requestId: string;
}) {
    const db = await database();
    return new Promise<FormIntent | null>((resolve, reject) => {
        const tx = db.transaction('intents', command.kind === 'read' ? 'readonly' : 'readwrite', { durability: 'strict' }), store = tx.objectStore('intents');
        let value: FormIntent | null = null, error: unknown;
        tx.oncomplete = () => resolve(value);
        tx.onabort = () => reject(error ?? tx.error ?? Error('Original form action could not be saved.'));
        tx.onerror = () => { };
        const r = store.get(scope);
        r.onsuccess = () => {
            try {
                const old = r.result as FormIntent | undefined;
                if (command.kind === 'read') {
                    value = old ?? null;
                    return;
                }
                if (command.kind === 'settle' || command.kind === 'conflict') {
                    const settle=(original:FormIntent|undefined)=>{
                        if(!original||original.action.operationId!==command.operationId)throw Error('Original action identity changed.');
                        value={...original,state:command.kind==='conflict'?'conflict':'accepted',requestId:command.requestId};
                        // A late original receipt must not replace another tab's newer pending intent.
                        if(old?.action.operationId===command.operationId)store.put(value,scope);
                        store.put(value,`operation:${scope}:${command.operationId}`);
                    };
                    if(old?.action.operationId===command.operationId)settle(old);
                    else {const original=store.get(`operation:${scope}:${command.operationId}`);original.onsuccess=()=>{try{settle(original.result);}catch(e){error=e;tx.abort();}};}
                    return;
                }
                if (command.kind !== 'admit') throw Error('Unknown form journal operation.');
                const action = ordinaryAction(command.action, command.spec);
                if (old?.state === 'pending') {
                    if (JSON.stringify(old.action) !== JSON.stringify(action) || !!old.pinRequired !== !!command.pinRequired)
                        throw Error('Confirm the earlier form action first. Its original input is retained.');
                    value = old;
                    return;
                }
                value = { action, state: 'pending', ...(command.pinRequired ? { pinRequired: true } : {}) };
                store.put(value, scope);
                store.put(value, `operation:${scope}:${value.action.operationId}`);
            }
            catch (e) {
                error = e;
                tx.abort();
            }
        };
    });
}
export async function formDraft(scope: string, spec?: TaskRequestSpec) {
    const db = await database();
    return new Promise<TaskRequestSpec | null>((resolve, reject) => {
        const tx = db.transaction('intents', spec ? 'readwrite' : 'readonly', { durability: 'strict' }), store = tx.objectStore('intents');
        let result: TaskRequestSpec | null = null;
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error ?? Error('Editable draft recovery unavailable.'));
        tx.onerror = () => { };
        if (spec) {
            result = taskRequestSpec(spec);
            store.put(result, `draft:${scope}`);
        }
        else {
            const r = store.get(`draft:${scope}`);
            r.onsuccess = () => { result = r.result ?? null; };
        }
    });
}
/** Local unsaved ordinary edits only. The caller's per-tab scope contains no bearer or PIN. */
export async function progressDraft(scope:string,spec:TaskRequestSpec,draft?:OrdinaryProgress):Promise<OrdinaryProgress|null> {
    const clean=(value:OrdinaryProgress):OrdinaryProgress=>{
        const changes=taskRequestValues(spec,value.changes),baseValues=taskRequestValues(spec,value.baseValues);
        if(Object.keys(baseValues).some(k=>!Object.hasOwn(changes,k)))throw Error('Invalid ordinary recovery base.');
        if(value.name&&[value.name.value,value.name.base].some(v=>typeof v!=='string'||v.length>100||/[\x00-\x1f]/.test(v)))throw Error('Invalid ordinary name recovery.');
        return {changes,baseValues,...(value.name?{name:{value:value.name.value,base:value.name.base}}:{})};
    };
    const validated=draft?clean(draft):undefined,db=await database();
    return new Promise((resolve,reject)=>{
        const tx=db.transaction('intents',validated?'readwrite':'readonly',{durability:'strict'}),store=tx.objectStore('intents');let result:OrdinaryProgress|null=null;
        tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error??Error('Local ordinary recovery unavailable.'));tx.onerror=()=>{};
        if(validated){result=validated;store.put(validated,`progress:${scope}`);}else {const r=store.get(`progress:${scope}`);r.onsuccess=()=>{try{result=r.result?clean(r.result):null;}catch{tx.abort();}};}
    });
}
/** Bind a newly acknowledged owner draft to its server ID without replacing recovery. */
export async function bindFormJournal(from: string, to: string, operationId: string) {
    if (from === to)
        return;
    const db = await database();
    return new Promise<void>((resolve, reject) => {
        const tx = db.transaction('intents', 'readwrite', { durability: 'strict' }), store = tx.objectStore('intents');
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? Error('Request receipt alias could not be saved.'));
        tx.onerror = () => { };
        const r = store.get(from);
        r.onsuccess = () => {
            const value = r.result as FormIntent | undefined;
            if (value?.action.operationId !== operationId || value.state !== 'accepted') {
                tx.abort();
                return;
            }
            const old = store.get(to);
            old.onsuccess = () => {
                if (!old.result)
                    store.put(value, to);
            };
        };
    });
}
