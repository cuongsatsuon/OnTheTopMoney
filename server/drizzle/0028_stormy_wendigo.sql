ALTER TABLE "media_assets" ALTER COLUMN "public_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "url" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "format" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "prompt" text;--> statement-breakpoint
CREATE INDEX "media_assets_created_at_idx" ON "media_assets" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_status_check" CHECK ("media_assets"."status" in ('pending', 'ready', 'failed'));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_error_code_check" CHECK (("media_assets"."status" = 'failed') = ("media_assets"."error_code" is not null) and ("media_assets"."error_code" is null or "media_assets"."error_code" in ('IMAGE_REJECTED', 'IMAGE_FAILED')));--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_ready_file_check" CHECK ("media_assets"."status" <> 'ready' or ("media_assets"."public_id" is not null and "media_assets"."url" is not null and "media_assets"."width" is not null and "media_assets"."height" is not null and "media_assets"."bytes" is not null and "media_assets"."format" is not null));