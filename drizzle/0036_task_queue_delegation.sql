CREATE TABLE `todo_queue_receipts` (
	`owner_key` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`todo_id` integer NOT NULL,
	`generation` integer NOT NULL,
	`receipt` text NOT NULL,
	PRIMARY KEY(`owner_key`, `operation_id`)
);
--> statement-breakpoint
CREATE TABLE `todo_queue_state` (
	`todo_id` integer PRIMARY KEY NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`delegation` text,
	`delegation_generation` integer
);
--> statement-breakpoint
-- Queue source fences
CREATE TRIGGER IF NOT EXISTS todo_queue_source_delete AFTER DELETE ON todos BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) VALUES(OLD.id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS todo_queue_source_insert AFTER INSERT ON todos BEGIN
  UPDATE todo_queue_state SET generation=generation+1 WHERE todo_id=NEW.id; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS todo_queue_source_update AFTER UPDATE ON todos
  WHEN OLD.title IS NOT NEW.title OR OLD.notes IS NOT NEW.notes OR OLD.updated_at IS NOT NEW.updated_at OR OLD.status IS NOT NEW.status
   OR OLD.priority IS NOT NEW.priority OR OLD.due_date IS NOT NEW.due_date OR OLD.project IS NOT NEW.project OR OLD.context IS NOT NEW.context
   OR OLD.source_kind IS NOT NEW.source_kind OR OLD.source_id IS NOT NEW.source_id OR OLD.client_id IS NOT NEW.client_id
   OR OLD.completed_at IS NOT NEW.completed_at OR OLD.snoozed_until IS NOT NEW.snoozed_until OR OLD.recurrence_cron IS NOT NEW.recurrence_cron
   OR OLD.recurrence_last_fired_at IS NOT NEW.recurrence_last_fired_at OR OLD.pinned IS NOT NEW.pinned OR OLD.sort_order IS NOT NEW.sort_order OR OLD.created_at IS NOT NEW.created_at
  BEGIN INSERT INTO todo_queue_state(todo_id,generation) VALUES(NEW.id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS todo_queue_file_insert AFTER INSERT ON todo_attachments WHEN NEW.todo_id IS NOT NULL BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) VALUES(NEW.todo_id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS todo_queue_file_update AFTER UPDATE ON todo_attachments BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) SELECT OLD.todo_id,1 WHERE OLD.todo_id IS NOT NULL ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1;
  INSERT INTO todo_queue_state(todo_id,generation) SELECT NEW.todo_id,1 WHERE NEW.todo_id IS NOT NULL ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS todo_queue_file_delete AFTER DELETE ON todo_attachments WHEN OLD.todo_id IS NOT NULL BEGIN
  INSERT INTO todo_queue_state(todo_id,generation) VALUES(OLD.todo_id,1) ON CONFLICT(todo_id) DO UPDATE SET generation=generation+1; END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS todo_queue_sync_insert AFTER INSERT ON todo_queue_state BEGIN
  INSERT INTO todo_sync_changes(entity_type,entity_key,operation) VALUES('todo',CAST(NEW.todo_id AS TEXT),'upsert'); END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS todo_queue_sync_update AFTER UPDATE ON todo_queue_state BEGIN
  INSERT INTO todo_sync_changes(entity_type,entity_key,operation) VALUES('todo',CAST(NEW.todo_id AS TEXT),'upsert'); END;
