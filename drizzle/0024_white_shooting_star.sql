CREATE TABLE `todo_push_deliveries` (
	`event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`delivered_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`event_id`, `subscription_id`)
);
--> statement-breakpoint
CREATE INDEX `todo_push_deliveries_subscription_idx` ON `todo_push_deliveries` (`subscription_id`);