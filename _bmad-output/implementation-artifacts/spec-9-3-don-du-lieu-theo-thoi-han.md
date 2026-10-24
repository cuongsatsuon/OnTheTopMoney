---
title: 'Story 9.3 — Dọn dữ liệu theo thời hạn'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '67eae2044c2cc1b62ca6ecf44f16be6b21ea28f4'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 9.3, AD-22, AD-24, AD-1, AD-14; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Trang chính sách (9.1) hứa thời hạn lưu theo AD-22 nhưng chưa có cron nào dọn: `webhook_events.payload` (nội dung tin của khách) giữ vĩnh viễn, `autoreply_runs` và `ai_usage.ref` tăng mãi, phiên hết hạn chỉ bị xoá khi đăng nhập lại. File Cloudinary mà DB không còn trỏ tới (ghi DB lỗi sau khi tải lên, cửa sổ đua của 9.2, khôi phục bản dump cũ) nằm trên kho mãi.

**Approach:** Cron `privacy.retention` (03:30 giờ VN) gọi lần lượt hàm dọn của từng module chủ bảng, theo bảng thời hạn chung ở `packages/shared`. Cron riêng `privacy.orphan_files` (05:00 giờ VN) liệt kê file theo prefix của app trên Cloudinary, so với tham chiếu của `content`, `inbox`, `profiles`, rồi xoá file mồ côi cũ với các chốt an toàn. Trang chính sách dựng mục "Thời gian lưu trữ" từ cùng bảng thời hạn. pg-boss xoá job đã xong sau 7 ngày, khai tường minh trong registry.

## Boundaries & Constraints

**Always:**
- **Bảng thời hạn** (`RETENTION` ở `packages/shared/src/privacy.ts`, nguồn duy nhất cho cron và trang chính sách):

  | Dữ liệu | Hạn | Cách dọn | Chủ bảng |
  |---|---|---|---|
  | `webhook_events.payload` | 30 ngày theo `received_at` | đặt `payload = null`, giữ metadata (sản phẩm, trang, field, trạng thái, mốc giờ, `dedupe_key`) | `webhooks` |
  | `autoreply_runs` | 90 ngày theo `started_at` | xoá dòng | `autoreply` |
  | `ai_usage.ref` | 90 ngày theo `created_at` | đặt `ref = null`, giữ dòng chi phí | `ai` |
  | `sessions` hết hạn | `expires_at ≤ now` | xoá dòng | `settings` |
  | job pg-boss đã xong / lỗi / huỷ | 7 ngày | `deleteAfterSeconds` của mọi queue (pg-boss tự xoá) | `platform/jobs` |
  | Trang gỡ quá 30 ngày | 30 ngày | đã có từ 9.2 (`privacy.removed_pages`) — chỉ dùng chung hằng số | `privacy` |
  | Ảnh bài không gắn bài | 7 ngày | đã có từ 6.3 (`content.media_gc`) — chỉ dùng chung hằng số | `content` |
  | File Cloudinary mồ côi | ≥ 7 ngày tuổi trên kho | xoá file | (ghép ở entrypoint) |

- **Không đụng dữ liệu còn dùng:** tin nhắn, hội thoại, khách giữ tới khi chủ shop xoá (AD-22, không làm gì thêm). File chỉ bị coi là mồ côi khi không có dòng nào tham chiếu: `media_assets.public_id` (mọi trạng thái), `message_attachments.file_public_id`, `knowledge_items.file_public_id`, `brand_profiles.logo_path` (URL chứa public_id). Kiểm lại tham chiếu ngay trước khi xoá từng file.
- **AD-1:** mỗi module export hàm dọn / hàm tra tham chiếu cho bảng của mình. Handler cron nằm ở `server/src/worker/retention.ts` (entrypoint ghép, vì `privacy` chỉ được gọi module nền). `adapters/media` thêm `inventory.list/delete`, không biết nghiệp vụ.
- **Theo lô, chạy lại an toàn:** mỗi bước dọn DB lặp lô (mặc định 1000) tới khi hết hoặc chạm trần lô mỗi lượt; chạy lại chỉ làm phần còn lại. Một bước lỗi không chặn bước khác; cuối lượt ném lỗi gộp để log + retry (cron retry 1).
- **Chốt an toàn dọn Cloudinary:**
  - Chỉ liệt kê `<folder>/public/` (image upload), `<folder>/private/` (image + raw authenticated); adapter từ chối xoá public_id ngoài hai prefix này.
  - Chỉ file có `created_at` cũ hơn 7 ngày (thiếu / hỏng mốc → bỏ qua).
  - Tối đa 100 file xoá mỗi lượt, tối đa 5 trang × 500 file mỗi loại mỗi lượt; con trỏ trang lưu ở `settings` (khoá `media_orphan_cursors`) để lượt sau đi tiếp, hết danh sách thì quay về đầu.
  - Cầu dao: trong số file cũ đã quét có ≥ 20 file và > 50% là mồ côi → không xoá file nào, giữ con trỏ, log cảnh báo (nghi DB không khớp kho: dev dùng chung thư mục, DB trống, khôi phục nhầm).
  - Env `MEDIA_ORPHAN_SWEEP` = `off | dry_run | on | force`; mặc định `on` khi `NODE_ENV=production`, `dry_run` ở môi trường khác. `dry_run` quét + đếm, không xoá; `force` bỏ cầu dao (giữ hạn tuổi và trần). Kho chưa cấu hình → bỏ qua.
  - Lỗi Cloudinary khi liệt kê / xoá (`RATE_LIMITED`, `TRANSIENT`, `AUTH_FAILED`) → dừng loại đó ở lượt này, không ném, giữ con trỏ; `INVALID_REQUEST` khi có con trỏ → xoá con trỏ.
