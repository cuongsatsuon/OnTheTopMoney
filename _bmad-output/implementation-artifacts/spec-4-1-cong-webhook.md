---
title: 'Story 4.1 — Cổng nhận webhook Meta và Threads'
type: 'feature'
created: '2026-10-23'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/planning-artifacts/epics.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 4.1 (PM duyệt), AD-4">

## Intent

**Problem:** Chưa có cổng nhận webhook. Cần nhận an toàn mọi sự kiện Meta/Threads (xác minh chữ ký trên raw body), tách thành mục, chống trùng, enqueue xử lý, và nhật ký ở Cài đặt › Webhook. Chưa có module `webhooks`, bảng `webhook_events`, hay xác minh HMAC webhook.

**Approach:** Module `webhooks` + bảng `webhook_events`; `POST /webhooks/{meta,threads}` xác minh `X-Hub-Signature-256` HMAC-SHA256 trên **raw body** (constant-time) với app secret đúng app, tách body thành mục (parser Graph + parser Threads riêng), mỗi mục một dòng `webhook_events` (khoá chống trùng), enqueue `webhook.route` mỗi mục, trả 200 nhanh (≤1s p95). `GET` trả `hub.challenge` khi verify token khớp. `webhook.route` chuẩn hoá + đặt `status`; trang không có/đã gỡ → lưu, không route (ingest vào inbox là Story 4.3/4.4 — nay chỉ stub route: status routed/ignored/failed không gọi inbox). FE Cài đặt › Webhook: URL + verify token + nhật ký + Xử lý lại + Gửi sự kiện thử.

## Boundaries & Constraints

**Always (bám AC epics.md Story 4.1 + AD-4):**
- `POST /webhooks/meta`, `POST /webhooks/threads`: xác minh HMAC-SHA256 trên **raw body** (không phải body đã parse) với app secret của đúng app (meta vs threads), so sánh constant-time (`crypto.timingSafeEqual`); sai/thiếu chữ ký → **401, không ghi gì**.
- Hợp lệ → tách body thành mục: Graph `entry[].messaging[]` và `entry[].changes[]`; Threads payload dạng riêng (parser riêng). Mỗi mục → một dòng `webhook_events` với **khoá chống trùng** của mục (`mid`/`comment_id`/id media nếu có; không thì hash của mục) → UNIQUE chặn bản thứ hai (kể cả Meta gửi lại gom khác). Mỗi mục enqueue một job `webhook.route`. Trả **200** trong ≤1s p95 (không xử lý nghiệp vụ trong request — AD-4).
- `GET /webhooks/{meta,threads}` với `hub.mode=subscribe` & `hub.verify_token` khớp `META_VERIFY_TOKEN` → trả `hub.challenge` (200 text); sai token → 403.
- `webhook.route` (job): chuẩn hoá qua `adapters/meta`; đặt `webhook_events.status` ∈ `received|routed|ignored|failed` + `error_code`. Story 4.1: trang không có trong DB/đã gỡ → `ignored` (lưu, không route); sự kiện cờ `test` → `ignored` (chỉ nhật ký); mục nhận diện được loại nhưng ingest là story sau → tạm `routed`/`ignored` theo loại (ghi chú; KHÔNG gọi inbox vì chưa có). Idempotent theo khoá mục.
- Cài đặt › Webhook: hai callback URL (`<PUBLIC_BASE_URL>/webhooks/meta`, `/webhooks/threads`) có nút sao chép; verify token đầy đủ (chủ shop xem được — đây là giá trị của chính họ, không phải secret của bên thứ ba); nhật ký: thời gian, trang (nếu biết), field/loại, `status`, lỗi; mục `failed` có "Xử lý lại" (enqueue lại); "Gửi sự kiện thử" tạo `webhook_events` cờ `test` chỉ ghi nhật ký.
- Secret (app secret, chữ ký) không log, không trả client (AD-12). Raw body chỉ dùng để verify rồi parse.

**Never:** Không xử lý nghiệp vụ trong request webhook (chỉ ghi + enqueue). Không verify trên body đã parse. Không gọi inbox (chưa có — Story 4.3/4.4). Không để lộ app secret. Không chặn 200 vì lỗi route (route chạy ở job).

## I/O & Edge-Case Matrix

| Scenario | Input | Expected | Error |
|----------|-------|----------|-------|
| POST chữ ký đúng | raw body + X-Hub-Signature-256 hợp lệ | tách mục, ghi webhook_events, enqueue route mỗi mục, 200 | |
| POST chữ ký sai/thiếu | | 401, KHÔNG ghi | |
| Gửi lại gom khác | cùng mid/comment_id | UNIQUE chặn bản 2 (1 dòng) | |
| GET verify đúng token | hub.verify_token khớp | 200 trả hub.challenge | sai → 403 |
| route: trang không có/đã gỡ | | status=ignored (lưu, không route) | |
| route: test event | cờ test | status=ignored, chỉ nhật ký | |
| Threads payload | dạng Threads | parser riêng tách đúng mục | |
| Nhật ký FE | mở Cài đặt › Webhook | URL + token + log + Xử lý lại (failed) + Gửi sự kiện thử | |
| Xử lý lại | mục failed | enqueue lại route | |

</frozen-after-approval>

## Code Map (điểm xuất phát — subagent điều tra thêm)

