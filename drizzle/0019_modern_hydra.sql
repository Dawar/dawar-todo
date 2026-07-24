CREATE TABLE `todo_assistant_memories` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`scope` text NOT NULL,
	`todo_id` integer,
	`kind` text DEFAULT 'fact' NOT NULL,
	`content` text NOT NULL,
	`provenance_json` text DEFAULT '{}' NOT NULL,
	`dedupe_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`forgotten_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_assistant_memories_dedupe_idx` ON `todo_assistant_memories` (`user_key`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `todo_assistant_memories_user_idx` ON `todo_assistant_memories` (`user_key`,`updated_at`);--> statement-breakpoint
CREATE INDEX `todo_assistant_memories_task_idx` ON `todo_assistant_memories` (`user_key`,`todo_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `todo_assistant_memories_forgotten_idx` ON `todo_assistant_memories` (`forgotten_at`);--> statement-breakpoint
CREATE TABLE `todo_talk_messages` (
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
CREATE UNIQUE INDEX `todo_talk_messages_realtime_idx` ON `todo_talk_messages` (`user_key`,`realtime_item_id`);--> statement-breakpoint
CREATE INDEX `todo_talk_messages_session_idx` ON `todo_talk_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_messages_user_idx` ON `todo_talk_messages` (`user_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_messages_task_idx` ON `todo_talk_messages` (`focused_todo_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `todo_talk_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`model` text NOT NULL,
	`voice` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_activity_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`ended_at` text,
	`end_reason` text
);
--> statement-breakpoint
CREATE INDEX `todo_talk_sessions_user_idx` ON `todo_talk_sessions` (`user_key`,`started_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_sessions_status_idx` ON `todo_talk_sessions` (`status`,`last_activity_at`);--> statement-breakpoint
CREATE TABLE `todo_talk_tool_calls` (
	`call_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_key` text NOT NULL,
	`name` text NOT NULL,
	`arguments_json` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`result_json` text,
	`undo_token` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `todo_talk_tool_calls_session_idx` ON `todo_talk_tool_calls` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_tool_calls_user_idx` ON `todo_talk_tool_calls` (`user_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `todo_talk_workspaces` (
	`user_key` text PRIMARY KEY NOT NULL,
	`active_session_id` text,
	`last_focused_todo_id` integer,
	`summary` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