- **Nhật ký webhook:** DTO thêm `payloadPurged`. Sự kiện `failed` đã dọn payload không "Xử lý lại" được (API 409, web ẩn nút). Job `webhook.route` gặp payload null → `missing`, không đổi trạng thái. Cài đặt › Webhook ghi một dòng: nội dung thô chỉ giữ 30 ngày.
- **Mục webhook của khách đang chờ xoá** (việc hoãn của 9.2): `webhook.route` ingest xong mà người gửi là khách có `deletion_requested_at` → đặt trạng thái kèm bỏ payload thô ngay (giai đoạn 1 của luồng xoá đã quét `webhook_events`, mục tới sau không ai xoá).
- Cron khai ở `queues.ts`, `tz: 'Asia/Ho_Chi_Minh'`, standard, retry 1, concurrency 1. Log chỉ số đếm (không public_id, không PII).
- Trang chính sách mục 5 dựng từ `RETENTION`, thêm dòng hàng đợi tác vụ nền 7 ngày và tệp không còn dùng ≥ 7 ngày.

**Never:**
- Không xoá tin nhắn, hội thoại, khách, bài, số liệu, `knowledge_items`, dòng `ai_usage`, dòng `webhook_events` (chỉ payload). Không xoá file trong 7 ngày đầu, ngoài prefix của app, hay khi cầu dao bật.
- Không query bảng của module khác; không thêm sự kiện miền mới; không SDK Cloudinary; không gọi Cloudinary thật trong test.
- Không làm hộp thoại / màn mới; không đổi luồng xoá theo yêu cầu (9.2), không làm 9.4 / 9.5.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Payload webhook quá hạn | sự kiện 31 ngày (`routed`, `failed`), 29 ngày, sự kiện thử 31 ngày | 31 ngày: `payload` null, metadata giữ, DTO `payloadPurged=true`; 29 ngày nguyên | |
| Xử lý lại sự kiện đã dọn | `failed` + payload null | `POST …/retry` 409, không enqueue; web `canRetry` false | |
| Route gặp payload null | job `webhook.route` của dòng đã dọn | `missing`, trạng thái không đổi | |
| Khách đang chờ xoá nhắn thêm | khách có `deletion_requested_at`, mục DM mới tới; khách khác cùng trang | mục của khách đang chờ xoá `routed` + payload null; khách khác giữ payload | |
| Lượt AI quá hạn | `autoreply_runs` 91 ngày (xong + dở), 89 ngày | 91 ngày xoá, 89 ngày giữ | |
| Tham chiếu chi phí AI | `ai_usage` 91 ngày có `ref`, 89 ngày | 91 ngày `ref` null, chi phí nguyên; 89 ngày giữ `ref` | |
| Phiên hết hạn | phiên hết hạn + phiên còn hạn | hết hạn xoá, còn hạn giữ | |
| Job pg-boss | `ensureQueues` | mọi queue `deleteAfterSeconds` = 7 ngày | |
| Theo lô / chạy lại | lô 2, 5 dòng quá hạn mỗi bảng | lượt 1 dọn hết; lượt 2 đếm 0 | |
| Một bước lỗi | bước `autoreply` ném | các bước khác vẫn chạy; handler ném lỗi gộp | cron retry 1 |
| File mồ côi | kho có: mồ côi cũ (public, private image, raw), cũ còn tham chiếu (ảnh bài, đính kèm, file kiến thức, logo), mồ côi mới 2 ngày, file ngoài prefix | chỉ 3 file mồ côi cũ bị xoá | |
| Sau khôi phục dump cũ | file tải lên sau thời điểm dump, DB không có dòng | coi như mồ côi, xoá khi đủ 7 ngày (trong trần + cầu dao) | |
| Trần mỗi lượt | 130 mồ côi cũ, 200 file có tham chiếu (`force` không cần) | lượt 1 xoá 100, lượt 2 xoá 30 | |
| Cầu dao | 30 file cũ, 20 mồ côi | không xoá, cảnh báo, con trỏ giữ; `force` → xoá 20 | |
| Chế độ | `off` / `dry_run` / mặc định theo `NODE_ENV` | `off`: không gọi kho; `dry_run`: đếm, không xoá | |
| Phân trang | trần trang 1, 3 trang | mỗi lượt đi 1 trang, con trỏ lưu, hết thì quay về đầu | |
| Kho lỗi | liệt kê `RATE_LIMITED` | dừng loại đó, không ném, con trỏ giữ | |
| Kho chưa cấu hình | thiếu `CLOUDINARY_URL` | bỏ qua, không lỗi | |
| Trang chính sách | `GET /privacy/policy` | mục 5 hiện đúng số ngày của `RETENTION` | |
| Log | cả hai cron | chỉ số đếm, không public_id / nội dung | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/privacy.ts` -- `RETENTION`, `MEDIA_ORPHAN_SWEEP_MODES`.
- `packages/shared/src/webhooks.ts` -- `WebhookEventDto.payloadPurged`.
- `server/src/modules/webhooks/{schema,retention,service,route-job,index}.ts` -- payload nullable + index một phần, dọn payload, chặn retry, route gặp null, bỏ payload của khách đang chờ xoá.
- `server/src/modules/autoreply/{retention,index}.ts` -- xoá lượt quá hạn (index `started_at` đã có).
- `server/src/modules/ai/{schema,retention,index}.ts` -- bỏ `ref` quá hạn + index một phần.
- `server/src/modules/settings/{auth,state,index}.ts` -- xoá phiên hết hạn; đọc/ghi giá trị trạng thái (con trỏ).
- `server/src/modules/{content,inbox,profiles}/file-refs.ts` -- hàm tra tham chiếu file (`inbox` thêm index `file_public_id`); `inbox/purge.ts` `isSenderPendingDeletion`.
- `server/src/adapters/media/{index,fake}.ts` -- `inventory.list/delete` (Admin API, Basic auth); fake liệt kê theo prefix, `createdAt`.
- `server/src/platform/{config,db,jobs/queues,jobs/boss}.ts` -- `MEDIA_ORPHAN_SWEEP`, `runInBatches`, hai cron, `deleteAfterSeconds`.
- `server/src/worker/{retention,main}.ts` -- ghép hai cron.
- `server/src/app/{privacy-pages,webhooks}.ts` -- mục 5 từ hằng số; 409 khi đã dọn.
- `web/src/lib/webhooks.ts`, `web/src/screens/Settings.tsx` -- ẩn "Xử lý lại", dòng ghi chú 30 ngày.
- `deploy/{runbook.md,env.production.example,docker-compose.yml}`, `server/.env.example` -- env + ghi chú khôi phục.
- `server/test/privacy-retention.test.ts` (mới), `server/test/{webhooks,queues,notifications,media-adapter,privacy}.test.ts`, `web/src/lib/webhooks.test.ts`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/{privacy,webhooks}.ts` -- bảng thời hạn, chế độ sweep, `payloadPurged` -- hợp đồng chung.
- [x] `server/src/modules/{webhooks,autoreply,ai,settings}/*` + migration -- hàm dọn theo lô của từng chủ bảng -- AD-1, AD-22.
- [x] `server/src/modules/{content,inbox,profiles}/*` + migration -- tra tham chiếu file theo lô id -- AD-1.
- [x] `server/src/adapters/media/{index,fake}.ts` -- liệt kê / xoá theo prefix, Cloudinary giả -- AD-14.
- [x] `server/src/platform/*`, `server/src/worker/*` -- env, queue, `deleteAfterSeconds`, handler ghép -- AD-24.
- [x] `server/src/app/{privacy-pages,webhooks}.ts`, `web/src/{lib/webhooks.ts,screens/Settings.tsx}` -- chính sách khớp hệ thống, nhật ký webhook.
- [x] `server/test/privacy-retention.test.ts` + sửa test liên quan -- phủ mọi dòng I/O matrix trên Postgres thật, Cloudinary giả.
- [x] `deploy/*`, `server/.env.example`, `deferred-work.md` -- env, runbook khôi phục, đóng mục hoãn 9.3.

