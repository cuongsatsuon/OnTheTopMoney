ALTER TABLE "ai_usage" DROP CONSTRAINT "ai_usage_feature_check";--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_feature_check" CHECK ("ai_usage"."feature" in ('autoreply', 'autoreply_test', 'inbox_suggest', 'compose_caption', 'campaign_generate', 'brand_sample', 'image_generate', 'contact_summary', 'image_prompt'));--> statement-breakpoint
-- Model ảnh mặc định (Story 6.7): `gpt-image-2.5-sunburst` như FlowMate (mặc định = model ảnh đang bật có `sort` nhỏ
-- nhất). Chỉ đổi thứ tự: người dùng đã lưu model ảnh ở Cài đặt giữ nguyên lựa chọn (`resolveModel`). Giá hai model như
-- nhau nên chi phí mỗi ảnh không đổi.
UPDATE "ai_model_prices" AS p SET "sort" = v.sort, "updated_at" = now()
FROM (VALUES ('gpt-image-2.5-sunburst', 0), ('gpt-image-2.5-flare', 1), ('gpt-image-2', 2)) AS v(model, sort)
WHERE p."model" = v.model;
