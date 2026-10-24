# Epic 9 Context: Sẵn sàng go-live và quyền riêng tư

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Đưa app đủ điều kiện để Meta chuyển sang Live mode và nhận tin của khách thật: có trang chính sách quyền riêng tư công khai, callback gỡ app / xoá dữ liệu của Meta, đường xoá dữ liệu khách theo yêu cầu (một khách, một trang, hoặc toàn bộ) do module `privacy` điều phối, cron dọn dữ liệu cá nhân hết hạn, hồ sơ App Review để chủ shop tự nộp, và một lần diễn tập khôi phục từ bản sao lưu. Epic không thêm màn nghiệp vụ mới; phần web chỉ là liên kết tới trang chính sách và (9.2) hành động xoá khách ở Khách hàng.

## Stories

- Story 9.1: Trang chính sách và callback xoá dữ liệu của Meta
- Story 9.2: Xoá khách và dữ liệu theo yêu cầu
- Story 9.3: Dọn dữ liệu theo thời hạn
- Story 9.4: Hồ sơ App Review và chuyển Live
- Story 9.5: Diễn tập khôi phục backup

## Requirements & Constraints

- Live mode cần: Privacy Policy URL, Data Deletion callback, icon, mô tả dùng dữ liệu, Advanced Access qua App Review (Messenger, Instagram qua Facebook Login for Business, Page, Threads), Business Verification; phía OpenAI có thể cần Organization Verification cho model ảnh. Danh sách quyền chốt lúc nộp, đối chiếu tài liệu Meta khi đó.
- Trang chính sách phải nêu: dữ liệu thu thập, việc gửi nội dung tin nhắn sang OpenAI (`store: false`), thời hạn lưu, cách yêu cầu xoá.
- Callback Meta xác minh `signed_request` (HMAC-SHA256 với app secret, so sánh constant-time); sai chữ ký → 400, không ghi gì. Data-deletion trả `{url, confirmation_code}`, `url` trỏ trang trạng thái công khai `/privacy/status/<code>`.
- Bí mật (token, khoá OpenAI, app secret) không bao giờ trả về client hay ghi log; log không mang PII (nội dung tin, tên, SĐT, id người dùng nền tảng).
- Retention [ASSUMPTION các mốc]: payload thô `webhook_events` 30 ngày (sau đó giữ metadata); archive pg-boss 7 ngày; `autoreply_runs` 90 ngày; session hết hạn xoá ngay; tin nhắn + khách giữ tới khi chủ shop xoá hoặc trang bị gỡ quá 30 ngày.
- Không có backup tự động: RPO = lần `pg_dump` tay gần nhất (runbook mục 4). Story 9.5 viết theo "bản `pg_dump` mới nhất", không phải "bản backup đêm qua"; xoá dữ liệu có hiệu lực ngay trên DB, file dump tay chủ shop tự giữ thì tự xoá/hết hạn [ASSUMPTION].
- Khôi phục phải giải mã được token và khoá OpenAI bằng `APP_ENCRYPTION_KEYS` cất riêng; ghi thời gian khôi phục vào runbook.

## Technical Decisions

- **Module `privacy` (AD-1, AD-22):**
  - Sở hữu `deletion_requests(code, scope, target_id, status, requested_at, completed_at)` và là điều phối duy nhất của mọi lượt xoá. Chỉ được gọi module nền (`pages`, `settings`); chỉ entrypoint gọi nó, module khác báo cho nó qua sự kiện. `privacy` chưa có thư mục nhưng đã nằm trong `server/dependency-rules.cjs` (`arrows.privacy = []`) và KHÔNG thuộc `metaCallers` → không import `adapters/meta`.
  - Việc cần module khác (vd ngắt trang ở `connections`) do entrypoint `app/` ghép, trong cùng transaction.
- **Luồng xoá (AD-22, AD-3):**
  - `privacy` phát `privacy.purge_requested{id=requestId, scope: page|contact|all, targetId, conversationIds?}` trong cùng transaction với dòng `deletion_requests`.
  - Mỗi module tham gia cố định (`inbox`, `autoreply`, `webhooks`, `ai`, `content` khi `scope=page|all`) tự xoá phần của mình rồi phát `privacy.purge_part_completed{module}`. `inbox` xoá sau cùng (payload đã mang `conversationIds` cho module khác). `privacy` đóng yêu cầu (`purge_completed`) khi đủ phần.
  - `deauthorize` = ngắt mọi trang + yêu cầu `scope=all`. "Xoá khách và toàn bộ hội thoại" ở Khách hàng dùng cùng đường.
  - Ngoài luồng này không xoá cứng dữ liệu nghiệp vụ; gỡ trang vẫn là soft-delete `removed_at` (AD-23).
- **Bề mặt công khai (AD-19):** `/privacy/*` công khai, ngoài `/api/v1`: không guard phiên, không CORS, không nằm trong rate-limit ghi mặc định (chỉ áp `/api/v1`) → route tự khai rate-limit. nginx (cả hai mẫu) đã chuyển `/privacy` → api. Host api ở chế độ tách đặt CSP `default-src 'none'` → trang HTML ở `/privacy/*` cần ngoại lệ CSP.
- **Hàng đợi (AD-24):** `privacy.*` standard, retry 3, concurrency 2, chống trùng bằng trạng thái bản ghi. Consumer sự kiện `events.privacy` (retry 5, concurrency 5, handler idempotent). Cron `privacy.retention` hằng ngày, `tz: 'Asia/Ho_Chi_Minh'`. Khai báo duy nhất ở `platform/jobs/queues.ts`. Job `privacy.*` hết retry → `job.failed` → `notifications` tạo thông báo.

