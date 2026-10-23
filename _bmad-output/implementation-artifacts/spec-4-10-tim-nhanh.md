---
title: 'Story 4.10: Tìm nhanh bằng ⌘K'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
baseline_commit: 'a3b4ea2aeb409d52ef55bfd45a32f2492e57e518'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Ô tìm trên thanh trên chỉ là khung giả (`⌘K` không làm gì), và tìm khách ở 4.9 dùng `ILIKE` nên gõ "nguyen thu ha" không ra "Nguyễn Thu Hà". Chủ shop không tới nhanh được trang, nhóm hay khách.

**Approach:** Bật `unaccent` + `pg_trgm`, thêm hàm chuẩn hoá bất biến `search_norm` (bỏ dấu + thường hoá) và `search_phone` (chỉ chữ số, `84…` → `0…`) kèm index GIN trigram. `pages.search` (trang, nhóm) và `inbox.searchContacts` (khách) dùng chung helper so khớp; `GET /api/v1/search?q=` ghép ở `app/read-models`. FE dựng bảng lệnh ⌘K/Ctrl+K: kết quả từ API + hai lệnh FE "Tạo bài viết", "Đổi phạm vi".

## Boundaries & Constraints

**Always:**
- So khớp không dấu, không phân biệt hoa thường: mỗi từ của truy vấn phải là chuỗi con của tên đã chuẩn hoá (thứ tự từ tự do). Trang khớp cả `handle`. Khách khớp tên hoặc SĐT (≥3 chữ số, so theo `search_phone`). Ký tự `%`, `_`, `\` là chữ thường.
- ⌘K thêm khớp gần đúng (`<%` của `pg_trgm`, truy vấn chuẩn hoá ≥4 ký tự) để chịu lỗi gõ; xếp: khớp từ trước khớp gần đúng, rồi trùng hẳn > bắt đầu bằng > còn lại, rồi `word_similarity` giảm dần, rồi tên.
- Tìm toàn bộ (không theo phạm vi đang chọn): trang chưa gỡ, mọi nhóm, khách có định danh trên trang chưa gỡ. Tối đa 5 trang, 5 nhóm, 8 khách.
- AD-1: `inbox` không đọc bảng `pages` (nhận tập trang chưa gỡ từ bên gọi); ghép ở `app/read-models/search.ts`. Helper SQL dùng chung ở `platform/db`.
- Không log từ khoá tìm (có thể là SĐT). Schema request/response zod ở `packages/shared`.
- Danh sách Khách hàng (`q` của 4.9) chuyển sang cùng cách khớp từ không dấu (tên, thẻ, SĐT), không khớp gần đúng.
- Chọn kết quả: trang → `/trang-nhom/trang/:id`, nhóm → `/trang-nhom/nhom/:id`, khách → `/khach-hang?id=:id`. "Tạo bài viết" → `/soan-bai`; "Đổi phạm vi" → mở bộ chọn phạm vi sẵn có.

**Never:** Tìm bài viết/hội thoại/nội dung tin; lọc ⌘K theo phạm vi; full-text search (`tsvector`); cột chuẩn hoá lưu sẵn; thư viện `cmdk` mới; lưu lịch sử tìm.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Không dấu | `q=nguyen thu ha`; khách "Nguyễn Thu Hà", trang "Nguyễn Thu Hà Shop", nhóm "Đồ gia dụng" | `contacts` có khách, `pages` có trang; `q=do gia` ra nhóm kèm `pageCount` | N/A |
| Thứ tự từ / một phần | `q=ha nguyen`, `q=HÀ` | Vẫn khớp "Nguyễn Thu Hà" | N/A |
| SĐT | khách `phone='0912 345 678'`; `q=345678`, `q=+84 912 345 678` | Khớp; `q=34` không khớp theo SĐT | N/A |
| Gõ sai (⌘K) | `q=ngyen thu ha` | Khớp gần đúng, xếp sau khớp đúng từ | N/A |
| Xếp hạng | trang "Hà", "Hà Nội Shop", "Shop Hà" với `q=ha` | Thứ tự: "Hà", "Hà Nội Shop", "Shop Hà" | N/A |
| Đã gỡ | trang đã gỡ; khách chỉ có định danh ở trang đã gỡ | Không trả | N/A |
| Ký tự đại diện | `q=100%` | Không khớp tên "1000" | N/A |
| Giới hạn | 7 trang khớp | Trả 5 | N/A |
| Truy vấn sai | `q` rỗng / chỉ khoảng trắng / >100 ký tự; thiếu phiên | — | 400 `VALIDATION_FAILED`; 401 |
| Danh sách khách | `GET /contacts?q=nguyen thu` | Khớp "Nguyễn Thu Hà" (4.9 trước đây không) | N/A |
| Phím tắt | ⌘K (Mac) / Ctrl+K; khi đang gõ IME | Mở/đóng bảng lệnh; Esc đóng; ↑/↓ chọn, ↵ mở | IME composing → bỏ qua |
| Trống / lỗi | không kết quả; API lỗi | "Không tìm thấy trang, nhóm hay khách nào"; microcopy lỗi theo mã | Lệnh FE vẫn dùng được |

</frozen-after-approval>

## Code Map

- `server/drizzle/0021_daffy_sunspot.sql` -- `drizzle-kit generate` (index GIN), đầu file thêm tay extension + 2 hàm.
- `server/src/platform/db/search.ts` -- MỚI: `searchTerms`, `textMatch`, `textRank`, `phoneMatch`.
- `server/src/modules/pages/{schema,search,index}.ts` -- index trigram tên trang/handle/nhóm; `search`.
- `server/src/modules/inbox/{schema,contacts,index}.ts` -- index tên/SĐT khách; `searchContacts`; `q` của `listContacts`.
- `server/src/app/{read-models/search,search,app}.ts` -- ghép kết quả, route `/api/v1/search`.
- `packages/shared/src/search.ts` (+ `index.ts`, `contacts.ts` comment) -- `SearchQuery`, `SearchResponse`, giới hạn.
- `web/src/lib/search.ts` (+ test), `web/src/components/CommandPalette.tsx`, `web/src/components/AppShell.tsx`, `web/src/lib/realtime.ts` -- bảng lệnh.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/search.ts` -- hợp đồng tìm kiếm -- AD-18.
- [x] `server/src/platform/db/search.ts` + schema index + migration 0021 -- chuẩn hoá và index -- AC 1.
- [x] `server/src/modules/pages/search.ts`, `server/src/modules/inbox/contacts.ts` -- `pages.search`, `inbox.searchContacts`, `q` danh sách khách -- AD-18, việc hoãn 4.9.
- [x] `server/src/app/read-models/search.ts`, `server/src/app/search.ts`, `app.ts` -- `/api/v1/search`.
- [x] `server/test/search.test.ts` (+ cập nhật `contacts.test.ts`) -- phủ mọi dòng server của ma trận.
- [x] `web/src/lib/search.ts`, `CommandPalette.tsx`, `AppShell.tsx`, `realtime.ts` -- bảng lệnh, phím tắt, đích mở, lệnh FE; `page`/`group`/`contact` làm cũ `['search']`.
- [x] `web/src/lib/search.test.ts` -- phím tắt, đích mở, danh sách mục + lệnh lọc không dấu, di chuyển ↑/↓.
- [x] `deferred-work.md` -- gỡ mục "Tìm khách không dấu" của 4.9.

