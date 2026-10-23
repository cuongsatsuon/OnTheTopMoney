# Epic 7 Context: Chiến dịch nuôi page

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Chủ shop tạo một chiến dịch AI nhiều ngày (vd "Tăng tương tác" · 30 ngày) qua wizard 4 bước: mục tiêu → trang đích (nhóm hoặc từng trang, tần suất riêng) → chủ đề + tỉ lệ, ảnh AI, khung giờ, chế độ duyệt → xem trước 7 bài đầu. Bấm "Bắt đầu" thì Lịch nội dung có đủ bài dự kiến "AI tạo" cho cả thời lượng; AI viết cuốn chiếu vài ngày trước, chủ shop duyệt trong "Bài chờ duyệt" (hoặc để tự đăng). Chiến dịch tạm dừng/tiếp tục ngay, và tự dừng an toàn khi trang mất kết nối, hết hạn mức AI, thiếu hồ sơ hoặc đăng lỗi liên tục. Epic này dựng module `campaigns` trên nền `content` của Epic 6 — không có đường tạo/đăng bài thứ hai.

## Stories

- Story 7.1: Wizard tạo chiến dịch — mục tiêu, trang đích, nội dung và lịch
- Story 7.2: Xem trước 7 bài đầu
- Story 7.3: Bắt đầu chiến dịch
- Story 7.4: Sinh nội dung cuốn chiếu và hàng đợi Bài chờ duyệt
- Story 7.5: Tạm dừng, tiếp tục và xoá chiến dịch
- Story 7.6: Chiến dịch tự tạm dừng khi có sự cố

## Requirements & Constraints

- Tổng tỉ lệ chủ đề phải đúng 100%, kiểm cả FE (báo ngay dưới ô) lẫn server (lỗi validate).
- Chế độ mặc định "Duyệt trước khi đăng"; "Tự đăng" là lựa chọn chủ động.
- Tỉ lệ ảnh AI chỉ áp cho Facebook/Threads; slot trang Instagram luôn có ảnh (FE ghi chú "Instagram luôn cần ảnh").
- Trang `disconnected` hoặc chưa có hồ sơ thương hiệu hiệu lực (`CONFIG_MISSING`) không chọn được làm đích, phải nêu lý do. Trang `expiring` vẫn dùng được; `page.expiring` không làm chiến dịch dừng.
- 7 bài xem trước không đăng được trước khi bắt đầu, và không bị nhân đôi khi bắt đầu.
- Bài AI lỗi (AI lỗi, ảnh lỗi, hậu kiểm chặn) không bị bỏ: về "Chờ duyệt" kèm mã lỗi, kể cả chế độ "Tự đăng".
- Duyệt bài: giờ đã qua hoặc còn dưới 2 phút → `SCHEDULE_IN_PAST`, FE hỏi giờ mới.
- Tạm dừng/Tiếp tục không cần xác nhận; Xoá phải xác nhận, bài đã đăng giữ nguyên.
- Lý do tạm dừng hiện trên thẻ chiến dịch, có thông báo và cảnh báo ở Tổng quan. Chủ shop tự dừng (`MANUAL`) thì không thông báo.
- v1 chỉ đổi tên và chế độ của chiến dịch đang chạy; đổi trang/tần suất/chủ đề = tạo chiến dịch mới.

## Technical Decisions

- **Sở hữu (AD-1):** `campaigns` sở hữu `campaigns`, `campaign_pages`, `campaign_topics`. Được gọi `content`, `profiles`, `ai` (+ nền `pages`, `settings`). `content` không bao giờ import `campaigns`; chiều ngược lại chỉ qua sự kiện. Module `campaigns` chưa có thư mục, nhưng đã nằm trong `server/dependency-rules.cjs`.
- **Trạng thái:** `CampaignStatus` = `draft|running|paused|done`. `CampaignMode` = `review|auto`. `PauseReason` = `PAGE_DISCONNECTED|AI_BUDGET_EXCEEDED|PUBLISH_FAILURES|CONFIG_MISSING|MANUAL`. Cả ba đã có ở shared `enums.ts`.
- **Slot (AD-13, AD-15):**
  - Mỗi slot tạo qua `content.createPost({source: campaign, campaignId, topic, targets[]})`, 1 post : 1 target.
  - `slot_at` bất biến, khoá duy nhất `(campaign_id, page_id, slot_at)`. Kéo thả chỉ đổi `scheduled_at`.
  - `posts.caption` được rỗng khi chưa sinh.
- **Vòng đời chiến dịch (AD-15):**
  - Bước 4: job `campaigns.preview` sinh 7 slot đầu ở `pending_approval` + `held=true`.
  - "Bắt đầu": chụp `campaign_pages` (trang + tần suất). Tạo idempotent các slot còn lại ở `planned`, chủ đề theo tỉ lệ. Bỏ `held` cho 7 bài xem trước (chế độ tự đăng → `scheduled`). Chiến dịch → `running`.
  - `campaigns.group_id` chỉ là nhãn.
