---
title: 'Story 8.2 — Màn Hiệu suất theo phạm vi'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '8d5500032cad8ace36bf7a194719a10de2a4ccda'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-8-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 8.2, AD-17, AD-18, AD-1; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** `/hieu-suat` chạy hoàn toàn dữ liệu mẫu. Story 8.1 đã thu số liệu bài / trang về `post_metrics`, `page_daily_metrics`, `metric_sync_states` nhưng chưa có API đọc nào, nên chủ shop chưa thấy được trang / bài nào hiệu quả thật theo nhóm và khoảng thời gian.

**Approach:** Một endpoint `GET /api/v1/performance?scope=&range=` chỉ đọc bảng nội bộ: `analytics` tổng hợp ở server (KPI + kỳ trước, chuỗi tương tác theo nền tảng, bảng từng trang, bài tốt nhất) từ trang trong phạm vi (`pages.listPages` → `resolveScope`) và bài đã đăng lấy qua hàm export của `content`. Màn Hiệu suất thay dữ liệu mẫu ở bốn phần đó bằng API.

## Boundaries & Constraints

**Always:**
- **Hợp đồng (shared `metrics.ts`):** `PerformanceQuery { scope?: ScopeParam, range: '7d'|'30d'|'90d' = '30d' }` (strict). `PerformanceResponse`:
  - `from`, `to` (`YYYY-MM-DD`, ngày VN, gồm cả hai đầu); `insufficientData`; `platforms` (nền tảng có trang trong phạm vi, thứ tự facebook → instagram → threads);
  - `kpis.{views,reach,engagement,followersDelta}` = `{ current, previous }` (số hoặc `null`);
  - `series[]` mỗi ngày của kỳ: `{ date, facebook, instagram, threads, previous }` — tương tác trong ngày; `previous` = tổng tương tác ngày cùng vị trí ở kỳ trước;
  - `pages[]` (thứ tự `listPages`): `{ pageId, views, reach, engagement, followersDelta, posts, trend[], insufficientData, metricsState, missingScopes }`;
  - `topPosts[]` (≤ `TOP_POSTS_MAX` = 5): `{ targetId, postId, pageId, publishedAt, title, permalink, thumbnailUrl, ai, source, campaignId, views, reach, engagement }`.
- **Khoảng thời gian:** kỳ = N ngày VN trọn vẹn kết thúc HÔM QUA (`to` = hôm qua, `from` = `to − N + 1`); kỳ trước = N ngày liền trước. Hôm nay không tính (số liệu trang hôm nay chưa thu — tính vào sẽ làm kỳ này thiếu một ngày so với kỳ trước).
- **Tổng hợp (server, AD-17):**
  - KPI, chuỗi, bảng trang lấy từ `page_daily_metrics` của trang trong phạm vi; tổng = cộng các giá trị không `null`; không có giá trị nào → `null` (không phải 0). `reach` = cộng reach theo ngày [ASSUMPTION — Meta không cho reach duy nhất cho khoảng tuỳ ý].
  - Gộp nhóm theo thành viên HIỆN TẠI (`resolveScope`); trang đã gỡ không tính.
  - `posts` = số target `published` có `published_at` trong kỳ (theo ngày VN) của trang đó.
  - `topPosts`: target `published` trong kỳ thuộc trang trong phạm vi, số liệu = snapshot mới nhất của `post_metrics` (tổng trọn đời), xếp `engagement` giảm dần (`null` sau cùng), rồi `views`, rồi id. Mỗi target (một trang) là một dòng. `ai` cùng luật Lịch nội dung (slot chiến dịch / caption AI / ảnh AI); `title` = `calendarTitle(caption)`.
  - `insufficientData` trang: `connected_at` sau `now − 7 ngày`; cấp response: phạm vi có trang và MỌI trang đều chưa đủ 7 ngày.
  - `metricsState` từ `metric_sync_states` (cả hai loại): `permissions_missing` khi có `permissions_missing` / `permission_denied` (kèm hợp `missing_scopes`), rồi `failed` khi `failed` / `disconnected`, rồi `pending` khi chưa có dòng nào, còn lại `ok`.
