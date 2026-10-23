ALTER TABLE "post_targets" DROP CONSTRAINT "post_targets_error_code_check";--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "slot_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "post_targets" ADD COLUMN "held" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_slot_unique" UNIQUE("campaign_id","page_id","slot_at");--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_slot_check" CHECK (("post_targets"."campaign_id" is null) = ("post_targets"."slot_at" is null));--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_error_code_check" CHECK (("post_targets"."status" <> 'failed' or "post_targets"."error_code" is not null) and ("post_targets"."error_code" is null or "post_targets"."status" in ('failed', 'pending_approval')));