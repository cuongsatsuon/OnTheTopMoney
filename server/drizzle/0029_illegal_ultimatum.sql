ALTER TABLE "post_targets" ADD COLUMN "publishing_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "published_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "platform_post_id" text;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "permalink" text;--> statement-breakpoint
CREATE INDEX "post_targets_status_scheduled_idx" ON "post_targets" USING btree ("status","scheduled_at");--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_error_code_check" CHECK (("post_targets"."status" = 'failed') = ("post_targets"."error_code" is not null));--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_scheduled_at_check" CHECK ("post_targets"."status" <> 'scheduled' or "post_targets"."scheduled_at" is not null);