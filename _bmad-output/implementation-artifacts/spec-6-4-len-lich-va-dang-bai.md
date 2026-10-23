---
title: 'Story 6.4 — Lên lịch và đăng bài theo từng trang'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'dd22c79817c281100083b752a346630d990c9be6'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-6-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 6.4, AD-13, AD-6, AD-14, AD-24; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Soạn bài đã lưu được nháp nhiều trang (6.1–6.3) nhưng "Lên lịch" / "Đăng ngay" còn khoá: chưa có chuyển trạng thái `post_targets`, chưa có job đăng, chưa có hàm đăng FB/IG/Threads trong `adapters/meta`. Ngoài ra ảnh dọc chụp điện thoại (3:4, 9:16) nằm ngoài khung ảnh feed Instagram, và nginx chặn ảnh tải lên >2 MB (413, ở chế độ tách còn thiếu CORS nên web chỉ thấy lỗi mạng).

**Approach:**
- `content.transitionTarget` (khoá lạc quan `version`) cho các hành động của chủ shop: lên lịch / đăng ngay, đổi giờ, bỏ lịch, đăng lại. Mọi chuyển tới `scheduled` qua `assertPublishable` + giới hạn đăng/24h, rồi enqueue `publish.target` cùng transaction.
- Job `publish.target` chiếm target bằng `UPDATE … WHERE status='scheduled' AND schedule_version=?`, đăng ngoài transaction qua `adapters/meta`. Chỉ retry khi chắc Meta chưa tạo bài. Cron `content.requeue` vá job mất và target kẹt.
- Composer mở "Lên lịch" / "Đăng ngay" theo giờ VN. Bài đã rời nháp hiện trạng thái từng trang, có "Bỏ lịch", "Đổi giờ", "Đăng lại". Toast "Đã đăng" qua SSE.

## Boundaries & Constraints

**Always:**
- **Hợp đồng (shared `content.ts`):**
  - `PLATFORM_RULES[*].dailyPublishMax`: facebook `null` (Meta không công bố), instagram 100, threads 250 [theo tài liệu Meta, kiểm lại trong job].
  - `instagramImageFit(w, h)` → `ok | pad_tall | pad_wide`, khung `4:5 – 1,91:1`. FE (xem trước) và server (URL đăng) dùng chung.
  - `TransitionTargetsRequest` (strict):
    - `action ∈ schedule | reschedule | unschedule | retry`;
    - `scheduledAt`: ISO UTC; `null` = ngay. Bắt buộc có khoá với mọi action trừ `unschedule`, và cấm với `unschedule`;
    - `targets[{id, version}]` (1–50, không trùng).
  - `PostTargetDto` thêm `publishedAt`, `permalink`.
- **Bảng `post_targets` (migration `drizzle-kit generate`):**
  - Thêm `publishing_at`, `published_at`, `platform_post_id`, `permalink`.
  - Check: `(status='failed') = (error_code is not null)`; `scheduled ⇒ scheduled_at not null`.
  - Index `(status, scheduled_at)` cho cron.
- **`POST /api/v1/posts/:id/targets/transition`** → 200 `PostDto`. MỘT transaction, tất cả hoặc không:
  - Khoá `posts` rồi các target (cùng thứ tự với `updateDraftPost`).
  - Target không thuộc bài → 404. `version` lệch hoặc sai trạng thái nguồn → 409 `VERSION_CONFLICT`.
  - `scheduledAt` ≤ now → 422 `SCHEDULE_IN_PAST`; > now + 366 ngày → 400.
  - Chuyển tới `scheduled` (schedule: `draft→`; reschedule: `scheduled→`; retry: `failed→`):
    - `assertPublishable` (422 + `issues`);
    - giới hạn đăng/24h: khoá advisory theo trang, đếm target `scheduled|publishing|published` của trang có mốc (`published_at` hoặc `scheduled_at`) trong (t−24h, t+24h); ≥ giới hạn → 422 `PUBLISH_LIMIT_REACHED` {pageId, limit};
    - `schedule_version+1`, `version+1`, xoá `error_code`;
    - enqueue `publish.target {targetId, scheduleVersion}` `startAfter=scheduledAt` cùng transaction.
  - `unschedule` (`scheduled→draft`): `scheduled_at=null`, `schedule_version+1`.
