CREATE TABLE IF NOT EXISTS `todo_operator_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_key` text NOT NULL,
	`context_json` text NOT NULL
);
