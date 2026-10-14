import { taskRequestValues, type TaskRequestGuest, type TaskRequestPatch, type TaskRequestValues } from '../../lib/task-requests';
import { mergeFormReceipt } from './receipts';
type Edit = {
    value: string | string[];
    base?: string | string[];
};
export type OrdinaryProgress = {
    changes: TaskRequestValues;
    baseValues: TaskRequestValues;
    name?: {
        value: string;
        base: string;
    };
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Field bases survive local edits and out-of-order receipts. Private fields never enter this model. */
export class SharedProgress {
    request: TaskRequestGuest;
    private edits: Record<string, Edit> = {};
    private nameEdit?: {
        value: string;
        base: string;
    };
    constructor(request: TaskRequestGuest) { this.request = request; }
    get values() { return { ...this.request.submission?.values, ...Object.fromEntries(Object.entries(this.edits).map(([id, e]) => [id, e.value])) }; }
    get name() { return this.nameEdit?.value ?? this.request.submission?.contributorName ?? ''; }
    get dirty() { return !!Object.keys(this.edits).length || !!this.nameEdit; }
    get conflicts() {
        const shared = this.request.submission?.values ?? {};
        return [...Object.entries(this.edits).filter(([id, e]) => !same(shared[id], e.base) && !same(shared[id], e.value)).map(([id]) => id),
            ...(this.nameEdit && this.request.submission?.contributorName !== this.nameEdit.base && this.request.submission?.contributorName !== this.nameEdit.value ? ['$name'] : [])];
    }
    change(id: string, value: string | string[]) {
        const valid = taskRequestValues(this.request.spec, { [id]: value });
        taskRequestValues(this.request.spec, { ...this.values, [id]: value });
        const base = Object.hasOwn(this.edits, id) ? this.edits[id].base : this.request.submission?.values[id];
        this.edits[id] = { value: valid[id], ...(base === undefined ? {} : { base }) };
        if (same(base, value))
            delete this.edits[id];
    }
    changeName(value: string) {
        if (value.length > 100 || /[\x00-\x1f]/.test(value))
            throw Error('Use a name up to 100 characters without control characters.');
        const base = this.nameEdit?.base ?? this.request.submission?.contributorName ?? '';
        this.nameEdit = value === base ? undefined : { value, base };
    }
    receive(next: TaskRequestGuest) {
        if (next.id !== this.request.id || next.revision !== this.request.revision || next.submission?.id !== this.request.submission?.id)
            throw Error('Shared progress scope changed. Reopen the original form.');
        this.request = mergeFormReceipt(this.request, next);
        // A final submission cannot consume unsaved local work, even when an answer happens to match.
        if (!this.request.submission?.submittedAt) {
            for (const [id, e] of Object.entries(this.edits))
                if (same(this.request.submission?.values[id], e.value))
                    delete this.edits[id];
            if (this.nameEdit?.value === this.request.submission?.contributorName)
                this.nameEdit = undefined;
        }
    }
    resolve(id: string, keepMine: boolean) {
        if (id === '$name') {
            if (this.nameEdit)
                this.nameEdit = keepMine ? { ...this.nameEdit, base: this.request.submission?.contributorName ?? '' } : undefined;
        }
        else if (this.edits[id]) {
            if (keepMine)
                this.edits[id] = { value: this.edits[id].value, base: this.request.submission?.values[id] };
            else
                delete this.edits[id];
        }
    }
    snapshot(): OrdinaryProgress {
        return { changes: Object.fromEntries(Object.entries(this.edits).map(([id, e]) => [id, e.value])), baseValues: Object.fromEntries(Object.entries(this.edits).filter(([, e]) => e.base !== undefined).map(([id, e]) => [id, e.base!])), ...(this.nameEdit ? { name: { ...this.nameEdit } } : {}) };
    }
    restore(draft: OrdinaryProgress) {
        const changes = taskRequestValues(this.request.spec, draft.changes), base = taskRequestValues(this.request.spec, draft.baseValues);
        if (Object.keys(base).some(k => !Object.hasOwn(changes, k)))
            throw Error('Ordinary recovery scope changed.');
        this.edits = Object.fromEntries(Object.entries(changes).map(([id, value]) => [id, { value, ...(base[id] === undefined ? {} : { base: base[id] }) }]));
        if (draft.name) {
            this.changeName(draft.name.value);
            this.nameEdit = { ...draft.name };
        }
        this.receive(this.request);
    }
    patch(): Omit<TaskRequestPatch, 'id' | 'operationId'> | null {
        if (!this.dirty)
            return null;
        if (this.conflicts.length)
            throw Error('Resolve shared answer conflicts before saving or submitting.');
        if (this.request.submission?.submittedAt)
            throw Error('This submission is frozen. Unsaved ordinary changes remain on this device.');
        taskRequestValues(this.request.spec, this.values);
        return { ...this.snapshot(), expectedRevision: this.request.submission!.revision };
    }
}
