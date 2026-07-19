CREATE TABLE `todo_calendar_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_calendar_feeds_token_idx` ON `todo_calendar_feeds` (`token`);--> statement-breakpoint
CREATE INDEX `todo_calendar_feeds_revoked_at_idx` ON `todo_calendar_feeds` (`revoked_at`);