**Acceptance Criteria:**
- Given extension đã bật, when gọi `/api/v1/search?q=nguyen thu ha`, then trả kết quả gộp từ `pages.search` và `inbox.searchContacts`, khớp "Nguyễn Thu Hà".
- Given bảng lệnh ⌘K, when chọn một kết quả, then mở đúng trang/nhóm/khách; "Tạo bài viết", "Đổi phạm vi" chạy phía FE.
- Given migration chạy trên Postgres 18 (CI, production) và Postgres nhúng (test), then extension/hàm/index tạo được, `npm run check` xanh.

## Design Notes

`unaccent()` là STABLE nên không dùng thẳng trong index; bọc thành hàm SQL IMMUTABLE gọi bản hai tham số với từ điển cố định (`'public.unaccent'::regdictionary`), `lower(… collate pg_c_utf8)` vì DB khởi tạo `--locale=C`. Đã kiểm: Postgres nhúng (18.4) có sẵn `unaccent`, `pg_trgm` và `unaccent.rules` (đ→d, chữ dựng sẵn lẫn tổ hợp NFD); image `postgres:18` có contrib. Cả hai extension là "trusted" nên chủ DB không cần superuser.

```sql
CREATE FUNCTION public.search_norm(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  RETURN lower(public.unaccent('public.unaccent'::regdictionary, $1) COLLATE pg_c_utf8);
```