**Acceptance Criteria:**
- Given `npm run check`, when chạy ở gốc, then typecheck, lint, depcruise (AD-1) và mọi test xanh.
- Given worker chạy production, when tới 03:30 / 05:00 giờ VN, then hai cron chạy, log chỉ số đếm.

## Implementation Notes

- **Ghép ở entrypoint:** `server/src/worker/retention.ts` gọi hàm của từng module chủ bảng (`webhooks.purgeExpiredPayloads`, `autoreply.purgeExpiredRuns`, `ai.clearExpiredRefs`, `settings.deleteExpiredSessions`; tra tham chiếu `content/inbox/profiles.referenced*Files`). `privacy` không đổi (chỉ dùng chung hằng số). Lặp lô dùng chung `platform/db.runInBatches` (lô 1000, trần 200 lô mỗi bước mỗi lượt).
- **Bảng thời hạn** `RETENTION` (`packages/shared/src/privacy.ts`) cũng thay số cứng của `privacy.removed_pages` và `content.media_gc`; mục 5 trang chính sách dựng từ đó. Sửa câu "Phiên đăng nhập hết hạn: xoá ngay" thành "hết hiệu lực ngay, bị xoá trong vòng một ngày" (cron ngày) — đúng với hệ thống hơn chữ AD-22.
- **pg-boss 12 không còn bảng archive:** job đã kết thúc bị pg-boss tự xoá sau `deletion_seconds`; `ensureQueues` đặt tường minh 7 ngày cho mọi queue (`JOB_DELETE_AFTER_SECONDS`).
- **Webhook:** `payload` nullable (migration `server/drizzle/0041_loose_black_widow.sql`, kèm 3 index một phần: `webhook_events(received_at) where payload is not null`, `ai_usage(created_at) where ref is not null`, `message_attachments(file_public_id)`). DTO `payloadPurged`; retry mục đã dọn → 409 `VERSION_CONFLICT`; web ẩn "Xử lý lại", ghi "· đã dọn nội dung" và dòng phụ 30 ngày. Thêm (đóng việc hoãn 9.2): `webhook.route` bỏ payload thô của tin từ khách đang chờ xoá.
- **Dọn file mồ côi:** `adapters/media` thêm `inventory.list/delete` (Admin API, Basic auth; prefix do adapter dựng, xoá ngoài prefix bị từ chối). Hai giai đoạn: quét (≤ 5 trang × 500 mỗi loại từ con trỏ ở `settings.media_orphan_cursors`) → cầu dao (≥ 20 file cũ và > 50% mồ côi, trừ `force`) → xoá ≤ 100, kiểm lại tham chiếu từng file. Hết trần / lỗi kho tạm → con trỏ giữ ở trang còn file chưa xoá. Mặc định `dry_run` ở mọi môi trường (xem quyết định chủ dự án bên dưới).
- **Quyết định người dùng có thể để ý:** nhật ký webhook mất nội dung sau 30 ngày (sự kiện lỗi cũ không xử lý lại được); logo cũ đã thay và file của bản dump cũ hơn kho bị dọn sau 7 ngày; cầu dao chặn cả trường hợp hợp lệ (khôi phục dump rất cũ) cho tới khi đặt `force` — ghi ở runbook mục 4.2 / 5.
- Docs: `deploy/runbook.md` (mục 4.2, mục 5 › Dọn dữ liệu theo hạn), `deploy/env.production.example`, `deploy/docker-compose.yml`, `server/.env.example`. `deferred-work.md`: đóng 6 mục (GC webhook, file mồ côi, ghi `stored` lỗi, chính sách khớp thời hạn, cửa sổ đua 9.2, webhook tới sau giai đoạn 1), thêm 3 mục (kiểm UI, Cloudinary thật, metadata webhook giữ vô hạn).
- **Quyết định chủ dự án (review 9.3, vì an toàn — đường Admin API của Cloudinary chưa từng chạy với kho thật):** `MEDIA_ORPHAN_SWEEP` không đặt → `dry_run` ở MỌI môi trường, kể cả production (thay dòng "mặc định `on` khi `NODE_ENV=production`" của phần Always đã đóng băng). Người vận hành đối chiếu báo cáo dry_run trong log worker với thư mục trên Cloudinary thật rồi mới đặt `on` (runbook mục 5). `resolveSweepMode` chỉ còn đọc env; `.env.example`, `env.production.example`, `docker-compose.yml`, runbook sửa theo. Báo cáo dry_run: kết quả có `byKind` = mỗi loại `{prefix, scanned, old, orphans}` (`inventory.prefix(kind)` của adapter, không gọi mạng) — chỉ số đếm + prefix, không public_id đầy đủ / PII; worker log dòng `dọn file mồ côi (dry_run — chỉ đếm, không xoá)`.
- `npm run check` xanh: server 78 file / 1548 test, web 25 file / 355 test; depcruise sạch. Chưa chạy UI trong trình duyệt.

