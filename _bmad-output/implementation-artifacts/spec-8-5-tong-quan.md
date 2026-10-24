---
title: 'Story 8.5 — Tổng quan với việc cần xử lý thật'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '329a56a789c8d59554173842d4c026acc7c67711'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 8.5, AD-18, AD-3, AD-1, UX-DR7; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Tổng quan `/` còn chạy dữ liệu mẫu (KPI quy đổi theo tỉ lệ, hội thoại / bài lỗi / bài sắp đăng của `data/mock`, bảng trang có người theo dõi và công tắc AI giả); chỉ thẻ chiến dịch là thật. Chủ shop mở app không thấy số liệu thật và những việc đang chờ mình. Thẻ chiến dịch còn `trend` = bài đã đăng/ngày (hoãn từ 7.3).

**Approach:** Read-model `app/read-models/overview.ts` ghép từ hàm đọc của từng module (AD-1) thành hai DTO: `GET /api/v1/overview?scope=` (việc cần xử lý + bài sắp đăng + chiến dịch, refetch theo hint realtime) và `GET /api/v1/overview/metrics?scope=&range=` (số liệu chính từ `analytics`, không refetch theo realtime). Web thay toàn bộ dữ liệu mẫu; mỗi việc có link / nút tới đúng chỗ xử lý. `trend` chiến dịch đổi sang tương tác tăng mỗi ngày từ `post_metrics`.

## Boundaries & Constraints

**Always:**
- **Phạm vi:** `pages.listPages(scope)` (giải bằng `resolveScope`; nhóm / trang lạ → 404, sai cú pháp → 400). Bài thuộc phạm vi khi có target (cùng trạng thái của mục) ở trang trong phạm vi; target cùng bài ở trang khác chưa gỡ vẫn trả (AD-18).
- **`/overview` (một hàm ghép `overview()`):**
  - `needsHuman {count, items}`: `inbox.countConversations(…,'needs_human')` + `listConversations` tab `needs_human` (chờ lâu nhất trước) — đúng điều kiện tab "Cần xử lý"; tối đa `OVERVIEW_LIST_MAX` (5) mục.
  - `failedPosts {count, items}`: target `failed`, gom theo bài, mới nhất trước (theo `scheduled_at`); `count` = số bài. Mỗi target kèm `version`, `errorCode` (nút "Đăng lại" gửi thẳng).
  - `pendingApproval` = số slot `pending_approval` không `held` của chiến dịch đã bắt đầu, trang trong phạm vi — cùng tập với hàng đợi "Bài chờ duyệt".
  - `pageAlerts`: trang trong phạm vi có `connectionStatus` `disconnected` (trước) / `expiring`.
  - `webhookStalled`: sản phẩm `stalled` (`webhooks.getWebhookHealth`) mà phạm vi có trang thuộc sản phẩm đó.
  - `aiBudget {percent, state, spentVnd, limitVnd}` từ `ai.getBudgetSummary` (không theo phạm vi).
  - `upcoming`: tối đa 5 bài `scheduled|pending_approval`, không `held`, `scheduled_at ≥ now`, sớm nhất trước, gom target theo `(bài, giờ)`.
  - `campaigns`: chiến dịch `running|paused` theo phạm vi qua `campaignSummaries` có sẵn (tiến độ + `pauseReason`).
