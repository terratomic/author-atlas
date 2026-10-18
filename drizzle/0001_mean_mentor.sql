CREATE TABLE `author_history` (
	`history_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` text NOT NULL,
	`record_json` text NOT NULL,
	`replaced_at` text NOT NULL
);
