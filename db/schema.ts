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
    uniqueIndex("todos_source_idx").on(table.sourceKind, table.sourceId),
  ],
);
