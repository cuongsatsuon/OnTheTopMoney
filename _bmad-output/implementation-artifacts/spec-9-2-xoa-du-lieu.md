---
title: 'Story 9.2 — Xoá khách và dữ liệu theo yêu cầu'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '5b02331f5d30e63e74dee558f7ff76dbd407135a'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 9.2, AD-22, AD-1, AD-3, AD-24; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** 9.1 chỉ ghi `deletion_requests` + phát `privacy.purge_requested`, chưa module nào xoá, nên yêu cầu của Meta nằm mãi ở "đang chờ". Chủ shop cũng chưa xoá được một khách và hội thoại của họ, trang gỡ quá 30 ngày vẫn giữ dữ liệu khách. Ngoài ra còn ba việc hoãn: `signed_request` cũ phát lại được, không ai xoá `meta_accounts`, file Cloudinary của đính kèm không bị dọn.

**Approach:** Thêm đường xoá hai giai đoạn do `privacy` điều phối. Giai đoạn 1: `privacy.purge_requested` → mỗi module phụ thuộc tự xoá phần của mình, rồi phát `purge_part_completed`. Khi đủ phần, `privacy` phát sự kiện mới `privacy.purge_final_requested` → `inbox` xoá sau cùng → `privacy` đóng yêu cầu (`purge_completed`). Nguồn yêu cầu:
- nút "Xoá khách" ở Khách hàng (`scope=contact`);
- cron trang gỡ quá 30 ngày (`scope=page`);
- callback Meta của 9.1 (`scope=all`, thu hẹp về trang của đúng tài khoản Meta đó).

## Boundaries & Constraints

**Always:**
- **Phần tham gia** (khai một lần ở `packages/shared/privacy.ts`, `inbox` luôn là phần cuối):
  - `contact`: `autoreply`, `webhooks`, `ai`.
  - `page`: thêm `content`.
  - `all`: thêm `content` và `connections`.
- **Mỗi module chỉ xoá bảng của mình** (AD-1), trong consumer riêng `<module>.purge`:
  - `autoreply`: `autoreply_runs` theo `conversationIds` (contact) / `pageIds`.
  - `webhooks`: `webhook_events` có payload chứa id nền tảng của khách (id người dùng của định danh, `thread_key`, id tin — lấy qua `inbox`, vì `inbox` chưa xoá) / mọi sự kiện của `pageIds` (theo `page_id` hoặc `platform_page_id`).
  - `ai`: đặt `ai_usage.ref = null` (giữ chi phí cho hạn mức) theo `contactId` + `conversationIds` / `pageIds`.
  - `content`: xoá `post_targets` của `pageIds` (`post_target_media`, `post_metrics` đi theo khoá ngoại), bài không còn đích, ảnh vừa thành không gắn bài (dòng + file công khai).
  - `connections`: xoá dòng `meta_accounts` của yêu cầu (tên, user token; khoá ngoại tự `set null`).
  - `inbox` (cuối): tin trong các hội thoại + tin khách viết ở hội thoại khác, `message_attachments` + file riêng tư (`PrivateFileStore.delete` TRƯỚC khi xoá dòng, trong cùng transaction, dòng đính kèm khoá `FOR UPDATE`), hội thoại, định danh, khách (gợi ý gộp đi theo cascade). Với `page|all`: khách chỉ bị xoá khi không còn định danh nào.
- **Xoá theo lô**, mỗi lô một transaction. Handler idempotent: chạy lại (retry, worker chết, cron resume) thì xoá tiếp phần còn lại rồi phát lại phần đã xong; `privacy` bỏ qua phần trùng. Lỗi kho tạm thời (`TRANSIENT|RATE_LIMITED|AUTH_FAILED`) ném lỗi để retry. Kho chưa cấu hình / ref hỏng thì vẫn xoá dòng, log cảnh báo kèm số lượng.
- **Hàng đợi** (khai ở `queues.ts`): `<module>.purge` ×6 và `events.privacy`, mỗi queue standard, retry 5 backoff, concurrency 1, `critical` (hết retry → thông báo `system_error`). Thêm hai cron:
  - `privacy.purge_resume` (mỗi giờ): phát lại giai đoạn đang dở của yêu cầu mở quá 1 giờ chưa tiến triển;
  - `privacy.removed_pages` (02:30 giờ VN): tạo `scope=page` cho trang có `removed_at` quá 30 ngày mà chưa có yêu cầu nào sau `removed_at`.
