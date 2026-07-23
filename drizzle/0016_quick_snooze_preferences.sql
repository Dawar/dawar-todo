CREATE TRIGGER `todo_sync_quick_snooze_insert`
AFTER INSERT ON `app_settings`
WHEN NEW.key = 'snooze_quick_presets'
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('settings', NEW.key, 'changed');
END;--> statement-breakpoint
CREATE TRIGGER `todo_sync_quick_snooze_update`
AFTER UPDATE ON `app_settings`
WHEN NEW.key = 'snooze_quick_presets'
BEGIN
  INSERT INTO `todo_sync_changes` (`entity_type`, `entity_key`, `operation`)
  VALUES ('settings', NEW.key, 'changed');
END;--> statement-breakpoint
INSERT OR IGNORE INTO `app_settings` (`key`, `value`, `updated_at`)
VALUES ('snooze_quick_presets', '["15m","30m","1h","2h"]', strftime('%Y-%m-%dT%H:%M:%fZ','now'));--> statement-breakpoint
INSERT INTO `app_settings` (`key`, `value`, `updated_at`)
VALUES ('schema_version', '16', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = excluded.`updated_at`;
