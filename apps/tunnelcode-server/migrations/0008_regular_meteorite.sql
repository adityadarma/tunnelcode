CREATE TABLE `reasonings` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reasonings_conversation_idx` ON `reasonings` (`conversation_id`);