- **Trạng thái:** `pending` → `processing` (phần đầu tiên về) → `completed`. Bảng `deletion_request_parts` ghi từng phần đã xong. Trang `/privacy/status/<code>` hiện phạm vi (không tên khách) và "đã xong n/m phần".
- **`scope=all` (an toàn, hẹp):** lúc nhận callback, ảnh chụp `page_ids` = Fanpage có `page_credentials.meta_account_id` của tài khoản + IG dùng chung token của chúng, kèm `meta_account_id`. Trang Threads và trang của tài khoản Meta khác không bị đụng. Không xoá cứng dòng `pages`, không xoá token trang. Yêu cầu cũ của 9.1 thiếu ảnh chụp thì không được phát lại (cron bỏ qua + log cảnh báo).
- **Chống phát lại:** lưu `meta_issued_at` (`issued_at` của `signed_request`). Có yêu cầu trước của cùng người dùng với `meta_issued_at` ≥ `issued_at` mới (hoặc mới thiếu `issued_at`) → trả lại mã cũ, KHÔNG ngắt trang, không tạo yêu cầu, không sự kiện.
- **Xoá khách tay:** `POST /api/v1/contacts/:id/deletion` body `{confirm: true}` (dưới phiên, kiểm Origin). Một transaction gồm:
  - `inbox` đánh dấu `contacts.deletion_requested_at` (ẩn khỏi danh sách, chi tiết, facets, ⌘K) và trả `conversationIds`;
  - `privacy` ghi yêu cầu `scope=contact source=manual` + phát `purge_requested`.
  Còn yêu cầu mở / đã xong cho khách đó → trả lại đúng yêu cầu ấy (200). Tạo mới → 202 `{requestId, code, status, statusUrl}`. Khách không có → 404. Web: nút "Xoá khách" ở ngăn hồ sơ → hộp xác nhận có ô "Tôi hiểu…" bắt buộc → hiện link trang trạng thái.
- Log chỉ mang `requestId`, module, số đếm. Sau khi xoá xong khách, `inbox` phát `contact.deleted` (realtime) để web làm cũ.

