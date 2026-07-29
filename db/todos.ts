import { env } from "cloudflare:workers";
import { importedTodos } from "./imported-todos";
import {
  type AttachmentRow,
  attachmentSnapshotsForTodos,
  claimDraftAttachments,
  restoreAttachmentStatements,
} from "./attachments";
import { normalizeCronExpression } from "../lib/cron";
import { queueTodoPushEvent } from "./push-notifications";
import {
  DEFAULT_QUICK_SNOOZE_PRESETS,
  isQuickSnoozePreset,
  parseQuickSnoozePresets,
  quickSnoozeDurationMs,
  type QuickSnoozePreset,
} from "../lib/snooze-presets";
import {
  DEFAULT_REALTIME_VOICE,
  normalizeRealtimeVoice,
  type RealtimeVoice,
} from "../lib/ai-preferences";
import { zonedLocalDateTimeToUtc } from "../lib/zoned-date-time";
import { validateTaskDescription } from "../lib/task-description";

type StoredTodoStatus = "open" | "completed" | "archived";
export type TodoStatus = "open" | "completed";
export type BulkTodoAction = "complete" | "reopen" | "snooze" | "unsnooze" | "reproject" | "delete";
export type SnoozePreset = QuickSnoozePreset | "8pm";
export type ProjectDeleteMode = "reassign" | "delete";

type TodoRow = {
  id: number;
  title: string;
  notes: string;
  status: StoredTodoStatus;
  priority: number;
  due_date: string | null;
  project: string | null;
  context: string | null;
  source_kind: string | null;
  source_id: number | null;
  client_id: string | null;
  completed_at: string | null;
  snoozed_until: string | null;
  recurrence_cron: string | null;
  recurrence_last_fired_at: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
  attachment_count?: number;
};

type UndoSnapshot = {
  todos: TodoRow[];
  attachments?: AttachmentRow[];
  createdSourceKind?: string;
};

export type Todo = {
  id: number;
  title: string;
  notes: string;
  status: TodoStatus;
  priority: number;
  dueDate: string | null;
  project: string | null;
  context: string | null;
  sourceKind: string | null;
  sourceId: number | null;
  clientId: string | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  recurrenceCron: string | null;
  recurrenceLastFiredAt: string | null;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  attachmentCount: number;
};

export type TodoUpdate = Partial<
  Pick<Todo, "title" | "notes" | "priority" | "dueDate" | "project" | "context" | "snoozedUntil" | "recurrenceCron" | "pinned">
> & { status?: TodoStatus };

export type TodoMutationMetadata = {
  mutationId?: string;
  fieldTimestamps?: Partial<Record<keyof TodoUpdate, string>>;
  recordUndo?: boolean;
};

export type TodoSettings = {
  snoozeTimeZone: string;
  snoozeWakeHour: number;
  snoozeQuickPresets: QuickSnoozePreset[];
  realtimeVoice: RealtimeVoice;
};

export type TodoCaptureDraft = {
  text: string;
  updatedAt: string;
  clientId: string;
  version: string;
};

export type TodoBootstrapSnapshot = {
  todos: Todo[];
  projects: string[];
  settings: TodoSettings;
  captureDraft: TodoCaptureDraft | null;
  revision: number;
};

export type TodoSyncDelta = {
  reset: false;
  revision: number;
  todos: Todo[];
  deletedIds: number[];
  projects?: string[];
  settings?: TodoSettings;
  captureDraft?: TodoCaptureDraft | null;
} | ({ reset: true; reason: string } & TodoBootstrapSnapshot);

type TodoSyncChangeRow = {
  revision: number;
  entity_type: "todo" | "project" | "settings" | "capture_draft";
  entity_key: string;
  operation: string;
};

let initialization: Promise<void> | null = null;
const CURRENT_SCHEMA_VERSION = "26";

function database() {
  if (!env.DB) throw new Error("The todo database is unavailable.");
  return env.DB;
}

function mapTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status === "archived" ? "open" : row.status,
    priority: row.priority,
    dueDate: row.due_date,
    project: row.project,
    context: row.context,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    clientId: row.client_id,
    completedAt: row.completed_at,
    snoozedUntil: row.snoozed_until,
    recurrenceCron: row.recurrence_cron,
    recurrenceLastFiredAt: row.recurrence_last_fired_at,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    attachmentCount: Number(row.attachment_count ?? 0),
  };
}

function mapTodoCaptureDraft(value: string | null | undefined): TodoCaptureDraft | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<TodoCaptureDraft>;
    if (
      typeof parsed.text !== "string"
      || typeof parsed.updatedAt !== "string"
      || typeof parsed.clientId !== "string"
      || typeof parsed.version !== "string"
    ) return null;
    return {
      text: parsed.text,
      updatedAt: parsed.updatedAt,
      clientId: parsed.clientId,
      version: parsed.version,
    };
  } catch {
    return null;
  }
}

function mapTodoSettings(rows: Array<{ key: string; value: string }>): TodoSettings {
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  let snoozeQuickPresets = DEFAULT_QUICK_SNOOZE_PRESETS;
  try {
    snoozeQuickPresets = parseQuickSnoozePresets(JSON.parse(values.snooze_quick_presets ?? "null"))
      ?? DEFAULT_QUICK_SNOOZE_PRESETS;
  } catch {
    snoozeQuickPresets = DEFAULT_QUICK_SNOOZE_PRESETS;
  }
  return {
    snoozeTimeZone: values.snooze_timezone || "America/Toronto",
    snoozeWakeHour: Number(values.snooze_wake_hour ?? 8),
    snoozeQuickPresets: [...snoozeQuickPresets],
    realtimeVoice: normalizeRealtimeVoice(values.ai_realtime_voice) ?? DEFAULT_REALTIME_VOICE,
  };
}

const todoListSql = `
  SELECT todos.*,
    (SELECT COUNT(*) FROM todo_attachments
     WHERE todo_attachments.todo_id = todos.id
       AND todo_attachments.upload_state = 'ready'
       AND todo_attachments.deleted_at IS NULL) AS attachment_count
  FROM todos
`;