- **Job `publish.target`** (`standard`, retry 5 backoff, concurrency 3, `critical`, hạn 300 giây):
  - Thứ tự xử lý:
    1. Target không còn / không `scheduled` / `schedule_version` lệch → bỏ qua im lặng (`held` chưa có cột — Epic 7).
    2. Trang đã gỡ → `failed PAGE_REMOVED`; `disconnected` → `failed PAGE_DISCONNECTED` (`expiring` vẫn đăng).
    3. `assertPublishable` lỗi → `failed` với mã đó.
    4. Chiếm `scheduled→publishing` (`publishing_at=now`).
  - Mọi lần ghi `failed` đều là `UPDATE` có điều kiện trạng thái, phát `post_target.failed {errorCode, version}` đúng một lần.
  - Token lấy qua `connections.getAccessToken` ngay trước khi gọi; hạng `publish`.
  - Cách đăng:
    - FB: có ảnh `/{page}/photos {url, message}`, không ảnh `/{page}/feed {message}`;
    - IG: `/{ig}/media {image_url, caption}` → hỏi `status_code` tới `FINISHED` → `/{ig}/media_publish`;
    - Threads: `/me/threads` (TEXT/IMAGE) → hỏi `status` tới `FINISHED` → `/me/threads_publish`;
    - IG/Threads kiểm `content_publishing_limit` / `threads_publishing_limit` trước (lỗi khi kiểm thì bỏ qua); đã hết → `failed PUBLISH_LIMIT_REACHED`.
  - Ảnh IG ngoài khung → URL Cloudinary đệm nền trắng (`c_pad`) vào khung gần nhất; IG/Threads rộng >1440 px → thu nhỏ. Ảnh gốc giữ nguyên.
  - Thành công → `published` + `PublishedRef` (`publishedRefFrom*`) + `published_at`, phát `post_target.published`. Sau đó lấy permalink (lỗi thì bỏ qua).
  - Ánh xạ lỗi:
    - `REJECTED` → `PUBLISH_REJECTED`; `TOKEN_INVALID` → `markDisconnected` (trang giữ token) + `PAGE_DISCONNECTED`; `PERMISSION_DENIED` → `PAGE_DISCONNECTED`;
    - container `ERROR|EXPIRED` → `PUBLISH_REJECTED`;
    - `RATE_LIMITED` → trả `scheduled` + job mới `startAfter` (không tính lượt); trễ quá 30 phút so với `scheduled_at` → `PUBLISH_FAILED`;
    - lỗi tạm ở bước KHÔNG tạo bài (container, hỏi trạng thái, `notSent`) → trả `scheduled` rồi ném; lần cuối → `PUBLISH_FAILED`.
- **Chống đăng trùng:** bước tạo bài (FB `feed/photos`, `media_publish`, `threads_publish`) gặp hết giờ / lỗi mạng sau khi gửi / 5xx / phản hồi không đọc được → KHÔNG retry.
  - IG/Threads: hỏi trạng thái container một lần; `PUBLISHED` → `published` (không có id).
  - Còn lại → `failed PUBLISH_UNKNOWN`.
  - Adapter đánh dấu `notSent` cho lỗi chắc chắn chưa rời máy: chặn tần suất trước khi gửi, store lỗi, không kết nối được (DNS / từ chối / hết giờ kết nối).
- **Cron `content.requeue`** (`*/15`, tz VN):
  - Target `scheduled` có `scheduled_at < now−10 phút` mà không có job `publish.target` sống (created/retry/active) cùng `{targetId, scheduleVersion}` → enqueue lại.
  - Target `publishing` có `publishing_at < now−15 phút` → `failed PUBLISH_UNKNOWN`.
