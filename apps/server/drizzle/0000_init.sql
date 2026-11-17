CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_enc` text,
	`key_hint` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_name_unique` ON `accounts` (`name`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`lane` text NOT NULL,
	`repo` text NOT NULL,
	`revision` text DEFAULT '' NOT NULL,
	`files` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`result` text,
	`url` text,
	`infohash` text,
	`message` text
);
--> statement-breakpoint
CREATE INDEX `jobs_started_idx` ON `jobs` (`started_at`);--> statement-breakpoint
CREATE INDEX `jobs_node_idx` ON `jobs` (`node_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`account_id` text,
	`token_hash` text NOT NULL,
	`lanes` text DEFAULT '[]' NOT NULL,
	`max_size_gib` integer DEFAULT 0 NOT NULL,
	`idle_sec` integer DEFAULT 300 NOT NULL,
	`hostname` text,
	`os` text,
	`kernel` text,
	`arch` text,
	`cpus` integer,
	`agent_version` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_name_unique` ON `nodes` (`name`);--> statement-breakpoint
CREATE TABLE `samples` (
	`node_id` text NOT NULL,
	`ts` integer NOT NULL,
	`bytes` integer NOT NULL,
	PRIMARY KEY(`node_id`, `ts`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
