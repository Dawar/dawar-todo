CREATE TRIGGER `todo_sync_capture_draft_insert`
AFTER INSERT ON `app_settings`
WHEN NEW.key = 'capture_draft'
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('capture_draft', NEW.key, 'changed');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_capture_draft_update`
AFTER UPDATE ON `app_settings`
WHEN NEW.key = 'capture_draft'
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('capture_draft', NEW.key, 'changed');
END;--> statement-breakpoint
INSERT INTO `app_settings` (`key`, `value`, `updated_at`)
VALUES ('schema_version', '15', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = excluded.`updated_at`;
