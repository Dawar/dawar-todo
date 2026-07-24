CREATE TABLE `todo_assistant_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`todo_id` integer NOT NULL,
	`role` text NOT NULL,
	`kind` text DEFAULT 'message' NOT NULL,
	`content` text NOT NULL,
	`question_json` text,
	`proposal_json` text,
	`sources_json` text,
	`attachment_ids_json` text DEFAULT '[]' NOT NULL,
	`client_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_assistant_messages_thread_idx` ON `todo_assistant_messages` (`user_key`,`todo_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `todo_assistant_messages_client_idx` ON `todo_assistant_messages` (`user_key`,`client_id`);--> statement-breakpoint
CREATE TABLE `todo_assistant_threads` (
	`user_key` text NOT NULL,
	`todo_id` integer NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`draft_text` text DEFAULT '' NOT NULL,
	`current_question_json` text,
	`skipped_question_keys_json` text DEFAULT '[]' NOT NULL,
	`understanding_json` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`user_key`, `todo_id`)
);
--> statement-breakpoint
CREATE INDEX `todo_assistant_threads_todo_idx` ON `todo_assistant_threads` (`todo_id`);--> statement-breakpoint
CREATE INDEX `todo_assistant_threads_updated_idx` ON `todo_assistant_threads` (`updated_at`);--> statement-breakpoint
CREATE TABLE `todo_assistant_workspaces` (
	`user_key` text PRIMARY KEY NOT NULL,
	`selected_todo_id` integer,
	`navigator_view` text DEFAULT 'open' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