**Never:**
- Không query bảng của module khác, `privacy` không gọi module ngoài nền. Không đưa id nền tảng / PII vào payload job.
- Không xoá cứng `pages`, `knowledge_items`, `brand_profiles`, số liệu trang (`page_daily_metrics`, `metric_sync_states`), dòng `ai_usage`. Không xoá dữ liệu Threads khi gỡ app Facebook.
- Không làm retention theo hạn (9.3), dọn file mồ côi theo prefix, callback Threads, huỷ `subscribed_apps`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Xoá khách | khách có DM + bình luận trên 2 trang, đính kèm đã lưu, run AI, `ai_usage`, webhook thô; khách khác cùng trang | 202; chạy hết pipeline → không còn dòng nào chứa PII của khách ở mọi bảng epic-9 liệt kê, file riêng tư đã xoá, `ai_usage` còn nhưng `ref` null; dữ liệu khách khác giữ nguyên; trạng thái `completed` | |
| Ẩn ngay | ngay sau 202, trước khi worker chạy | khách không có trong danh sách / chi tiết 404 / facets / ⌘K | |
| Gọi lại | POST lần 2 khi đang mở / sau khi xong | 200 cùng `code` | |
| Thiếu xác nhận | body thiếu `confirm:true` / không phiên / khách lạ | 400 / 401 / 404, không ghi gì | |
| Worker chết giữa lô | kho lỗi tạm ở file thứ 2 (lô 1 tin) | handler ném; lần chạy lại xoá tiếp, không còn file / dòng mồ côi | retry |
| Thứ tự | `inbox` chỉ chạy sau khi đủ phần giai đoạn 1 | `purge_final_requested` phát đúng một lần | |
| Trang gỡ quá 30 ngày | trang A gỡ 31 ngày, B gỡ 10 ngày, C đang dùng | cron tạo đúng 1 yêu cầu `page` cho A; dữ liệu khách/hội thoại/bài của A hết, khách có định danh ở C còn (mất định danh A); chạy cron lần 2 không tạo thêm | |
| Meta `scope=all` | deauthorize chủ shop (FB+IG), có Threads + FB tài khoản khác | dữ liệu FB+IG hết, `meta_accounts` của chủ shop xoá; Threads, FB2, `meta_accounts` khác giữ; trang trạng thái "Đã xoá xong" | |
| Phát lại `signed_request` | gửi lại đúng signed_request sau khi xong + đã kết nối lại cùng tài khoản | cùng mã, không ngắt trang, không yêu cầu mới; `issued_at` mới hơn → yêu cầu mới | |
| Yêu cầu 9.1 thiếu ảnh chụp | `scope=all`, `page_ids` null | cron resume bỏ qua + log cảnh báo | |
| Trang trạng thái | yêu cầu `processing` | "Đang xoá dữ liệu", "đã xong n/m phần", phạm vi; không tên khách | |
| Log | toàn bộ pipeline | không chứa tên, SĐT, nội dung, id nền tảng | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{privacy,events,enums,contacts}.ts` -- phần tham gia, sự kiện mới, nguồn `page_removed`, DTO xoá khách.
- `server/src/modules/privacy/` -- `schema.ts` (cột mới + `deletion_request_parts`), `requests.ts` (chống phát lại, ảnh chụp, yêu cầu khách/trang), `coordinator.ts` (đóng phần, giai đoạn cuối, resume, cron trang gỡ).
- `server/src/modules/{autoreply,webhooks,ai,content,connections,inbox}/purge.ts` + `index.ts` -- consumer xoá phần của mỗi module.
- `server/src/modules/inbox/{schema,contacts}.ts` -- `deletion_requested_at`, lọc khách đang xoá.
- `server/src/modules/connections/deauthorize.ts` -- `metaUserPurgeScope` (ảnh chụp trang + tài khoản).
- `server/src/modules/pages/service.ts` -- `listRemovedBefore`.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- queue + handler.
- `server/src/app/privacy.ts`, `privacy-pages.ts` -- route xoá khách, chống phát lại, trang trạng thái có tiến độ.
- `web/src/lib/contacts.ts`, `web/src/screens/Contacts.tsx` -- hộp xác nhận xoá khách.
- `server/src/platform/events/index.ts` -- `envelopePayload` (kiểm payload theo tên sự kiện, sai dạng → bỏ qua).
- `server/test/{privacy-purge,privacy,notifications}.test.ts` -- test mới + sửa test 9.1 (`issued_at` mới hơn) và danh sách handler worker.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/*` -- `PURGE_MODULES`, `PURGE_FINAL_MODULE`, `privacy.purge_final_requested`, `contact.deleted`, `pageIds`/`metaAccountId` trong payload, `ContactDeletionBody/Response` -- hợp đồng chung.
- [x] `server/src/modules/privacy/*` + migration -- bảng/cột, ghi yêu cầu, điều phối, resume, cron trang gỡ -- AD-22.
- [x] `server/src/modules/*/purge.ts` -- sáu consumer xoá theo lô, idempotent -- AD-1.
- [x] `server/src/modules/inbox/contacts.ts` -- ẩn khách đang xoá -- UX ngay.
- [x] `server/src/app/privacy.ts`, `privacy-pages.ts`, `worker/main.ts`, `queues.ts` -- nối route / handler / queue.
- [x] `server/test/privacy-purge.test.ts` (+ sửa `privacy.test.ts`, `queues.test.ts` nếu cần) -- phủ mọi dòng I/O matrix trên Postgres thật, Cloudinary giả.
- [x] `web/src/lib/contacts.ts` (+ test), `web/src/screens/Contacts.tsx` -- nút + hộp xác nhận + link trạng thái.
- [x] `deferred-work.md` -- đóng ba mục 9.2, thêm mục còn lại.

