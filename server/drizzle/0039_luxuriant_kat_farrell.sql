CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"scope" text NOT NULL,
	"target_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"subject_hash" text,
	"matched" boolean DEFAULT true NOT NULL,
	"requested_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "deletion_requests_code_unique" UNIQUE("code"),
	CONSTRAINT "deletion_requests_scope_check" CHECK ("deletion_requests"."scope" in ('page', 'contact', 'all')),
	CONSTRAINT "deletion_requests_status_check" CHECK ("deletion_requests"."status" in ('pending', 'processing', 'completed')),
	CONSTRAINT "deletion_requests_source_check" CHECK ("deletion_requests"."source" in ('meta_deauthorize', 'meta_data_deletion', 'manual')),
	CONSTRAINT "deletion_requests_target_check" CHECK (("deletion_requests"."scope" = 'all') = ("deletion_requests"."target_id" is null)),
	CONSTRAINT "deletion_requests_completed_check" CHECK (("deletion_requests"."status" = 'completed') = ("deletion_requests"."completed_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_requests_open_subject_unique" ON "deletion_requests" USING btree ("subject_hash") WHERE "deletion_requests"."status" <> 'completed' and "deletion_requests"."subject_hash" is not null;--> statement-breakpoint
CREATE INDEX "deletion_requests_subject_idx" ON "deletion_requests" USING btree ("subject_hash","requested_at");