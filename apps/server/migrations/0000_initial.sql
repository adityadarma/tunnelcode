CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`workspace` text NOT NULL,
	`engine` text NOT NULL,
	`token_hash` text,
	`run_id_hash` text,
	`cli_version` text,
	`created_at` integer NOT NULL,
	`last_activity_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`title` text,
	`engine` text,
	`model` text,
	`engine_session_id` text,
	`engine_session_engine` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`last_input_tokens` integer,
	`last_output_tokens` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversations_session_idx` ON `conversations` (`session_id`);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`partial` integer DEFAULT false NOT NULL,
	`interruption` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`);
--> statement-breakpoint
CREATE TABLE `reasonings` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reasonings_conversation_idx` ON `reasonings` (`conversation_id`);
--> statement-breakpoint
CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`tool` text NOT NULL,
	`target` text,
	`blocked` integer DEFAULT false NOT NULL,
	`reason` text,
	`output` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activities_conversation_idx` ON `activities` (`conversation_id`);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `subscriptions_session_idx` ON `subscriptions` (`session_id`);
