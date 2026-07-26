CREATE TABLE `todo_mutation_receipts` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_mutation_receipts_created_at_idx` ON `todo_mutation_receipts` (`created_at`);