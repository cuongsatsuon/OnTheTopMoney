CREATE TABLE "meta_rate_state" (
	"scope" text NOT NULL,
	"bucket" text NOT NULL,
	"usage_pct" real DEFAULT 0 NOT NULL,
	"blocked_until" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meta_rate_state_scope_bucket_pk" PRIMARY KEY("scope","bucket"),
	CONSTRAINT "meta_rate_state_usage_pct_check" CHECK ("meta_rate_state"."usage_pct" >= 0)
);
