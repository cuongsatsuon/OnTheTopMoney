---
title: 'Story 4.2 — Tự đăng ký webhook trang và theo dõi sức khoẻ webhook'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '8605199aed54b47915ea51d0d5597b1f2606d3b0'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-4-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.2 (PM duyệt), AD-4, AD-5, AD-24">

## Intent

**Problem:** Trang vừa kết nối chưa được đăng ký nhận webhook: chủ shop phải vào Meta bật tay, và nếu webhook im lặng thì không ai biết là tin đang không về.

**Approach:** Thêm job `connections.subscribe_page`. Job được enqueue khi xác nhận hoặc kết nối lại trang, và chạy bù một lần cho các trang đã kết nối từ trước. Lỗi đăng ký được lưu và hiện ở đúng trang đó. Module `webhooks` có thêm bảng `webhook_health` và cron `webhooks.health` (5 phút) tính trạng thái cho `meta` và `threads` (`waiting_first|ok|stalled`), phát `webhook.stalled|recovered`. Có API sức khoẻ để Cài đặt › Webhook hiện tin gần nhất, Hộp thư hiện banner vàng khi webhook ngừng nhận tin.

## Boundaries & Constraints

**Always:**
- Job `connections.subscribe_page {pageId}` lấy token bằng `getAccessToken` ngay trước khi gọi.
  - Fanpage: gọi `POST /{platformAccountId}/subscribed_apps`, `subscribed_fields=messages,messaging_postbacks,message_echoes,feed`.
  - IG: đăng ký Fanpage nguồn của nó với cùng field. Field IG `messages`, `comments` bật ở cấp app (ghi runbook).
  - Threads: không có API đăng ký theo tài khoản (field `replies` bật ở cấp app). Job ghi thành công mà không gọi mạng.
- Kết quả đăng ký lưu trên `page_credentials`: `webhook_subscribed_at` và `webhook_subscribe_error`, mã lỗi chẩn đoán trong số `PERMISSION_DENIED|TOKEN_INVALID|REJECTED|FAILED`.
  - `TOKEN_INVALID` → `markDisconnected`.
  - `RATE_LIMITED`/`TRANSIENT` → ném lỗi để retry, theo policy `connections.*` của AD-24 (retry 3, concurrency 2).
  - Thành công thì xoá lỗi cũ.
- Enqueue trong CÙNG transaction của `confirmConnections` (AD-2), cho mọi trang vừa upsert, kể cả trang đang `active` được xác nhận lại. Chạy bù: khi worker khởi động, enqueue cho trang chưa gỡ, không `disconnected`, mà `webhook_subscribed_at IS NULL AND webhook_subscribe_error IS NULL`. Chạy lại an toàn (idempotent).
- Cron `webhooks.health` (`*/5 * * * *`, tz VN) chạy riêng cho từng sản phẩm:
  - `lastEventAt` = `max(received_at)` của `webhook_events` không phải `test`.
  - Chưa có sự kiện nào → `waiting_first`.
  - `stalled` khi đồng thời: (a) sản phẩm có trang `active` (meta: facebook/instagram; threads: threads), (b) giờ VN hiện tại trong 08:00–22:00, (c) `now − max(lastEventAt, 08:00 hôm nay giờ VN) > 30 phút`. Ngoài các trường hợp trên → `ok`.
  - Sang `stalled` thì phát `webhook.stalled {id: product, product}` một lần. Từ `stalled` sang khác thì phát `webhook.recovered`. Ghi và phát trong cùng transaction.
- `GET /api/v1/webhooks/health` trả:
  - `products[]`: `{product, status, lastEventAt}`.
  - `pageSubscriptionErrors[]`: `{pageId, name, platform, errorCode}`, chỉ trang chưa gỡ.
- FE:
  - Cài đặt › Webhook: mỗi sản phẩm hiện "Đang chờ tin đầu tiên" hoặc "Nhận tin gần nhất: vừa xong/x phút trước", `stalled` thì chip cảnh báo. Có danh sách trang đăng ký lỗi, kèm câu tiếng Việt theo mã.
  - Chi tiết trang: cảnh báo khi trang đó đăng ký lỗi.
  - Hộp thư: banner vàng "Chưa nhận tin mới 30 phút — Kiểm tra webhook" khi có sản phẩm `stalled`, link tới `/cai-dat?section=webhook`.
  - Query key gốc `['webhooks', …]` để hint realtime `webhook.*` tự làm cũ.