## Spec Change Log

- Trong lúc làm (tự duyệt): thêm dòng I/O "Khách đang chờ xoá nhắn thêm" + một ý ở Always — làm luôn việc hoãn của 9.2 (mục webhook tới sau giai đoạn 1) bằng cách bỏ payload ngay ở `webhook.route`, thay vì để tới hạn 30 ngày. Giữ: không đổi luồng xoá 9.2, chỉ đụng payload của mục thuộc khách đã chờ xoá.
- Review lượt 1 (quyết định chủ dự án): mặc định `MEDIA_ORPHAN_SWEEP` = `dry_run` ở mọi môi trường thay cho `on` ở production (xem Implementation Notes); dòng "mặc định theo `NODE_ENV`" của I/O "Chế độ" đọc là "mặc định `dry_run`".

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: một migration (payload nullable, ba index).
- `npm run check` -- expected: exit 0.

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `MEDIA_ORPHAN_SWEEP` bỏ trống → `on` ở production: lượt xoá thật chạy ngay lần lên bản đầu tiên trên đường Admin API (`resources/<resource_type>/<type>?prefix=`, Basic auth, `next_cursor`, `created_at`) chưa từng chạy với Cloudinary thật — sai lệch nào của kho thật so với kho giả cũng thành xoá nhầm, không hoàn tác | high (quyết định chủ dự án) | patch: `worker/retention.ts` `resolveSweepMode` → `dry_run` khi không đặt env, mọi môi trường; chú thích `platform/config`; `server/.env.example`, `deploy/env.production.example`, `deploy/docker-compose.yml`, `deploy/runbook.md` (mục 4.2, 5: bật `on` sau khi đối chiếu dry_run); test `privacy-retention.test.ts` |
| Báo cáo dry_run chỉ có tổng số đếm — không đủ để đối chiếu từng thư mục trên Cloudinary thật; cần chắc log dry_run không có public_id / PII | medium (yêu cầu chủ dự án) | patch: `adapters/media` thêm `inventory.prefix(kind)` (`storedFilePrefix`, không gọi mạng); `sweepOrphanFiles` trả `byKind` `{prefix, scanned, old, orphans}` (cũng vào log cầu dao); worker log dòng riêng cho dry_run; test kiểm `byKind` và kết quả / log không chứa public_id |
| Đã rà, không phải lỗi: nguồn tham chiếu đủ (`media_assets.public_id` mọi trạng thái — ảnh bài / AI / 8.4 dùng lại qua `post_target_media`; `message_attachments.file_public_id`; `knowledge_items.file_public_id` tới lúc trích xong rồi file bị xoá; `brand_profiles.logo_path` URL `…/v<n>/<public_id>.<ext>` của cả nhóm và trang; không bảng nào khác lưu public_id / URL Cloudinary — `pages.avatar_url` là URL Meta, chiến dịch không có ảnh riêng); prefix do adapter dựng từ `CLOUDINARY_FOLDER` đã kiểm dạng (không `/` cuối → `ottm/` không khớp `ottm-2/`), lọc lại khi liệt kê, từ chối khi xoá; cầu dao xét file đủ tuổi của cả lượt, giữ con trỏ khi bật; con trỏ: hết trần / lỗi tạm giữ ở trang còn mồ côi, file trẻ / xoá lỗi lẻ được quét lại khi danh sách quay về đầu, `INVALID_REQUEST` xoá con trỏ — không file nào bị bỏ qua mãi; `autoreply_runs` không ai đọc ngoài ghi / 9.2 (8.3 đếm trên `messages`), `ai_usage.ref` không báo cáo nào đọc (hạn mức theo `month`) → cửa sổ 90 ngày của màn Hiệu suất không đổi; `deleteAfterSeconds` 7 ngày = mặc định pg-boss 12, chỉ áp job đã kết thúc — `hasLiveJob` chỉ xem job sống, `stately` / `singletonKey` không xét job xong, không màn nào đọc job lỗi cũ; mốc cắt theo thời điểm tuyệt đối (không lệch múi giờ); vòng lô dừng khi lô thiếu hoặc chạm trần 200 lô, dòng đã dọn rời index một phần | reject | — |
