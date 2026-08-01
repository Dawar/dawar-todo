ALTER TABLE `todos` ADD `sort_order` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `todos_sort_order_idx` ON `todos` (`sort_order`);--> statement-breakpoint
WITH ranked AS (
	SELECT id, (ROW_NUMBER() OVER (ORDER BY updated_at DESC, id DESC) - 1) * 1024 AS next_sort_order
	FROM todos
)
UPDATE todos
SET sort_order = (SELECT next_sort_order FROM ranked WHERE ranked.id = todos.id);--> statement-breakpoint
INSERT INTO app_settings (`key`, `value`)
VALUES ('todo_sort_order_v1', '1')
ON CONFLICT (`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now');--> statement-breakpoint
INSERT INTO app_settings (`key`, `value`)
VALUES ('schema_version', '28')
ON CONFLICT (`key`) DO UPDATE SET `value` = excluded.`value`, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ','now');
