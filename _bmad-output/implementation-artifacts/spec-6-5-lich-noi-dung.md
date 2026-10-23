---
title: 'Story 6.5 — Lịch nội dung với kéo thả'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'dcb02b9120d60121a47652657ea6f8f816ff60c0'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 6.5, AD-13, AD-18, UX-DR10; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Lịch nội dung `/lich` (và tab "Lịch đăng" của Chi tiết trang) còn chạy trên dữ liệu mẫu: chưa có API đọc target theo giờ, kéo thả chỉ đổi state phía web, "Xoá" không huỷ gì. Server chưa có hành động huỷ (`cancelled`), chưa lưu cờ "AI tạo" của caption, và khoá giới hạn/24h trong `transitionPostTargets` lấy theo thứ tự body → hai request ngược thứ tự có thể deadlock.

**Approach:**
- `GET /api/v1/calendar?scope=&from=&to=` (giải phạm vi bằng `pages.resolveScope`) trả từng target có `scheduled_at` trong khoảng, kèm trạng thái, cờ `ai`.
- Web gom target thành "bài trên lịch" (cùng bài/chiến dịch + cùng giờ + cùng trạng thái); kéo thả và các nút trong ngăn chi tiết đều gọi `POST /posts/:id/targets/transition` có sẵn (`reschedule` / `retry` / `unschedule`) — không có đường ghi riêng.
- Thêm hành động `cancel` (→ `cancelled` + `cancel_reason`), cột `ai_caption`, khoá advisory theo `pageId` tăng dần.

## Boundaries & Constraints

**Always:**
- **Shared `content.ts`:**
  - `TARGET_ACTIONS` thêm `cancel`. `TransitionTargetsRequest`: `cancel` giống `unschedule` — cấm `scheduledAt`.
  - `SavePostTarget.aiCaption: boolean` (mặc định `false`) — caption do AI viết (kể cả đã sửa lại). `PostTargetDto.aiCaption`.
  - `CalendarQuery {scope?, from, to}`: ISO UTC, `from < to`, `to − from ≤ 43 ngày` (lưới tháng 6 tuần) → sai: 400.
  - `CalendarItemDto {id, postId, pageId, status, version, scheduledAt, publishedAt, errorCode, permalink, ai, campaignId, title, thumbnailUrl}`; `CalendarResponse {items, truncated}`.
- **`cancel` (AD-13 "mọi trạng thái trước `publishing` → `cancelled`"):** nguồn `planned|draft|pending_approval|scheduled|failed`; đích `cancelled`, `cancel_reason='USER_DELETED'`, `error_code=null`, `version+1`, `schedule_version+1` khi rời `scheduled` (job cũ bỏ qua); phát `post_target.cancelled {pageId, campaignId:null, version}` cùng transaction. `publishing|published|cancelled` → 409. Check DB: `(status='cancelled') = (cancel_reason is not null)`.
- **Khoá/24h:** `transitionPostTargets` lấy `pg_advisory_xact_lock(publish_limit:<page>)` cho mọi trang có `dailyPublishMax` trong request, theo `pageId` tăng dần, TRƯỚC vòng chuyển từng target (chỉ với hành động tới `scheduled`).
- **Đọc lịch (`content.listCalendar(db, {pageIds, from, to})`):**
  - Target có `scheduled_at ∈ [from, to)`, `status <> 'cancelled'`, trang chưa gỡ; thuộc bài có ít nhất một target (không huỷ) ở trang trong phạm vi (AD-18: giao khác rỗng; target của trang khác trong phạm vi bài vẫn trả).
  - `ai = ai_caption OR posts.source='campaign' OR có ảnh gắn source='ai'`. `title` = 120 code point đầu của caption (gộp khoảng trắng), trống → `null`. `thumbnailUrl` = ảnh đầu.
  - Thứ tự `scheduled_at, id`; tối đa 2.000 dòng [ASSUMPTION] → `truncated`.