- **Web:**
  - Footer có ngày + giờ theo giờ VN (mặc định 19:00 hôm nay, đã qua thì ngày mai), "Lên lịch", "Đăng ngay".
  - Bấm → lưu nháp (POST/PUT) rồi `transition schedule` mọi target. Khoá khi: có tab vi phạm luật, trang đã chọn mất kết nối, giờ đã qua.
  - Bài có target rời nháp → chế độ chỉ xem:
    - không sửa chữ / ảnh / đích;
    - mỗi tab có nhãn trạng thái (Đã lên lịch giờ…, Đang đăng…, Đã đăng + "Xem bài", Lỗi + câu theo mã);
    - footer: "Bỏ lịch" + "Đổi giờ" cho target `scheduled`, "Đăng lại" (giờ chọn) / "Đăng lại ngay" cho target `failed`.
  - SSE `post_target.*` làm cũ `['posts', …]`. Toast "Đã đăng lên <trang>" (gộp nhiều trang).
  - Xem trước IG đệm trắng khi ảnh ngoài khung, kèm câu giải thích.
- **nginx:** `/api/v1/media-assets` vào location body 11 MB (cả hai mẫu). `nginx-api` gắn `Access-Control-Allow-Origin` + `Allow-Credentials` cho origin được phép khi api không tự đặt (lỗi do nginx sinh).

