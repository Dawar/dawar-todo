import { createHash } from 'node:crypto';
import { StorageError, type BotStorageEnv } from './bot-storage';
import { TaskQueueExports } from './task-queue-exports';
import type { TaskDelegation } from '../lib/task-queue-delegation';
// Separate from source todo status, timestamps, recurrence, pin and files.
export const TASK_DELEGATION_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS todo_queue_state(todo_id INTEGER PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,delegation TEXT,delegation_generation INTEGER)`,
    `CREATE TABLE IF NOT EXISTS todo_queue_receipts(owner_key TEXT NOT NULL,operation_id TEXT NOT NULL,fingerprint TEXT NOT NULL,todo_id INTEGER NOT NULL,generation INTEGER NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(owner_key,operation_id))`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_source_delete AFTER DELETE ON todos BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) VALUES(OLD.id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_source_insert AFTER INSERT ON todos BEGIN
  UPDATE todo_queue_state SET generation=generation+1 WHERE todo_id=NEW.id; END`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_source_update AFTER UPDATE ON todos
  WHEN OLD.title IS NOT NEW.title OR OLD.notes IS NOT NEW.notes OR OLD.updated_at IS NOT NEW.updated_at OR OLD.status IS NOT NEW.status
   OR OLD.priority IS NOT NEW.priority OR OLD.due_date IS NOT NEW.due_date OR OLD.project IS NOT NEW.project OR OLD.context IS NOT NEW.context
   OR OLD.source_kind IS NOT NEW.source_kind OR OLD.source_id IS NOT NEW.source_id OR OLD.client_id IS NOT NEW.client_id
   OR OLD.completed_at IS NOT NEW.completed_at OR OLD.snoozed_until IS NOT NEW.snoozed_until OR OLD.recurrence_cron IS NOT NEW.recurrence_cron
   OR OLD.recurrence_last_fired_at IS NOT NEW.recurrence_last_fired_at OR OLD.pinned IS NOT NEW.pinned OR OLD.sort_order IS NOT NEW.sort_order OR OLD.created_at IS NOT NEW.created_at
  BEGIN INSERT INTO todo_queue_state(todo_id,generation) VALUES(NEW.id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_file_insert AFTER INSERT ON todo_attachments WHEN NEW.todo_id IS NOT NULL BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) VALUES(NEW.todo_id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_file_update AFTER UPDATE ON todo_attachments BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) SELECT OLD.todo_id,1 WHERE OLD.todo_id IS NOT NULL ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1;
  INSERT INTO todo_queue_state(todo_id,generation) SELECT NEW.todo_id,1 WHERE NEW.todo_id IS NOT NULL ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_file_delete AFTER DELETE ON todo_attachments WHEN OLD.todo_id IS NOT NULL BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) VALUES(OLD.todo_id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_sync_insert AFTER INSERT ON todo_queue_state BEGIN
  INSERT INTO todo_sync_changes(entity_type,entity_key,operation) VALUES('todo',CAST(NEW.todo_id AS TEXT),'upsert'); END`,
    `CREATE TRIGGER IF NOT EXISTS todo_queue_sync_update AFTER UPDATE ON todo_queue_state BEGIN
  INSERT INTO todo_sync_changes(entity_type,entity_key,operation) VALUES('todo',CAST(NEW.todo_id AS TEXT),'upsert'); END`,
];
const initialized = new WeakMap<D1Database, Promise<unknown>>();
export function ensureTaskDelegationSchema(db: D1Database) {
    let ready = initialized.get(db);
    if (!ready) {
        ready = db.batch(TASK_DELEGATION_SCHEMA.map(sql => db.prepare(sql))).catch(error => { initialized.delete(db); throw error; });
        initialized.set(db, ready);
    }
    return ready;
}
export type DelegationInput = {
    operationId: string;
    queueOperationId: string;
    botId: string;
    taskExportId: string;
    todoId: number;
    sourceRevision: string;
    listId: string | null;
};
export async function confirmTaskDelegation(environment: BotStorageEnv & {
    BOTS_OWNER_EMAIL?: string;
}, owner: string, input: DelegationInput) {
    if (owner !== environment.BOTS_OWNER_EMAIL?.trim().toLowerCase())
        throw new StorageError('Configured owner required.', 403, 'forbidden');
    if (!Number.isSafeInteger(input.todoId) || input.todoId < 1 || !/^[a-f0-9]{64}$/.test(input.sourceRevision ?? '')
        || !/^task-export:[a-f0-9]{64}$/.test(input.taskExportId ?? '') || [input.operationId, input.queueOperationId, input.botId].some(id => typeof id !== 'string' || !/^[\w:.-]{1,200}$/.test(id))
        || input.listId !== null && (typeof input.listId !== 'string' || !/^[\w:.-]{1,200}$/.test(input.listId)))
        throw new StorageError('Invalid original delegation receipt.');
    const db = environment.DB;
    await ensureTaskDelegationSchema(db);
    const fingerprint = createHash('sha256').update(JSON.stringify([input.queueOperationId, input.botId, input.taskExportId, input.todoId, input.sourceRevision, input.listId])).digest('hex');
    const read = () => db.prepare('SELECT fingerprint,receipt,generation FROM todo_queue_receipts WHERE owner_key=? AND operation_id=?').bind(owner, input.operationId).first<{
        fingerprint: string;
        receipt: string;
        generation: number;
    }>();
    const active = async () => {
        const delegated = await db.prepare('SELECT todos.id FROM todos JOIN todo_queue_state ON todo_id=todos.id WHERE todos.id=? AND generation=delegation_generation AND delegation IS NOT NULL').bind(input.todoId).first();
        return !delegated;
    };
    const prior = await read();
    if (prior) {
        if (prior.fingerprint !== fingerprint)
            throw new StorageError('Original disposition operation conflicts.', 409, 'conflict');
        return { delegation: JSON.parse(prior.receipt) as TaskDelegation, active: await active() };
    }
    await db.prepare('INSERT OR IGNORE INTO todo_queue_state(todo_id,generation) SELECT id,0 FROM todos WHERE id=?').bind(input.todoId).run();
    const before = await db.prepare('SELECT generation FROM todo_queue_state WHERE todo_id=?').bind(input.todoId).first<{
        generation: number;
    }>();
    if (!before)
        throw new StorageError('Source task unavailable. Original queue receipt is retained.', 404, 'not_found');
    const { receipt, sourceCurrent } = await new TaskQueueExports(environment, owner).resolve(input.taskExportId, input.botId);
    if (!sourceCurrent || receipt.source.todoId !== input.todoId || receipt.source.revision !== input.sourceRevision)
        throw new StorageError('Source task changed. Accepted queue work is retained and the newer task stays active.', 409, 'source_changed');
    const delegation: TaskDelegation = { version: 1, operationId: input.operationId, queueOperationId: input.queueOperationId, taskExportId: input.taskExportId, todoId: input.todoId,
        sourceRevision: input.sourceRevision, botId: input.botId, listId: input.listId, confirmedAt: new Date().toISOString() };
    // Receipt and marker commit atomically. Source/file triggers increment the
    // generation even for a same-timestamp edit between resolve and this CAS.
    await db.batch([
        db.prepare(`INSERT OR IGNORE INTO todo_queue_receipts(owner_key,operation_id,fingerprint,todo_id,generation,receipt)
   SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM todos JOIN todo_queue_state ON todo_id=todos.id WHERE todos.id=? AND generation=?)`)
            .bind(owner, input.operationId, fingerprint, input.todoId, before.generation, JSON.stringify(delegation), input.todoId, before.generation),
        db.prepare(`UPDATE todo_queue_state SET delegation=(SELECT receipt FROM todo_queue_receipts WHERE owner_key=? AND operation_id=? AND fingerprint=?),delegation_generation=generation
   WHERE todo_id=? AND EXISTS(SELECT 1 FROM todo_queue_receipts WHERE owner_key=? AND operation_id=? AND fingerprint=? AND todo_id=todo_queue_state.todo_id AND generation=todo_queue_state.generation)`)
            .bind(owner, input.operationId, fingerprint, input.todoId, owner, input.operationId, fingerprint),
    ]);
    const saved = await read();
    if (!saved)
        throw new StorageError('Source changed before task disposition. Original accepted work is retained.', 409, 'source_changed');
    if (saved.fingerprint !== fingerprint)
        throw new StorageError('Original disposition operation conflicts.', 409, 'conflict');
    return { delegation: JSON.parse(saved.receipt) as TaskDelegation, active: await active() };
}
