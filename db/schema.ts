import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const todos = sqliteTable(
  "todos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status").notNull().default("open"),
    priority: integer("priority").notNull().default(3),
    dueDate: text("due_date"),
    project: text("project"),
    context: text("context"),
    sourceKind: text("source_kind"),
    sourceId: integer("source_id"),
    completedAt: text("completed_at"),
    snoozedUntil: text("snoozed_until"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todos_status_idx").on(table.status),
    index("todos_project_idx").on(table.project),
    index("todos_due_date_idx").on(table.dueDate),
    index("todos_snoozed_until_idx").on(table.snoozedUntil),
    uniqueIndex("todos_source_idx").on(table.sourceKind, table.sourceId),
  ],
);

export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const todoProjects = sqliteTable("todo_projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
});

export const todoActionHistory = sqliteTable(
  "todo_action_history",
  {
    id: text("id").primaryKey(),
    snapshot: text("snapshot").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [index("todo_action_history_created_at_idx").on(table.createdAt)],
);

export const todoAttachments = sqliteTable(
  "todo_attachments",
  {
    id: text("id").primaryKey(),
    todoId: integer("todo_id"),
    draftToken: text("draft_token"),
    originalKey: text("original_key").notNull().unique(),
    displayKey: text("display_key").notNull().unique(),
    thumbnailKey: text("thumbnail_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    uploadState: text("upload_state").notNull().default("ready"),
    sortOrder: integer("sort_order").notNull().default(0),
    expiresAt: text("expires_at"),
    deletedAt: text("deleted_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("todo_attachments_todo_id_idx").on(table.todoId),
    index("todo_attachments_draft_token_idx").on(table.draftToken),
    index("todo_attachments_expires_at_idx").on(table.expiresAt),
    index("todo_attachments_deleted_at_idx").on(table.deletedAt),
  ],
);
