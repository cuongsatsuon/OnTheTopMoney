ALTER TABLE "ai_model_prices" ADD COLUMN "image_input_usd_per_1m" numeric(12, 6);--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "reference_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_reference_asset_id_media_assets_id_fk" FOREIGN KEY ("reference_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_assets_reference_idx" ON "media_assets" USING btree ("reference_asset_id");--> statement-breakpoint
-- Giá token ảnh vào (Story 6.6): USD / 1 triệu token, kiểm 2026-10-24 trên trang giá OpenAI (model ảnh: chữ vào 5, ảnh
-- vào 8, ảnh ra 30). Dùng cho ảnh tham khảo của Images API edits; model chữ tính token ảnh như token vào thường.
UPDATE "ai_model_prices" SET "image_input_usd_per_1m" = 8.00, "updated_at" = now()
WHERE "model" IN ('gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2');
