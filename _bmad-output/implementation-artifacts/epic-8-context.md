# Epic 8 Context: Hiệu suất và Tổng quan

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Chủ shop mở `/hieu-suat` chọn Phạm vi (tất cả / nhóm / trang) và khoảng thời gian, thấy KPI, biểu đồ theo nền tảng, bảng so sánh từng trang, bài tốt nhất và mục "Hiệu quả AI" (AI trả lời bao nhiêu tin, chuyển người bao nhiêu, phản hồi nhanh thế nào, bài AI so với bài tự viết). Từ một bài tốt bấm "Tạo bài tương tự" để mở Soạn bài AI điền sẵn. Màn Tổng quan `/` thay dữ liệu mẫu bằng số liệu chính và việc cần xử lý thật, tự cập nhật theo realtime. Nền của cả epic là số liệu Meta kéo định kỳ về bảng nội bộ của module `analytics` — màn hình không bao giờ gọi Graph theo request và không ăn quota lúc khách đang nhắn.

## Stories

- Story 8.1: Thu thập số liệu trang và bài
- Story 8.2: Màn Hiệu suất theo phạm vi
- Story 8.3: Hiệu quả AI
- Story 8.4: Tạo bài tương tự
- Story 8.5: Tổng quan với việc cần xử lý thật

## Requirements & Constraints

- API Hiệu suất / Tổng quan chỉ đọc bảng nội bộ; không gọi Meta trong request.
- Chỉ số chuẩn duy nhất: `views`, `reach`, `engagement` (= reactions + comments + shares + saves, theo những gì nền tảng có), `followers_delta`. Nền tảng không cung cấp → `null`, không phải 0 (FE phân biệt "không có" với "bằng 0").
- Không dùng metric `*impressions*` (Meta bỏ từ v26); lượt xem dùng metric `*media_view*` / `views`.
- Gộp theo Nhóm dùng thành viên hiện tại [ASSUMPTION]; không có lịch sử thành viên nhóm.
- Trang có `connected_at` < 7 ngày → API trả `insufficientData: true`; FE hiện "Cần thêm vài ngày dữ liệu" thay biểu đồ.
- "Hiệu quả AI" tính từ tin nhắn và tin `system` chuyển trạng thái; bài AI vs bài tự viết so tương tác trung bình.
- "Tạo bài tương tự": điền sẵn ý tưởng (tóm từ caption gốc) và đích là trang của bài; chưa gọi AI tới khi chủ shop bấm "Tạo bằng AI".
- Tổng quan: "N tin nhắn cần bạn xử lý" đúng điều kiện tab "Cần xử lý"; bài lỗi; trang sắp hết hạn / mất kết nối; webhook `stalled`; mức hạn mức AI; bài sắp đăng; chiến dịch đang chạy kèm tiến độ + lý do tạm dừng. Sự kiện liên quan → refetch phần đó trong ≤3 giây.
- Microcopy theo Voice and Tone: "AI đã trả lời 81% tin nhắn", không phải "Tỷ lệ tự động hoá: 0,81".

## Technical Decisions

- **Sở hữu (AD-1):** `analytics` sở hữu `post_metrics`, `page_daily_metrics`. Được gọi `content`, `inbox`, `connections` (+ nền `pages`, `settings`) và `adapters/meta`. Không được gọi `autoreply`, `campaigns`, `ai`. Ghép xuyên module (Tổng quan, `Campaign.trend` theo tương tác) ở `app/read-models/`. Module `analytics` chưa có thư mục nhưng đã nằm trong `server/dependency-rules.cjs` (cả danh sách `metaCallers`).
- **Thu thập (AD-17, AD-6):**
  - Cron `analytics.post_metrics` mỗi 6 giờ: bài đã đăng 30 ngày gần nhất, theo `platform_post_id` lấy qua hàm của `content`.
  - Cron `analytics.page_metrics` hằng ngày: số liệu trang theo ngày.
  - Mọi lời gọi hạng `background`: dừng khi usage ≥75%, `RATE_LIMITED` → hoãn tới `blocked_until`, không tính vào số lần retry. `TOKEN_INVALID` → `connections.markDisconnected`.
  - Ánh xạ metric gốc từng nền tảng → chỉ số chuẩn là MỘT bảng cấu hình trong `analytics`. Bảng chỉ số chuẩn ở `packages/shared` (`metrics.ts`).