**Acceptance Criteria:**
- Given `npm run check`, when chạy ở gốc, then typecheck, lint, depcruise (AD-1) và mọi test xanh.
- Given chủ shop xoá khách ở web, when worker chạy, then khách biến mất khỏi Khách hàng / Hộp thư và trang trạng thái hiện "Đã xoá xong".

## Implementation Notes

- **Hai giai đoạn:** `privacy.purge_requested` → `<module>.purge` (autoreply, webhooks, ai, content, connections; module không thuộc `PURGE_MODULES[scope]` nhận job nhưng bỏ qua) → `events.privacy` ghi `deletion_request_parts`. Đủ phần thì phát sự kiện mới `privacy.purge_final_requested` (một lần, `final_requested_at`) → `inbox.purge` → `completed` + `purge_completed`. Payload chỉ mang id nội bộ: `conversationIds` / `pageIds` / `metaAccountId`, chụp vào `deletion_requests` lúc ghi để phát lại xoá đúng tập cũ.
- **Phạm vi `all` (hẹp):** chỉ Fanpage có `meta_account_id` của tài khoản + IG dùng chung token. Threads và tài khoản Meta khác không bị đụng. `connections` xoá dòng `meta_accounts` (đóng việc hoãn b). Token trang và dòng `pages` giữ nguyên; data-deletion không ngắt trang (như 9.1). Đã ghi vào hoãn.
- **Chống phát lại (việc hoãn a):** lưu `meta_issued_at` (giữ mốc lớn nhất đã thấy). Khi yêu cầu gần nhất đã `completed`, một `signed_request` có `issued_at` ≤ mốc (hoặc thiếu `issued_at`) → trả mã cũ TRƯỚC khi ngắt trang, không tạo yêu cầu. Không chặn khi yêu cầu còn mở: deauthorize lặp lại vô hại, giữ hành vi 9.1. Chọn cách "nhớ mốc" thay cho ngưỡng tuổi vì Meta không công bố cửa sổ retry.
- **Cloudinary (việc hoãn c):**
  - `inbox` xoá file riêng tư trước khi xoá dòng, trong cùng transaction lô. Dòng đính kèm khoá `FOR UPDATE` nên job tải đính kèm đang chạy phải chờ rồi tự bỏ file. Lỗi kho tạm thời → rollback + retry.
  - `content` xoá ảnh bài vừa thành không gắn (dòng rồi file, như `media_gc`); worker chết giữa chừng thì `media_gc` dọn nốt.
- **Xoá theo lô / resume:** mỗi lô một transaction, handler idempotent. Queue `critical`, retry 5. Cron `privacy.purge_resume` (mỗi giờ) phát lại yêu cầu mở quá 1 giờ không tiến triển, bỏ qua yêu cầu `all` của 9.1 thiếu `page_ids` (log cảnh báo). Cron `privacy.removed_pages` (02:30 VN) tạo `scope=page` cho trang gỡ quá 30 ngày; trang chính sách mục 5 giờ đã đúng về điểm này.
- **Xoá khách:**
  - `contacts.deletion_requested_at` ẩn khách ngay khỏi danh sách / chi tiết / facets / ⌘K / gộp.
  - `inbox` xoá cả tin khách viết trong luồng bình luận của người khác (`sender_identity_id` là `set null` nên phải xoá chủ động).
  - Khách còn định danh ở trang khác thì giữ ở `scope=page|all`.
  - Web: nút "Xoá khách" ở ngăn hồ sơ → hộp xác nhận có ô "Tôi hiểu…" → hộp "Đã nhận" với link trạng thái. `contact.deleted` (realtime) làm cũ cache.
