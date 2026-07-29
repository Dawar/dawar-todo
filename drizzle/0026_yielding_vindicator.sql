CREATE TABLE `todo_talk_phone_recording_segments` (
	`recording_sid` text PRIMARY KEY NOT NULL,
	`call_sid` text NOT NULL,
	`segment_index` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`attachment_id` text,
	`transcript_text` text,
	`twilio_deleted_at` text,
	`error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_talk_phone_recording_segments_order_idx` ON `todo_talk_phone_recording_segments` (`call_sid`,`segment_index`);--> statement-breakpoint
CREATE INDEX `todo_talk_phone_recording_segments_status_idx` ON `todo_talk_phone_recording_segments` (`call_sid`,`status`);--> statement-breakpoint
CREATE INDEX `todo_talk_phone_recording_segments_cleanup_idx` ON `todo_talk_phone_recording_segments` (`twilio_deleted_at`,`updated_at`);--> statement-breakpoint
CREATE TABLE `todo_talk_phone_recordings` (
	`call_sid` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`status` text DEFAULT 'recording' NOT NULL,
	`expected_segments` integer,
	`task_id` integer,
	`task_client_id` text NOT NULL,
	`total_duration_ms` integer DEFAULT 0 NOT NULL,
	`processing_attempts` integer DEFAULT 0 NOT NULL,
	`processing_started_at` text,
	`next_retry_at` text,
	`completed_at` text,
	`error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_talk_phone_recordings_status_idx` ON `todo_talk_phone_recordings` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX `todo_talk_phone_recordings_user_idx` ON `todo_talk_phone_recordings` (`user_key`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `todo_talk_phone_recordings_client_idx` ON `todo_talk_phone_recordings` (`task_client_id`);--> statement-breakpoint
ALTER TABLE `todo_talk_phone_calls` ADD `mode` text;--> statement-breakpoint
ALTER TABLE `todo_talk_phone_calls` ADD `mode_attempt_count` integer DEFAULT 0 NOT NULL;