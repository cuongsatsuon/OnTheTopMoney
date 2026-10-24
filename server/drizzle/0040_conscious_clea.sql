CREATE TABLE "deletion_request_parts" (
	"request_id" uuid NOT NULL,
	"module" text NOT NULL,
	"completed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_request_parts_request_id_module_pk" PRIMARY KEY("request_id","module"),
	CONSTRAINT "deletion_request_parts_module_check" CHECK ("deletion_request_parts"."module" in ('autoreply', 'webhooks', 'ai', 'content', 'connections', 'inbox'))
);
--> statement-breakpoint
ALTER TABLE "deletion_requests" DROP CONSTRAINT "deletion_requests_source_check";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deletion_requested_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "conversation_ids" uuid[];--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "page_ids" uuid[];--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "meta_account_id" uuid;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "meta_issued_at" bigint;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "final_requested_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "last_published_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "deletion_request_parts" ADD CONSTRAINT "deletion_request_parts_request_id_deletion_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."deletion_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_requests_open_target_unique" ON "deletion_requests" USING btree ("scope","target_id") WHERE "deletion_requests"."status" <> 'completed' and "deletion_requests"."target_id" is not null;--> statement-breakpoint
CREATE INDEX "deletion_requests_target_idx" ON "deletion_requests" USING btree ("target_id","requested_at");--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_source_check" CHECK ("deletion_requests"."source" in ('meta_deauthorize', 'meta_data_deletion', 'manual', 'page_removed'));