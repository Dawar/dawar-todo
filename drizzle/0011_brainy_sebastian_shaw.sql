ALTER TABLE `todos` ADD `pinned` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `todos_pinned_idx` ON `todos` (`pinned`);