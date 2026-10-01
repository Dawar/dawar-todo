CREATE TABLE `bot_storage_files` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_key` text NOT NULL,
	`id` text NOT NULL,
	`bot_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`staging_key` text NOT NULL,
	`object_key` text NOT NULL,
	`state` text NOT NULL,
	`metadata` text NOT NULL,
	`parent_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_storage_identity` ON `bot_storage_files` (`owner_key`,`id`);--> statement-breakpoint
CREATE INDEX `bot_storage_catalog` ON `bot_storage_files` (`owner_key`,`bot_id`,`state`,`seq`);--> statement-breakpoint
CREATE INDEX `bot_storage_derivatives` ON `bot_storage_files` (`owner_key`,`parent_id`,`state`);--> statement-breakpoint
CREATE TABLE `bot_storage_identities` (
	`owner_key` text NOT NULL,
	`id` text NOT NULL,
	`machine_id` text NOT NULL,
	`metadata` text NOT NULL,
	PRIMARY KEY(`owner_key`, `id`)
);
