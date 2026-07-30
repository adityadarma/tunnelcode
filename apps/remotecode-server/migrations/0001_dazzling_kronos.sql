CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`tool` text NOT NULL,
	`target` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activities_conversation_idx` ON `activities` (`conversation_id`);