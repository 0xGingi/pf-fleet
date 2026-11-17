CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_node_idx` ON `events` (`node_id`,`ts`);--> statement-breakpoint
CREATE INDEX `events_ts_idx` ON `events` (`ts`);--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` text NOT NULL,
	`lane` text NOT NULL,
	`ts` integer NOT NULL,
	`stream` text NOT NULL,
	`text` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logs_lane_idx` ON `logs` (`node_id`,`lane`,`id`);