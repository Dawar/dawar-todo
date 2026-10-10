CREATE TABLE IF NOT EXISTS `todo_call_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_key` text NOT NULL,
	`realtime_item_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`focused_todo_id` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `todo_call_messages_realtime_idx` ON `todo_call_messages` (`user_key`,`realtime_item_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `todo_call_messages_session_idx` ON `todo_call_messages` (`user_key`,`session_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `todo_legacy_chat_backup_chunks` (
	`operation_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`ciphertext` text NOT NULL,
	PRIMARY KEY(`operation_id`, `ordinal`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `todo_legacy_chat_retirement_guard` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "todo_legacy_chat_retirement_guard_valid" CHECK("todo_legacy_chat_retirement_guard"."valid"=1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `todo_legacy_chat_retirements` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`backup_sha256` text NOT NULL,
	`ciphertext_sha256` text NOT NULL,
	`salt` text NOT NULL,
	`iv` text NOT NULL,
	`chunks` integer NOT NULL,
	`counts_json` text NOT NULL,
	`completed_at` text NOT NULL
);
