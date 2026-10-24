---
title: 'Story 8.1 — Thu thập số liệu trang và bài'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '88d4874c4f11609de22040c5a5df9cf7c7c56986'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 8.1, AD-17, AD-6, AD-5, AD-24, AD-1; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Màn Hiệu suất, Tổng quan và thẻ chiến dịch chưa có số liệu thật: chưa có module `analytics`, chưa có bảng snapshot, chưa có cron kéo insight từ Meta. Gọi Graph theo request sẽ chậm và ăn quota đúng lúc khách đang nhắn.

**Approach:** Module `analytics` mới sở hữu `post_metrics`, `page_daily_metrics` (+ bảng trạng thái thu thập). Hai cron (bài mỗi 6 giờ, trang hằng ngày) rải job theo trang. Job lấy token qua `connections` ngay trước khi gọi, kiểm quyền insight trước, gọi Meta hạng `background`, ánh xạ metric gốc → bốn chỉ số chuẩn qua MỘT bảng cấu hình, rồi upsert theo khoá ngày (chạy lại không nhân đôi).

## Boundaries & Constraints

**Always:**
- **Shared `metrics.ts` (mới):** `STANDARD_METRICS = views | reach | engagement | followers_delta`; `INSIGHTS_SCOPES` theo nền tảng (facebook `read_insights`, instagram `instagram_manage_insights`, threads `threads_manage_insights`); `METRIC_SYNC_KINDS = posts | page`; `METRIC_SYNC_STATUSES = ok | permissions_missing | permission_denied | disconnected | failed`.
- **Bảng (migration `drizzle-kit generate`):**
  - `post_metrics`: PK `(post_target_id, metric_date)`; `page_id`; `views`, `reach`, `engagement` (bigint, null được, ≥0); `raw jsonb` (metric gốc, chỉ số); `fetched_at`. `metric_date` = ngày VN lúc thu; giá trị là tổng trọn đời của bài tại lúc đó. FK `post_target_id` → `post_targets` và `page_id` → `pages`, `on delete cascade`. Index `(page_id, metric_date)`.
  - `page_daily_metrics`: PK `(page_id, date)`; `views`, `reach`, `engagement` (≥0), `followers_delta` (âm được), `raw`, `fetched_at`.
  - `metric_sync_states`: PK `(page_id, kind)`; `status`; `missing_scopes text[]`; `attempted_at`; `succeeded_at`. Bảng thứ ba của `analytics` để "ghi rõ" thiếu quyền cho 8.2.
  - Upsert `ON CONFLICT DO UPDATE … WHERE excluded.fetched_at >= fetched_at`.
- **Bảng ánh xạ** `analytics/metric-map.ts` là chỗ DUY NHẤT biết tên metric Meta + đường gọi:
  - Bài: FB `GET /{post}?fields=shares,comments.limit(0).summary(true),reactions.limit(0).summary(true),insights.metric(post_media_view,post_total_media_view_unique)`; IG `GET /{media}/insights?metric=views,reach,likes,comments,shares,saved`; Threads `GET /{media}/insights?metric=views,likes,replies,reposts,quotes`.
  - Trang: FB `GET /{page}/insights?metric=page_media_view,page_total_media_view_unique,page_post_engagements,page_daily_follows_unique,page_daily_unfollows_unique&period=day&since&until` (một lời gọi, nhiều ngày); IG mỗi ngày VN: `metric=views,reach,total_interactions&metric_type=total_value` + `follows_and_unfollows` (`breakdown=follow_type`); Threads mỗi ngày VN `GET /me/threads_insights?metric=views,likes,replies,reposts,quotes`.
  - Chỉ số chuẩn = tổng metric gốc (trừ `minus`): engagement FB bài = reactions + comments + shares; IG = likes + comments + shares + saved; Threads = likes + replies + reposts + quotes; trang FB `page_post_engagements`, IG `total_interactions`. Reach Threads, followers_delta Threads → `null` (nền tảng không có).
  - Không metric gốc nào được tham chiếu có mặt → `null`; có ít nhất một → cộng những cái có. Số âm / không phải số → bỏ. Cấm tên chứa `impressions`.
