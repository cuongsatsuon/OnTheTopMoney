CREATE TABLE "campaign_pages" (
	"campaign_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"frequency" text,
	CONSTRAINT "campaign_pages_campaign_id_page_id_pk" PRIMARY KEY("campaign_id","page_id"),
	CONSTRAINT "campaign_pages_frequency_check" CHECK ("campaign_pages"."frequency" is null or "campaign_pages"."frequency" in ('3_per_week', '1_per_day', '2_per_day', '3_per_day'))
);
--> statement-breakpoint
CREATE TABLE "campaign_topics" (
	"campaign_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name" text NOT NULL,
	"share" integer NOT NULL,
	CONSTRAINT "campaign_topics_campaign_id_position_pk" PRIMARY KEY("campaign_id","position"),
	CONSTRAINT "campaign_topics_share_check" CHECK ("campaign_topics"."share" between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"mode" text DEFAULT 'review' NOT NULL,
	"start_date" date NOT NULL,
	"duration_days" integer NOT NULL,
	"group_id" uuid,
	"default_frequency" text NOT NULL,
	"image_ratio" integer NOT NULL,
	"post_times" text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_goal_check" CHECK ("campaigns"."goal" in ('engage', 'follow', 'sell', 'launch')),
	CONSTRAINT "campaigns_status_check" CHECK ("campaigns"."status" in ('draft', 'running', 'paused', 'done')),
	CONSTRAINT "campaigns_mode_check" CHECK ("campaigns"."mode" in ('review', 'auto')),
	CONSTRAINT "campaigns_duration_check" CHECK ("campaigns"."duration_days" in (7, 14, 30)),
	CONSTRAINT "campaigns_default_frequency_check" CHECK ("campaigns"."default_frequency" in ('3_per_week', '1_per_day', '2_per_day', '3_per_day')),
	CONSTRAINT "campaigns_image_ratio_check" CHECK ("campaigns"."image_ratio" between 0 and 100),
	CONSTRAINT "campaigns_post_times_check" CHECK (cardinality("campaigns"."post_times") between 1 and 6)
);
--> statement-breakpoint
ALTER TABLE "campaign_pages" ADD CONSTRAINT "campaign_pages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_pages" ADD CONSTRAINT "campaign_pages_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_topics" ADD CONSTRAINT "campaign_topics_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_pages_page_idx" ON "campaign_pages" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");