- **Không làm (hẹp):** không xoá cứng `pages`, số liệu trang, hồ sơ / kho kiến thức, dòng `ai_usage` (chỉ `ref = null`).
- Migration `server/drizzle/0040_conscious_clea.sql`. `npm run check` xanh: server 77 file / 1527 test, web 25 file / 353 test. Thêm hoãn: kiểm UI bằng trình duyệt, token / ngắt trang khi `all`, yêu cầu 9.1 thiếu ảnh chụp, cửa sổ đua nhỏ khi xoá khách, realtime cho `page|all`.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: một migration (cột `deletion_requests`, bảng `deletion_request_parts`, `contacts.deletion_requested_at`).
- `npm run check` -- expected: exit 0.

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Trang gỡ quá 30 ngày được kết nối lại trong lúc yêu cầu `scope=page` (`source=page_removed`) chưa xong (pipeline kẹt, cron resume phát lại hằng giờ) → `inbox` vẫn xoá hết khách / hội thoại / tin của trang đang dùng, kể cả tin mới sau khi kết nối lại; cron cũng có thể ghi yêu cầu cho trang vừa kết nối lại giữa lúc liệt kê và lúc ghi | medium — xoá nhiều hơn yêu cầu, không hoàn tác | patch: `privacy/coordinator.ts` — trước khi phát giai đoạn cuối và khi resume, yêu cầu `page_removed` mà `pages.getPage` thấy trang chưa gỡ → đóng yêu cầu (`completed`, không phát `purge_completed`), resume đếm `closedReconnected`; `sweepRemovedPages` kiểm lại trong transaction trước khi ghi. Test mới ở `privacy-purge.test.ts` |
| Xoá khách là tác giả bình luận gốc → cả hội thoại bình luận bị xoá (khoá ngoại `conversations.contact_identity_id` NOT NULL cascade), gồm trả lời của khách KHÁC trong luồng đó; `webhooks` khớp `thread_key` (id bình luận gốc) nên cũng xoá payload thô các trả lời ấy | medium — xoá thêm dữ liệu của khách khác, nhưng đúng theo phạm vi spec ("tin trong các hội thoại của khách") và cần quyết định sản phẩm (chuyển hội thoại cho người trả lời khác / giữ tin vô danh) | defer |
| `webhook_events` của khách tới SAU khi phần `webhooks` (giai đoạn 1) chạy mà trước giai đoạn cuối (khách đang chờ xoá vẫn nhắn; pipeline kẹt thì cửa sổ kéo dài) không bao giờ bị xoá — resume chỉ phát lại giai đoạn cuối | low–medium — PII thô còn lại tới khi có retention 30 ngày của 9.3 | defer |
| `scope=all` từ callback "xin xoá dữ liệu" (không gỡ app): `connections` xoá `meta_accounts` nhưng trang vẫn chạy → `page_credentials.meta_account_id = null`; callback deauthorize / xoá dữ liệu sau đó của cùng người không còn khớp trang nào (người lạ, `matched=false`) → không ngắt trang, không xoá dữ liệu mới | low–medium — xoá ít hơn ở yêu cầu sau | defer (gộp với việc hoãn "token / ngắt trang khi `all`") |
| Đã rà, không phải lỗi: phạm vi `all` chỉ Fanpage có `meta_account_id` + IG `token_source_page_id`, không Threads / tài khoản khác; mọi `where` của consumer có điều kiện (mảng rỗng → bỏ vòng, không `where(undefined)`); bài chỉ xoá khi hết đích, ảnh chỉ xoá khi không còn gắn; khách `page|all` chỉ xoá khi hết định danh; gộp khách chặn khi một bên đang chờ xoá (khoá dòng); giai đoạn cuối một lần (`final_requested_at` dưới `FOR UPDATE`), phần trùng bỏ qua; mỗi lô một transaction, chạy lại xoá tiếp; file riêng tư xoá trong transaction lô (kho lỗi tạm → rollback, xoá idempotent `not found` = ok); mốc `issued_at` đơn điệu nên so với yêu cầu gần nhất là đủ; `confirm: z.literal(true)`; log chỉ id + số đếm, lỗi drizzle đã che `params` | reject | — |
