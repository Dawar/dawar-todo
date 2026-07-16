CREATE TABLE `todos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`due_date` text,
	`project` text,
	`context` text,
	`source_kind` text,
	`source_id` integer,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todos_status_idx` ON `todos` (`status`);--> statement-breakpoint
CREATE INDEX `todos_project_idx` ON `todos` (`project`);--> statement-breakpoint
CREATE INDEX `todos_due_date_idx` ON `todos` (`due_date`);--> statement-breakpoint
CREATE UNIQUE INDEX `todos_source_idx` ON `todos` (`source_kind`,`source_id`);