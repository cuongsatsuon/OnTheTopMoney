ALTER TABLE "campaigns" ADD COLUMN "pause_reason" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "paused_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_pause_reason_check" CHECK (("campaigns"."status" = 'paused') = ("campaigns"."pause_reason" is not null));--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_pause_reason_value_check" CHECK ("campaigns"."pause_reason" is null or "campaigns"."pause_reason" in ('PAGE_DISCONNECTED', 'AI_BUDGET_EXCEEDED', 'PUBLISH_FAILURES', 'CONFIG_MISSING', 'MANUAL'));--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_paused_at_check" CHECK (("campaigns"."pause_reason" is null) = ("campaigns"."paused_at" is null));