- **Web `lib/calendar.ts` (helper thuần + hook):**
  - Lưới theo giờ VN (UTC+7) bất kể múi giờ trình duyệt: tháng bắt đầu Thứ Hai, đủ tuần; tuần 7 ngày × 24 giờ (cuộn tới 07:00).
  - Gom: khoá `(campaignId ?? postId) + phút của scheduledAt + status`. Slot chiến dịch (1 post : 1 target) gom theo `campaignId` cùng giờ.
  - Kéo được khi nhóm `scheduled` (→ `reschedule`) hoặc `failed` (→ `retry`, tức "Đăng lại" vào giờ mới). Thả ô tháng: đổi ngày, giữ giờ phút VN; thả ô giờ ở tuần: đổi ngày + giờ, giữ phút. Một request mỗi bài, `targets` = target của nhóm.
  - Chặn trước khi gửi: giờ mới ≤ bây giờ ("Không dời bài về thời điểm đã qua"), cùng chỗ → không gọi.
  - Ngăn chi tiết (mở bằng bấm, bàn phím được — thay cho kéo thả): tên trang + trạng thái từng trang; lỗi theo `ErrorCode`; ô ngày/giờ VN + "Đổi giờ" (`scheduled`) / "Đăng lại lúc này" + "Đăng lại ngay" (`failed`); "Bỏ lịch"; "Xoá" có xác nhận (`cancel`); "Mở ở Soạn bài"; "Xem bài" khi đã đăng. Nhãn chữ "AI tạo" trên ô lịch và ngăn chi tiết.
  - Màu: lên lịch xanh, đang đăng xanh nhạt, đã đăng xám + dấu ✓, lỗi đỏ + ⚠ + chữ "Lỗi đăng". Lọc nền tảng / trạng thái. Hỏi lại khi có `post_target.*` (khoá gốc `post_targets`) và sau mỗi chuyển trạng thái.
- **Chi tiết trang › Lịch đăng:** đọc `scope=page:<id>`, từ bây giờ tới +42 ngày, chỉ target của trang đó, chưa `published`.
- **Composer:** gửi `aiCaption` theo nhãn "AI tạo" của tab; mở lại nháp giữ nhãn.

**Never:**
- Không endpoint ghi riêng cho kéo thả; không sửa `scheduled_at` ngoài `transitionTarget`.
- Không kéo `planned|pending_approval` (chưa có hành động đổi giờ giữ trạng thái — Epic 7), không duyệt bài, không "Tạo lại bằng AI" trên lịch.
- Không sửa nội dung target đã rời nháp / bài lẫn trạng thái (giữ việc hoãn). Không hiện bài nháp chưa có giờ trên lịch.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Đọc lịch | 3 target 31/10 19:00 VN (FB caption AI, IG ảnh AI, TH tay) + 1 target ngoài khoảng + 1 `cancelled` + 1 nháp | 3 item theo `scheduled_at`, `status`, `version`; `ai` true/true/false; không có item ngoài khoảng / huỷ / nháp | |
| Phạm vi | `scope=page:<IG>` của bài 3 trang; bài khác chỉ ở FB | trả cả 3 target của bài có IG; không trả bài chỉ FB | nhóm/trang lạ 404; `scope` sai 400 |
| Khoảng sai | `from ≥ to`; > 43 ngày; thiếu `from` | 400 `VALIDATION_FAILED` | |
| Kéo bài lên lịch | nhóm `scheduled` 31/10 19:00 thả vào 02/11 (tháng) | `reschedule` 02/11 19:00 VN; `scheduled_at` đổi, `schedule_version+1`, job mới; job cũ bỏ qua | 409 → "Dữ liệu vừa thay đổi", lịch tải lại |
| Kéo ở tuần | thả 01/11 ô 08:00, bài lúc 19:30 | `2026-11-01T01:30:00.000Z` | |
| Kéo không hợp lệ | bài `published`/`publishing`/`cancelled`; thả về quá khứ; thả đúng chỗ cũ | không kéo được / báo, không gọi API / không gọi | |
| Kéo bài lỗi | nhóm `failed` thả sang ngày mai | `retry` giờ mới → `scheduled`, `error_code` null | luật nền tảng 422 → câu theo trang |
| Bài lỗi trên lịch | `failed PAGE_DISCONNECTED` | ô đỏ "Lỗi đăng"; ngăn: câu theo mã + "Đăng lại ngay"/"Đăng lại lúc này" | |
| Huỷ | `scheduled` / `draft` / `failed` → `cancel` | `cancelled`, `cancel_reason USER_DELETED`, `schedule_version+1` (từ `scheduled`), sự kiện `post_target.cancelled`; job cũ bỏ qua; biến khỏi lịch | `published`/`publishing`/`cancelled` 409; có `scheduledAt` 400 |
| Gom | bài thủ công 3 trang cùng 19:00 (2 `scheduled`, 1 `failed`); 3 slot chiến dịch cùng `campaignId` 19:00 | 2 nhóm (scheduled ×2, failed ×1); 1 nhóm 3 target | |
| Deadlock/24h | 2 request song song: bài A [IG1, IG2], bài B [IG2, IG1] | cả hai 200 (khoá theo `pageId` tăng dần) | |
| Cờ AI | lưu nháp `aiCaption: true` rồi mở lại | `PostTargetDto.aiCaption` true, tab còn nhãn "AI tạo" | |
| Giờ VN | trình duyệt UTC, item `2026-10-31T17:30Z` | nằm ô 01/11, 00:30 | |
| Chưa đăng nhập | | 401 | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/content.ts` -- `cancel`, `aiCaption`, `CalendarQuery` / `CalendarItemDto` / `CalendarResponse`.
- `server/src/modules/content/{schema,posts,transitions,calendar,index}.ts` -- cột `ai_caption` + check huỷ; lưu cờ; `cancel` + khoá sắp xếp; đọc lịch.
- `server/drizzle/0030_demonic_red_hulk.sql` -- migration (`drizzle-kit generate`).
- `server/src/app/{posts,app}.ts` -- `GET /api/v1/calendar`, truyền `events` cho transition.
- `server/test/content-calendar.test.ts` (MỚI) -- ma trận server.
- `web/src/lib/{calendar,publish,composer}.ts` + test -- lưới VN, gom, kế hoạch kéo thả, hook; `aiCaption`.
- `web/src/screens/{ContentCalendar,PageDetail}.tsx` -- nối API.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- gỡ / cập nhật mục 6.4.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/content.ts` -- hợp đồng lịch, `cancel`, `aiCaption` -- AD-13, AD-18, UX-DR10.
- [x] `server/src/modules/content/schema.ts` + migration -- `ai_caption`, check `cancel_reason`.
- [x] `server/src/modules/content/transitions.ts` -- `cancel` + sự kiện; khoá advisory theo `pageId` tăng dần -- AD-13, việc hoãn deadlock.
- [x] `server/src/modules/content/{posts,calendar,index}.ts`, `server/src/app/{posts,app}.ts` -- lưu cờ AI, `listCalendar`, route -- AD-18.
- [x] `server/test/content-calendar.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/calendar.ts` (MỚI) + test, `publish.ts`, `composer.ts` -- helper lưới / gom / kéo thả / nhãn, hook, `aiCaption`.
- [x] `web/src/screens/ContentCalendar.tsx`, `PageDetail.tsx` -- nối API, kéo thả, ngăn chi tiết, Xoá.
- [x] `deferred-work.md` -- gỡ mục deadlock + huỷ; giữ phần sửa nội dung target đã rời nháp.