- **Hàng đợi (AD-24):** `analytics.*` standard, retry 3, concurrency 2, chống trùng bằng trạng thái bản ghi; cron `tz: 'Asia/Ho_Chi_Minh'`; khai báo duy nhất ở `platform/jobs/queues.ts`.
- **Hợp đồng (AD-18):** mọi endpoint nhận `scope=all|group:<id>|page:<id>`, giải bằng duy nhất `pages.resolveScope`. Schema zod ở `packages/shared`. Bài thuộc phạm vi khi trang của target nằm trong phạm vi. DTO Tổng quan ghép ở `app/read-models/`, mỗi DTO đúng một hàm ghép. Lỗi theo `ErrorCode` + bản đồ microcopy ở `web/`.
- **Thời gian:** lưu `timestamptz` UTC; ngày nghiệp vụ / khoảng thời gian theo `Asia/Ho_Chi_Minh`.

### Đã có, phải dùng lại

- **`content` (Epic 6–7):**
  - `posts` (`source` = `manual|campaign`, `topic`) + `post_targets` (1 bài : n trang; slot chiến dịch 1 : 1).
  - Sau khi đăng: `post_targets.status='published'`, `published_at`, `platform_post_id` (dạng chuẩn AD-6: FB `{pageId}_{postId}`, IG/Threads media id; có thể null khi Meta không trả id), `permalink` (có thể thiếu).
  - `ai_caption` (nhãn "AI tạo"), ảnh AI ở `media_assets.source='ai'` qua `post_target_media`, `campaign_id` cho slot chiến dịch.
  - Chưa có hàm export nào liệt kê bài đã đăng theo khoảng thời gian — thêm ở `content/index.ts`, không query bảng của `content` từ `analytics`.
- **`campaigns`:** read-model `app/read-models/campaigns.ts` + `content.campaignProgress`. `trend` hiện là **số bài đã đăng mỗi ngày** (7 ngày), nhãn thẻ "Bài đã đăng 7 ngày"; khi có `post_metrics` đổi thành tương tác theo ngày + % thay đổi (việc hoãn từ 7.3).
- **`inbox` (nguồn cho "Hiệu quả AI"):**
  - `messages.origin` ∈ `customer|app_human|app_ai|app_unmatched|external_human|system`. Tin `app_ai` = AI trả lời; `app_human` / `external_human` = chủ shop trả lời trong / ngoài app.
  - Tin `system` mang `reason_code` (`StateChangeReason`) khi hội thoại chuyển trạng thái (vd AI chuyển người). `conversations.state` / `state_reason`.
  - `autoreply_runs` (module `autoreply`) có `outcome`, `reason_code`, `inbound_at`, `finished_at` — `analytics` không gọi được `autoreply`; nếu cần thì đọc qua read-model.
  - Phải đọc qua hàm export của `inbox/index.ts` (thêm hàm đếm nếu chưa có), không SQL chéo.
- **Meta:**
  - `connections.getAccessToken(pageId)` ngay trước mỗi lời gọi (IG dùng token Fanpage nguồn), `tokenOwnerPageId` + `markDisconnected` khi `TOKEN_INVALID`.
  - Quyền đã cấp theo trang ở `page_credentials.granular_scopes` (`read_insights`, `instagram_manage_insights`, `threads_manage_insights` đã có trong danh sách xin quyền nhưng KHÔNG bắt buộc khi chọn trang — trang có thể thiếu).
  - Client `graph` / `threads` dựng bằng `connections.createMetaClients`. Scope đếm tần suất: `page:<platformAccountId>` (FB/IG), `threads:<pageId>` (Threads). Fake: `adapters/meta/fake.ts` (test), `META_FAKE=1` (dev).
