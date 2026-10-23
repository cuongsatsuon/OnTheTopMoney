CREATE TABLE "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"public_id" text NOT NULL,
	"url" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL,
	"format" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_assets_public_id_unique" UNIQUE("public_id"),
	CONSTRAINT "media_assets_source_check" CHECK ("media_assets"."source" in ('upload', 'ai'))
);
--> statement-breakpoint
CREATE TABLE "post_target_media" (
	"post_target_id" uuid NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "post_target_media_post_target_id_media_asset_id_pk" PRIMARY KEY("post_target_id","media_asset_id")
);
--> statement-breakpoint
CREATE TABLE "post_targets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"post_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"status" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"schedule_version" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp (3) with time zone,
	"error_code" text,
	"cancel_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_targets_post_page_unique" UNIQUE("post_id","page_id"),
	CONSTRAINT "post_targets_status_check" CHECK ("post_targets"."status" in ('planned', 'draft', 'pending_approval', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
	CONSTRAINT "post_targets_cancel_reason_check" CHECK ("post_targets"."cancel_reason" is null or "post_targets"."cancel_reason" in ('USER_DELETED', 'USER_REJECTED', 'CAMPAIGN_DELETED', 'MISSED_WHILE_PAUSED', 'PAGE_REMOVED', 'PAGE_LEFT_GROUP'))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"source" text NOT NULL,
	"topic" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "posts_source_check" CHECK ("posts"."source" in ('manual', 'campaign'))
);
--> statement-breakpoint
ALTER TABLE "post_target_media" ADD CONSTRAINT "post_target_media_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_target_media" ADD CONSTRAINT "post_target_media_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_targets" ADD CONSTRAINT "post_targets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_target_media_asset_idx" ON "post_target_media" USING btree ("media_asset_id");--> statement-breakpoint
CREATE INDEX "post_targets_page_idx" ON "post_targets" USING btree ("page_id");