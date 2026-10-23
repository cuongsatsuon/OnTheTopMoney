# Epic 6 Context: Soạn bài AI và Lịch nội dung

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Chủ shop viết một ý tưởng và đăng lên nhiều trang (Fanpage, Instagram Business, Threads) cùng lúc. Mỗi trang có caption riêng do AI viết theo hồ sơ thương hiệu hiệu lực của trang đó, kèm ảnh AI hoặc ảnh tự tải lên. Chủ shop đăng ngay hoặc lên lịch, xem và kéo thả bài trên Lịch nội dung. Một trang lỗi không chặn các trang khác và có "Đăng lại". Epic này dựng `content` (bài, đích từng trang, ảnh bài) và luồng đăng thật qua Meta. Epic 7 (chiến dịch) và Epic 8 (số liệu bài) dùng lại nền này.

## Stories

- Story 6.1: Soạn bài nháp cho nhiều trang
- Story 6.2: Viết caption bằng AI theo hồ sơ từng trang
- Story 6.3: Sinh ảnh AI
- Story 6.4: Lên lịch và đăng bài theo từng trang
- Story 6.5: Lịch nội dung với kéo thả

## Requirements & Constraints

- Đích là một nhóm hoặc vài trang. Mỗi trang là một `post_target` có trạng thái riêng. Caption và ảnh có thể khác nhau giữa các trang.
- Bảng ràng buộc nền tảng nằm ở `packages/shared`, FE và server dùng chung:
  - Instagram cần ít nhất 1 ảnh, caption tối đa 2.200 ký tự, tối đa 30 hashtag.
  - Threads tối đa 500 ký tự.
  - FE báo lỗi ngay trên tab của trang. Server từ chối với `CAPTION_TOO_LONG` / `MEDIA_REQUIRED` / `TOO_MANY_HASHTAGS` khi lên lịch.
- Ảnh tải lên được kiểm magic bytes (chỉ jpeg/png/webp, không SVG), có giới hạn kích thước, bỏ EXIF. Ảnh lưu ở kho công khai để Meta tải được. Ảnh dùng cho IG chuẩn hoá thành JPEG sRGB.
- Ảnh bị OpenAI từ chối hoặc lỗi: ô ảnh hiện "Không tạo được ảnh này" + "Thử mô tả khác" (`IMAGE_REJECTED`/`IMAGE_FAILED`), caption giữ nguyên.
- Ảnh không gắn vào bài nào quá 7 ngày [ASSUMPTION] bị cron dọn. Ảnh của bài đã đăng không bị dọn.
- Hết hạn mức (100%) hoặc khoá OpenAI lỗi: nút AI khoá theo mã lỗi, vẫn soạn tay được. Trang `CONFIG_MISSING` thì tab đó báo cần hồ sơ thương hiệu, các trang khác vẫn được viết.
- Lên lịch theo giờ VN. Kiểm giới hạn đăng/24h của nền tảng (`PUBLISH_LIMIT_REACHED`). Trang không `active` lúc tới giờ đăng → `failed` `PAGE_DISCONNECTED`.
- Bài đã `publishing`/`published`/`cancelled` không kéo thả được. Bài AI có nhãn chữ "AI tạo".

## Technical Decisions

- **Sở hữu (AD-1):** `content` sở hữu `posts`, `post_targets`, `media_assets`. Hướng gọi: `content → profiles | ai | connections` (+ nền `pages`, `settings`). `content` được import `adapters/meta` và `adapters/media`. `campaigns` (Epic 7) gọi `content`, không theo chiều ngược lại.
- **Một cửa tạo (AD-13):**
  - Chỉ `content.createPost({source: manual|campaign, campaignId?, topic?, targets[]})` tạo bài.
  - Bài thủ công: 1 post : n target. Slot chiến dịch: 1 post : 1 target, có `slot_at` bất biến và khoá duy nhất `(campaign_id, page_id, slot_at)`.
- **Chuyển trạng thái (AD-13):**
  - Mọi đổi trạng thái đi qua `content.transitionTarget(targetId, action, expectedVersion)`, khoá lạc quan bằng `post_targets.version`. `PostTargetStatus` = `planned|draft|pending_approval|scheduled|publishing|published|failed|cancelled`.
  - Mọi chuyển tới `scheduled` gọi `content.assertPublishable`.
  - `schedule_version` tăng mỗi lần đổi `scheduled_at` hoặc vào/rời `scheduled`.
  - Huỷ → `cancelled` + `cancel_reason`.