- **Nền:**
  - Cron giờ VN qua `QUEUES[...].cron`; worker nối handler ở `worker/main.ts`.
  - `pages.resolveScope`, `getPage` (`connectedAt`, `connectionStatus`), `getPlatformAccountId`, `listPages`.
  - Sự kiện realtime `post_target.*`, `message.*`, `conversation.state_changed`, `campaign.*`, `page.*`, `webhook.stalled|recovered`, `ai_budget.*` đã có ở `packages/shared/events.ts`.
- **Web:**
  - `screens/Analytics.tsx` (`/hieu-suat`) và tab Hiệu suất của Chi tiết trang / nhóm chạy hoàn toàn dữ liệu mẫu (`data/mock`: `posts`, `engagement30d`…).
  - `screens/Dashboard.tsx` (`/`): phần chiến dịch đã thật (Epic 7), còn lại dữ liệu mẫu (`conversations`, `posts`, `engagement30d`).
  - Có sẵn: `KpiCard`, recharts, `useApp().scope`, `lib/campaigns.ts`, `lib/realtime.ts`, `error-messages.ts`.
- **Việc hoãn gắn Epic 8:**
  - Thao tác hàng loạt của chiến dịch (tạm dừng / tiếp tục huỷ bài lỡ giờ / xoá) không phát `post_target.cancelled` từng bài. Thống kê bài huỷ phải đọc lại theo `campaign_id` hoặc thêm phát theo lô.
  - `trend` thẻ chiến dịch đổi sang tương tác khi có `post_metrics`.
  - API sức khoẻ webhook chưa coi trạng thái cũ là cũ khi cron chết. Cân nhắc khi Tổng quan hiện cảnh báo webhook.

## UX & Interaction Patterns

- `/hieu-suat`:
  - Bộ chọn Phạm vi + khoảng thời gian; thẻ KPI (giá trị `metric` 28 đậm, dòng so sánh kỳ trước mũi tên xanh/đỏ).
  - Biểu đồ theo nền tảng: màu nền tảng chỉ dùng cho đường biểu đồ và biểu tượng.
  - Bảng so sánh từng trang, danh sách bài tốt nhất có "Tạo bài tương tự", mục "Hiệu quả AI".
- Chi tiết trang / nhóm có tab "Hiệu suất" cùng nguồn dữ liệu.
- State "Chưa đủ dữ liệu": trang kết nối <7 ngày → "Cần thêm vài ngày dữ liệu" thay biểu đồ trống.
- Tổng quan: thẻ KPI, "4 tin nhắn cần bạn xử lý", bài sắp đăng, chiến dịch đang chạy (Tạm dừng / Tiếp tục ngay), cảnh báo token / webhook / chiến dịch / hạn mức (UX-DR7). Chip trạng thái luôn có chữ.
- Đang tải hiện skeleton đúng bố cục; lỗi qua bản đồ `ErrorCode`.

## Cross-Story Dependencies

- 8.1 tạo bảng snapshot + cron và hàm đọc của `analytics`; 8.2, 8.3 (phần bài AI vs tự viết), 8.5 (số liệu chính) và `Campaign.trend` đều đọc từ đó.
- 8.2 cần `content` export danh sách bài đã đăng theo phạm vi / khoảng thời gian (kèm `ai_caption`, `source`, caption, permalink) để dựng "bài tốt nhất"; 8.4 dùng lại đúng bài đó.
- 8.3 cần hàm đọc mới ở `inbox` (đếm tin `app_ai`, tin `system` chuyển người, thời gian phản hồi).
- 8.5 ghép từ `inbox` (đếm "Cần xử lý"), `content` (bài lỗi, bài sắp đăng), `pages` (token), `webhooks` (sức khoẻ), `ai` (hạn mức), `campaigns` (read-model đã có) ở `app/read-models/`.
