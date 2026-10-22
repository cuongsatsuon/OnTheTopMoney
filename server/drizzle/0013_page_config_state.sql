CREATE TABLE "page_config_state" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"page_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"use_own" boolean DEFAULT false NOT NULL,
	"awaiting_group_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_config_state_page_kind_unique" UNIQUE("page_id","kind"),
	CONSTRAINT "page_config_state_kind_check" CHECK ("page_config_state"."kind" in ('brand'))
);
--> statement-breakpoint
ALTER TABLE "page_config_state" ADD CONSTRAINT "page_config_state_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;