**Never:**
- Không gọi Meta trong request API hay trong transaction. Không log token / caption / URL có token.
- Không tự đăng lại khi không rõ kết quả (`PUBLISH_UNKNOWN`). Không dùng `singletonKey` cho `publish.target`.
- Không huỷ (`cancelled`), không sửa nội dung target đã rời nháp, không kéo thả lịch, không nối Lịch nội dung (Story 6.5). Không `held` / `pending_approval` (Epic 7). Không cắt ảnh (chỉ đệm).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lên lịch 3 trang | 3 target `draft` hợp lệ, `scheduledAt` Thứ Bảy 19:00 VN (12:00Z) | 200; 3 target `scheduled`, `scheduled_at`=12:00Z, `schedule_version` 1; 3 job `startAfter` 12:00Z, data `{targetId, scheduleVersion:1}` | |
| Đăng ngay | `scheduledAt: null` | `scheduled_at`=now, job chạy ngay | |
| Một trang vi phạm | IG không ảnh trong 3 target | 422 `MEDIA_REQUIRED` + `details.pageId`; không target nào đổi, không job | tất cả hoặc không |
| Giờ / phiên bản / trạng thái sai | `scheduledAt` quá khứ; version cũ; `retry` trên `draft`; target bài khác; body thiếu `scheduledAt` | 422 `SCHEDULE_IN_PAST`; 409; 409; 404; 400 | không đổi gì |
| Giới hạn/24h | trang IG đã có 100 target trong ±24h | 422 `PUBLISH_LIMIT_REACHED` | |
| Bỏ lịch / đổi giờ | `scheduled` → `unschedule` / `reschedule` | `draft`, `scheduled_at` null, version lịch +1 / giờ mới + job mới; job cũ chạy tới → bỏ qua, không gọi Meta | `publishing` → 409 |
| Job lệch / chạy trùng | version cũ; target `publishing`/`published`; target đã xoá | bỏ qua im lặng, không gọi Meta | |
| Trang không dùng được | gỡ / `disconnected` / `expiring` | `failed PAGE_REMOVED` / `PAGE_DISCONNECTED` / đăng bình thường | |
| Đăng FB | có ảnh / chỉ chữ | `/photos {url,message}` → `platform_post_id`=`post_id` / `/feed {message}`; `published`, sự kiện, permalink | |
| Đăng IG | ảnh 3:4, 4032 px | container `image_url` có `c_pad` khung 4:5 rộng ≤1440, hỏi tới `FINISHED`, `media_publish`, id media | container `ERROR` → `PUBLISH_REJECTED` |
| Đăng Threads | chỉ chữ / có ảnh | container TEXT / IMAGE → `threads_publish` | |
| Hết hạn mức đăng Meta | `quota_usage ≥ quota_total` | `failed PUBLISH_LIMIT_REACHED`, không tạo container | lỗi khi kiểm → vẫn đăng |
| Lỗi Meta dứt khoát | `REJECTED` / `TOKEN_INVALID` / `PERMISSION_DENIED` | `PUBLISH_REJECTED` / `PAGE_DISCONNECTED` + trang giữ token `disconnected` / `PAGE_DISCONNECTED`; `post_target.failed` một lần | không retry |
| Lỗi tạm trước bước tạo bài | container 5xx / hỏi trạng thái quá lâu / `notSent` | trả `scheduled` (giữ version) rồi ném; lần cuối `PUBLISH_FAILED` | |
| Không rõ ở bước tạo bài | FB hết giờ / 5xx; IG `media_publish` hết giờ + container `FINISHED` / `PUBLISHED` | `PUBLISH_UNKNOWN` / `PUBLISH_UNKNOWN` / `published` (không id); không retry, không gọi publish lần hai | |
| `RATE_LIMITED` | chặn 60 giây / trễ >30 phút | `scheduled` + job mới `startAfter` / `PUBLISH_FAILED` | |
| Một trang lỗi | 3 target, IG `REJECTED` | chỉ IG `failed`; FB, Threads `published` | |
| Đăng lại | `failed` → `retry` (giờ mới / ngay) | `scheduled`, `error_code` null, version lịch +1, job mới; lần lỗi sau vẫn có thông báo (dedupe theo `version`) | |
| Cron requeue | `scheduled` quá 11 phút không job / có job chờ; `publishing` 16 / 10 phút | enqueue lại / không; `PUBLISH_UNKNOWN` / giữ | |
| Chưa đăng nhập | | 401 | |
| Web giờ VN | 31/10/2026 19:00 | `2026-10-31T12:00:00.000Z`; hiển thị lại "19:00 · Thứ Bảy 31/10" | ngày/giờ trống hoặc đã qua → báo trước khi gửi |
| Web chế độ bài | mọi target `draft` / có target khác `draft` | sửa được / chỉ xem; nút theo trạng thái (Bỏ lịch, Đăng lại) | |
| Web toast | `post_target.published` cho 1 / 3 trang | "Đã đăng lên <trang>" / "Đã đăng lên 3 trang" | |
| Web khung IG | ảnh 3:4 / 1:1 / 3:1 | đệm dọc / giữ / đệm ngang | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/{content,index}.ts` -- `dailyPublishMax`, `instagramImageFit`, `TransitionTargetsRequest`, DTO target mới.
- `server/src/adapters/meta/{client,errors}.ts` -- cờ `notSent`.
- `server/src/adapters/media/index.ts` -- `imageVariantUrl` (chèn transformation vào URL công khai).
- `server/src/modules/content/{schema,posts,transitions,publish,requeue,index}.ts` -- cột mới; chuyển trạng thái; job đăng; cron.
- `server/drizzle/0029_illegal_ultimatum.sql` -- migration.
- `server/src/platform/jobs/{queues,boss,index}.ts` -- `publish.target`, `content.requeue`, `hasLiveJob`.
- `server/src/app/{posts,app}.ts`, `server/src/app/main.ts`, `server/src/worker/main.ts` -- route + handler.
- `server/src/modules/connections/fake-meta.ts` -- Meta giả cho đường đăng (dev).
- `server/test/content-publish.test.ts` (MỚI) -- ma trận server.
- `web/src/lib/{publish,composer,realtime}.ts` + test, `web/src/screens/Composer.tsx`, `web/src/components/AppShell.tsx` -- giờ VN, chế độ bài, toast.
- `deploy/nginx*.conf.example`, `.github/workflows/ci.yml` -- body 11 MB + CORS lỗi nginx.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/content.ts` -- hợp đồng chuyển trạng thái, luật/24h, khung IG -- AD-13, AD-18.
- [x] `server/src/adapters/meta/*`, `adapters/media/index.ts` -- `notSent`, URL biến thể ảnh -- AD-6, AD-14.
- [x] `server/src/modules/content/schema.ts` + migration -- cột đăng, check, index.
- [x] `server/src/modules/content/transitions.ts` -- `transitionTarget` / `transitionPostTargets` + giới hạn/24h -- AD-13.
- [x] `server/src/modules/content/publish.ts`, `requeue.ts` -- job + cron -- AD-13, AD-24.
- [x] `server/src/platform/jobs/*`, `app/*`, `worker/main.ts`, `connections/fake-meta.ts` -- queue, route, handler, Meta giả.
- [x] `server/test/content-publish.test.ts` -- phủ các dòng server của ma trận.
- [x] `web/src/lib/publish.ts` (MỚI) + test, `composer.ts`, `realtime.ts` -- helper giờ VN / chế độ / toast, làm cũ `posts`.
- [x] `web/src/screens/Composer.tsx`, `components/AppShell.tsx` -- footer lên lịch, chế độ chỉ xem, toast.
- [x] `deploy/*`, `.github/workflows/ci.yml`, `deferred-work.md` -- nginx; ghi/gỡ việc hoãn.