- **`/overview/metrics`:** cắt từ `analytics.performanceOverview` (cùng kỳ VN kết thúc hôm qua của 8.2): `range, from, to, insufficientData, platforms, kpis {reach, engagement, messages, followersDelta}, series, aiAnswered, customerMessages`.
- **`trend` chiến dịch:** 7 số = tương tác TĂNG mỗi ngày VN (6 ngày trước → hôm nay) của bài đã đăng của chiến dịch: `post_metrics` là tổng trọn đời theo ngày thu → mức của ngày = snapshot mới nhất ≤ ngày đó (`engagement` khác `null`); tăng = mức − mức hôm trước (chưa có mức trước → cả mức; giảm → 0). `engagement7d {current, previous}`: tổng 7 ngày này / 7 ngày liền trước; `current = null` khi chưa bài nào có snapshot; `previous = null` khi chiến dịch bắt đầu sau ngày đầu kỳ trước. Hàm đọc ở `analytics`, ghép theo chiến dịch ở `read-models/campaigns.ts`.
- **Webhook cũ (hoãn 4.2):** `getWebhookHealth` coi dòng cron cũ hơn `HEALTH_STALE_AFTER_MS` (15 phút = 3 chu kỳ) là không còn tin được → tính lại tại chỗ bằng `computeHealthStatus`.
- **Web realtime (AD-3):** khoá `['overview', scope]` bị làm cũ bởi thực thể `message`, `conversation`, `contact`, `post_target`, `campaign`, `page`, `group`, `webhook`, `ai_budget`, `settings` (≤3 giây = refetch ngay khi invalidate); `['overview_metrics', …]` không. Tạm dừng / tiếp tục chiến dịch và "Đăng lại" làm cũ `['overview']`.
- **Web Tổng quan:** KPI Lượt tiếp cận / Tương tác / Tin nhắn mới ("AI đã trả lời X%") / Người theo dõi mới + % kỳ trước; biểu đồ tương tác theo nền tảng (7 / 30 / 90 ngày, "Cần thêm vài ngày dữ liệu"). "Cần bạn xử lý": cảnh báo (hạn mức AI ≥80% → `/cai-dat?section=openai`; webhook → `/cai-dat?section=webhook`; trang mất kết nối / sắp hết hạn → "Kết nối lại" mở OAuth đúng trang; chiến dịch tự tạm dừng → `/chien-dich`; n bài chờ duyệt → `/chien-dich`; bài lỗi → "Đăng lại" + mở đúng bài trên Lịch) rồi hội thoại → `/hop-thu?tab=needs_human&c=<id>`. Bảng trang: trạng thái thật + "Kết nối lại", AI trả lời đọc từ cấu hình thật (chỉ xem), bỏ cột người theo dõi. Chip luôn có chữ; skeleton đúng bố cục; lỗi qua `errorMessageOf`.
- **Link mới:** `/hop-thu?tab=needs_human` mở tab "Cần xử lý"; `/lich?bai=<targetId>&ngay=<YYYY-MM-DD>` mở lịch ở tuần/tháng đó và mở ngăn của bài.

**Never:**
- Không gọi Meta / OpenAI theo request; không SQL chéo bảng module khác; không N+1 (mỗi phần một số câu cố định).
- Không làm tab Hiệu suất của Chi tiết trang / nhóm (AC 8.5 không chạm — giữ hoãn 8.2). Không thêm loại thông báo mới. Không bật/tắt AI từ Tổng quan (đổi ở Trang & Nhóm / AI trả lời).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cần xử lý | 1 `handoff`, 1 `human` tin cuối của khách, 1 `human` đã trả lời, 1 `ai`; 6 `handoff` khác | `count` = số tab "Cần xử lý" (8), `items` 5 mục chờ lâu nhất trước | |
| Bài lỗi | bài A lỗi FB+IG, bài B lỗi trang ngoài phạm vi, bài C `published` | phạm vi trang FB: `count 1`, A kèm 2 target (version, mã lỗi) | |
| Chờ duyệt | 2 slot `pending_approval` chạy, 1 `held` (tạm dừng), 1 của nháp | `pendingApproval 2` | |
| Trang | `active`, `expiring`, `disconnected`, trang ngoài phạm vi / đã gỡ | `pageAlerts` = [disconnected, expiring] | |
| Webhook | `meta stalled`; phạm vi chỉ có Threads / có FB | `[]` / `['meta']` | |
| Webhook cũ | dòng `ok` `checked_at` 20 phút trước, im lặng 40 phút trong giờ, có trang active | `stalled` (tính lại) | |
| Hạn mức AI | chi 850k / 1tr, cảnh báo 80% bật | `{percent 85, state 'warn'}` | |
| Sắp đăng | bài `scheduled` +1h, slot `pending_approval` +2h, `held`, quá giờ, `draft`, 7 bài tương lai | 5 bài sớm nhất, không `held` / quá giờ / nháp | |
| Chiến dịch | `running`, `paused` (`PAGE_DISCONNECTED`), `done`, nháp | 2 chiến dịch kèm `pauseReason` | |
| Phạm vi | không có trang / nhóm lạ / `scope=bad` / chưa đăng nhập | mọi phần rỗng (budget vẫn có) / 404 / 400 / 401 | |
| Số liệu chính | phạm vi 2 trang có `page_daily_metrics`, tin khách | KPI + series khớp `/performance` cùng kỳ | |
| Trend chiến dịch | bài 1 snapshot 10 (6 ngày trước) → 25 (hôm nay); bài 2 đăng hôm qua snapshot 5; trước kỳ có mức 4 → 10 | `trend` tăng đúng ngày; `current` = tổng; chạy <14 ngày → `previous null`; chưa snapshot → `{null, null}` | giảm → 0 |
| Web realtime | hint `message.received` / `campaign.paused` / `webhook.stalled` / `ai_budget.threshold_reached` | làm cũ `['overview', …]`; không làm cũ `['overview_metrics', …]` | |
| Web việc cần xử lý | dữ liệu đủ loại | thứ tự: hạn mức hết → webhook → trang mất kết nối → chiến dịch tự dừng → bài lỗi → chờ duyệt → trang sắp hết hạn → hạn mức 80%; mỗi mục có link / hành động đúng | |
| Web link | target lịch `2026-10-31T12:00Z`; `?tab=needs_human` | `/lich?bai=…&ngay=2026-10-31`; lịch mở tháng 10, ngăn bài đó; Hộp thư mở tab "Cần xử lý" | target không còn → không mở ngăn |

