ALTER TABLE "messages" ADD COLUMN "delivery" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_platform_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "queued_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sending_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "messages_sending_idx" ON "messages" USING btree ("sending_at") WHERE "messages"."status" = 'sending';--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_delivery_check" CHECK ("messages"."delivery" in ('dm', 'public_reply', 'private_reply'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_error_code_check" CHECK ("messages"."error_code" in ('OUTSIDE_24H', 'PRIVATE_REPLY_USED', 'PRIVATE_REPLY_INVALID', 'RECIPIENT_UNAVAILABLE', 'PAGE_DISCONNECTED', 'PAGE_REMOVED', 'RATE_LIMITED', 'SEND_REJECTED', 'SEND_FAILED', 'SEND_UNKNOWN'));--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_failed_code_check" CHECK (("messages"."status" = 'failed') = ("messages"."error_code" is not null));