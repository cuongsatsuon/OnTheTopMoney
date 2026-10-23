CREATE TABLE "contact_merge_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"contact_id" uuid NOT NULL,
	"other_contact_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contact_merge_suggestions_pair_unique" UNIQUE("contact_id","other_contact_id"),
	CONSTRAINT "contact_merge_suggestions_reason_check" CHECK ("contact_merge_suggestions"."reason" in ('private_reply')),
	CONSTRAINT "contact_merge_suggestions_distinct_check" CHECK ("contact_merge_suggestions"."contact_id" <> "contact_merge_suggestions"."other_contact_id")
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ai_summary" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ai_summary_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ai_summary_requested_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "ai_summary_error" text;--> statement-breakpoint
ALTER TABLE "contact_merge_suggestions" ADD CONSTRAINT "contact_merge_suggestions_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_merge_suggestions" ADD CONSTRAINT "contact_merge_suggestions_other_contact_id_contacts_id_fk" FOREIGN KEY ("other_contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_merge_suggestions_other_idx" ON "contact_merge_suggestions" USING btree ("other_contact_id");