</frozen-after-approval>

## Code Map

- `packages/shared/src/overview.ts` (MỚI) + `index.ts` -- hợp đồng `/overview`, `/overview/metrics`.
- `packages/shared/src/campaigns.ts` -- `trend` theo tương tác, `engagement7d`.
- `server/src/modules/content/{overview,slots,slots-progress,index}.ts` -- bài lỗi / sắp đăng gom theo bài, đếm chờ duyệt, target đã đăng theo chiến dịch.
- `server/src/modules/analytics/{engagement,index}.ts` (MỚI `engagement.ts`) -- tương tác tăng theo ngày của target.
- `server/src/modules/webhooks/health.ts` -- dòng cron cũ → tính lại.
- `server/src/modules/campaigns/{drafts,start}.ts` -- `getCampaigns` nạp theo lô (danh sách chiến dịch / Tổng quan không N+1).
- `server/src/app/read-models/{overview,campaigns}.ts`, `server/src/app/overview.ts` (MỚI), `app.ts` -- ghép + route.
- `server/test/overview.test.ts` (MỚI), `campaigns-start.test.ts`, `webhooks-health*.test.ts` -- ma trận server.
- `web/src/lib/{overview,realtime,calendar,campaigns,publish,inbox}.ts` + test -- hook, helper thuần, khoá realtime, link.
- `web/src/screens/{Dashboard,ContentCalendar,Inbox,Campaigns}.tsx` -- màn.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- việc hoãn.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/overview.ts`, `campaigns.ts` -- hợp đồng zod -- AD-18.
- [x] `server/src/modules/content/overview.ts` + `slots.ts` + `slots-progress.ts` + `index.ts` -- hàm đọc mới -- AD-1.
- [x] `server/src/modules/analytics/engagement.ts` + `index.ts` -- `engagementGains` -- AD-17.
- [x] `server/src/modules/webhooks/health.ts` -- trạng thái cũ -- hoãn 4.2.
- [x] `server/src/app/read-models/overview.ts` + `campaigns.ts` + `app/overview.ts` + `app.ts` -- ghép, route -- AD-18.
- [x] `server/test/overview.test.ts` + cập nhật test chiến dịch / webhook -- mọi dòng server của ma trận.
- [x] `web/src/lib/overview.ts` + `realtime.ts` + `calendar.ts` + `campaigns.ts` + `publish.ts` + `inbox.ts` + test -- dòng "Web".
- [x] `web/src/screens/Dashboard.tsx`, `ContentCalendar.tsx`, `Inbox.tsx`, `Campaigns.tsx` -- thay dữ liệu mẫu, link, thẻ chiến dịch.
- [x] `deferred-work.md` -- kiểm UI, đóng mục trend 7.3 / webhook cũ 4.2.

**Acceptance Criteria:**
- Given phạm vi đang chọn, when mở Tổng quan, then thấy số liệu chính, "N tin nhắn cần bạn xử lý" (đúng tab "Cần xử lý"), bài lỗi, trang sắp hết hạn / mất kết nối, webhook ngừng nhận tin, mức hạn mức AI, bài sắp đăng, chiến dịch đang chạy kèm tiến độ + lý do tạm dừng — tất cả từ server, không dữ liệu mẫu.
- Given sự kiện realtime liên quan (tin mới, bài lỗi, chiến dịch tạm dừng), when xảy ra, then phần việc cần xử lý refetch ngay (≤3 giây).
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `overview.ts` (mới) — `OverviewQuery`, `OverviewMetricsQuery`, `OverviewPostDto`, `OverviewResponse`, `OverviewMetricsResponse`, `OVERVIEW_LIST_MAX`; `CampaignSummaryDto.engagement7d` (`MetricComparison`), `trend` = tương tác tăng/ngày.
- **Content:** `overview.ts` (mới) — `listFailedPosts` (chọn bài bằng `group by` + `count(*) over ()` rồi đọc target trang chưa gỡ), `listUpcomingPosts` (nhóm `(bài, giờ, trạng thái)`); `countPendingSlots` dùng chung điều kiện với `listPendingSlots`; `campaignProgress` trả `publishedTargetIds` thay `trend`.
- **Analytics:** `engagement.ts` (mới) — `engagementGains` (mức nền `distinct on` + snapshot trong cửa sổ, hai câu cố định). Read-model chiến dịch gọi một lần cho mọi chiến dịch; `campaignEngagement` gộp theo chiến dịch.
- **Campaigns:** `getCampaigns` (3 câu cho mọi chiến dịch) thay vòng `getCampaign` trong `listCampaigns` — `/campaigns` và Tổng quan hết N+1.
- **Webhooks:** `HEALTH_STALE_AFTER_MS` 15 phút — `getWebhookHealth` tính lại tại chỗ khi dòng cron cũ (đóng việc hoãn 4.2).
- **App:** `read-models/overview.ts` (`overview`, `overviewMetrics`) + route `app/overview.ts`; depcruise sạch (223 module).
- **Web:** `lib/overview.ts` (hook + `attentionItems` theo mức gấp, `aiRepliedHint`, `postLabel`, `retryCall`); `realtime.ts` thêm `overview` cho `message`, `conversation`, `contact`, `post_target`, `campaign`, `page`, `group`, `webhook`, `ai_budget`, `settings`; `calendar.ts` `calendarHref` / `dayParamOf` / `groupKeyOfTarget` + `ContentCalendar` mở ngăn theo `?bai=&ngay=`; `inbox.ts` `inboxTabOf` / `inboxHref` + `Inbox` đọc `?tab=`; `campaigns.ts` `engagementText` thay `trendTotal` (thẻ `/chien-dich` "Tương tác 7 ngày ±x%"). `Dashboard.tsx` viết lại: không còn `data/mock` ngoài `compact` / `formatNumber`; bảng trang bỏ cột người theo dõi, AI trả lời thành chip chỉ xem dẫn tới AI trả lời; Tạm dừng / Tiếp tục / Đăng lại làm cũ `['overview']`.
- **Test:** `server/test/overview.test.ts` (11 test mới, mọi dòng server của ma trận); `campaigns-start.test.ts` (trend tương tác), `webhook-health.test.ts` (+1 dòng cron cũ); web `overview.test.ts` (mới), `realtime.test.ts` (+1 — refetch ngay với observer đang mở, không kéo `overview_metrics` / `ai_typing`), `calendar.test.ts`, `inbox.test.ts`, `campaigns.test.ts`.
- **Kiểm tra:** `npm run check` xanh — server 74 file / 1476 test; web 24 file / 350 test. Chưa chạy UI bằng trình duyệt (ghi việc hoãn).
- **Việc hoãn** (`deferred-work.md`): kiểm UI; tổng người theo dõi chưa thu; gai tương tác lúc mới bật thu. Đã đóng: `trend` 7.3, webhook cũ 4.2. Tab Hiệu suất Chi tiết trang / nhóm (8.2) giữ hoãn — AC 8.5 không chạm.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Link `/lich?bai=&ngay=` từ Tổng quan: khoảng lịch đã có cache cũ (đã xem Lịch trước khi tạo bài, gcTime 5 phút) → lần render đầu dùng dữ liệu cũ chưa có target, đánh dấu link "đã xử lý" ngay nên khi refetch về có bài thì ngăn vẫn không mở | medium — thật (vi phạm dòng "Web link" của ma trận) | patch: `ContentCalendar.tsx` chưa thấy target mà query còn `isFetching` → chờ lượt tải xong mới bỏ link |
| Mỗi hint `message` / `conversation` / `contact` làm cũ `['overview', …]` → refetch cả `GET /overview` (~15 câu: hội thoại, bài, chiến dịch + `engagementGains`, sức khoẻ webhook, hạn mức); `invalidateQueries` huỷ request đang bay phía client nhưng server vẫn tính — tin / bình luận dồn dập (livestream) thì mỗi tin một lượt tính đủ | medium — thật (tải server, không sai số) | defer: cần throttle có lượt cuối (≤3 giây) trong realtime client — đổi hành vi chung, ngoài phạm vi sửa nhỏ |

## Design Notes

- **Hai endpoint thay một:** số liệu chính là số cron (6 giờ / ngày) và tốn hơn (gộp 2 kỳ `page_daily_metrics` + quét tin); tin mới tới liên tục. Tách để hint `message.*` chỉ refetch phần việc cần xử lý ("refetch phần liên quan"), đổi khoảng 7/30/90 ngày không tải lại việc cần xử lý.
- **Tương tác tăng thay vì tổng trọn đời:** `post_metrics` lưu tổng trọn đời theo ngày thu; trừ mức hôm trước cho "tương tác mỗi ngày" đúng nghĩa thẻ UX "Tương tác 7 ngày ±x%". Bài có snapshot đầu tiên trong kỳ (mới đăng) tính cả mức — đúng với bài mới; bài cũ mới bật thu số liệu sẽ dồn vào ngày đầu (chỉ lúc mới bật 8.1).

## Verification

**Commands:**
- `npm run check` -- expected: thoát 0 (depcruise sạch, test server + web xanh).