**Acceptance Criteria:**
- Given bài 3 trang lên lịch Thứ Bảy 19:00, when mở `/lich` tuần đó, then thấy một ô 19:00 có biểu tượng 3 nền tảng; kéo sang Chủ Nhật → 3 target đổi giờ, job cũ không đăng.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `TARGET_ACTIONS` + `cancel`, `UNTIMED_TARGET_ACTIONS`; `SavePostTarget.aiCaption` (mặc định `false`, kiểu `SavePostTarget` thành `z.input`); `PostTargetDto.aiCaption`; `CalendarQuery` / `CalendarItemDto` / `CalendarResponse`, `CALENDAR_RANGE_MAX_MS` (43 ngày), `CALENDAR_ITEMS_MAX` 2.000, `CALENDAR_TITLE_MAX` 120.
- **Server:**
  - Migration `0030_demonic_red_hulk.sql`: cột `ai_caption`, check `post_targets_cancelled_reason_check`.
  - `content/transitions.ts`: `FROM` thành danh sách trạng thái nguồn; `cancel` → `cancelled` + `USER_DELETED`, `schedule_version+1` chỉ khi rời `scheduled`, phát `post_target.cancelled` (`TransitionDeps.events` mới). `transitionPostTargets` lấy khoá advisory/24h theo `pageId` tăng dần trước vòng lặp (chỉ hành động tới `scheduled`, chỉ trang có giới hạn).
  - `content/calendar.ts` (MỚI): `listCalendar` + `calendarTitle`. Route nhận thêm `visiblePageIds` (= `resolveScope(all)`) để bỏ trang đã gỡ mà `content` không đọc bảng `pages`.
  - `app/posts.ts`: `GET /api/v1/calendar`; route chuyển trạng thái chỉ đăng ký khi có cả `jobs` + `events`.