### Đã có, phải dùng lại

- **Hợp đồng chung:** `packages/shared/events.ts` đã khai `privacy.purge_requested` (`scope`, `targetId` nullable, `conversationIds?`), `privacy.purge_part_completed` (`module`), `privacy.purge_completed` — đều `realtime=false`. `enums.ts` có `DeletionScope` (`page|contact|all`) và `DeletionStatus` (`pending|processing|completed`).
- **Bảng có dữ liệu cá nhân theo module (mỗi module tự xoá phần của mình):**
  - `inbox`: `contacts` (tên, SĐT, ghi chú, thẻ, tóm tắt AI), `contact_identities` (id/tên/username nền tảng), `conversations`, `messages` (nội dung), `message_attachments` (ref file riêng tư), `contact_merge_suggestions`.
  - `webhooks`: `webhook_events.payload` (mục webhook thô, chứa nội dung tin của khách).
  - `autoreply`: `autoreply_runs` (theo `conversation_id`, không FK).
  - `ai`: `ai_usage.ref` (tham chiếu của caller; không chứa prompt/nội dung).
  - `content`: `media_assets` (`prompt`, `public_id`), `posts` / `post_targets`; `analytics`: `post_metrics`, `page_daily_metrics`, `metric_sync_states` (số liệu, gắn trang).
  - `profiles`: `knowledge_items` (FAQ, văn bản trích từ file, ref file riêng tư). `connections`: `meta_accounts` (`fb_user_id`, tên, user token), `page_credentials`. `notifications`: tiêu đề/nội dung cố định, không tên khách.
- **File Cloudinary:** `adapters/media` có `MediaStore` (ảnh công khai, `delete(publicId)`) và `PrivateFileStore` (file `authenticated`, `delete(ref)`).
  - Xoá cascade `message_attachments` KHÔNG xoá file trên Cloudinary → luồng xoá (9.2) phải gọi `PrivateFileStore.delete` theo ref.
  - Dọn file mồ côi (liệt kê theo prefix, so với DB, kể cả sau khi khôi phục backup) còn hoãn; cron `content.media_gc` hiện chỉ dọn theo DB.
- **Meta:** mẫu verify chữ ký constant-time `verifyWebhookSignature` ở `adapters/meta/client.ts`. `connections.markDisconnectedTx` (ngắt trang + mọi IG dùng chung token, phát `page.disconnected`) và `meta_accounts.fb_user_id` (id theo app — cùng loại id trong `signed_request.user_id`).
- **Web:** `apiUrl()` ở `web/src/lib/api.ts` dựng URL theo `API_ORIGIN` — dùng cho mọi liên kết `/privacy/*` (chế độ tách: `/privacy/*` nằm trên host api, không phải host web Hostinger).
- **Deploy:** `deploy/runbook.md` (mục 4 sao lưu/khôi phục tay, mục 6 Meta Test App, mục 8 chế độ tách), `deploy/env.production.example`, hai mẫu nginx. Chưa có `deploy/app-review.md`.
- **Việc hoãn gắn Epic 9:**
  - Dùng `apiUrl()` cho link `/privacy/*` khi có màn quyền riêng tư (từ 1.3c / 4.3).
  - GC/retention `webhook_events` (payload PII, tăng vô hạn) → 9.3.
  - Dọn file đính kèm Cloudinary khi xoá khách/hội thoại (và khi transaction ghi `stored` lỗi) → 9.2.
  - Dọn file mồ côi Cloudinary, kể cả sau khi khôi phục backup → 9.3/9.5.
  - Gỡ trang thì huỷ đăng ký `DELETE /{page}/subscribed_apps` ở Meta (liên quan `scope=page`).
  - Xác nhận bằng sự kiện Meta thật: dạng payload Threads `replies`, echo IG, secret ký webhook Threads → 9.4.
  - Công cụ xoay khoá `crypto.reencrypt` (đếm bản ghi theo keyId) — liên quan khôi phục 9.5.
  - `metric_sync_states` chưa có trong bảng sở hữu của spine.

## UX & Interaction Patterns

- `/privacy/*` là trang công khai ngoài IA của app [ASSUMPTION], tiếng Việt, đọc được không cần đăng nhập.
- "Xoá khách và toàn bộ hội thoại" ở Khách hàng [ASSUMPTION — EXPERIENCE chưa mô tả]: hành động phá huỷ → phải xác nhận; microcopy theo Voice and Tone; lỗi qua bản đồ `ErrorCode`.
- Cài đặt › Webhook › nhật ký sự kiện chỉ còn payload thô trong 30 ngày sau 9.3.

## Cross-Story Dependencies

- 9.1 dựng module `privacy`, bảng `deletion_requests`, trang công khai, phát `privacy.purge_requested`; 9.2 thêm consumer xoá ở từng module + đóng yêu cầu, rồi trang `/privacy/status/<code>` mới đi tới "đã xong".
- 9.3 dùng cron `privacy.retention` (không qua `purge_requested`); xong 9.3 thì nội dung "thời hạn lưu" của trang chính sách mới đúng với hệ thống.
- 9.4 cần URL chính sách và URL callback của 9.1, cùng việc xác nhận webhook ba nguồn với app Live.
- 9.5 dựa vào runbook sao lưu tay (mục 4) và `APP_ENCRYPTION_KEYS` cất riêng.