- `server/src/modules/webhooks/` (MỚI) — `schema.ts` (`webhook_events`: id, product(meta|threads), page_id nullable, field/type, dedupe_key, payload jsonb, status, error_code, test bool, received_at; UNIQUE(product, dedupe_key)), `parse.ts` (parser Graph + Threads → mục chuẩn), `service.ts` (ingestWebhook: verify đã xong ở route? hoặc verify ở đây), `route-job.ts` (handler `webhook.route`), `index.ts`.
- `server/src/adapters/meta/client.ts` — đã có `createHmac('sha256', appSecret)`; thêm `verifySignature(raw, header, appSecret)` constant-time nếu chưa có; chuẩn hoá mục qua adapter.
- `server/src/app/` — route webhook cần **raw body**: dùng `addContentTypeParser('application/json', { parseAs: 'buffer' })` cho scope webhook, hoặc `@fastify/raw-body`. Verify rồi mới JSON.parse. Đăng ký `/webhooks/*` ngoài guard phiên (công khai — AD-19 cho phép).
- `server/src/platform/jobs/queues.ts` + `worker/main.ts` — queue `webhook.route` (per-item; retry; critical? — [ASSUMPTION] chưa critical ở 4.1, dead-letter/job.failed ở story webhook health 4.2). Handler.
- `packages/shared/src/` — WebhookEventDto, WebhookStatus enum (received|routed|ignored|failed — kiểm WEBHOOK_EVENT_STATUS đã có ở enums?), log response schema.
- `server/src/app/` — API Cài đặt: `GET /webhooks/log` (nhật ký, phân trang), `POST /webhooks/test` (sự kiện thử), `POST /webhooks/events/:id/retry`.
- `web/src/screens/Settings.tsx` (section webhook, hiện mock: CALLBACK_URL, "Gửi sự kiện thử" giả) — nối API thật: 2 URL từ PUBLIC_BASE_URL, verify token, nhật ký, Xử lý lại, Gửi sự kiện thử; `web/src/lib/` hook.
- `META_VERIFY_TOKEN`: cần thêm lại vào config/env (đã gỡ ở lần dọn env trước — Story 4.1 dùng lại). Cập nhật env.production.example + docker-compose x-app-env + runbook.
- Runbook: ghi secret nào ký webhook Threads (xác nhận [ASSUMPTION] AD-4) — mục để điền khi có sự kiện Threads thật.

## Tasks & Acceptance

**Execution:**
- [ ] config/env: thêm lại `META_VERIFY_TOKEN` (compose x-app-env, env.production.example, runbook); dùng cho GET verify.
- [ ] BE: module webhooks (schema+migration, parser Graph+Threads, verify HMAC raw-body constant-time); route POST/GET; queue + handler webhook.route (status, ignore trang-không-có/test; chưa gọi inbox).
- [ ] BE: API nhật ký + test-event + retry.
- [ ] shared: DTO + status enum.
- [ ] FE: Cài đặt › Webhook nối API thật (URL, token, nhật ký, Xử lý lại, Gửi sự kiện thử).
- [ ] Test: server (verify đúng/sai→401 không ghi; tách mục Graph & Threads; dedup UNIQUE; GET challenge/403; route ignore trang-không-có & test; retry; raw-body verify đúng body thật); web (nhật ký render, test-event, copy URL — pure helpers).

**Acceptance Criteria:** AC epics.md Story 4.1 (frozen) đạt và có test. (AC "ghi secret ký Threads vào runbook" = thêm mục runbook để điền khi có sự kiện thật.)

## Verification
**Commands:** `npm run check` — xanh.

## Implementation Notes

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap) — triage
| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| dedupe_key không namespace theo field/type → id tự nhiên trùng (comment_id==mid) → mất sự kiện khác | high | patch (`${field}:${naturalId}`) |
| findPageByPlatformAccountId không lọc platform → route chéo sản phẩm/nền tảng, chọn trang tuỳ tiện | medium | patch (lọc platform theo item/product + order ổn định) |
| retryEvent không guard status → API reset/re-route cả mục non-failed | medium | patch (chỉ cho failed, else 409/no-op) |
| Public POST không đặt bodyLimit → batch Meta lớn 413 → Meta retry, mất tin | medium | patch (bodyLimit tường minh ~2MB) |
| Thiếu cảnh báo boot khi META_APP_SECRET/THREADS_APP_SECRET trống → mọi webhook 401 → Meta tắt sub | medium | patch (warn lúc khởi động) |
| Index (received_at,id) không khớp query (order theo id) → index chết | low | patch (khớp index với query) |
| Handler webhook.route chưa test nhánh đánh dấu failed (final attempt) | medium | patch (tách hàm + test) |
| Thiếu test: not_configured→401 no-write; GET verify chưa cấu hình→403; dedupe cross-type | medium | patch (test) |
| WebhookEventPage.platform z.string() → cast ở UI | low | patch (dùng Platform enum) |
| th cột thao tác thiếu nhãn a11y | low | patch (nhãn ẩn) |
| Log không tự refresh | low | patch (nút làm mới / interval nhẹ) |
| comment queues.ts nói job.failed consumer nhưng ghi inline | low | patch (sửa comment) |
| Chưa có GC/retention cho webhook_events (PII, tăng vô hạn) | medium | defer (gắn AD-22 / Story 9.3 privacy retention) |
| Pagination client chưa load-more (cap 50) | low | defer (panel chẩn đoán) |
| verify-token so sánh không constant-time | low | reject (token không bí mật, trả cho client) |
