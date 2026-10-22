CREATE TABLE "ai_model_prices" (
	"model" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"input_usd_per_1m" numeric(12, 6),
	"output_usd_per_1m" numeric(12, 6),
	"image_usd_each" numeric(12, 6),
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_model_prices_kind_check" CHECK ("ai_model_prices"."kind" in ('text', 'image'))
);
--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "last4" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_status_check" CHECK ("secrets"."status" is null or "secrets"."status" in ('valid', 'invalid'));--> statement-breakpoint
-- Seed model (Story 1.5). Model mặc định của mỗi loại = model đang bật có sort nhỏ nhất.
-- Cột giá để trống: Story 1.6 điền sau khi kiểm giá [ASSUMPTION].
INSERT INTO "ai_model_prices" ("model", "kind", "label", "sort") VALUES
	('gpt-6-luna', 'text', 'GPT-6 Luna', 0),
	('gpt-6.1-sol', 'text', 'GPT-6.1 Sol', 1),
	('gpt-6-astra', 'text', 'GPT-6 Astra', 2),
	('gpt-image-2.5-flare', 'image', 'GPT Image 2.5 Flare', 0),
	('gpt-image-2.5-sunburst', 'image', 'GPT Image 2.5 Sunburst', 1),
	('gpt-image-2', 'image', 'GPT Image 2', 2)
ON CONFLICT ("model") DO NOTHING;
