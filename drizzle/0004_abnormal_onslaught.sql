CREATE TABLE `todo_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` integer,
	`draft_token` text,
	`original_key` text NOT NULL,
	`display_key` text NOT NULL,
	`thumbnail_key` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`expires_at` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_attachments_original_key_unique` ON `todo_attachments` (`original_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `todo_attachments_display_key_unique` ON `todo_attachments` (`display_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `todo_attachments_thumbnail_key_unique` ON `todo_attachments` (`thumbnail_key`);--> statement-breakpoint
CREATE INDEX `todo_attachments_todo_id_idx` ON `todo_attachments` (`todo_id`);--> statement-breakpoint
CREATE INDEX `todo_attachments_draft_token_idx` ON `todo_attachments` (`draft_token`);--> statement-breakpoint
CREATE INDEX `todo_attachments_expires_at_idx` ON `todo_attachments` (`expires_at`);--> statement-breakpoint
CREATE INDEX `todo_attachments_deleted_at_idx` ON `todo_attachments` (`deleted_at`);