- **Đăng (AD-13, AD-24):**
  - Job `publish.target`: queue `standard`, retry 5 (không tính `RATE_LIMITED`), concurrency 3. `startAfter=scheduled_at`, data `{targetId, scheduleVersion}`.
  - Job bỏ qua im lặng khi version lệch hoặc `held`. Chiếm `scheduled → publishing` bằng `UPDATE … WHERE status='scheduled' AND schedule_version=?`.
  - Lỗi retry được → trả về `scheduled` rồi ném lỗi. Lỗi cuối → `failed` + `error_code`, phát `post_target.failed` đúng một lần.
  - Ánh xạ lỗi adapter: `REJECTED` → `PUBLISH_REJECTED`; `TRANSIENT` hết retry → `PUBLISH_FAILED`; `PERMISSION_DENIED` / `RATE_LIMITED` / `TOKEN_INVALID` → `PAGE_DISCONNECTED`.
  - Cron `content.requeue` 15 phút: enqueue lại target `scheduled` quá 10 phút mà không có job. Target `publishing` quá 15 phút → `PUBLISH_UNKNOWN`, không tự đăng lại.
  - Cách đăng: FB qua feed/photos. IG và Threads tạo container, chờ `status_code=FINISHED` rồi publish. Lưu `PublishedRef` đã chuẩn hoá.
- **Media (AD-14):**
  - `media_assets` chỉ chứa ảnh bài, không chứa logo hay đính kèm của khách. `ai` không chạm `media_assets`.
  - Sinh ảnh là job `content.image.generate` (standard, retry 2, concurrency 2): `ai.generateImage()` (`feature=image_generate`, `output_format: jpeg`) → `MediaStore.put()` → chèn `media_assets` → phát `media_asset.created`.
  - Cron `content.media_gc` hằng ngày, tz `Asia/Ho_Chi_Minh`.
- **AI tương tác (AD-2, AD-7, AD-21):**
  - "Tạo bằng AI" chạy trong request api, trả JSON một lần. Nút Dừng huỷ request, server truyền `AbortSignal` sang OpenAI.
  - Gọi gateway với `feature=compose_caption` cho từng trang, dùng hồ sơ hiệu lực và mẫu prompt chung ở `ai/prompts`.
  - Caption qua `ai.checkOutput`; vi phạm thì sinh lại một lần, còn vi phạm thì trả danh sách cụm vi phạm để FE đánh dấu.
- **Hợp đồng (AD-18):** REST `/api/v1`, zod ở shared. Lịch nhận `scope=` giải bằng `pages.resolveScope`. Bài thuộc phạm vi khi tập trang của nó giao tập phạm vi. Thời gian lưu `timestamptz` UTC, FE tự định dạng.

### Đã có, phải dùng lại

- **Kho media (spec media-cloudinary, AD-14):**
  - `adapters/media`: `MediaStore` công khai `put({data, mime, asJpeg, stripMetadata})` → `{publicId, url, width, height, bytes, format}`, và `delete`. `PrivateFileStore` cho file riêng tư. Lỗi đã phân loại.
  - `fake.ts` = Cloudinary giả cho test. `app/media-errors.ts` (`mediaAppError`) ánh xạ lỗi kho → `AppError`.
  - Mẫu route tải bytes thô (không base64): `app/knowledge-items.ts`.
  - `profiles.detectImageMime` kiểm magic jpeg/png/webp.
- **AI (Epic 1, Story 3.4):**
  - Gateway `generateText` / `generateImage`: reserve/settle hạn mức, ghi `ai_usage`, có `estimateImageCost`. `AiFeature` đã có `compose_caption`, `image_generate`.
  - `buildCaptionPrompt` / `captionInstructions` / `captionInput` + `CaptionBrand`: mẫu caption theo hồ sơ của "Viết thử bằng AI".
  - `checkOutput(text, {brand, kind:'caption', maxChars})`.
  - Mẫu route AI tương tác có Dừng: `app/brand-sample.ts`, `app/ai-request.ts`.
- **Hồ sơ (Epic 3):** `profiles.resolveEffective(pageId, 'brand')` / `resolveEffectiveOrNull` → `{config, source}` hoặc `CONFIG_MISSING`.
- **Kết nối (Epic 2):**
  - `connections.getAccessToken(pageId)`: gọi ngay trước mỗi lời gọi, không cache; IG lấy token của Fanpage nguồn.
  - `markDisconnected` / `markDisconnectedTx` khi gặp `TOKEN_INVALID`. Trạng thái trang đọc từ `pages.getPage(id).connectionStatus`.