- **Sinh cuốn chiếu:**
  - Cron `campaigns.generate_window` hằng giờ sinh slot `planned` trong 3 ngày tới [ASSUMPTION], bỏ qua chiến dịch `paused`.
  - Gọi AI với `feature=campaign_generate`, qua `ai.checkOutput`.
  - Slot chỉ rời `planned` khi caption xong và ảnh (nếu cần) `ready` hoặc lỗi. Duyệt trước → `pending_approval`; tự đăng → `scheduled` qua `assertPublishable`.
- **Tạm dừng / tiếp tục:**
  - Tạm dừng = `paused` + `pause_reason` + `content.holdCampaignTargets` (`held=true`) trong cùng transaction.
  - Tiếp tục: từ chối nếu lý do còn. Ngược lại gọi `content.releaseCampaignTargets(campaignId, now)`: slot đã lỡ giờ → `cancelled MISSED_WHILE_PAUSED`; slot tương lai bỏ `held`, tăng `schedule_version`, enqueue lại. Đặt `consecutive_failures = 0`.
- **Tự tạm dừng (AD-15, AD-7, AD-5):**
  - Kích hoạt khi: `page.disconnected` của trang trong `campaign_pages`, `ai_budget.threshold_reached{100}`, `CONFIG_MISSING` lúc sinh, hoặc `consecutive_failures` chạm 3.
  - `consecutive_failures` tăng khi `post_target.failed` cuối có mã khác `PAGE_DISCONNECTED`, về 0 khi `post_target.published`. Handler idempotent theo `targetId`.
  - `page.removed`: `content` đã tự huỷ target (`PAGE_REMOVED`); `campaigns` chỉ bỏ trang khỏi `campaign_pages`.
  - Trang rời đúng nhóm nhãn: `content.cancelCampaignTargets(campaignId, pageId)` với `PAGE_LEFT_GROUP`.
- **Hoàn tất:** cron `campaigns.complete_check` hằng giờ. Chiến dịch → `done` khi không còn slot `planned|pending_approval|scheduled|publishing`, rồi phát `campaign.completed`.
- **Hàng đợi:**
  - `campaigns.generate` / `campaigns.preview`: policy `stately`, `singletonKey=campaignId`, retry 2, concurrency 2.
  - Consumer sự kiện `events.campaigns` (standard, retry 5).
  - Khai báo duy nhất ở `platform/jobs/queues.ts`.
- **Hợp đồng (AD-18):**
  - Danh sách chiến dịch nhận `scope=`, giải bằng `pages.resolveScope`. Chiến dịch thuộc phạm vi khi `campaign_pages` giao phạm vi.
  - `Campaign.postsDone/postsTotal/nextPost/trend` và `Group.activeCampaigns` là dẫn xuất, ghép ở `app/read-models/`.
  - Giờ đăng và ngày theo `Asia/Ho_Chi_Minh`, lưu `timestamptz` UTC.

### Đã có, phải dùng lại

- **Module `content` (Epic 6):**
  - Bảng `posts` (`source` đã cho `campaign`, `topic`) và `post_targets`.
  - `post_targets` có `status`, `version`, `schedule_version`, `scheduled_at`, `error_code`, `cancel_reason`, `ai_caption`, `PublishedRef`.
  - **Chưa có** cột `campaign_id`, `slot_at`, `held` và khoá duy nhất slot. Thêm ở story đầu tiên tạo slot (7.2).
  - `createPost` hiện chỉ nhận `source: manual` và tạo target `draft`.
- **Chuyển trạng thái:**
  - `transitionTarget` / `transitionPostTargets` (khoá `version`, advisory giới hạn/24h theo `pageId` tăng dần, tất cả hoặc không).
  - Hành động: `schedule|reschedule|unschedule|retry|cancel`. **Chưa có:** duyệt (`pending_approval → scheduled`), tạo lại (`→ planned`), `holdCampaignTargets` / `releaseCampaignTargets` / `cancelCampaignTargets`.
  - `cancel` đã nhận nguồn `planned|pending_approval`. `CANCEL_REASONS` đã có `CAMPAIGN_DELETED`, `MISSED_WHILE_PAUSED`, `PAGE_REMOVED`, `PAGE_LEFT_GROUP`.
- **Đăng:**
  - Job `publish.target {targetId, scheduleVersion}`: bỏ qua im lặng khi version lệch. **Chưa kiểm `held`.**
  - Cron `content.requeue`; `assertPublishable`; bảng `PLATFORM_RULES` (IG bắt buộc ảnh).
  - Sự kiện `post_target.published|failed|cancelled` có `campaignId` nhưng hiện luôn `null`.
