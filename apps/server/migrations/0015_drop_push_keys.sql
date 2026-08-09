DROP TABLE IF EXISTS `push_keys`;
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
INSERT INTO `subscriptions` (`endpoint`, `session_id`, `p256dh`, `auth`, `created_at`)
  SELECT `endpoint`, `session_id`, `p256dh`, `auth`, `created_at` FROM `push_subscriptions`;
--> statement-breakpoint
DROP TABLE `push_subscriptions`;
--> statement-breakpoint
CREATE INDEX `subscriptions_session_idx` ON `subscriptions` (`session_id`);
