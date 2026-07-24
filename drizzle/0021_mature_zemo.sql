CREATE TABLE `todo_talk_phone_calls` (
	`call_sid` text PRIMARY KEY NOT NULL,
	`user_key` text,
	`from_number_hash` text NOT NULL,
	`to_number` text NOT NULL,
	`status` text DEFAULT 'pin_pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`stream_token_hash` text,
	`stream_token_expires_at` text,
	`stream_token_consumed_at` text,
	`talk_session_id` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`authenticated_at` text,
	`connected_at` text,
	`ended_at` text,
	`failure_reason` text
);
--> statement-breakpoint
CREATE INDEX `todo_talk_phone_calls_user_idx` ON `todo_talk_phone_calls` (`user_key`,`started_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_phone_calls_source_idx` ON `todo_talk_phone_calls` (`from_number_hash`,`started_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_phone_calls_status_idx` ON `todo_talk_phone_calls` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_phone_calls_stream_idx` ON `todo_talk_phone_calls` (`stream_token_hash`);--> statement-breakpoint
CREATE TABLE `todo_talk_phone_profiles` (
	`user_key` text PRIMARY KEY NOT NULL,
	`pin_hash` text NOT NULL,
	`pin_salt` text NOT NULL,
	`pin_iterations` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`webhook_url` text,
	`provider_configured_at` text,
	`pin_updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_authenticated_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
