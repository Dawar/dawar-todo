CREATE TABLE `todo_profile_contacts` (
	`user_key` text PRIMARY KEY NOT NULL,
	`phone_ciphertext` text,
	`phone_iv` text,
	`phone_hash` text,
	`phone_suffix` text,
	`phone_verified_at` text,
	`urgent_alerts_enabled` integer DEFAULT false NOT NULL,
	`call_window_start` integer DEFAULT 8 NOT NULL,
	`call_window_end` integer DEFAULT 22 NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_profile_contacts_phone_hash_idx` ON `todo_profile_contacts` (`phone_hash`);--> statement-breakpoint
CREATE TABLE `todo_profile_phone_verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`phone_ciphertext` text NOT NULL,
	`phone_iv` text NOT NULL,
	`phone_hash` text NOT NULL,
	`phone_suffix` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_profile_phone_verifications_user_idx` ON `todo_profile_phone_verifications` (`user_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `todo_profile_phone_verifications_expiry_idx` ON `todo_profile_phone_verifications` (`expires_at`);--> statement-breakpoint
CREATE TABLE `todo_urgent_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`escalation_id` text NOT NULL,
	`wave_index` integer NOT NULL,
	`channel` text NOT NULL,
	`provider_sid` text,
	`status` text DEFAULT 'prepared' NOT NULL,
	`submitted_at` text,
	`delivered_at` text,
	`error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_urgent_attempts_wave_channel_idx` ON `todo_urgent_attempts` (`escalation_id`,`wave_index`,`channel`);--> statement-breakpoint
CREATE INDEX `todo_urgent_attempts_provider_idx` ON `todo_urgent_attempts` (`provider_sid`);--> statement-breakpoint
CREATE INDEX `todo_urgent_attempts_status_idx` ON `todo_urgent_attempts` (`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `todo_urgent_escalations` (
	`id` text PRIMARY KEY NOT NULL,
	`todo_id` integer NOT NULL,
	`user_key` text NOT NULL,
	`source_token_id` text,
	`source_agent_name` text NOT NULL,
	`reply_code` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`wave_index` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`last_attempt_at` text,
	`acknowledged_at` text,
	`acknowledgement_channel` text,
	`stopped_reason` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_urgent_escalations_todo_idx` ON `todo_urgent_escalations` (`todo_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `todo_urgent_escalations_reply_idx` ON `todo_urgent_escalations` (`reply_code`);--> statement-breakpoint
CREATE INDEX `todo_urgent_escalations_due_idx` ON `todo_urgent_escalations` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `todo_urgent_escalations_user_idx` ON `todo_urgent_escalations` (`user_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `todo_urgent_escalations_lease_idx` ON `todo_urgent_escalations` (`lease_expires_at`);--> statement-breakpoint
PRAGMA optimize;