- **Web:**
  - `lib/calendar.ts` (MỚI): ngày VN (`todayKey`, `monthGrid`, `weekGrid`, `rangeOfDays`), `groupCalendarItems`, `filterItems`, `planMove` / `dropAt` / `groupCalls`, nhãn trạng thái, `useCalendar` (khoá gốc `post_targets` → SSE `post_target.*` tự làm cũ).
  - `useTransitionTargets` làm cũ `['post_targets']` khi xong (cả lỗi). Composer gửi / nạp `aiCaption`.
  - `ContentCalendar.tsx` viết lại trên API: tuần 24 hàng (cuộn tới 07:00), ô "AI tạo", kéo thả theo `planMove`, ngăn chi tiết có ô ngày giờ (thay kéo thả cho bàn phím), Đổi giờ / Bỏ lịch / Đăng lại / Xoá (xác nhận) / Mở ở Soạn bài / Xem bài; bộ lọc "N bài đăng lỗi" bấm được.
  - `PageDetail.tsx` tab "Lịch đăng": `scope=page:<id>`, hôm nay → +42 ngày, bỏ bài đã đăng, "Đăng cùng" từ target khác của cùng bài.
- **Việc hoãn:** gỡ mục deadlock; mục "sửa / huỷ target đã rời nháp" thu lại còn phần sửa; thêm 3 mục (kiểm trình duyệt, lịch tab khác không tự cập nhật khi đổi giờ, kéo slot chiến dịch nhiều request).
- **Kiểm tra:** `npm run check` thoát 0 — depcruise sạch; server 63 file / 1309 test (11 mới ở `content-calendar.test.ts`; test deadlock đã thử fail khi tắt khoá sắp xếp); web 21 file / 293 test (12 mới ở `calendar.test.ts`). Chưa thử bằng trình duyệt.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

Không có phát hiện mức trung bình / cao được xác nhận; các nghi vấn đã đọc code để loại:

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Ô lịch gần nửa đêm rơi sai ngày / phụ thuộc múi giờ trình duyệt | Không lỗi — `isoToVnInput` / `vnToIso` / `rangeOfDays` / `todayKey` cộng UTC+7 cố định trên `getUTC*` | reject |
| Thả về quá khứ / hôm nay nhưng giờ sớm hơn | Không lỗi — `planMove` chặn `≤ now` (cả ô tháng giữ giờ), server vẫn 422 `SCHEDULE_IN_PAST` | reject |
| Kéo bài `publishing` / `published` | Không lỗi — `canDrag` chỉ `scheduled|failed`; server `FROM` → 409 | reject |
| `cancel` đua với job đã chiếm target | Không lỗi — `transitionTarget` khoá `FOR UPDATE` rồi kiểm trạng thái (đã `publishing` → 409); job chiếm bằng `UPDATE … status='scheduled' AND schedule_version=?` nên thấy `cancelled` / version mới thì bỏ qua; `markFailed` / `returnToScheduled` cũng có điều kiện | reject |
| Sửa deadlock chưa đủ (khoá khác cùng transaction ngược thứ tự) | Không lỗi — thứ tự luôn `posts` → target theo id → advisory theo `pageId`; chỉ `transitionPostTargets` lấy khoá `publish_limit`, phần còn lại trong vòng lặp là đọc / ghi dòng đã khoá | reject |
| Lịch lộ target của trang đã gỡ / ngoài phạm vi | Không lỗi — `resolveScope` lọc `removed_at`, `visiblePageIds` bỏ trang đã gỡ, nhóm/trang lạ 404 | reject |
| N+1 / auth / nội dung trong log | Không lỗi — một truy vấn (subquery tương quan cho ảnh / cờ AI), route sau hook phiên (test 401), không log caption | reject |

## Design Notes

- **Cờ `ai`:** caption AI chưa được lưu trước 6.5 (chỉ ở state Soạn bài) nên thêm `post_targets.ai_caption` do web gửi theo nhãn "AI tạo" của tab (app một chủ, không cần chống giả). Bài có ảnh AI hoặc slot chiến dịch cũng tính là "AI tạo" — nội dung do AI sinh, đúng tinh thần UX-DR10.
- **Kéo bài lỗi = "Đăng lại" vào giờ mới:** AD-13 cho kéo mọi target chưa `publishing/published/cancelled`; với `failed` chỉ có `retry` đưa về `scheduled` kèm giờ mới, nên dùng đúng đường đó (cùng kiểm luật + giới hạn/24h).
- **Gom theo cả trạng thái:** nhóm có một trạng thái nên một lần kéo là một hành động, tất cả hoặc không; bài 3 trang có một trang lỗi hiện thêm ô đỏ riêng — dễ thấy hơn gộp.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới cho `post_targets`.
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `META_FAKE=1` + worker: lên lịch bài 3 trang; `/lich` tuần/tháng hiện một ô; kéo sang ngày khác; "Xoá" → biến mất; bài lỗi đỏ + "Đăng lại".
