ALTER TABLE `todo_talk_phone_calls` ADD `transport` text DEFAULT 'media' NOT NULL;--> statement-breakpoint
ALTER TABLE `todo_talk_phone_calls` ADD `provider_call_id` text;--> statement-breakpoint
CREATE INDEX `todo_talk_phone_calls_provider_idx` ON `todo_talk_phone_calls` (`provider_call_id`);