**Acceptance Criteria:**
- Given bài nháp 3 trang, when bấm "Lên lịch" Thứ Bảy 19:00, then 3 target `scheduled` lúc 12:00Z và tới giờ job đăng từng trang; một trang lỗi không chặn hai trang kia.
- Given `npm run check` ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Shared:** `PLATFORM_RULES[*].dailyPublishMax`, `INSTAGRAM_ASPECT` + `instagramImageFit`, `TARGET_ACTIONS` / `TransitionTargetsRequest`, `SCHEDULE_MAX_AHEAD_MS`; `PostTargetDto.publishedAt|permalink`.
- **Adapter:**
  - `MetaFailure.notSent` cho chặn tần suất trước khi gửi, store tần suất lỗi, lỗi pha mở kết nối (`ENOTFOUND`, `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT`… — đọc qua `cause`). Hết giờ / đứt giữa chừng / 5xx không có cờ.
  - `adapters/media.fitImageUrl` chèn `c_pad,w_,h_,b_white` hoặc `c_limit,w_` vào URL giao; bản gốc giữ nguyên.
- **Server:**
  - Migration `0029_illegal_ultimatum.sql`: 4 cột, 2 check, index `(status, scheduled_at)`.
  - `content/transitions.ts`: khoá `posts` → target theo id. Giới hạn/24h đếm bảo thủ ±24h, khoá advisory theo trang.
  - `content/publish.ts`: job; bước tạo bài không truyền `job.signal`.
  - `content/requeue.ts`: cron. `platform/jobs.hasLiveJob` (jsonb `@>` trên `pgboss.job`).
  - Route `POST /api/v1/posts/:id/targets/transition` (chỉ khi có `jobs`); worker đăng ký `publish.target`, `content.requeue`; Meta giả dev cho feed / photos / media / container.
  - `post_target.*` mang `version` → thông báo `publish_failed` không bị gộp giữa hai lần lỗi.
- **Lệch AD-13 có chủ đích** (ghi ở Design Notes):
  - `RATE_LIMITED` quá 30 phút → `PUBLISH_FAILED`;
  - trang đã gỡ → `PAGE_REMOVED`;
  - `held` chưa có cột (Epic 7) nên cron coi mọi target là `held=false`;
  - `expiring` vẫn đăng (token còn dùng được), chỉ `disconnected` mới chặn.
- **Web:**
  - `lib/publish.ts`: giờ VN, nhãn trạng thái, câu lỗi theo trang, toast, `useTransitionTargets`, `usePublishedToasts` (gộp 1,5 giây, ở AppShell).
  - `usePost` có `poll` (5 giây khi còn trang đang đăng). `realtime`: `post_target` → `posts`.
  - Composer:
    - footer ngày / giờ VN + "Lên lịch" / "Đăng ngay" (lưu nháp rồi chuyển);
    - chế độ chỉ xem bằng `fieldset disabled`, nhãn / biểu tượng trạng thái trên tab, "Xem bài";
    - "Bỏ lịch", "Đổi giờ", "Đăng lại lúc này" / "Đăng lại ngay";
    - xem trước IG đệm trắng.
- **nginx:**
  - `/api/v1/media-assets` vào location 11 MB ở cả hai mẫu — trước đây ảnh >2 MB bị nginx chặn 413.
  - `nginx-api` gắn `Access-Control-Allow-Origin` / `Allow-Credentials` / `Vary` cho origin web khi api không tự đặt.
  - CI sed thêm `app.example.com`; runbook mục 8 cập nhật. Chưa chạy `nginx -t` tại máy (không có image nginx), CI sẽ kiểm.
