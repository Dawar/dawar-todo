CREATE TABLE `todo_api_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`token_prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_email` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_api_tokens_hash_idx` ON `todo_api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `todo_api_tokens_revoked_at_idx` ON `todo_api_tokens` (`revoked_at`);--> statement-breakpoint
CREATE INDEX `todo_api_tokens_expires_at_idx` ON `todo_api_tokens` (`expires_at`);