**Never:** Không gọi Meta trong request API hay trong transaction. Không log token. Không đăng ký field cấp app qua API (đó là việc một lần, ghi runbook). Không tạo thông báo cho `webhook.stalled` (story này chỉ có banner). Không làm thật luồng Hộp thư (vẫn dữ liệu mẫu, chỉ thêm banner).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected | Error |
|---|---|---|---|
| Xác nhận Fanpage | confirm 1 FB | 1 job; `subscribed_apps` đủ 4 field; `webhook_subscribed_at` đặt | |
| Xác nhận IG | IG + Fanpage nguồn | đăng ký trên Fanpage nguồn | |
| Threads | trang threads | thành công, không gọi mạng | |
| Thiếu quyền | Meta `PERMISSION_DENIED` | lưu lỗi, job kết thúc (không retry); hiện ở trang | |
| Token hỏng | `TOKEN_INVALID` | `markDisconnected` + lưu lỗi | |
| Trang gỡ/mất kết nối khi job chạy | | bỏ qua, không lỗi | |
| Chạy bù | 2 trang cũ chưa đăng ký, 1 đã đăng ký | enqueue 2 | |
| Chưa từng có sự kiện | | `waiting_first` | |
| Im 31 phút lúc 10:00 VN, có trang active | | `stalled` + `webhook.stalled` một lần (cron sau không phát lại) | |
| Im lâu nhưng là 23:00 hoặc 08:20 VN | | không `stalled` | |
| Không có trang active | | không `stalled` | |
| Có sự kiện lại | trước đó `stalled` | `ok` + `webhook.recovered` | |

</frozen-after-approval>

## Code Map

- `server/src/modules/connections/confirm.ts` -- thêm `jobs: JobSender` vào deps; enqueue `connections.subscribe_page` bằng `bossDbFor(tx)` (giống `webhooks/service.ts` `ingestWebhook`). Gọi từ `app/connections.ts:51`; dựng `jobs` trong `app/deps.ts` (`createJobSender(boss)`) và `app/app.ts`.
- `server/src/modules/connections/subscribe.ts` (MỚI) -- `subscribePage(deps {db, events, cipher, graph, log}, pageId)` + `enqueueMissingSubscriptions(db, jobs)`. Dùng lại `getAccessToken` (`credentials.ts`), `markDisconnected` (`token-check.ts`), `getPage`. Export ở `index.ts`.
- `server/src/modules/connections/schema.ts` + migration `server/drizzle/0015_*.sql` (dùng `drizzle-kit generate` như các migration trước) -- 2 cột mới trên `page_credentials`.
- `server/src/modules/connections/fake-meta.ts` -- fake trả `{success:true}` cho `POST …/subscribed_apps`.
- `server/src/adapters/meta/client.ts` -- `post(path, {token, tier:'background', scope:'page:<id>', params|form})`. Kiểm tên hạng thật trong `rate.ts`.
- `server/src/platform/jobs/queues.ts` -- khai báo `connections.subscribe_page` (standard, retry 3, backoff, concurrency 2) và `webhooks.health` (cron, retry 1, concurrency 1), thêm payload vào `QueuePayloads`. Sửa comment của `webhook.route` đang hứa dead-letter ở 4.2 (giữ không critical; ghi việc hoãn).
- `server/src/worker/main.ts` -- worker đã có `threads`; lấy thêm `graph` từ `createMetaClients`. Đăng ký 2 handler, gọi `enqueueMissingSubscriptions` sau `startWorkers`.
- `server/src/modules/webhooks/health.ts` (MỚI) + `schema.ts` (bảng `webhook_health`: product PK, status, last_event_at, status_changed_at, checked_at) -- `computeHealthStatus` thuần (nhận `now`, `lastEventAt`, `hasActivePages`) + `runHealthCheck(deps {db, events, now})` + `getWebhookHealth(db)`. Trang active đọc qua `pages` (`listPages`); lỗi đăng ký đọc qua một hàm export của `connections` (webhooks → connections được phép theo AD-1).
- `server/src/app/webhooks.ts` -- `GET /api/v1/webhooks/health`.
- `packages/shared/src/webhooks.ts` -- `WebhookHealthResponse`; `WebhookSubscribeError` enum.
- `web/src/lib/webhooks.ts` -- `useWebhookHealth` (key `['webhooks','health']`, refetch 60 giây) + helper thuần `lastEventLabel`, `subscribeErrorLabel`.
- `web/src/screens/Settings.tsx` -- khối sức khoẻ trong section webhook; đọc `?section=webhook` để mở đúng section (hiện chỉ đọc tham số kết nối, dòng 119).
- `web/src/screens/Inbox.tsx` -- banner trên đầu danh sách. `web/src/screens/PageDetail.tsx` -- cảnh báo lỗi đăng ký.
- `deploy/` runbook -- bước bật field cấp app (Page/IG/Threads) một lần.

