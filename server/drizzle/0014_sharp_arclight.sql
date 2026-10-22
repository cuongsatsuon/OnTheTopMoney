CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"product" text NOT NULL,
	"platform_page_id" text,
	"page_id" uuid,
	"field" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"error_code" text,
	"test" boolean DEFAULT false NOT NULL,
	"received_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"routed_at" timestamp (3) with time zone,
	CONSTRAINT "webhook_events_product_dedupe_unique" UNIQUE("product","dedupe_key"),
	CONSTRAINT "webhook_events_product_check" CHECK ("webhook_events"."product" in ('meta', 'threads')),
	CONSTRAINT "webhook_events_status_check" CHECK ("webhook_events"."status" in ('received', 'routed', 'ignored', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;