- **Meta (Story 2.1):**
  - `adapters/meta` client `graph`/`threads` (`createMetaClients`), phân loại lỗi `classifyMetaError`/`isRetryable`.
  - Hạng ưu tiên `RATE_TIERS` (đăng bài dùng `publish`, dừng ở ≥90% usage).
  - `publishedRefFromFacebook|Instagram|Threads` chuẩn hoá `PublishedRef`. Hàm đăng bài cụ thể (feed/photos, container IG/Threads) **chưa có**.
- **Hàng đợi:** `platform/jobs/queues.ts` là nơi duy nhất khai báo queue (policy, retry, concurrency, `critical`). `publish.target`, `content.image.generate`, `content.requeue`, `content.media_gc` **chưa khai báo**. Mẫu job chống trùng bằng `UPDATE … WHERE status=…`: `inbox.send` + `inbox.send_sweep`.
- **Shared đã khai báo:**
  - `PostTargetStatus`, `CancelReason`.
  - ErrorCode đăng bài và ảnh: `MEDIA_REQUIRED`, `CAPTION_TOO_LONG`, `TOO_MANY_HASHTAGS`, `PUBLISH_LIMIT_REACHED`, `SCHEDULE_IN_PAST`, `PUBLISH_*`, `IMAGE_*`, `MEDIA_NOT_CONFIGURED`.
  - Sự kiện `post_target.published|failed|cancelled` (có `pageId`, `campaignId`, `errorCode`) và `media_asset.created`.
  - Bảng ràng buộc nền tảng và hợp đồng bài/ảnh **chưa có**.
- **Phạm vi:** `pages.resolveScope(scope)` là chỗ duy nhất dịch `scope=`. `pages.listPages` / `getPage` trả trang chưa gỡ.
- **Web:**
  - `screens/Composer.tsx` (`/soan-bai`) và `screens/ContentCalendar.tsx` (`/lich`) chạy trên dữ liệu mẫu.
  - Có sẵn: `AiLockHint` + `aiLock` (khoá nút AI theo trạng thái khoá OpenAI), `usePages`/`useGroups`, `apiFetch({raw})` tải bytes, `error-messages.ts`.
- **Việc hoãn gắn Epic 6:**
  - nginx-api chưa gắn header CORS cho lỗi tự sinh (413 khi tải ảnh lớn), nên web chỉ thấy lỗi mạng.
  - Chưa dọn file mồ côi trên Cloudinary (liệt kê theo prefix). `content.media_gc` chỉ dọn theo DB.

## UX & Interaction Patterns

- **Soạn bài AI `/soan-bai`** có ba cột:
  - Thiết lập: chọn đích theo nhóm hoặc trang; trang mất kết nối không chọn được. Ô ý tưởng, nút "Tạo bằng AI".
  - Nội dung: tab theo từng trang, chữ sửa được. Lưới ảnh có chọn ảnh, "Tạo lại ảnh", "Tải ảnh lên".
  - Xem trước theo dạng bài Facebook / Instagram / Threads.
  - Chân trang có Lưu nháp, ngày/giờ, Lên lịch, Đăng ngay. `?idea=` điền sẵn ý tưởng ("Tạo bài tương tự").
- **Nút AI:** khi chạy hiện "AI đang viết…" ngay tại chỗ, có nút Dừng. Kết quả luôn sửa được. Thiếu khoá thì nút mờ, tooltip "Thêm khoá OpenAI ở Cài đặt".
- **Lịch nội dung `/lich`:**
  - Xem theo tuần/tháng, lọc theo Phạm vi. Kéo thả để đổi ngày.
  - Bài lỗi màu đỏ, mở ra thấy lý do theo `ErrorCode` và "Đăng lại". Toast "Đã đăng" theo SSE.
  - Chi tiết trang có tab "Lịch đăng".
- **Cao trào F4:** "Lên lịch" Thứ Bảy 19:00 → bài hiện trên Lịch ở cả 3 trang.

## Cross-Story Dependencies

- 6.1 là nền cho cả epic: dựng bảng `content`, `createPost`, upload ảnh, bảng ràng buộc nền tảng, `assertPublishable`, Composer nối API.
- 6.2 và 6.3 điền caption/ảnh vào target của 6.1.
- 6.4 cần `assertPublishable` của 6.1, thêm `transitionTarget`, queue `publish.target`, `content.requeue` và hàm đăng bài trong `adapters/meta`.
- 6.5 đọc target theo `scheduled_at` và dùng chuyển trạng thái của 6.4.
- Epic 7 tạo slot qua `createPost({source: campaign})` và dùng `held` / `pending_approval`. Epic 8 đọc `PublishedRef`.