- `analytics` gọi `pages` (base) và `content` qua `index.ts` (AD-1); thêm ở `content`: `listPublishedInRange` (id + trang, tối đa 10 000 [ASSUMPTION]) và `describePublishedTargets` (chi tiết bài tốt nhất). Route `app/performance.ts` chỉ parse + gọi `analytics`.
- **Web `/hieu-suat`:** bộ chọn Phạm vi (`useApp().scope`, `serverScope` — id kho mẫu → dữ liệu rỗng) + `7 ngày | 30 ngày | 90 ngày` + công tắc "So với kỳ trước". 5 thẻ KPI: Lượt xem, Lượt tiếp cận, Tương tác, Tỉ lệ tương tác (= tương tác / tiếp cận), Người theo dõi mới; `null` → "—", không mũi tên; % so kỳ trước chỉ khi kỳ trước là số > 0. Biểu đồ tương tác chồng theo nền tảng (màu nền tảng) + đường nét đứt "Kỳ trước". Bảng trang sắp xếp được (`null` luôn cuối). Bài tốt nhất giữ nút "Tạo bài tương tự" như hiện tại (Story 8.4 làm đủ). Đang tải → skeleton; lỗi → `errorMessageOf`.
- `insufficientData` → "Cần thêm vài ngày dữ liệu" thay biểu đồ; dòng trang chưa đủ 7 ngày → câu đó thay sparkline. `metricsState = permissions_missing` → dòng trang "Thiếu quyền thống kê — Kết nối lại" (nút mở OAuth kết nối lại trang đó, `from: 'pages'`).

