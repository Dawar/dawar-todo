CREATE TABLE `todo_action_history` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_action_history_created_at_idx` ON `todo_action_history` (`created_at`);