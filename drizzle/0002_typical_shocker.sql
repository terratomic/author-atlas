CREATE TABLE `author_lookup_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text NOT NULL
);