async function ensureTodoSyncSchema(db: D1Database) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS todo_sync_changes (
        revision INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        operation TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `),
    db.prepare("CREATE INDEX IF NOT EXISTS todo_sync_changes_created_at_idx ON todo_sync_changes(created_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS todo_sync_changes_entity_idx ON todo_sync_changes(entity_type, entity_key, revision)"),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS todo_mutation_receipts (
        operation_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `),
    db.prepare("CREATE INDEX IF NOT EXISTS todo_mutation_receipts_created_at_idx ON todo_mutation_receipts(created_at)"),
    db.prepare("DELETE FROM todo_mutation_receipts WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_todos_insert AFTER INSERT ON todos BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('todo', CAST(NEW.id AS TEXT), 'upsert');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_todos_update AFTER UPDATE ON todos BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('todo', CAST(NEW.id AS TEXT), 'upsert');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_todos_delete AFTER DELETE ON todos BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('todo', CAST(OLD.id AS TEXT), 'delete');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_projects_insert AFTER INSERT ON todo_projects BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('project', NEW.name, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_projects_update AFTER UPDATE ON todo_projects BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('project', NEW.name, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_projects_delete AFTER DELETE ON todo_projects BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('project', OLD.name, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_settings_insert AFTER INSERT ON app_settings
      WHEN NEW.key IN ('snooze_timezone', 'snooze_wake_hour') BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('settings', NEW.key, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_settings_update AFTER UPDATE ON app_settings
      WHEN NEW.key IN ('snooze_timezone', 'snooze_wake_hour') BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('settings', NEW.key, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_quick_snooze_insert AFTER INSERT ON app_settings
      WHEN NEW.key = 'snooze_quick_presets' BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('settings', NEW.key, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_quick_snooze_update AFTER UPDATE ON app_settings
      WHEN NEW.key = 'snooze_quick_presets' BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('settings', NEW.key, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_capture_draft_insert AFTER INSERT ON app_settings
      WHEN NEW.key = 'capture_draft' BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('capture_draft', NEW.key, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_capture_draft_update AFTER UPDATE ON app_settings
      WHEN NEW.key = 'capture_draft' BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('capture_draft', NEW.key, 'changed');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_attachments_insert AFTER INSERT ON todo_attachments
      WHEN NEW.todo_id IS NOT NULL BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('todo', CAST(NEW.todo_id AS TEXT), 'upsert');
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_attachments_update AFTER UPDATE ON todo_attachments
      WHEN OLD.todo_id IS NOT NEW.todo_id OR OLD.upload_state IS NOT NEW.upload_state OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation)
        SELECT 'todo', CAST(OLD.todo_id AS TEXT), 'upsert' WHERE OLD.todo_id IS NOT NULL;
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation)
        SELECT 'todo', CAST(NEW.todo_id AS TEXT), 'upsert' WHERE NEW.todo_id IS NOT NULL;
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS todo_sync_attachments_delete AFTER DELETE ON todo_attachments
      WHEN OLD.todo_id IS NOT NULL BEGIN
      INSERT INTO todo_sync_changes (entity_type, entity_key, operation) VALUES ('todo', CAST(OLD.todo_id AS TEXT), 'upsert');
    END`),
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('schema_version', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(CURRENT_SCHEMA_VERSION),
  ]);
}

export async function ensureTodoDatabase() {
  if (initialization) return initialization;

  initialization = (async () => {
    const db = database();
    const fastPathStartedAt = Date.now();
    try {
      const schemaVersion = await db
        .prepare("SELECT value FROM app_settings WHERE key = 'schema_version'")
        .first<{ value: string }>();
      if (schemaVersion?.value === CURRENT_SCHEMA_VERSION) {
        console.info("[todo-db] production schema fast path", {
          schemaVersion: schemaVersion.value,
          durationMs: Date.now() - fastPathStartedAt,
        });
        return;
      }
      console.warn("[todo-db] compatibility initialization required", {
        schemaVersion: schemaVersion?.value ?? null,
      });
    } catch (error) {
      console.warn("[todo-db] schema marker unavailable; running compatibility initialization", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await db.batch([
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          notes TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','archived')),
          priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
          due_date TEXT,
          project TEXT,
          context TEXT,
          source_kind TEXT,
          source_id INTEGER,
          client_id TEXT,
          completed_at TEXT,
          snoozed_until TEXT,
          recurrence_cron TEXT,
          recurrence_last_fired_at TEXT,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_status_idx ON todos(status)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_project_idx ON todos(project)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todos_due_date_idx ON todos(due_date)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todos_source_idx ON todos(source_kind, source_id)"),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_action_history (
          id TEXT PRIMARY KEY NOT NULL,
          snapshot TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_field_versions (
          todo_id INTEGER NOT NULL,
          field TEXT NOT NULL,
          version TEXT NOT NULL,
          mutation_id TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (todo_id, field)
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_calendar_feeds (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          token TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          revoked_at TEXT
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_api_tokens (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          token_prefix TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          encrypted_token TEXT,
          created_by_email TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_used_at TEXT,
          expires_at TEXT,
          revoked_at TEXT
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_attachments (
          id TEXT PRIMARY KEY NOT NULL,
          todo_id INTEGER,
          draft_token TEXT,
          original_key TEXT NOT NULL UNIQUE,
          display_key TEXT NOT NULL UNIQUE,
          thumbnail_key TEXT NOT NULL UNIQUE,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          kind TEXT NOT NULL DEFAULT 'image',
          duration_ms INTEGER NOT NULL DEFAULT 0,
          upload_state TEXT NOT NULL DEFAULT 'ready',
          sort_order INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT,
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_push_subscriptions (
          id TEXT PRIMARY KEY NOT NULL,
          endpoint TEXT NOT NULL,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          device_id TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_success_at TEXT,
          disabled_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_push_events (
          id TEXT PRIMARY KEY NOT NULL,
          event_type TEXT NOT NULL,
          todo_id INTEGER NOT NULL,
          todo_title TEXT NOT NULL,
          origin_device_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          deliver_after TEXT NOT NULL,
          delivered_at TEXT
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_push_deliveries (
          event_id TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (event_id, subscription_id)
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_assistant_workspaces (
          user_key TEXT PRIMARY KEY NOT NULL,
          selected_todo_id INTEGER,
          navigator_view TEXT NOT NULL DEFAULT 'open',
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_assistant_threads (
          user_key TEXT NOT NULL,
          todo_id INTEGER NOT NULL,
          paused INTEGER NOT NULL DEFAULT 0,
          draft_text TEXT NOT NULL DEFAULT '',
          draft_attachment_ids_json TEXT NOT NULL DEFAULT '[]',
          current_question_json TEXT,
          skipped_question_keys_json TEXT NOT NULL DEFAULT '[]',
          understanding_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          PRIMARY KEY (user_key, todo_id)
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_assistant_messages (
          id TEXT PRIMARY KEY NOT NULL,
          user_key TEXT NOT NULL,
          todo_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'message',
          content TEXT NOT NULL,
          question_json TEXT,
          proposal_json TEXT,
          sources_json TEXT,
          attachment_ids_json TEXT NOT NULL DEFAULT '[]',
          client_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_workspaces (
          user_key TEXT PRIMARY KEY NOT NULL,
          active_session_id TEXT,
          last_focused_todo_id INTEGER,
          summary TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_threads (
          id TEXT PRIMARY KEY NOT NULL,
          user_key TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'custom',
          system_key TEXT,
          title TEXT NOT NULL,
          focused_todo_id INTEGER,
          summary TEXT NOT NULL DEFAULT '',
          draft_text TEXT NOT NULL DEFAULT '',
          delete_token TEXT,
          deleted_at TEXT,
          purge_after TEXT,
          last_message_at TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_sessions (
          id TEXT PRIMARY KEY NOT NULL,
          user_key TEXT NOT NULL,
          thread_id TEXT,
          transport TEXT NOT NULL DEFAULT 'browser',
          model TEXT NOT NULL,
          voice TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          last_activity_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          ended_at TEXT,
          end_reason TEXT
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_messages (
          id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          user_key TEXT NOT NULL,
          thread_id TEXT,
          realtime_item_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          focused_todo_id INTEGER,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_tool_calls (
          call_id TEXT PRIMARY KEY NOT NULL,
          session_id TEXT NOT NULL,
          user_key TEXT NOT NULL,
          thread_id TEXT,
          name TEXT NOT NULL,
          arguments_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'running',
          result_json TEXT,
          undo_token TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          completed_at TEXT
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_phone_profiles (
          user_key TEXT PRIMARY KEY NOT NULL,
          pin_hash TEXT NOT NULL,
          pin_salt TEXT NOT NULL,
          pin_iterations INTEGER NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          webhook_url TEXT,
          provider_configured_at TEXT,
          pin_updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          last_authenticated_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_phone_calls (
          call_sid TEXT PRIMARY KEY NOT NULL,
          user_key TEXT,
          from_number_hash TEXT NOT NULL,
          to_number TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pin_pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          mode TEXT,
          mode_attempt_count INTEGER NOT NULL DEFAULT 0,
          stream_token_hash TEXT,
          stream_token_expires_at TEXT,
          stream_token_consumed_at TEXT,
          transport TEXT NOT NULL DEFAULT 'media',
          provider_call_id TEXT,
          talk_session_id TEXT,
          started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          authenticated_at TEXT,
          connected_at TEXT,
          ended_at TEXT,
          failure_reason TEXT
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_phone_recordings (
          call_sid TEXT PRIMARY KEY NOT NULL,
          user_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'recording',
          expected_segments INTEGER,
          task_id INTEGER,
          task_client_id TEXT NOT NULL UNIQUE,
          total_duration_ms INTEGER NOT NULL DEFAULT 0,
          processing_attempts INTEGER NOT NULL DEFAULT 0,
          processing_started_at TEXT,
          next_retry_at TEXT,
          completed_at TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_talk_phone_recording_segments (
          recording_sid TEXT PRIMARY KEY NOT NULL,
          call_sid TEXT NOT NULL,
          segment_index INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          duration_ms INTEGER NOT NULL DEFAULT 0,
          byte_size INTEGER NOT NULL DEFAULT 0,
          attachment_id TEXT,
          transcript_text TEXT,
          twilio_deleted_at TEXT,
          error_code TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `),
      db.prepare(`
        CREATE TABLE IF NOT EXISTS todo_assistant_memories (
          id TEXT PRIMARY KEY NOT NULL,
          user_key TEXT NOT NULL,
          scope TEXT NOT NULL,
          todo_id INTEGER,
          kind TEXT NOT NULL DEFAULT 'fact',
          content TEXT NOT NULL,
          provenance_json TEXT NOT NULL DEFAULT '{}',
          dedupe_key TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          forgotten_at TEXT
        )
      `),
    ]);

    const columns = await db.prepare("PRAGMA table_info(todos)").all<{ name: string }>();
    if (!columns.results.some((column) => column.name === "snoozed_until")) {
      await db.prepare("ALTER TABLE todos ADD COLUMN snoozed_until TEXT").run();
      console.info("[todo-db] added snoozed_until compatibility column");
    }
    if (!columns.results.some((column) => column.name === "pinned")) {
      await db.prepare("ALTER TABLE todos ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0").run();
      console.info("[todo-db] added pinned compatibility column");
    }
    if (!columns.results.some((column) => column.name === "recurrence_cron")) {
      await db.prepare("ALTER TABLE todos ADD COLUMN recurrence_cron TEXT").run();
      console.info("[todo-db] added recurrence cron compatibility column");
    }
    if (!columns.results.some((column) => column.name === "recurrence_last_fired_at")) {
      await db.prepare("ALTER TABLE todos ADD COLUMN recurrence_last_fired_at TEXT").run();
      console.info("[todo-db] added recurrence last-fired compatibility column");
    }
    await db.prepare("CREATE INDEX IF NOT EXISTS todos_snoozed_until_idx ON todos(snoozed_until)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS todos_recurrence_cron_idx ON todos(recurrence_cron)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS todos_pinned_idx ON todos(pinned)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS todo_action_history_created_at_idx ON todo_action_history(created_at)").run();
    await db.prepare("CREATE INDEX IF NOT EXISTS todo_field_versions_mutation_idx ON todo_field_versions(mutation_id)").run();
    await db.batch([
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_calendar_feeds_token_idx ON todo_calendar_feeds(token)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_calendar_feeds_revoked_at_idx ON todo_calendar_feeds(revoked_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_api_tokens_hash_idx ON todo_api_tokens(token_hash)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_api_tokens_revoked_at_idx ON todo_api_tokens(revoked_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_api_tokens_expires_at_idx ON todo_api_tokens(expires_at)"),
    ]);
    const apiTokenColumns = await db.prepare("PRAGMA table_info(todo_api_tokens)").all<{ name: string }>();
    if (!apiTokenColumns.results.some((column) => column.name === "encrypted_token")) {
      await db.prepare("ALTER TABLE todo_api_tokens ADD COLUMN encrypted_token TEXT").run();
      console.info("[todo-db] added encrypted API token compatibility column");
    }
    const attachmentColumns = await db.prepare("PRAGMA table_info(todo_attachments)").all<{ name: string }>();
    if (!attachmentColumns.results.some((column) => column.name === "upload_state")) {
      await db.prepare("ALTER TABLE todo_attachments ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'ready'").run();
      console.info("[todo-db] added attachment upload state compatibility column");
    }
    if (!attachmentColumns.results.some((column) => column.name === "kind")) {
      await db.prepare("ALTER TABLE todo_attachments ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'").run();
      console.info("[todo-db] added attachment kind compatibility column");
    }
    if (!attachmentColumns.results.some((column) => column.name === "duration_ms")) {
      await db.prepare("ALTER TABLE todo_attachments ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0").run();
      console.info("[todo-db] added attachment duration compatibility column");
    }
    const phoneCallColumns = await db.prepare("PRAGMA table_info(todo_talk_phone_calls)").all<{ name: string }>();
    if (!phoneCallColumns.results.some((column) => column.name === "transport")) {
      await db.prepare("ALTER TABLE todo_talk_phone_calls ADD COLUMN transport TEXT NOT NULL DEFAULT 'media'").run();
      console.info("[todo-db] added Talk phone transport compatibility column");
    }
    if (!phoneCallColumns.results.some((column) => column.name === "provider_call_id")) {
      await db.prepare("ALTER TABLE todo_talk_phone_calls ADD COLUMN provider_call_id TEXT").run();
      console.info("[todo-db] added Talk phone provider call compatibility column");
    }
    if (!phoneCallColumns.results.some((column) => column.name === "mode")) {
      await db.prepare("ALTER TABLE todo_talk_phone_calls ADD COLUMN mode TEXT").run();
      console.info("[todo-db] added Talk phone mode compatibility column");
    }
    if (!phoneCallColumns.results.some((column) => column.name === "mode_attempt_count")) {
      await db.prepare("ALTER TABLE todo_talk_phone_calls ADD COLUMN mode_attempt_count INTEGER NOT NULL DEFAULT 0").run();
      console.info("[todo-db] added Talk phone mode attempt compatibility column");
    }
    const talkSessionColumns = await db.prepare("PRAGMA table_info(todo_talk_sessions)").all<{ name: string }>();
    if (!talkSessionColumns.results.some((column) => column.name === "thread_id")) {
      await db.prepare("ALTER TABLE todo_talk_sessions ADD COLUMN thread_id TEXT").run();
      console.info("[todo-db] added Talk session thread compatibility column");
    }
    if (!talkSessionColumns.results.some((column) => column.name === "transport")) {
      await db.prepare("ALTER TABLE todo_talk_sessions ADD COLUMN transport TEXT NOT NULL DEFAULT 'browser'").run();
      console.info("[todo-db] added Talk session transport compatibility column");
    }
    const talkMessageColumns = await db.prepare("PRAGMA table_info(todo_talk_messages)").all<{ name: string }>();
    if (!talkMessageColumns.results.some((column) => column.name === "thread_id")) {
      await db.prepare("ALTER TABLE todo_talk_messages ADD COLUMN thread_id TEXT").run();
      console.info("[todo-db] added Talk message thread compatibility column");
    }
    const talkToolColumns = await db.prepare("PRAGMA table_info(todo_talk_tool_calls)").all<{ name: string }>();
    if (!talkToolColumns.results.some((column) => column.name === "thread_id")) {
      await db.prepare("ALTER TABLE todo_talk_tool_calls ADD COLUMN thread_id TEXT").run();
      console.info("[todo-db] added Talk tool thread compatibility column");
    }
    const todoColumns = await db.prepare("PRAGMA table_info(todos)").all<{ name: string }>();
    if (!todoColumns.results.some((column) => column.name === "client_id")) {
      await db.prepare("ALTER TABLE todos ADD COLUMN client_id TEXT").run();
      console.info("[todo-db] added offline sync client id compatibility column");
    }
    await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todos_client_id_idx ON todos(client_id)").run();
    await db.batch([
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_todo_id_idx ON todo_attachments(todo_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_draft_token_idx ON todo_attachments(draft_token)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_expires_at_idx ON todo_attachments(expires_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_attachments_deleted_at_idx ON todo_attachments(deleted_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_push_subscriptions_endpoint_idx ON todo_push_subscriptions(endpoint)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_push_subscriptions_device_idx ON todo_push_subscriptions(device_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_push_subscriptions_disabled_idx ON todo_push_subscriptions(disabled_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_push_events_delivery_idx ON todo_push_events(delivered_at, deliver_after)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_push_events_todo_idx ON todo_push_events(todo_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_push_deliveries_subscription_idx ON todo_push_deliveries(subscription_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_assistant_threads_todo_idx ON todo_assistant_threads(todo_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_assistant_threads_updated_idx ON todo_assistant_threads(updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_assistant_messages_thread_idx ON todo_assistant_messages(user_key, todo_id, created_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_assistant_messages_client_idx ON todo_assistant_messages(user_key, client_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_sessions_user_idx ON todo_talk_sessions(user_key, started_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_sessions_status_idx ON todo_talk_sessions(status, last_activity_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_talk_threads_system_idx ON todo_talk_threads(user_key, system_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_threads_user_idx ON todo_talk_threads(user_key, deleted_at, last_message_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_threads_delete_idx ON todo_talk_threads(delete_token)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_threads_purge_idx ON todo_talk_threads(purge_after)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_talk_messages_realtime_idx ON todo_talk_messages(user_key, realtime_item_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_messages_session_idx ON todo_talk_messages(session_id, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_messages_user_idx ON todo_talk_messages(user_key, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_messages_thread_idx ON todo_talk_messages(thread_id, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_messages_task_idx ON todo_talk_messages(focused_todo_id, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_tool_calls_session_idx ON todo_talk_tool_calls(session_id, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_tool_calls_user_idx ON todo_talk_tool_calls(user_key, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_tool_calls_thread_idx ON todo_talk_tool_calls(thread_id, created_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_calls_user_idx ON todo_talk_phone_calls(user_key, started_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_calls_source_idx ON todo_talk_phone_calls(from_number_hash, started_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_calls_status_idx ON todo_talk_phone_calls(status, started_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_calls_stream_idx ON todo_talk_phone_calls(stream_token_hash)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_calls_provider_idx ON todo_talk_phone_calls(provider_call_id)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_recordings_status_idx ON todo_talk_phone_recordings(status, next_retry_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_recordings_user_idx ON todo_talk_phone_recordings(user_key, created_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_talk_phone_recordings_client_idx ON todo_talk_phone_recordings(task_client_id)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_talk_phone_recording_segments_order_idx ON todo_talk_phone_recording_segments(call_sid, segment_index)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_recording_segments_status_idx ON todo_talk_phone_recording_segments(call_sid, status)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_talk_phone_recording_segments_cleanup_idx ON todo_talk_phone_recording_segments(twilio_deleted_at, updated_at)"),
      db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS todo_assistant_memories_dedupe_idx ON todo_assistant_memories(user_key, dedupe_key)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_assistant_memories_user_idx ON todo_assistant_memories(user_key, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_assistant_memories_task_idx ON todo_assistant_memories(user_key, todo_id, updated_at)"),
      db.prepare("CREATE INDEX IF NOT EXISTS todo_assistant_memories_forgotten_idx ON todo_assistant_memories(forgotten_at)"),
    ]);

    await db.batch([
      db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('snooze_timezone', 'America/Toronto')"),
      db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('snooze_wake_hour', '8')"),
      db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('snooze_quick_presets', '[\"15m\",\"30m\",\"1h\",\"2h\"]')"),
    ]);

    const total = await db.prepare("SELECT COUNT(*) AS count FROM todos").first<{ count: number }>();
    const existingTotal = Number(total?.count ?? 0);
    const seedVersion = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'seed_version'")
      .first<{ value: string }>();
    let inserted = 0;
    if (!seedVersion && existingTotal === 0) {
      const seed = db.prepare(`
        INSERT OR IGNORE INTO todos (
          title, notes, status, priority, due_date, project, context,
          source_kind, source_id, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const results = await db.batch(
        importedTodos.map((todo) =>
          seed.bind(
            todo.title,
            todo.notes,
            todo.status,
            todo.priority,
            todo.dueDate,
            todo.project || null,
            todo.context || null,
            todo.sourceKind,
            todo.sourceId,
            todo.completedAt,
            todo.createdAt,
            todo.updatedAt,
          ),
        ),
      );
      inserted = results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
    }
    if (!seedVersion) {
      await db.prepare("INSERT INTO app_settings (key, value) VALUES ('seed_version', '1')").run();
    }

    const archiveStatusVersion = await db
      .prepare("SELECT value FROM app_settings WHERE key = 'archive_status_to_open_v1'")
      .first<{ value: string }>();
    let archivedConverted = 0;
    if (!archiveStatusVersion) {
      const results = await db.batch([
        db.prepare(`
          UPDATE todos
          SET status = 'open',
              completed_at = NULL,
              snoozed_until = NULL,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE status = 'archived'
        `),
        db.prepare("INSERT INTO app_settings (key, value) VALUES ('archive_status_to_open_v1', '1')"),
      ]);
      archivedConverted = Number(results[0].meta.changes ?? 0);
      console.info("[todo-db] legacy archives converted to open tasks", {
        changed: archivedConverted,
        retainedProjectAssignments: true,
      });
    }

    const projectBackfill = await db.prepare(`
      INSERT OR IGNORE INTO todo_projects (name)
      SELECT DISTINCT trim(project)
      FROM todos
      WHERE project IS NOT NULL AND trim(project) <> ''
    `).run();
    const registeredProjects = await db.prepare("SELECT COUNT(*) AS count FROM todo_projects").first<{ count: number }>();
    console.info("[todo-db] project registry ready", {
      imported: Number(projectBackfill.meta.changes ?? 0),
      total: Number(registeredProjects?.count ?? 0),
    });

    await ensureTodoSyncSchema(db);

    console.info("[todo-db] ready", {
      inserted,
      total: existingTotal + inserted,
      imported: importedTodos.length,
      seedSkipped: Boolean(seedVersion) || existingTotal > 0,
      archivedConverted,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    });
  })().catch((error) => {
    initialization = null;
    throw error;
  });

  return initialization;
}

export async function listTodos(): Promise<Todo[]> {
  await ensureTodoDatabase();
  const result = await database()
    .prepare(`${todoListSql} ORDER BY updated_at DESC, id DESC`)
    .all<TodoRow>();
  return result.results.map(mapTodo);
}

export async function wakeExpiredSnoozedTodosInDatabase(db: D1Database, now = new Date()) {
  const deliverAfter = new Date(Math.ceil(now.valueOf() / 60_000) * 60_000).toISOString();
  const [queued, result] = await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO todo_push_events (
        id, event_type, todo_id, todo_title, created_at, deliver_after
      )
      SELECT
        'snooze:' || id || ':' || snoozed_until,
        'snooze_expired',
        id,
        title,
        ?,
        ?
      FROM todos
      WHERE status = 'open'
        AND snoozed_until IS NOT NULL
        AND snoozed_until <= ?
    `).bind(now.toISOString(), deliverAfter, now.toISOString()),
    db.prepare(`
    UPDATE todos
    SET snoozed_until = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE status = 'open'
      AND snoozed_until IS NOT NULL
      AND snoozed_until <= ?
    RETURNING id
    `).bind(now.toISOString()),
  ]) as [D1Result, D1Result<{ id: number }>];
  const ids = result.results.map((row) => Number(row.id)).filter(Number.isInteger);
  if (ids.length) {
    console.info("[todo-snooze] expired tasks returned to Open", {
      checkedAt: now.toISOString(),
      count: ids.length,
      ids,
      pushEventsQueued: Number(queued.meta.changes ?? 0),
      pushDeliverAfter: deliverAfter,
    });
  }
  return ids;
}

export async function wakeExpiredSnoozedTodos(now = new Date()) {
  await ensureTodoDatabase();
  return wakeExpiredSnoozedTodosInDatabase(database(), now);
}

export async function readTodoBootstrap(): Promise<TodoBootstrapSnapshot> {
  await ensureTodoDatabase();
  const db = database();
  const [todoResult, projectResult, settingResult, captureDraftResult, revisionResult] = await db.batch([
    db.prepare(`${todoListSql} ORDER BY updated_at DESC, id DESC`),
    db.prepare("SELECT name FROM todo_projects ORDER BY name COLLATE NOCASE ASC"),
    db.prepare("SELECT key, value FROM app_settings WHERE key IN ('snooze_timezone', 'snooze_wake_hour', 'snooze_quick_presets', 'ai_realtime_voice')"),
    db.prepare("SELECT value FROM app_settings WHERE key = 'capture_draft'"),
    db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM todo_sync_changes"),
  ]) as [
    D1Result<TodoRow>,
    D1Result<{ name: string }>,
    D1Result<{ key: string; value: string }>,
    D1Result<{ value: string }>,
    D1Result<{ revision: number }>,
  ];
  return {
    todos: todoResult.results.map(mapTodo),
    projects: projectResult.results.map((row) => row.name),
    settings: mapTodoSettings(settingResult.results),
    captureDraft: mapTodoCaptureDraft(captureDraftResult.results[0]?.value),
    revision: Number(revisionResult.results[0]?.revision ?? 0),
  };
}

async function listTodosByIds(db: D1Database, ids: number[]) {
  if (!ids.length) return [];
  const chunks: number[][] = [];
  for (let index = 0; index < ids.length; index += 90) chunks.push(ids.slice(index, index + 90));
  const results = await db.batch(chunks.map((chunk) => db
    .prepare(`${todoListSql} WHERE todos.id IN (${placeholders(chunk.length)})`)
    .bind(...chunk))) as D1Result<TodoRow>[];
  return results.flatMap((result) => result.results.map(mapTodo));
}

export async function readTodoSyncDelta(afterRevision: number): Promise<TodoSyncDelta> {
  await ensureTodoDatabase();
  const db = database();
  const [changeResult, boundResult] = await db.batch([
    db.prepare(`
      SELECT revision, entity_type, entity_key, operation
      FROM todo_sync_changes
      WHERE revision > ?
      ORDER BY revision ASC
      LIMIT 501
    `).bind(afterRevision),
    db.prepare("SELECT MIN(revision) AS first_revision, MAX(revision) AS last_revision FROM todo_sync_changes"),
  ]) as [D1Result<TodoSyncChangeRow>, D1Result<{ first_revision: number | null; last_revision: number | null }>];
  const firstRevision = Number(boundResult.results[0]?.first_revision ?? 0);
  const lastRevision = Number(boundResult.results[0]?.last_revision ?? 0);
  const resetReason = afterRevision > lastRevision
    ? "client-revision-ahead"
    : firstRevision > 0 && afterRevision < firstRevision - 1
      ? "revision-expired"
      : changeResult.results.length > 500
        ? "change-window-exceeded"
        : null;
  if (resetReason) return { reset: true, reason: resetReason, ...await readTodoBootstrap() };

  const changes = changeResult.results;
  if (!changes.length) {
    return { reset: false, revision: lastRevision, todos: [], deletedIds: [] };
  }
  const todoIds = [...new Set(changes
    .filter((change) => change.entity_type === "todo")
    .map((change) => Number(change.entity_key))
    .filter((id) => Number.isInteger(id) && id > 0))];
  const todos = await listTodosByIds(db, todoIds);
  const liveIds = new Set(todos.map((todo) => todo.id));
  const deletedIds = todoIds.filter((id) => !liveIds.has(id));
  const projectsChanged = changes.some((change) => change.entity_type === "project");
  const settingsChanged = changes.some((change) => change.entity_type === "settings");
  const captureDraftChanged = changes.some((change) => change.entity_type === "capture_draft");
  const [projects, settings, captureDraft] = await Promise.all([
    projectsChanged ? listTodoProjects() : Promise.resolve(undefined),
    settingsChanged ? getTodoSettings() : Promise.resolve(undefined),
    captureDraftChanged ? getTodoCaptureDraft() : Promise.resolve(undefined),
  ]);
  return {
    reset: false,
    revision: Math.max(lastRevision, Number(changes.at(-1)?.revision ?? afterRevision)),
    todos,
    deletedIds,
    ...(projects ? { projects } : {}),
    ...(settings ? { settings } : {}),
    ...(captureDraftChanged ? { captureDraft: captureDraft ?? null } : {}),
  };
}

export async function listTodoProjects(): Promise<string[]> {
  await ensureTodoDatabase();
  const result = await database()
    .prepare("SELECT name FROM todo_projects ORDER BY name COLLATE NOCASE ASC")
    .all<{ name: string }>();
  return result.results.map((row) => row.name);
}

export async function createTodoProject(inputName: string): Promise<string> {
  await ensureTodoDatabase();
  const name = inputName.trim();
  if (!name) throw new Error("A project name is required.");
  if (name.length > 120) throw new Error("Project names are limited to 120 characters.");
  const result = await database()
    .prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)")
    .bind(name)
    .run();
  if (!Number(result.meta.changes ?? 0)) throw new Error("A project with that name already exists.");
  console.info("[todo-db] project created", { name, nameLength: name.length });
  return name;
}

export async function deleteTodoProject(
  inputName: string,
  mode: ProjectDeleteMode,
  inputTargetProject?: string | null,
) {
  await ensureTodoDatabase();
  const name = inputName.trim();
  const targetProject = inputTargetProject?.trim() || null;
  if (!name) throw new Error("A project name is required.");
  if (mode !== "reassign" && mode !== "delete") throw new Error("Choose what should happen to this project's notes.");
  if (mode === "reassign" && !targetProject) throw new Error("Choose a project for these notes.");
  if (targetProject === name) throw new Error("Choose a different project for these notes.");

  const db = database();
  const existing = await db.prepare("SELECT name FROM todo_projects WHERE name = ?").bind(name).first<{ name: string }>();
  if (!existing) throw new Error("That project no longer exists.");
  if (targetProject) {
    const target = await db.prepare("SELECT name FROM todo_projects WHERE name = ?").bind(targetProject).first<{ name: string }>();
    if (!target) throw new Error("The destination project no longer exists.");
  }

  const beforeResult = await db
    .prepare("SELECT * FROM todos WHERE project = ? ORDER BY id")
    .bind(name)
    .all<TodoRow>();
  const before = beforeResult.results;
  const attachmentBefore = mode === "delete"
    ? await attachmentSnapshotsForTodos(before.map((todo) => todo.id))
    : [];
  const undoToken = before.length > 0 && before.length <= 200 ? crypto.randomUUID() : null;
  const statements = [
    db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    ...(undoToken
      ? [db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
        .bind(undoToken, JSON.stringify({ todos: before, attachments: attachmentBefore } satisfies UndoSnapshot))]
      : []),
    ...(mode === "delete" && before.length
      ? [db.prepare(`
        UPDATE todo_attachments
        SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE todo_id IN (${placeholders(before.length)}) AND deleted_at IS NULL
      `).bind(...before.map((todo) => todo.id))]
      : []),
    mode === "reassign"
      ? db.prepare("UPDATE todos SET project = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE project = ?").bind(targetProject, name)
      : db.prepare("DELETE FROM todos WHERE project = ?").bind(name),
    db.prepare("DELETE FROM todo_projects WHERE name = ?").bind(name),
  ];
  await db.batch(statements);
  console.info("[todo-db] project deleted", {
    name,
    mode,
    targetProject,
    affected: before.length,
    attachmentsAffected: attachmentBefore.length,
    undoAvailable: Boolean(undoToken),
  });
  return { project: name, mode, targetProject, affected: before.length, undoToken };
}

export async function createTodo(input: {
  title: string;
  notes?: string;
  priority?: number;
  dueDate?: string | null;
  project?: string | null;
  context?: string | null;
  recurrenceCron?: string | null;
  draftToken?: string;
  attachmentIds?: string[];
  clientId?: string;
  originDeviceId?: string | null;
  sourceKind?: string;
}): Promise<Todo> {
  await ensureTodoDatabase();
  const notes = validateTaskDescription(input.notes ?? "");
  const clientId = input.clientId?.trim() || null;
  if (clientId && !/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error("That offline task identifier is invalid.");
  const project = input.project?.trim() || null;
  const recurrenceCron = normalizeCronExpression(input.recurrenceCron);
  const sourceKind = input.sourceKind?.trim() || "site";
  if (!/^[a-z0-9-]{1,40}$/i.test(sourceKind)) throw new Error("That task source is invalid.");
  if (project?.length && project.length > 120) throw new Error("Project names are limited to 120 characters.");
  const db = database();
  if (clientId) {
    const existing = await db.prepare(`
      SELECT todos.*,
        (SELECT COUNT(*) FROM todo_attachments
         WHERE todo_attachments.todo_id = todos.id
           AND todo_attachments.upload_state = 'ready'
           AND todo_attachments.deleted_at IS NULL) AS attachment_count
      FROM todos WHERE client_id = ?
    `).bind(clientId).first<TodoRow>();
    if (existing) {
      console.info("[todo-db] idempotent offline create replay resolved", { clientId, id: existing.id, attachmentCount: Number(existing.attachment_count ?? 0) });
      return mapTodo(existing);
    }
  }
  if (project) {
    await db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(project).run();
  }
  const row = await db
    .prepare(`
      ${clientId ? "INSERT OR IGNORE" : "INSERT"} INTO todos (title, notes, status, priority, due_date, project, context, recurrence_cron, source_kind, client_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `)
    .bind(
      input.title,
      notes,
      "open",
      input.priority ?? 3,
      input.dueDate ?? null,
      project,
      input.context ?? null,
      recurrenceCron,
      sourceKind,
      clientId,
    )
    .first<TodoRow>();
  if (!row && clientId) {
    const replay = await db.prepare(`
      SELECT todos.*,
        (SELECT COUNT(*) FROM todo_attachments
         WHERE todo_attachments.todo_id = todos.id
           AND todo_attachments.upload_state = 'ready'
           AND todo_attachments.deleted_at IS NULL) AS attachment_count
      FROM todos WHERE client_id = ?
    `).bind(clientId).first<TodoRow>();
    if (replay) {
      console.info("[todo-db] concurrent offline create replay resolved", { clientId, id: replay.id, attachmentCount: Number(replay.attachment_count ?? 0) });
      return mapTodo(replay);
    }
  }
  if (!row) throw new Error("The task could not be created.");
  try {
    const attachmentCount = await claimDraftAttachments(row.id, input.draftToken, input.attachmentIds);
    let pushQueued = false;
    try {
      pushQueued = await queueTodoPushEvent(db, {
        type: "task_created",
        todoId: row.id,
        title: row.title,
        originDeviceId: input.originDeviceId,
        eventId: clientId ? `create:${clientId}` : undefined,
      });
    } catch (pushError) {
      console.error("[todo-push] created task notification could not be queued", {
        todoId: row.id,
        error: pushError instanceof Error ? pushError.message : String(pushError),
      });
    }
    console.info("[todo-db] task created", { id: row.id, clientId, attachmentCount, pushQueued });
    return mapTodo({ ...row, attachment_count: attachmentCount });
  } catch (error) {
    await db.prepare("DELETE FROM todos WHERE id = ?").bind(row.id).run();
    console.error("[todo-db] task attachment claim failed; task rolled back", { id: row.id, error });
    throw error;
  }
}

const TODO_MUTATION_FIELDS = new Set<keyof TodoUpdate>([
  "title", "notes", "status", "priority", "dueDate", "project", "context", "snoozedUntil", "recurrenceCron", "pinned",
]);

function normalizedMutationTimestamp(input: string | undefined, receivedAt: Date) {
  if (!input) return receivedAt.toISOString();
  const timestamp = new Date(input);
  if (Number.isNaN(timestamp.valueOf())) throw new Error("A sync field timestamp is invalid.");
  if (timestamp.valueOf() > receivedAt.valueOf() + 5 * 60 * 1000) {
    throw new Error("A sync field timestamp is too far in the future.");
  }
  return timestamp.toISOString();
}

export async function updateTodo(
  id: number,
  update: TodoUpdate,
  metadata: TodoMutationMetadata = {},
): Promise<{ todo: Todo; undoToken: string | null; appliedFields: string[] } | null> {
  await ensureTodoDatabase();
  const normalizedUpdate = { ...update };
  if (normalizedUpdate.notes !== undefined) normalizedUpdate.notes = validateTaskDescription(normalizedUpdate.notes);
  if (normalizedUpdate.recurrenceCron !== undefined) normalizedUpdate.recurrenceCron = normalizeCronExpression(normalizedUpdate.recurrenceCron);
  const columnByField: Record<keyof TodoUpdate, string> = {
    title: "title",
    notes: "notes",
    status: "status",
    priority: "priority",
    dueDate: "due_date",
    project: "project",
    context: "context",
    snoozedUntil: "snoozed_until",
    recurrenceCron: "recurrence_cron",
    pinned: "pinned",
  };
  const entries = (Object.entries(normalizedUpdate) as [keyof TodoUpdate, TodoUpdate[keyof TodoUpdate]][])
    .filter(([, value]) => value !== undefined);
  if (!entries.length) {
    const todo = await getTodo(id);
    return todo ? { todo, undoToken: null, appliedFields: [] } : null;
  }

  const db = database();
  const before = await db.prepare("SELECT * FROM todos WHERE id = ?").bind(id).first<TodoRow>();
  if (!before) return null;
  if (normalizedUpdate.snoozedUntil && (before.recurrence_cron || normalizedUpdate.recurrenceCron)) {
    throw new Error("Recurring tasks cannot be snoozed.");
  }
  const receivedAt = new Date();
  const mutationId = metadata.mutationId?.trim() || crypto.randomUUID();
  if (!/^[0-9a-f-]{36}$/i.test(mutationId)) throw new Error("A sync mutation identifier is invalid.");
  const fieldTimestamps = metadata.fieldTimestamps ?? {};
  for (const field of Object.keys(fieldTimestamps) as Array<keyof TodoUpdate>) {
    if (!TODO_MUTATION_FIELDS.has(field)) throw new Error("A sync field name is invalid.");
  }
  const versions = new Map<keyof TodoUpdate, string>();
  for (const [field] of entries) {
    const timestamp = normalizedMutationTimestamp(fieldTimestamps[field], receivedAt);
    versions.set(field, `${timestamp}|${mutationId}`);
  }
  const recordUndo = metadata.recordUndo !== false;
  const undoToken = recordUndo ? crypto.randomUUID() : null;

  const statements: D1PreparedStatement[] = [
    ...(recordUndo ? [
      db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
      db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
        .bind(undoToken, JSON.stringify({ todos: [before] } satisfies UndoSnapshot)),
    ] : []),
    ...(typeof normalizedUpdate.project === "string" && normalizedUpdate.project.trim()
      ? [db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(normalizedUpdate.project.trim())]
      : []),
  ];

  for (const [field, rawValue] of entries) {
    const version = versions.get(field)!;
    const value = field === "pinned" ? rawValue ? 1 : 0 : rawValue;
    statements.push(db.prepare(`
      INSERT INTO todo_field_versions (todo_id, field, version, mutation_id, updated_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(todo_id, field) DO UPDATE SET
        version = excluded.version,
        mutation_id = excluded.mutation_id,
        updated_at = excluded.updated_at
      WHERE excluded.version > todo_field_versions.version
    `).bind(id, field, version, mutationId));

    const currentVersion = "EXISTS (SELECT 1 FROM todo_field_versions WHERE todo_id = ? AND field = ? AND version = ? AND mutation_id = ?)";
    if (field === "status") {
      statements.push(db.prepare(`
        UPDATE todos
        SET status = ?,
            completed_at = CASE WHEN ? = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
            snoozed_until = CASE WHEN ? = 'completed' THEN NULL ELSE snoozed_until END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND ${currentVersion}
      `).bind(value, value, value, id, id, field, version, mutationId));
    } else if (field === "recurrenceCron") {
      statements.push(db.prepare(`
        UPDATE todos
        SET recurrence_cron = ?,
            recurrence_last_fired_at = NULL,
            snoozed_until = CASE WHEN ? IS NOT NULL THEN NULL ELSE snoozed_until END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND ${currentVersion}
      `).bind(value, value, id, id, field, version, mutationId));
    } else {
      statements.push(db.prepare(`
        UPDATE todos
        SET ${columnByField[field]} = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND ${currentVersion}
      `).bind(value, id, id, field, version, mutationId));
    }
  }
  await db.batch(statements);
  const todo = await getTodo(id);
  if (!todo) throw new Error("The updated task could not be loaded.");
  const versionRows = await db.prepare(`
    SELECT field, version, mutation_id
    FROM todo_field_versions
    WHERE todo_id = ? AND field IN (${placeholders(entries.length)})
  `).bind(id, ...entries.map(([field]) => field)).all<{ field: keyof TodoUpdate; version: string; mutation_id: string }>();
  const appliedFields = versionRows.results
    .filter((row) => row.mutation_id === mutationId && versions.get(row.field) === row.version)
    .map((row) => row.field);
  console.info("[todo-db] task details updated", {
    id,
    fields: entries.map(([field]) => field),
    appliedFields,
    conflictFields: entries.map(([field]) => field).filter((field) => !appliedFields.includes(field)),
    mutationId,
    autosave: !recordUndo,
    undoToken,
  });
  return { todo, undoToken, appliedFields };
}

export async function getTodo(id: number): Promise<Todo | null> {
  await ensureTodoDatabase();
  const row = await database().prepare(`
    SELECT todos.*,
      (SELECT COUNT(*) FROM todo_attachments
       WHERE todo_attachments.todo_id = todos.id
         AND todo_attachments.upload_state = 'ready'
         AND todo_attachments.deleted_at IS NULL) AS attachment_count
    FROM todos WHERE todos.id = ?
  `).bind(id).first<TodoRow>();
  return row ? mapTodo(row) : null;
}

export async function readTodoMutationReceipt<T>(operationId: string, kind: string): Promise<T | null> {
  await ensureTodoDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("A mutation operation identifier is invalid.");
  const receipt = await database().prepare(`
    SELECT response_json
    FROM todo_mutation_receipts
    WHERE operation_id = ? AND kind = ?
  `).bind(operationId, kind).first<{ response_json: string }>();
  if (!receipt) return null;
  console.info("[todo-db] idempotent mutation receipt replayed", { operationId, kind });
  return JSON.parse(receipt.response_json) as T;
}

export async function saveTodoMutationReceipt<T>(operationId: string, kind: string, response: T): Promise<T> {
  await ensureTodoDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(operationId)) throw new Error("A mutation operation identifier is invalid.");
  const responseJson = JSON.stringify(response);
  await database().batch([
    database().prepare(`
      INSERT OR IGNORE INTO todo_mutation_receipts (operation_id, kind, response_json)
      VALUES (?, ?, ?)
    `).bind(operationId, kind, responseJson),
    database().prepare("DELETE FROM todo_mutation_receipts WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
  ]);
  const stored = await database().prepare(`
    SELECT response_json
    FROM todo_mutation_receipts
    WHERE operation_id = ? AND kind = ?
  `).bind(operationId, kind).first<{ response_json: string }>();
  if (!stored) throw new Error("The mutation receipt could not be stored.");
  console.info("[todo-db] mutation receipt stored", { operationId, kind, bytes: responseJson.length });
  return JSON.parse(stored.response_json) as T;
}

function placeholders(count: number) {
  return Array.from({ length: count }, () => "?").join(", ");
}

function normalizedIds(ids: number[]) {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!unique.length) throw new Error("Choose at least one task.");
  if (unique.length > 200) throw new Error("Bulk actions are limited to 200 tasks at a time.");
  return unique;
}

function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<string, string>;
}

function zonedDateToUtc(year: number, month: number, day: number, hour: number, timeZone: string) {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsetAt = (timestamp: number) => {
    const values = zonedParts(new Date(timestamp), timeZone);
    return Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
      Number(values.second),
    ) - timestamp;
  };
  let result = guess - offsetAt(guess);
  result = guess - offsetAt(result);
  return new Date(result);
}

export async function getTodoSettings(): Promise<TodoSettings> {
  await ensureTodoDatabase();
  const result = await database()
    .prepare("SELECT key, value FROM app_settings WHERE key IN ('snooze_timezone', 'snooze_wake_hour', 'snooze_quick_presets', 'ai_realtime_voice')")
    .all<{ key: string; value: string }>();
  return mapTodoSettings(result.results);
}

export async function updateTodoSettings(settings: TodoSettings): Promise<TodoSettings> {
  await ensureTodoDatabase();
  const db = database();
  await db.batch([
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('snooze_timezone', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(settings.snoozeTimeZone),
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('snooze_wake_hour', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(String(settings.snoozeWakeHour)),
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('snooze_quick_presets', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(JSON.stringify(settings.snoozeQuickPresets)),
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('ai_realtime_voice', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).bind(settings.realtimeVoice),
  ]);
  console.info("[todo-db] settings updated", {
    snoozeTimeZone: settings.snoozeTimeZone,
    snoozeWakeHour: settings.snoozeWakeHour,
    quickSnoozeCount: settings.snoozeQuickPresets.length,
    realtimeVoice: settings.realtimeVoice,
  });
  return settings;
}

export async function getTodoCaptureDraft(): Promise<TodoCaptureDraft | null> {
  await ensureTodoDatabase();
  const row = await database()
    .prepare("SELECT value FROM app_settings WHERE key = 'capture_draft'")
    .first<{ value: string }>();
  return mapTodoCaptureDraft(row?.value);
}

export async function updateTodoCaptureDraft(input: {
  text: string;
  updatedAt?: string;
  clientId: string;
}): Promise<{ captureDraft: TodoCaptureDraft; applied: boolean }> {
  await ensureTodoDatabase();
  if (input.text.length > 2000) throw new Error("Quick Add drafts are limited to 2,000 characters.");
  const clientId = input.clientId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) throw new Error("A capture draft client identifier is invalid.");
  const updatedAt = normalizedMutationTimestamp(input.updatedAt, new Date());
  const candidate: TodoCaptureDraft = {
    text: input.text,
    updatedAt,
    clientId,
    version: `${updatedAt}|${clientId}`,
  };
  const db = database();
  const applied = await db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('capture_draft', ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
    WHERE json_extract(excluded.value, '$.version') > COALESCE(json_extract(app_settings.value, '$.version'), '')
    RETURNING value
  `).bind(JSON.stringify(candidate), updatedAt).first<{ value: string }>();
  const captureDraft = mapTodoCaptureDraft(applied?.value) ?? await getTodoCaptureDraft() ?? candidate;
  console.info("[todo-db] capture draft synchronized", {
    applied: Boolean(applied),
    textLength: input.text.length,
    returnedTextLength: captureDraft.text.length,
    clientIdPrefix: `${clientId.slice(0, 8)}…`,
    version: captureDraft.version,
  });
  return { captureDraft, applied: Boolean(applied) };
}

export async function nextSnoozeUntil() {
  const settings = await getTodoSettings();
  const today = zonedParts(new Date(), settings.snoozeTimeZone);
  const nextDate = new Date(Date.UTC(
    Number(today.year),
    Number(today.month) - 1,
    Number(today.day) + 1,
  ));
  return zonedDateToUtc(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth() + 1,
    nextDate.getUTCDate(),
    settings.snoozeWakeHour,
    settings.snoozeTimeZone,
  ).toISOString();
}

export async function snoozeUntilForPreset(preset: SnoozePreset, now = new Date()) {
  if (isQuickSnoozePreset(preset)) {
    return new Date(now.valueOf() + quickSnoozeDurationMs(preset)).toISOString();
  }
  if (preset !== "8pm") throw new Error("Choose a valid snooze adjustment.");

  const settings = await getTodoSettings();
  const local = zonedParts(now, settings.snoozeTimeZone);
  const todayAtEight = zonedDateToUtc(
    Number(local.year),
    Number(local.month),
    Number(local.day),
    20,
    settings.snoozeTimeZone,
  );
  if (todayAtEight.valueOf() > now.valueOf()) return todayAtEight.toISOString();
  const tomorrow = new Date(Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day) + 1));
  return zonedDateToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    20,
    settings.snoozeTimeZone,
  ).toISOString();
}

export async function snoozeUntilForLocalDateTime(localDateTime: string, now = new Date()) {
  const settings = await getTodoSettings();
  const until = zonedLocalDateTimeToUtc(localDateTime, settings.snoozeTimeZone);
  if (until.valueOf() <= now.valueOf()) throw new Error("Choose a future date and time.");
  return { snoozedUntil: until.toISOString(), timeZone: settings.snoozeTimeZone };
}

async function adjustSnoozedTodosUntil(
  inputIds: number[],
  until: string,
  adjustment: { preset?: SnoozePreset; localDateTime?: string; timeZone?: string },
) {
  await ensureTodoDatabase();
  const ids = normalizedIds(inputIds);
  const db = database();
  const inClause = placeholders(ids.length);
  const result = await db.prepare(`
    UPDATE todos
    SET snoozed_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id IN (${inClause}) AND status = 'open' AND snoozed_until IS NOT NULL AND recurrence_cron IS NULL
  `).bind(until, ...ids).run();
  const updated = await db.prepare(`
    SELECT todos.*,
      (SELECT COUNT(*) FROM todo_attachments
       WHERE todo_attachments.todo_id = todos.id
         AND todo_attachments.upload_state = 'ready'
         AND todo_attachments.deleted_at IS NULL) AS attachment_count
    FROM todos
    WHERE todos.id IN (${inClause}) AND todos.status = 'open' AND todos.snoozed_until = ? AND todos.recurrence_cron IS NULL
  `).bind(...ids, until).all<TodoRow>();
  const todos = updated.results.map(mapTodo);
  const changedIds = todos.map((todo) => todo.id);
  console.info("[todo-db] snooze adjusted", {
    ...adjustment,
    requested: ids.length,
    changed: result.meta.changes,
    changedIds,
    snoozedUntil: until,
  });
  return { ids: changedIds, todos, snoozedUntil: until };
}

export async function adjustSnoozedTodos(inputIds: number[], preset: SnoozePreset) {
  const until = await snoozeUntilForPreset(preset);
  return adjustSnoozedTodosUntil(inputIds, until, { preset });
}

export async function adjustSnoozedTodosToLocalDateTime(inputIds: number[], localDateTime: string) {
  const { snoozedUntil, timeZone } = await snoozeUntilForLocalDateTime(localDateTime);
  return adjustSnoozedTodosUntil(inputIds, snoozedUntil, { localDateTime, timeZone });
}

export async function bulkUpdateTodos(
  inputIds: number[],
  action: BulkTodoAction,
  options: { project?: string | null; snoozedUntil?: string | null } = {},
) {
  await ensureTodoDatabase();
  const ids = normalizedIds(inputIds);
  const db = database();
  const inClause = placeholders(ids.length);
  const beforeResult = await db.prepare(`SELECT * FROM todos WHERE id IN (${inClause})`).bind(...ids).all<TodoRow>();
  const beforeById = new Map(beforeResult.results.map((row) => [row.id, row]));
  const before = ids.map((id) => beforeById.get(id)).filter((row): row is TodoRow => Boolean(row));
  if (!before.length) throw new Error("The selected tasks no longer exist.");
  if (action === "snooze" && before.some((todo) => Boolean(todo.recurrence_cron))) {
    const recurringIds = before.filter((todo) => Boolean(todo.recurrence_cron)).map((todo) => todo.id);
    console.warn("[todo-db] recurring task snooze rejected", {
      requested: ids.length,
      recurringIds,
    });
    throw new Error("Recurring tasks cannot be snoozed.");
  }
  const undoToken = crypto.randomUUID();
  const attachmentBefore = action === "delete" ? await attachmentSnapshotsForTodos(ids) : [];
  const project = typeof options.project === "string" ? options.project.trim() || null : null;
  if (project && project.length > 120) throw new Error("Project names are limited to 120 characters.");
  let sql: string;
  let values: Array<string | number | null> = ids;

  if (action === "complete") {
    sql = `UPDATE todos SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), snoozed_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
  } else if (action === "reopen") {
    sql = `UPDATE todos SET status = 'open', completed_at = NULL, snoozed_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
  } else if (action === "reproject") {
    sql = `UPDATE todos SET project = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
    values = [project, ...ids];
  } else if (action === "snooze") {
    const customUntil = options.snoozedUntil ? new Date(options.snoozedUntil) : null;
    if (customUntil && (Number.isNaN(customUntil.valueOf()) || customUntil.valueOf() <= Date.now())) {
      throw new Error("Choose a snooze time in the future.");
    }
    const until = customUntil?.toISOString() ?? await nextSnoozeUntil();
    sql = `UPDATE todos SET status = 'open', completed_at = NULL, snoozed_until = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
    values = [until, ...ids];
  } else if (action === "unsnooze") {
    sql = `UPDATE todos SET status = 'open', completed_at = NULL, snoozed_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (${inClause})`;
  } else {
    sql = `DELETE FROM todos WHERE id IN (${inClause})`;
  }

  const statements = [
    db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
    db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
      .bind(undoToken, JSON.stringify({ todos: before, attachments: attachmentBefore } satisfies UndoSnapshot)),
    ...(project && action === "reproject"
      ? [db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(project)]
      : []),
    ...(action === "delete" ? [db.prepare(`
      UPDATE todo_attachments
      SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE todo_id IN (${inClause}) AND deleted_at IS NULL
    `).bind(...ids)] : []),
    db.prepare(sql).bind(...values),
  ];
  const results = await db.batch(statements);
  const result = results.at(-1)!;
  if (action === "delete") {
    console.info("[todo-db] bulk delete", { requested: ids.length, changed: result.meta.changes, attachments: attachmentBefore.length, undoToken });
    return { ids, todos: [], snoozedUntil: null, undoToken };
  }
  const updated = await db.prepare(`
    SELECT todos.*,
      (SELECT COUNT(*) FROM todo_attachments
       WHERE todo_attachments.todo_id = todos.id
         AND todo_attachments.upload_state = 'ready'
         AND todo_attachments.deleted_at IS NULL) AS attachment_count
    FROM todos WHERE todos.id IN (${inClause})
  `).bind(...ids).all<TodoRow>();
  const todos = updated.results.map(mapTodo);
  console.info("[todo-db] bulk action", {
    action,
    requested: ids.length,
    changed: result.meta.changes,
    project: action === "reproject" ? project : undefined,
    snoozedUntil: action === "snooze" ? todos[0]?.snoozedUntil : null,
    undoToken,
  });
  return { ids, todos, snoozedUntil: action === "snooze" ? todos[0]?.snoozedUntil ?? null : null, undoToken };
}

export async function mergeTodos(inputIds: number[]) {
  await ensureTodoDatabase();
  const ids = normalizedIds(inputIds);
  if (ids.length < 2) throw new Error("Choose at least two tasks to merge.");
  const db = database();
  const inClause = placeholders(ids.length);
  const result = await db.prepare(`SELECT * FROM todos WHERE id IN (${inClause})`).bind(...ids).all<TodoRow>();
  const byId = new Map(result.results.map((row) => [row.id, row]));
  const rows = ids.map((id) => byId.get(id)).filter((row): row is TodoRow => Boolean(row));
  if (rows.length < 2) throw new Error("At least two selected tasks must still exist.");
  const attachmentBefore = await attachmentSnapshotsForTodos(ids);

  const shared = (field: "project" | "context") => {
    const first = rows[0][field];
    return rows.every((row) => row[field] === first) ? first : null;
  };
  const dueDates = rows.map((row) => row.due_date).filter((value): value is string => Boolean(value)).sort();
  const undoToken = crypto.randomUUID();
  const createdSourceKind = `merge:${undoToken}`;
  const mergedNotes = [
    `Merged from ${rows.length} tasks:`,
    "",
    ...rows.flatMap((row) => [
      `• ${row.title}`,
      ...(row.notes ? row.notes.split("\n").map((line) => `  ${line}`) : []),
      "",
    ]),
  ].join("\n").trim();

  const inserted = await db.prepare(`
      INSERT INTO todos (title, notes, status, priority, due_date, project, context, source_kind)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?)
      RETURNING *
    `).bind(
      rows[0].title,
      mergedNotes,
      Math.min(...rows.map((row) => row.priority)),
      dueDates[0] ?? null,
      shared("project"),
      shared("context"),
      createdSourceKind,
    ).first<TodoRow>();
  if (!inserted) throw new Error("The merged task could not be created.");
  try {
    await db.batch([
      db.prepare("DELETE FROM todo_action_history WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')"),
      db.prepare("INSERT INTO todo_action_history (id, snapshot) VALUES (?, ?)")
        .bind(undoToken, JSON.stringify({ todos: rows, attachments: attachmentBefore, createdSourceKind } satisfies UndoSnapshot)),
      ...attachmentBefore.map((attachment, sortOrder) => db.prepare(`
        UPDATE todo_attachments
        SET todo_id = ?, sort_order = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND deleted_at IS NULL
      `).bind(inserted.id, sortOrder, attachment.id)),
      db.prepare(`DELETE FROM todos WHERE id IN (${inClause})`).bind(...ids),
    ]);
  } catch (error) {
    await db.prepare("DELETE FROM todos WHERE id = ?").bind(inserted.id).run();
    console.error("[todo-db] merge failed after insert", { sourceIds: ids, mergedId: inserted.id, error });
    throw error;
  }
  console.info("[todo-db] merged", {
    sourceIds: ids,
    mergedId: inserted.id,
    sourceCount: rows.length,
    attachmentsMoved: attachmentBefore.length,
    undoToken,
  });
  return { todo: mapTodo({ ...inserted, attachment_count: attachmentBefore.length }), ids, undoToken };
}

export async function undoTodoAction(undoToken: string) {
  await ensureTodoDatabase();
  if (!/^[0-9a-f-]{36}$/i.test(undoToken)) throw new Error("That undo action is invalid.");
  const db = database();
  const history = await db
    .prepare("SELECT snapshot FROM todo_action_history WHERE id = ? AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')")
    .bind(undoToken)
    .first<{ snapshot: string }>();
  if (!history) throw new Error("That undo action has expired or was already used.");

  const snapshot = JSON.parse(history.snapshot) as UndoSnapshot;
  const attachmentSnapshot = Array.isArray(snapshot.attachments) ? snapshot.attachments : [];
  if (!Array.isArray(snapshot.todos) || snapshot.todos.length > 200 || attachmentSnapshot.length > 2_400 || (!snapshot.todos.length && !attachmentSnapshot.length)) {
    throw new Error("That undo action could not be restored safely.");
  }
  const restore = db.prepare(`
    INSERT INTO todos (
      id, title, notes, status, priority, due_date, project, context,
      source_kind, source_id, client_id, completed_at, snoozed_until,
      recurrence_cron, recurrence_last_fired_at, pinned, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      notes = excluded.notes,
      status = excluded.status,
      priority = excluded.priority,
      due_date = excluded.due_date,
      project = excluded.project,
      context = excluded.context,
      source_kind = excluded.source_kind,
      source_id = excluded.source_id,
      client_id = excluded.client_id,
      completed_at = excluded.completed_at,
      snoozed_until = excluded.snoozed_until,
      recurrence_cron = excluded.recurrence_cron,
      recurrence_last_fired_at = excluded.recurrence_last_fired_at,
      pinned = excluded.pinned,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at
  `);
  const normalizedTodos = snapshot.todos.map((row) => row.status === "archived"
    ? { ...row, status: "open" as const, completed_at: null, snoozed_until: null }
    : row);
  const statements = [
    ...(snapshot.createdSourceKind
      ? [
        db.prepare(`
          UPDATE todo_attachments
          SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE todo_id IN (SELECT id FROM todos WHERE source_kind = ?) AND deleted_at IS NULL
        `).bind(snapshot.createdSourceKind),
        db.prepare("DELETE FROM todos WHERE source_kind = ?").bind(snapshot.createdSourceKind),
      ]
      : []),
    ...[...new Set(normalizedTodos.map((row) => row.project).filter((project): project is string => Boolean(project?.trim())))]
      .map((project) => db.prepare("INSERT OR IGNORE INTO todo_projects (name) VALUES (?)").bind(project)),
    ...normalizedTodos.map((row) => restore.bind(
      row.id,
      row.title,
      row.notes,
      row.status,
      row.priority,
      row.due_date,
      row.project,
      row.context,
      row.source_kind,
      row.source_id,
      row.client_id ?? null,
      row.completed_at,
      row.snoozed_until,
      row.recurrence_cron ?? null,
      row.recurrence_last_fired_at ?? null,
      row.pinned ?? 0,
      row.created_at,
      row.updated_at,
    )),
    ...restoreAttachmentStatements(db, attachmentSnapshot),
    db.prepare("DELETE FROM todo_action_history WHERE id = ?").bind(undoToken),
  ];
  await db.batch(statements);
  const todos = await listTodos();
  console.info("[todo-db] action undone", {
    undoToken,
    restored: normalizedTodos.length,
    restoredAttachments: attachmentSnapshot.length,
    removedCreatedTask: Boolean(snapshot.createdSourceKind),
    normalizedLegacyArchives: snapshot.todos.filter((row) => row.status === "archived").length,
  });
  return { todos, restored: normalizedTodos.length, restoredAttachments: attachmentSnapshot.length };
}
