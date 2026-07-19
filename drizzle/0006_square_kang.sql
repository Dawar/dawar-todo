ALTER TABLE `todo_attachments` ADD `kind` text DEFAULT 'image' NOT NULL;--> statement-breakpoint
ALTER TABLE `todo_attachments` ADD `duration_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `todos` ADD `client_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `todos_client_id_idx` ON `todos` (`client_id`);