CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `todos` ADD `snoozed_until` text;--> statement-breakpoint
CREATE INDEX `todos_snoozed_until_idx` ON `todos` (`snoozed_until`);