-- Story 4.10 (AD-18) — viết tay trước phần drizzle-kit sinh: tìm không dấu bằng `unaccent` + `pg_trgm` (cả hai "trusted",
-- có sẵn ở image postgres:18 lẫn Postgres nhúng của test). `unaccent()` là STABLE nên không dùng thẳng trong index:
-- bọc thành hàm IMMUTABLE gọi bản hai tham số với từ điển cố định. `lower(… collate pg_c_utf8)` vì DB có thể khởi tạo
-- `--locale=C` (chữ ngoài ASCII không thường hoá). Đổi thân hàm = phải REINDEX các index `*_search_idx`.
CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.search_norm(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN lower(public.unaccent('public.unaccent'::regdictionary, $1) COLLATE pg_c_utf8);--> statement-breakpoint
-- SĐT: chỉ chữ số; `84` + 9 số (dạng +84) → `0` + 9 số. Giữ khớp `phoneDigits` ở server/src/platform/db/search.ts.
CREATE OR REPLACE FUNCTION public.search_phone(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN regexp_replace(regexp_replace($1, '[^0-9]', '', 'g'), '^84([0-9]{9})$', '0\1');--> statement-breakpoint
CREATE INDEX "contacts_name_search_idx" ON "contacts" USING gin (search_norm("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "contacts_phone_search_idx" ON "contacts" USING gin (search_phone("phone") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "groups_name_search_idx" ON "groups" USING gin (search_norm("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "pages_name_search_idx" ON "pages" USING gin (search_norm("name") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "pages_handle_search_idx" ON "pages" USING gin (search_norm("handle") gin_trgm_ops);