- **Việc hoãn:**
  - Gỡ hai mục: tỉ lệ ảnh IG, CORS 413.
  - Thêm ba mục: kiểm bằng Meta / Cloudinary thật; sửa / huỷ target đã rời nháp (6.5); job hết hạn rồi trả `scheduled` phải chờ cron.
  - Mục `SEND_UNKNOWN` của 4.7 ghi thêm cờ `notSent`.
- **Kiểm tra:** `npm run check` thoát 0 — depcruise sạch, server 62 file / 1298 test (26 mới ở `content-publish.test.ts`), web 20 file / 281 test. Chưa thử bằng trình duyệt.

## Spec Change Log

## Review Triage Log

### Lượt 1 (review gọn)

Đã kiểm: đường đăng trùng (retry sau khi Meta đã tạo bài, cron requeue với job đang chạy, job cũ sau đổi giờ / bỏ lịch, job hết hạn của pg-boss 12, container IG / Threads), cờ `notSent`, giờ VN / ISO `Z`, giới hạn/24h, `markDisconnected` trang giữ token, trang gỡ / mất kết nối, thứ tự location + CORS `always` của nginx, log. Không thấy lỗi mức trung bình / cao cần vá.

| Phát hiện | Verdict | Route |
|---|---|---|
| Khoá advisory `publish_limit:<page>` lấy theo thứ tự target trong body (không sắp theo trang): hai request lên lịch hai bài khác nhau cùng chạm 2 trang IG/Threads theo thứ tự ngược nhau → deadlock, Postgres huỷ một request (500). Hiếm khi chỉ chủ shop bấm; dễ gặp hơn khi Epic 7 tự lên lịch chiến dịch song song. | đúng, thấp | `defer` |
| Target kẹt `publishing` > 15 phút bị cron đổi `failed PUBLISH_UNKNOWN`; nếu handler cũ sau đó đăng xong thì `markPublished` (chỉ nhận `publishing`) bỏ qua → target vẫn `failed` dù đã biết bài lên, chủ shop dễ "Đăng lại" → trùng. Cần handler chạy >15 phút (mỗi lời gọi Meta ≤30 giây, job hết hạn 300 giây) nên rất hiếm. | đúng, thấp | `defer` |

## Design Notes

- **Vì sao đệm trắng thay vì cắt hoặc chặn ảnh IG ngoài khung:**
  - Ảnh điện thoại 3:4 rất phổ biến; chặn khi lên lịch sẽ chặn đúng ca hay gặp nhất.
  - Cắt 9:16 về 4:5 mất ~30% ảnh, có thể cắt mất sản phẩm.
  - Đệm giữ trọn ảnh và xem trước hiện đúng như sẽ đăng.
- **Chống trùng:** chỉ trả `scheduled` khi chắc Meta chưa tạo bài. Lỗi trước khi gửi, hoặc lỗi ở bước container, đều không tạo bài. Job hết hạn mà vẫn chạy thì lần retry thấy `publishing` và bỏ qua; cron biến target kẹt thành `PUBLISH_UNKNOWN`.
- **Lệch AD-13 có chủ đích:** `RATE_LIMITED` kéo dài → `PUBLISH_FAILED`, không phải `PAGE_DISCONNECTED` (trang vẫn kết nối, câu "mất kết nối" sai). Trang đã gỡ → `PAGE_REMOVED` (rõ hơn `PAGE_DISCONNECTED`).
- **Giới hạn/24h phía server** là kiểm bảo thủ trên dữ liệu của app (cửa sổ ±24h). Hạn mức thật của Meta (gồm bài đăng ngoài app) được kiểm lại trong job.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: đúng một migration mới cho `post_targets`.
- `npm run check` -- expected: thoát 0.

**Manual checks (if no CLI):**
- `META_FAKE=1` + worker: lên lịch 3 trang 2 phút sau → 3 tab "Đã lên lịch"; tới giờ đổi "Đã đăng" + toast; "Đăng ngay"; "Bỏ lịch" rồi sửa lại được.