- **Hàng đợi (AD-24):** cron `analytics.post_metrics` (`15 */6 * * *`) và `analytics.page_metrics` (`30 4 * * *`), retry 1, concurrency 1 — rải `analytics.collect_posts {pageId}` / `analytics.collect_page {pageId}` cho mọi trang chưa gỡ, không `disconnected`. Hai queue collect: standard, retry 3 backoff, concurrency 2.
- **Job thu (mỗi trang):**
  1. Trang đã gỡ / `disconnected` / Threads chưa cấu hình → bỏ qua, không gọi Meta.
  2. Thiếu quyền insight trong `page_credentials.granular_scopes` (qua hàm export mới của `connections`) → `permissions_missing` + `missing_scopes`, không gọi Meta, KHÔNG đổi trạng thái kết nối trang.
  3. Token qua `connections.getAccessToken` ngay trước khi gọi; hạng `background`; scope `page:<platformAccountId>` (FB/IG), `threads:<pageId>`.
  4. Bài: target `published` có `platform_post_id`, `published_at` trong 30 ngày, tối đa 300 bài mới nhất, lấy qua hàm export mới của `content`.
  5. Trang: FB các ngày Meta trả về trong 4 ngày gần nhất; IG / Threads 3 ngày VN trước hôm nay.
- **Lỗi Meta:**
  - `RATE_LIMITED` (gồm usage ≥75% bị adapter giữ trước khi gửi) → dừng, enqueue lại cùng job `startAfter = now + retryAfterMs`, không tính lượt retry. Dữ liệu đã ghi giữ nguyên. Hoãn quá 3 giờ kể từ lần hoãn đầu → bỏ lượt này (cron sau chạy lại).
  - `TOKEN_INVALID` → `markDisconnected(tokenOwnerPageId)` + `disconnected`, dừng.
  - `PERMISSION_DENIED`: lời gọi trang → `permission_denied`; một bài → bỏ bài đó; mọi bài đều bị từ chối → `permission_denied`. Không đổi trạng thái kết nối.
  - `REJECTED` / loại khác ở một bài (bài đã xoá, media không hỗ trợ) → bỏ bài đó. Ở lời gọi trang → `failed`.
  - `TRANSIENT` / `ABORTED`: một bài → bỏ bài đó; 3 bài liên tiếp → ném để retry. Lời gọi trang → ném để retry. Lần thử cuối → `failed`.
  - Chạy hết → `ok` + `succeeded_at`.
- Log không có token, caption hay URL có query.