## Tasks & Acceptance

**Execution:**
- [x] shared: DTO health + enum lỗi đăng ký.
- [x] connections: cột + migration, `subscribePage`, `enqueueMissingSubscriptions`, enqueue trong confirm, fake Graph.
- [x] queues + worker: 2 queue, handler, chạy bù khi khởi động.
- [x] webhooks: bảng `webhook_health` + migration, `computeHealthStatus`, `runHealthCheck`, `getWebhookHealth`; route API.
- [x] web: hook + helper, Settings (section từ URL), banner Inbox, cảnh báo PageDetail.
- [x] runbook: bật field cấp app.
- [x] Test server: các dòng I/O matrix (`computeHealthStatus` biên 08:00/08:30/22:00/30 phút; chuyển trạng thái phát sự kiện đúng một lần; subscribe từng nền tảng/lỗi; confirm enqueue trong transaction; chạy bù chọn đúng trang). Test web: helper nhãn.

**Acceptance Criteria:**
- Given 3 AC của epics.md Story 4.2, when `npm run check`, then đều có test và xanh.
- Given webhook `stalled`, when mở Hộp thư, then thấy banner vàng dẫn tới Cài đặt › Webhook; khi `recovered` (hint realtime), banner biến mất mà không cần tải lại trang.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (chỉ blind — người dùng yêu cầu review gọn) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| API trả `stalled` cạnh "vừa xong" tới 5 phút sau khi tin về lại | medium | patch (API hạ `stalled` → `ok` khi lastEventAt ≤30 phút) |
| Retry `subscribe_page` hết trong <1 phút, chặn tần suất Meta kéo dài vài phút → FAILED vĩnh viễn | medium | patch (retryDelay 60 giây, backoff) |
| Banner Hộp thư không nói sản phẩm nào ngừng | low | patch (thêm nhãn sản phẩm) |
| Worker/cron chết → API giữ trạng thái cũ mãi | medium | defer (cần dùng `checked_at`; /healthz đã báo worker chết) |
| Trang FAILED chỉ phục hồi bằng kết nối lại, không có nút đăng ký lại | medium | defer |
| Gỡ trang không huỷ `subscribed_apps` ở Meta | medium | defer |
| Webhook chưa từng chạy (`waiting_first` có trang active) không cảnh báo | low | reject (đúng AC frozen) |
| Trang `expiring` không tính là active khi xét stalled | low | reject (đúng spec frozen "trang active") |
| Hai lần cron chồng nhau lần đầu có thể phát trùng `webhook.stalled` | low | reject (cron concurrency 1, một worker) |
| `markFailed` nuốt lỗi không log; job hết hạn không ghi FAILED | low | reject (hiếm, chạy bù lần sau không chọn lại được nhưng trang vẫn hiện chưa đăng ký) |
| Thiếu test nhánh `success:false`, wiring worker, component web | low | reject |
| PageDetail cảnh báo không có nút kết nối lại; `?section=` ở lại URL | low | reject |
| IG chung tín hiệu `meta` nên sự cố riêng IG bị che | low | reject (giới hạn đã biết của AD-4) |
| Index migration không CONCURRENTLY/partial | low | reject (bảng nhỏ ở giai đoạn này) |
| Fanpage bị đăng ký hai lần khi xác nhận IG | low | reject (idempotent phía Meta) |

## Verification

**Commands:**
- `npm run check` -- expected: typecheck, lint, depcruise, test đều xanh.
