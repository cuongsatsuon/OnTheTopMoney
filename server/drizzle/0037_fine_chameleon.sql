CREATE TABLE "metric_sync_states" (
	"page_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"missing_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempted_at" timestamp (3) with time zone NOT NULL,
	"succeeded_at" timestamp (3) with time zone,
	CONSTRAINT "metric_sync_states_page_id_kind_pk" PRIMARY KEY("page_id","kind"),
	CONSTRAINT "metric_sync_states_kind_check" CHECK ("metric_sync_states"."kind" in ('posts', 'page')),
	CONSTRAINT "metric_sync_states_status_check" CHECK ("metric_sync_states"."status" in ('ok', 'permissions_missing', 'permission_denied', 'disconnected', 'failed')),
	CONSTRAINT "metric_sync_states_missing_check" CHECK (("metric_sync_states"."status" = 'permissions_missing') = (cardinality("metric_sync_states"."missing_scopes") > 0))
);
--> statement-breakpoint
CREATE TABLE "page_daily_metrics" (
	"page_id" uuid NOT NULL,
	"date" date NOT NULL,
	"views" bigint,
	"reach" bigint,
	"engagement" bigint,
	"followers_delta" bigint,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "page_daily_metrics_page_id_date_pk" PRIMARY KEY("page_id","date"),
	CONSTRAINT "page_daily_metrics_non_negative_check" CHECK ("page_daily_metrics"."views" >= 0 and "page_daily_metrics"."reach" >= 0 and "page_daily_metrics"."engagement" >= 0)
);
--> statement-breakpoint
CREATE TABLE "post_metrics" (
	"post_target_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"views" bigint,
	"reach" bigint,
	"engagement" bigint,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp (3) with time zone NOT NULL,
	CONSTRAINT "post_metrics_post_target_id_metric_date_pk" PRIMARY KEY("post_target_id","metric_date"),
	CONSTRAINT "post_metrics_non_negative_check" CHECK ("post_metrics"."views" >= 0 and "post_metrics"."reach" >= 0 and "post_metrics"."engagement" >= 0)
);
--> statement-breakpoint
ALTER TABLE "metric_sync_states" ADD CONSTRAINT "metric_sync_states_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_daily_metrics" ADD CONSTRAINT "page_daily_metrics_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_target_id_post_targets_id_fk" FOREIGN KEY ("post_target_id") REFERENCES "public"."post_targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_metrics_page_date_idx" ON "post_metrics" USING btree ("page_id","metric_date");