**Never:**
- Không gọi Meta từ api hay theo request. Không query bảng của `content` / `connections` từ `analytics` (AD-1). Không cache token.
- Không coi thiếu quyền / `PERMISSION_DENIED` là mất kết nối. Không ghi 0 thay cho metric nền tảng không có.
- Không dùng metric `*impressions*`. Không làm API đọc / màn web (Story 8.2+). Không đổi `trend` chiến dịch (việc hoãn).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Cron rải job | 1 FB active, 1 IG expiring, 1 trang disconnected, 1 trang đã gỡ | mỗi cron enqueue job cho 2 trang đầu | |
| Bài FB | target `published` có id; Meta trả reactions 10, comments 3, shares vắng, media_view 500, unique 300 | 1 dòng `post_metrics`: views 500, reach 300, engagement 13, raw lưu; trạng thái `ok` | |
| Bài IG / Threads | IG đủ metric; Threads views 80, likes 5, replies 2 | IG engagement = likes+comments+shares+saved; Threads reach `null`, engagement 7 | |
| Chọn bài | bài nháp, `failed`, `published` không id, đăng 31 ngày trước, bài của trang khác | không lời gọi nào cho các bài đó | |
| Trang FB | 2 ngày, follows 7 / unfollows 2 | 2 dòng `page_daily_metrics` theo ngày Meta, followers_delta 5 | |
| Trang IG / Threads | IG 2 lời gọi × 3 ngày; Threads 3 ngày | IG followers_delta = FOLLOWER − NON_FOLLOWER; Threads reach + followers_delta `null` | IG lời gọi follows bị từ chối → followers_delta `null`, phần còn lại vẫn ghi |
| Chạy lại | cùng ngày chạy 2 lần (số đổi); ngày sau | cùng ngày: vẫn 1 dòng, số mới; ngày sau: dòng mới | |
| Thiếu quyền | FB thiếu `read_insights` | 0 lời gọi Meta; `permissions_missing`, `missing_scopes={read_insights}`; trang vẫn `active` | |
| Usage ≥75% | client thật, usage app 80% | 0 lời gọi gửi đi; job mới `startAfter` ≈ thời gian giữ; lời gọi `interactive` cùng client vẫn gửi | hoãn quá 3 giờ → bỏ lượt |
| Meta chặn giữa chừng | bài 2 trả `RATE_LIMITED` | bài 1 đã ghi; job mới `startAfter`; không ném | |
| Token hỏng | IG trả `TOKEN_INVALID` | Fanpage nguồn + IG `disconnected`, `page.disconnected`; trạng thái `disconnected`; dừng | |
| Bị từ chối quyền | lời gọi trang `PERMISSION_DENIED`; một bài `PERMISSION_DENIED`; mọi bài | `permission_denied`; bỏ bài đó, bài khác ghi, `ok`; `permission_denied` — trang vẫn `active` | |
| Lỗi tạm | bài `TRANSIENT` 1 lần; 3 bài liên tiếp; lời gọi trang `TRANSIENT` | bỏ bài; ném retry; ném retry — lần cuối `failed` | |
| Không có / hỏng | metric vắng hết; số âm | `null`; `null` | |
| Bỏ qua | trang đã gỡ / disconnected lúc chạy job; Threads chưa cấu hình | 0 lời gọi, không ghi gì | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/metrics.ts` (MỚI) + `index.ts` -- chỉ số chuẩn, quyền insight, trạng thái thu.
- `server/src/modules/analytics/{index,schema,metric-map,collect,cron}.ts` (MỚI) -- bảng, bảng ánh xạ, job thu, cron rải job.
- `server/src/modules/content/{metrics-targets,index}.ts` -- liệt kê bài đã đăng cho số liệu; export bảng `post_targets` chỉ để khai FK.
- `server/src/modules/connections/{credentials,index}.ts` -- `grantedScopes(db, pageId)`.
- `server/src/platform/jobs/queues.ts`, `server/src/worker/main.ts` -- 4 queue, nối handler.
- `server/drizzle/0037_*.sql` -- migration sinh bằng `drizzle-kit generate`.
- `server/test/analytics-metrics.test.ts` (MỚI) -- ma trận.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/metrics.ts` -- hằng + enum -- AD-17.
- [x] `server/src/modules/connections/*` -- `grantedScopes` -- AD-5.
- [x] `server/src/modules/content/*` -- `listMetricTargets`, `postTargetsTable` -- AD-1, AD-17.
- [x] `server/src/modules/analytics/*` + migration -- bảng, ánh xạ, thu, cron -- AD-17, AD-6, AD-2.
- [x] `server/src/platform/jobs/queues.ts`, `worker/main.ts` -- queue + nối -- AD-24.
- [x] `server/test/analytics-metrics.test.ts` -- phủ mọi dòng ma trận.
- [x] `deferred-work.md` -- việc hoãn (kiểm bằng Meta thật).

**Acceptance Criteria:**
- Given cron 6 giờ / hằng ngày chạy với hạng `background`, then `post_metrics` / `page_daily_metrics` có bốn chỉ số chuẩn, metric nền tảng không có là `null`, ánh xạ chỉ nằm ở `analytics/metric-map.ts` và không có `*impressions*`.
- Given usage Meta ≥75%, when cron chạy, then lời gọi bị hoãn tới lúc hết giữ, gửi tin (`interactive`) không bị ảnh hưởng.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `metrics.ts` (mới) — `STANDARD_METRICS`, `INSIGHTS_SCOPES`, `METRIC_SYNC_KINDS`, `METRIC_SYNC_STATUSES`; export ở `index.ts`.
- **Connections:** `grantedScopes(db, pageId)` ở `credentials.ts` (đọc `page_credentials.granular_scopes` của chính trang).
- **Content:** `metrics-targets.ts` (mới) — `listMetricTargets` (`published`, có `platform_post_id`, trong cửa sổ, tối đa `METRIC_TARGETS_MAX` = 300, mới nhất trước); `postTargetsTable` export chỉ để khai FK.
- **Analytics (mới):**
  - `schema.ts`: `post_metrics`, `page_daily_metrics`, `metric_sync_states`; migration `0037_fine_chameleon.sql` (sinh bằng `drizzle-kit generate`, chạy lại báo không đổi).
  - `metric-map.ts`: bảng ánh xạ duy nhất (`POST_METRIC_MAP`, `PAGE_METRIC_MAP`), đọc insight (`parseInsightTotals`, `parseInsightDaily`, breakdown → `<metric>.<chiều>`), `applyRule` / `standardize`, `referencedMetricNames` cho test cấm `impressions`.
  - `collect.ts`: `collectPostMetrics` / `collectPageMetrics` + handler job; `cron.ts`: `runPostMetricsCron` / `runPageMetricsCron` rải job.