- **Lịch `GET /calendar`:**
  - Trả `ai` (true cho `source=campaign`) và `campaignId` (hiện `null`).
  - Web `lib/calendar.ts` gom slot theo `campaignId` + giờ. Chỉ kéo được `scheduled|failed`.
- **AI:**
  - `content/compose.ts` (`composeCaptions`): caption theo hồ sơ hiệu lực, chạy trong request, có hậu kiểm.
  - `content/images.ts`: `requestImageGeneration` + job `content.image.generate` → `media_assets` + sự kiện `media_asset.created`.
  - Gateway `generateText` / `generateImage`: reserve/settle hạn mức; `estimateTextCost` / `estimateImageCost`.
  - `AiFeature.campaign_generate` đã khai báo. Lỗi `AI_BUDGET_EXCEEDED` / `OPENAI_KEY_*` / `CONFIG_MISSING`.
- **Hồ sơ:** `profiles.resolveEffectiveOrNull(db, pageId, 'brand')` (null = `CONFIG_MISSING`).
- **Trang:** `pages.getPage(id).connectionStatus`, `resolveScope`, `getGroup`. Chỉ `pagesTable` được export để khai FK.
- **Sự kiện & thông báo:**
  - Shared `events.ts` đã khai `campaign.paused {reason}` / `resumed` / `completed`.
  - `notifications` đã nghe `campaign.paused` (bỏ qua `MANUAL`), có loại `campaign_paused` (mặc định tắt) và `PAUSE_REASON_TEXT`.
  - `pages.affectedByMove` trả `campaigns: []` (chỗ chờ cảnh báo chiến dịch khi chuyển nhóm).
- **Web:**
  - `screens/CampaignWizard.tsx` (`/chien-dich/tao`) và `screens/Campaigns.tsx` (`/chien-dich`) đang chạy dữ liệu mẫu.
  - Có sẵn: `usePages` / `useGroups`, `AiLockHint` + `aiLock`, `isoToVnInput` / `vnToIso` / `todayKey`, `error-messages.ts`.
- **Việc hoãn gắn Epic 7:**
  - Lịch ở tab khác không tự cập nhật khi đổi giờ/lên lịch. Nếu Epic 7 tự lên lịch slot thì cần sự kiện kiểu `post_target.scheduled`.
  - Kéo một ô gom nhiều slot chiến dịch gửi mỗi bài một request, không tất-cả-hoặc-không. Cân nhắc route theo danh sách target, hoặc báo "Đã dời n/m bài".
  - Lịch chưa kéo/duyệt bài `planned` / `pending_approval`.

## UX & Interaction Patterns

- `/chien-dich/tao`:
  - Wizard 4 bước có stepper, cột phải "Tóm tắt" (tổng số bài, lịch nhiệt 30 ngày, chế độ).
  - Bước 2: nhóm hoặc từng trang, tần suất mặc định + đặt riêng từng trang.
  - Bước 3: tên, chủ đề + tỉ lệ ("Chia đều", gợi ý), khung giờ, thanh tỉ lệ ảnh AI, thẻ chế độ.
  - Bước 4: 7 bài với Sửa / Xoá / Tạo lại, nút "Bắt đầu chiến dịch".
- `/chien-dich`:
  - Thẻ chiến dịch có tiến độ, bài kế tiếp, xu hướng, Tạm dừng/Tiếp tục ngay, Xoá có xác nhận.
  - Tab trạng thái và hàng đợi "Bài chờ duyệt" (duyệt, sửa, tạo lại, bỏ).
- Cao trào F3: "Bắt đầu chiến dịch" → Lịch hiện đủ bài chấm tím "AI tạo"; Tổng quan hiện thẻ tiến độ 0/N.
- Nút AI khoá khi thiếu khoá OpenAI / hết hạn mức (tooltip "Thêm khoá OpenAI ở Cài đặt").

## Cross-Story Dependencies

- 7.1 lưu cấu hình nháp (chiến dịch, chủ đề, trang đích + tần suất), là đầu vào cho 7.2 và 7.3.
- 7.2 thêm cột slot (`campaign_id`, `slot_at`, `held`) ở `content`, mở `createPost({source: campaign})`, queue `campaigns.preview`.
- 7.3 chụp `campaign_pages`, tạo slot còn lại idempotent, dựng read-model tiến độ cho Campaigns/Tổng quan/Nhóm.
- 7.4 cần hành động duyệt/tạo lại ở `content.transitionTarget` (dùng chung với Lịch nội dung).
- 7.5 và 7.6 cần `hold/release/cancelCampaignTargets` ở `content` và job `publish.target` kiểm `held`.
- 7.6 cần consumer `events.campaigns` cho `page.*`, `ai_budget.threshold_reached`, `post_target.*`.
