CREATE TABLE "webhook_health" (
	"product" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"last_event_at" timestamp (3) with time zone,
	"status_changed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_health_product_check" CHECK ("webhook_health"."product" in ('meta', 'threads')),
	CONSTRAINT "webhook_health_status_check" CHECK ("webhook_health"."status" in ('waiting_first', 'ok', 'stalled'))
);
--> statement-breakpoint
ALTER TABLE "page_credentials" ADD COLUMN "webhook_subscribed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "page_credentials" ADD COLUMN "webhook_subscribe_error" text;--> statement-breakpoint
CREATE INDEX "webhook_events_product_received_at_idx" ON "webhook_events" USING btree ("product","received_at");--> statement-breakpoint
ALTER TABLE "page_credentials" ADD CONSTRAINT "page_credentials_webhook_subscribe_error_check" CHECK ("page_credentials"."webhook_subscribe_error" in ('PERMISSION_DENIED', 'TOKEN_INVALID', 'REJECTED', 'FAILED'));