- **Nền:** 4 queue ở `queues.ts` (`analytics.post_metrics` `15 */6 * * *`, `analytics.page_metrics` `30 4 * * *`, `analytics.collect_posts` / `collect_page` retry 3 backoff 60 giây, concurrency 2); worker nối handler với `analyticsDeps`.
- **Test:** `server/test/analytics-metrics.test.ts` (22 test, mới — phủ mọi dòng ma trận; dòng usage ≥75% dùng client Meta thật + `fetch` giả + store tần suất trong bộ nhớ). `notifications.test.ts`: thêm handler rỗng cho 4 queue mới (worker thật đòi đủ handler).
- **Kiểm tra:** `npm run check` thoát 0 — depcruise sạch (213 module); server 70 file / 1434 test; web 22 file / 327 test.
- **Lệch so với kiến trúc:** thêm bảng `metric_sync_states` cho `analytics` (Structural Seed chỉ nêu hai bảng) để ghi rõ thiếu quyền / bị từ chối mà không đụng trạng thái kết nối.
- **Việc hoãn:** kiểm tên metric bằng Meta thật; `metric_sync_states` chưa có trong bảng sở hữu của spine / chưa API đọc (8.2); lùi số liệu trang chỉ 3–4 ngày. `trend` thẻ chiến dịch vẫn là bài đã đăng/ngày (mục hoãn 7.3 còn mở).

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Upsert ghi đè số tốt bằng `null` khi lượt sau thiếu metric: số liệu trang lùi 3 ngày nên mỗi ngày được ghi lại 3 lượt — lời gọi phụ `follows_and_unfollows` của IG bị từ chối ở lượt sau xoá `followers_delta` đã có (tương tự bài khi Meta bỏ trường). Sửa: `coalesce(excluded.x, x)` cho các chỉ số, `raw` gộp (`raw \|\| excluded.raw`); test "lượt sau thiếu metric". | real (medium) | patch |
| Hoãn `RATE_LIMITED` của số liệu bài: `startAfter` tính từ lúc lượt BẮT ĐẦU (lượt 300 bài chạy nhiều phút → job mới chạy ngay, không chờ `retryAfterMs`), và job hoãn gọi lại từ đầu mọi bài đã ghi → đẩy usage lên lại, trang nhiều bài có thể không bao giờ tới bài phía sau trong 3 giờ. Sửa: `startAfter` = lúc bị chặn + `retryAfterMs`; job hoãn bỏ target đã có dòng ngày đó ghi từ `deferredSince`; test "hoãn: startAfter tính từ lúc bị chặn…". | real (medium) | patch |
| Threads `threads_insights` `views` là chuỗi theo ngày Meta (`end_time` giờ Thái Bình Dương) nhưng được hỏi theo cửa sổ ngày VN và cộng mọi giá trị → ngày VN D nhận số ngày Meta D−1 (lệch một ngày so với FB), hoặc nhân đôi nếu Meta trả hai giá trị chồng cửa sổ. | real (medium, cần Meta thật) | defer |

## Design Notes

- **Snapshot theo ngày, giá trị trọn đời:** bài là tổng trọn đời tại lúc thu, khoá `(target, ngày VN)` — chạy lại trong ngày ghi đè, sang ngày mới có dòng mới (8.2 lấy dòng mới nhất mỗi bài; thẻ chiến dịch sau này lấy chênh lệch theo ngày). Trang là số theo ngày, khoá `(trang, ngày)`.
- **Ngày của trang FB** là ngày Meta trả (`end_time` − 1 ngày, theo giờ Thái Bình Dương của Meta) [ASSUMPTION]; IG / Threads hỏi theo cửa sổ ngày VN. Lùi 3–4 ngày để số Meta chốt muộn được ghi đè.
- **Rải job theo trang:** mỗi trang hoãn `RATE_LIMITED` riêng (job mới `startAfter`), một trang lỗi không chặn trang khác; concurrency 2 giữ nhịp gọi thấp.
- **Lỗi một bài không làm hỏng lượt:** bài đã xoá / media không hỗ trợ insight bị bỏ; chỉ lỗi ở mức trang (token, quyền, lỗi tạm liên tiếp) dừng lượt.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới (3 bảng analytics).
- `npm run check` -- expected: thoát 0.
