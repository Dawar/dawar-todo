CREATE TABLE `todo_sync_changes` (
	`revision` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`operation` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_sync_changes_created_at_idx` ON `todo_sync_changes` (`created_at`);--> statement-breakpoint
CREATE INDEX `todo_sync_changes_entity_idx` ON `todo_sync_changes` (`entity_type`,`entity_key`,`revision`);--> statement-breakpoint
CREATE TRIGGER `todo_sync_todos_insert`
AFTER INSERT ON `todos`
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('todo', CAST(NEW.id AS TEXT), 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_todos_update`
AFTER UPDATE ON `todos`
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('todo', CAST(NEW.id AS TEXT), 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_todos_delete`
AFTER DELETE ON `todos`
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('todo', CAST(OLD.id AS TEXT), 'delete');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_projects_insert`
AFTER INSERT ON `todo_projects`
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('project', NEW.name, 'changed');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_projects_update`
AFTER UPDATE ON `todo_projects`
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('project', NEW.name, 'changed');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_projects_delete`
AFTER DELETE ON `todo_projects`
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('project', OLD.name, 'changed');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_settings_insert`
AFTER INSERT ON `app_settings`
WHEN NEW.key IN ('snooze_timezone', 'snooze_wake_hour')
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('settings', NEW.key, 'changed');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_settings_update`
AFTER UPDATE ON `app_settings`
WHEN NEW.key IN ('snooze_timezone', 'snooze_wake_hour')
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('settings', NEW.key, 'changed');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_attachments_insert`
AFTER INSERT ON `todo_attachments`
WHEN NEW.todo_id IS NOT NULL
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('todo', CAST(NEW.todo_id AS TEXT), 'upsert');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_attachments_update`
AFTER UPDATE ON `todo_attachments`
WHEN OLD.todo_id IS NOT NEW.todo_id
  OR OLD.upload_state IS NOT NEW.upload_state
  OR OLD.deleted_at IS NOT NEW.deleted_at
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  SELECT 'todo', CAST(OLD.todo_id AS TEXT), 'upsert' WHERE OLD.todo_id IS NOT NULL;
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  SELECT 'todo', CAST(NEW.todo_id AS TEXT), 'upsert' WHERE NEW.todo_id IS NOT NULL;
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_attachments_delete`
AFTER DELETE ON `todo_attachments`
WHEN OLD.todo_id IS NOT NULL
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('todo', CAST(OLD.todo_id AS TEXT), 'upsert');
END;--> statement-breakpoint
INSERT INTO `app_settings` (`key`, `value`, `updated_at`)
VALUES ('schema_version', '14', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = excluded.`updated_at`;
