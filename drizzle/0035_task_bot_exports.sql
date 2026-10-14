CREATE TABLE IF NOT EXISTS `todo_bot_exports` (
	`owner_key` text NOT NULL,
	`id` text NOT NULL,
	`operation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`bot_id` text NOT NULL,
	`todo_id` integer NOT NULL,
	`source_revision` text NOT NULL,
	`snapshot` text NOT NULL,
	`originals` text NOT NULL,
	`receipt` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`owner_key`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `todo_bot_export_operation` ON `todo_bot_exports` (`owner_key`,`operation_id`);