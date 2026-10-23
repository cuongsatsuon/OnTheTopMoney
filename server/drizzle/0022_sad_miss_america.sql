CREATE TABLE "autoreply_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_type" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"schedule" text DEFAULT 'always' NOT NULL,
	"hours" jsonb NOT NULL,
	"script" text DEFAULT '' NOT NULL,
	"handoff_keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"handoff_on_customer_ask" boolean DEFAULT true NOT NULL,
	"handoff_on_uncertain" boolean DEFAULT true NOT NULL,
	"handoff_message" text NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autoreply_configs_owner_unique" UNIQUE("owner_type","owner_id"),
	CONSTRAINT "autoreply_configs_owner_type_check" CHECK ("autoreply_configs"."owner_type" in ('group', 'page')),
	CONSTRAINT "autoreply_configs_schedule_check" CHECK ("autoreply_configs"."schedule" in ('always', 'offhours', 'custom')),
	CONSTRAINT "autoreply_configs_channels_check" CHECK ("autoreply_configs"."channels" <@ array['messenger', 'ig_direct', 'comment_public', 'comment_private']::text[])
);
--> statement-breakpoint
ALTER TABLE "page_config_state" DROP CONSTRAINT "page_config_state_kind_check";--> statement-breakpoint
ALTER TABLE "page_config_state" ADD CONSTRAINT "page_config_state_kind_check" CHECK ("page_config_state"."kind" in ('brand', 'autoreply'));