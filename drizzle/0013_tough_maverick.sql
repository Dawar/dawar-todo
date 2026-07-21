CREATE TABLE `todo_field_versions` (
	`todo_id` integer NOT NULL,
	`field` text NOT NULL,
	`version` text NOT NULL,
	`mutation_id` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`todo_id`, `field`)
);
--> statement-breakpoint
CREATE INDEX `todo_field_versions_mutation_idx` ON `todo_field_versions` (`mutation_id`);