CREATE TABLE `bot_storage_ready` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_key` text NOT NULL,
	`id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bot_storage_ready_identity` ON `bot_storage_ready` (`owner_key`,`id`);