CREATE TABLE "ai_budget_months" (
	"month" text PRIMARY KEY NOT NULL,
	"spent_vnd" bigint DEFAULT 0 NOT NULL,
	"alerted_80" boolean DEFAULT false NOT NULL,
	"alerted_100" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_budget_months_month_check" CHECK ("ai_budget_months"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
CREATE TABLE "ai_reservations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"month" text NOT NULL,
	"est_vnd" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"month" text NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"page_id" text,
	"ref" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"cached_input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"images" integer DEFAULT 0 NOT NULL,
	"usd_micros" bigint NOT NULL,
	"cost_vnd" bigint NOT NULL,
	CONSTRAINT "ai_usage_feature_check" CHECK ("ai_usage"."feature" in ('autoreply', 'autoreply_test', 'inbox_suggest', 'compose_caption', 'campaign_generate', 'brand_sample', 'image_generate', 'contact_summary')),
	CONSTRAINT "ai_usage_month_check" CHECK ("ai_usage"."month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$')
);
--> statement-breakpoint
ALTER TABLE "ai_model_prices" ADD COLUMN "cached_input_usd_per_1m" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "ai_reservations" ADD CONSTRAINT "ai_reservations_month_ai_budget_months_month_fk" FOREIGN KEY ("month") REFERENCES "public"."ai_budget_months"("month") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_reservations_month_idx" ON "ai_reservations" USING btree ("month");--> statement-breakpoint
CREATE INDEX "ai_reservations_created_at_idx" ON "ai_reservations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_month_feature_idx" ON "ai_usage" USING btree ("month","feature");--> statement-breakpoint
-- Giá seed (Story 1.6): USD / 1 triệu token, kiểm 2026-10-22 trên trang giá OpenAI. Model ảnh: input chữ +
-- output ảnh theo token; `image_usd_each` dùng khi Images API không trả `usage` [ASSUMPTION].
UPDATE "ai_model_prices" AS p SET
	"input_usd_per_1m" = v.input,
	"cached_input_usd_per_1m" = v.cached,
	"output_usd_per_1m" = v.output,
	"image_usd_each" = v.each,
	"updated_at" = now()
FROM (VALUES
	('gpt-6-luna', 0.10, 0.01, 0.50, NULL),
	('gpt-6.1-sol', 2.00, 0.10, 10.00, NULL),
	('gpt-6-astra', 10.00, 1.00, 50.00, NULL),
	('gpt-image-2.5-flare', 5.00, NULL, 30.00, 0.05),
	('gpt-image-2.5-sunburst', 5.00, NULL, 30.00, 0.05),
	('gpt-image-2', 5.00, NULL, 30.00, 0.05)
) AS v(model, input, cached, output, each)
WHERE p."model" = v.model;