## Verification

**Commands:**
- `npm run check` (gốc repo) -- expected: typecheck, lint, depcruise, test đều xanh.
- `npx drizzle-kit generate` trong `server/` sau khi xong -- expected: "No schema changes".

## Implementation Notes

- **Migration** `0021_daffy_sunspot.sql`: `drizzle-kit generate` sinh 5 index GIN (`contacts_name|phone_search_idx`, `groups_name_search_idx`, `pages_name|handle_search_idx`); đầu file viết tay `CREATE EXTENSION unaccent, pg_trgm` + `search_norm`/`search_phone` (SQL-standard `RETURN`, IMMUTABLE). Đã kiểm `EXPLAIN` (tắt seqscan): `like` và `<%` dùng đúng index.
- **Helper** `platform/db/search.ts`: `searchTerms` (NFC, gộp khoảng trắng, ≤8 từ, thoát `%_\`), `textMatch`, `textRank`, `phoneMatch`, `phoneDigits` (cùng luật `84…→0…` với SQL).
- **`pages.search`** (`modules/pages/search.ts`): trang khớp tên hoặc handle; nhóm kèm `pageCount` (chỉ trang chưa gỡ). Bẫy: cột trong phần `select` Drizzle không kèm tên bảng → subquery đếm phải viết `${groups}.id`.
- **`inbox.searchContacts`**: nhận tập trang chưa gỡ từ bên gọi (không đọc `pages`), xếp khớp tên trước khớp chỉ theo SĐT, rồi hoạt động gần nhất; `pageIds` trong tập. `q` của `listContacts` chuyển sang `textMatch` (tên, thẻ) + `phoneMatch`, không gần đúng — gỡ mục hoãn của 4.9.
- **Log**: thêm `q` vào `SECRET_QUERY_PARAMS` để URL `/search?q=`, `/contacts?q=` log ra `q=REDACTED` (trước đây `/contacts?q=` lộ SĐT/tên vào log request).
- **Web**: `CommandPalette.tsx` (hộp thoại riêng, không thêm `cmdk`), ô tìm giả ở thanh trên thành nút mở bảng lệnh, nhãn `⌘K`/`Ctrl K` theo hệ điều hành; phím tắt bắt ở pha capture trên `window`. "Đổi phạm vi" mở `ScopeSwitcher` (state `open` nhấc lên `Topbar`). `page`/`group`/`contact` làm cũ `['search']`.
- **Kết quả** `npm run check`: server 1044 test, web 208 test, depcruise sạch. Chưa kiểm UI bằng trình duyệt (ghi ở `deferred-work.md`).

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|---|---|---|
| Lỗi 500 khi truy vấn tìm hỏng (hết giờ, mất kết nối): error handler log nguyên `DrizzleQueryError` — `message`, `stack`, `params` chứa tham số truy vấn (`%từ khoá%`, chữ số SĐT) → từ khoá tìm vẫn vào log. Sửa: `loggableError` (`platform/log`) thay bằng lỗi chỉ còn câu SQL (`$n`) + lỗi gốc, dùng ở `setErrorHandler`. Test ở `log.test.ts`. | real (medium) | patch |
| Mẫu nginx (`deploy/nginx.conf.example`, `nginx-api.conf.example`) ghi access log nguyên request line → `/api/v1/search?q=…`, `/api/v1/contacts?q=…` lộ SĐT / tên khách trên máy chủ dù api đã thay `q=REDACTED`. Sửa: location `^/api/v1/(search|contacts)$` tắt access log, `error_log crit` (như `/oauth`, `/webhooks`), đặt trước location `/api`. | real (medium) | patch |
