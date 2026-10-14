CREATE TABLE `todo_bot_notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`bot_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text
);
--> statement-breakpoint
CREATE INDEX `todo_bot_notifications_pending_idx` ON `todo_bot_notifications` (`delivered_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `todo_bot_push_deliveries` (
	`notification_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`delivered_at` text NOT NULL,
	PRIMARY KEY(`notification_id`, `subscription_id`)
);
--> statement-breakpoint
CREATE TABLE `todo_bot_push_owners` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_bot_push_owners_owner_idx` ON `todo_bot_push_owners` (`owner_key`);