**Never:**
- Không gọi Meta trong request; không kéo dữ liệu thô về web để tính. Không query bảng của `content` / `pages` từ `analytics` (AD-1).
- Không làm "Hiệu quả AI" (8.3, giữ mẫu), "Tạo bài tương tự" điền sẵn (8.4), Tổng quan / `Campaign.trend` (8.5), tab Hiệu suất của Chi tiết trang / nhóm (hoãn).
- Không giữ phần không có story và chỉ có số giả trên màn số liệu thật: bỏ "Giờ đăng tốt nhất" và nút "Xuất báo cáo" (ghi việc hoãn).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Nhóm 30 ngày | `group:<Mỹ phẩm>` (FB + IG, kết nối 60 ngày), trang ngoài nhóm có số liệu; range 30d | KPI chỉ cộng trang trong nhóm, có `previous`; `series` 30 ngày `from..to` (đến hôm qua) theo nền tảng; `pages` 2 dòng; `topPosts` xếp theo tương tác | |
| Thành viên hiện tại | trang rời nhóm sau khi có số liệu; trang đã gỡ | không tính trong nhóm; trang đã gỡ không tính ở `all` | |
| Khoảng ngày | dòng hôm nay, dòng ngày `from − 1`, ngày `from` | hôm nay không tính; `from − 1` vào kỳ trước; `from` vào kỳ này | |
| Null ≠ 0 | Threads reach / followers_delta `null`; trang chỉ có Threads | `reach.current = null`; trang FB + Threads → reach chỉ cộng FB | |
| Bài tốt nhất | 6 bài trong kỳ, 1 bài ngoài kỳ, 1 bài trang ngoài phạm vi, 1 bài `failed`; bài có 2 snapshot | 5 bài, đúng thứ tự, số = snapshot mới nhất; cờ `ai` / `title` / `permalink` đúng | |
| Đếm bài | 3 bài published trong kỳ của trang A, 1 ngoài kỳ | `pages[A].posts = 3` | |
| Chưa đủ dữ liệu | `page:<id>` kết nối 3 ngày trước; nhóm có 1 trang mới + 1 trang cũ | `insufficientData: true` + dòng trang `true`; nhóm: response `false`, chỉ dòng trang mới `true` | |
| Thiếu quyền | sync `posts` = `permissions_missing {read_insights}`; trang `permission_denied`; `failed`; chưa có dòng | `permissions_missing` + `['read_insights']`; `permissions_missing`; `failed`; `pending` | |
| Phạm vi rỗng / sai | nhóm không có trang; scope sai cú pháp; nhóm không tồn tại; range lạ; chưa đăng nhập | 200 rỗng (`kpis` null, `series` đủ ngày với null); 400 `VALIDATION_FAILED`; 404; 400; 401 | |
| Web | KPI null; kỳ trước 0; sắp xếp có null; `insufficientData`; trang thiếu quyền | "—" không mũi tên; không %; null cuối cả hai chiều; "Cần thêm vài ngày dữ liệu"; "Thiếu quyền thống kê — Kết nối lại" | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/metrics.ts` -- thêm hợp đồng Hiệu suất (query, response, hằng).
- `server/src/modules/content/{metrics-targets,index}.ts` -- `listPublishedInRange`, `describePublishedTargets`.
- `server/src/modules/analytics/{performance,index}.ts` (MỚI `performance.ts`) -- tổng hợp đọc.
- `server/src/app/{performance,app}.ts` -- route `GET /api/v1/performance`.
- `server/test/analytics-performance.test.ts` (MỚI) -- ma trận qua app thật.
- `web/src/lib/performance{,.test}.ts` (MỚI) -- hook + helper thuần.
- `web/src/screens/Analytics.tsx` -- dùng API cho KPI, biểu đồ, bảng trang, bài tốt nhất.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- việc hoãn.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/metrics.ts` -- `PERFORMANCE_RANGES`, `PerformanceQuery`, `PerformanceResponse`, `TOP_POSTS_MAX`, `INSUFFICIENT_DATA_DAYS`, `PAGE_METRICS_STATES` -- AD-18.
- [x] `server/src/modules/content/*` -- hai hàm đọc bài đã đăng -- AD-1.
- [x] `server/src/modules/analytics/performance.ts` + `index.ts` -- `performanceOverview` -- AD-17.
- [x] `server/src/app/performance.ts`, `app.ts` -- route -- AD-18.
- [x] `server/test/analytics-performance.test.ts` -- phủ mọi dòng ma trận phía server.
- [x] `web/src/lib/performance.ts` + test -- hook, `deltaPct`, `engagementRate`, `sortPageRows`, nhãn trạng thái -- dòng "Web" của ma trận.
- [x] `web/src/screens/Analytics.tsx` -- thay dữ liệu mẫu bốn phần, bỏ heatmap + "Xuất báo cáo".
- [x] `deferred-work.md` -- tab Hiệu suất Chi tiết trang / nhóm, heatmap / xuất báo cáo, kiểm UI.

