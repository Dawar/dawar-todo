CREATE TABLE `todo_push_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_type` text NOT NULL,
	`todo_id` integer NOT NULL,
	`todo_title` text NOT NULL,
	`origin_device_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`deliver_after` text NOT NULL,
	`delivered_at` text
);
--> statement-breakpoint
CREATE INDEX `todo_push_events_delivery_idx` ON `todo_push_events` (`delivered_at`,`deliver_after`);--> statement-breakpoint
CREATE INDEX `todo_push_events_todo_idx` ON `todo_push_events` (`todo_id`);--> statement-breakpoint
CREATE TABLE `todo_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`device_id` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_success_at` text,
	`disabled_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_push_subscriptions_endpoint_idx` ON `todo_push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `todo_push_subscriptions_device_idx` ON `todo_push_subscriptions` (`device_id`);--> statement-breakpoint
CREATE INDEX `todo_push_subscriptions_disabled_idx` ON `todo_push_subscriptions` (`disabled_at`);