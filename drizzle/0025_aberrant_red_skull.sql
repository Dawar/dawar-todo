CREATE TABLE `todo_talk_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`system_key` text,
	`title` text NOT NULL,
	`focused_todo_id` integer,
	`summary` text DEFAULT '' NOT NULL,
	`draft_text` text DEFAULT '' NOT NULL,
	`delete_token` text,
	`deleted_at` text,
	`purge_after` text,
	`last_message_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_talk_threads_system_idx` ON `todo_talk_threads` (`user_key`,`system_key`);--> statement-breakpoint
CREATE INDEX `todo_talk_threads_user_idx` ON `todo_talk_threads` (`user_key`,`deleted_at`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_threads_delete_idx` ON `todo_talk_threads` (`delete_token`);--> statement-breakpoint
CREATE INDEX `todo_talk_threads_purge_idx` ON `todo_talk_threads` (`purge_after`);--> statement-breakpoint
ALTER TABLE `todo_talk_messages` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `todo_talk_messages_thread_idx` ON `todo_talk_messages` (`thread_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `todo_talk_sessions` ADD `thread_id` text;--> statement-breakpoint
ALTER TABLE `todo_talk_sessions` ADD `transport` text DEFAULT 'browser' NOT NULL;--> statement-breakpoint
ALTER TABLE `todo_talk_tool_calls` ADD `thread_id` text;--> statement-breakpoint
CREATE INDEX `todo_talk_tool_calls_thread_idx` ON `todo_talk_tool_calls` (`thread_id`,`created_at`);