**Acceptance Criteria:**
- Given phạm vi "Nhóm Mỹ phẩm" và 30 ngày, when mở Hiệu suất, then API (chỉ đọc bảng nội bộ) trả KPI, chuỗi theo nền tảng, bảng so sánh từng trang và bài tốt nhất, gộp nhóm theo thành viên hiện tại.
- Given trang kết nối <7 ngày, when hiển thị, then API trả `insufficientData: true`, FE hiện "Cần thêm vài ngày dữ liệu" thay biểu đồ.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** cuối `metrics.ts` — `PERFORMANCE_RANGES` / `PERFORMANCE_RANGE_DAYS`, `INSUFFICIENT_DATA_DAYS`, `TOP_POSTS_MAX`, `PAGE_METRICS_STATES`, `PerformanceQuery`, `MetricComparison`, `PerformanceSeriesPoint`, `PagePerformanceDto`, `TopPostDto`, `PerformanceResponse`.
- **Content:** `metrics-targets.ts` thêm `listPublishedInRange` (id + trang, `PUBLISHED_IN_RANGE_MAX` = 10 000) và `describePublishedTargets` (cùng luật `ai` / `calendarTitle` với Lịch nội dung).
- **Analytics:** `performance.ts` (mới) — `performanceWindow`, `pageMetricsState`, `performanceOverview` (gọi `pages.listPages` + hai hàm của `content`; xếp hạng bài bằng `distinct on` snapshot mới nhất + `limit 5` ở SQL). Không cần `app/read-models/`: `analytics → content` là mũi tên AD-1 có sẵn.
- **Route:** `app/performance.ts` `GET /api/v1/performance` (đăng ký ở `app.ts`, dùng `clock` của app).
- **Web:** `lib/performance.ts` (mới) — `usePerformance` (khoá `['performance', scope, range]`), `deltaPct`, `engagementRate`, `rateComparison`, `sortPageRows`, `metricsStateText`, `hasSeriesData`, `formatDay`. `Analytics.tsx`: 5 KPI (Lượt xem, Lượt tiếp cận, Tương tác, Tỉ lệ tương tác, Người theo dõi mới — bỏ KPI "Tin nhắn" mẫu, thuộc 8.3), biểu đồ đường theo nền tảng (không chồng — `null` không thành 0), bảng trang với cột Xu hướng nhường cho câu trạng thái, bài tốt nhất (ảnh / "AI tạo" / liên kết bài gốc); skeleton + lỗi có "Thử lại". "Hiệu quả AI" giữ mẫu (8.3); bỏ heatmap + "Xuất báo cáo".
- **Test:** `server/test/analytics-performance.test.ts` (9 test, mới — phủ mọi dòng server của ma trận), `web/src/lib/performance.test.ts` (8 test — dòng "Web").
- **Kiểm tra:** `npm run check` thoát 0 — depcruise sạch (215 module); server 71 file / 1445 test; web 23 file / 335 test.
- **Việc hoãn** (ghi `deferred-work.md`): kiểm UI bằng trình duyệt; tab Hiệu suất Chi tiết trang / nhóm; heatmap / xuất báo cáo đã bỏ; `connected_at` đặt lại khi kết nối lại + reach cộng theo ngày. `Campaign.trend` theo tương tác vẫn để 8.5 (AC 8.2 không cần).

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| KPI "Tỉ lệ tương tác" = tổng tương tác / tổng tiếp cận ở web: phạm vi có Threads (reach `null`, tương tác có) cộng tương tác Threads vào tử mà không vào mẫu → tỉ lệ thổi phồng. Sửa: server tính `kpis.engagementRate` (%) chỉ trên ngày có cả hai số; web dùng thẳng, bỏ `rateComparison`; test FB + Threads. | real (medium) | patch |
| % so kỳ trước giả: cron trang chỉ lùi 3 ngày nên trang mới kết nối / mới bật thu (Story 8.1 vừa lên) có kỳ trước thiếu hoặc trống → "+300%". Sửa: có trang trong phạm vi mà số liệu đầu tiên sau ngày đầu kỳ trước → `previous = null` cho mọi KPI (FE không mũi tên); test + seed dòng sớm cho test cũ. | real (medium) | patch |
| Hệ quả của bản sửa trên: phạm vi lớn (`all`) có một trang mới thì mất % so kỳ trước tới 2N ngày; đúng hơn là so like-for-like trên các trang đủ dữ liệu (cần thêm trường hợp đồng). | real (low–medium) | defer |

## Design Notes

- **Kỳ đến hết hôm qua:** cron trang (04:30) chỉ thu ngày trước hôm nay, nên kỳ "gồm hôm nay" luôn thiếu một ngày số liệu trang so với kỳ trước → % so sánh lệch âm (≈14% với 7 ngày). Bài đăng hôm nay vì thế chưa vào "bài tốt nhất" (số liệu còn quá ít để xếp hạng).
- **Hai bước qua `content`:** `analytics` không join được `post_targets`; lấy id bài trong kỳ (nhẹ) → xếp hạng ở `post_metrics` bằng SQL (`distinct on` snapshot mới nhất, `limit 5`) → hỏi chi tiết 5 bài. Không kéo caption của mọi bài.
- **Theo target, không theo bài:** bài đăng 3 trang có thể hiện 3 dòng (mỗi trang một số liệu) — biết trang nào hiệu quả; 8.4 dùng đúng trang đó làm đích.

## Verification

**Commands:**
- `npm run check` -- expected: thoát 0 (depcruise sạch, test server + web xanh).
