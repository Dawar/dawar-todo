ALTER TABLE `todos` ADD `recurrence_cron` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `recurrence_last_fired_at` text;--> statement-breakpoint
CREATE INDEX `todos_recurrence_cron_idx` ON `todos` (`recurrence_cron`);