---
title: 'Story 9.4 — Hồ sơ App Review và chuyển Live'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'fc270c2ada470b88c334fc655845523e6ff985a2'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 9.4, AD-22, AD-4, AD-19, AD-1; việc hoãn của 9.1 (callback Threads app); chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Muốn Meta duyệt app và chuyển Live, chủ shop cần một hồ sơ nộp: danh sách quyền khớp đúng scope code đang xin, kịch bản quay màn hình cho từng quyền, các URL bắt buộc, icon, Business Verification. Repo chưa có hồ sơ này. Threads app lại là app Meta riêng: lúc publish, Meta đòi Deauthorize callback URL và Data Deletion Requests URL, mà app chưa có hai route đó (việc hoãn của 9.1). Ngoài ra secret ký webhook Threads vẫn là [ASSUMPTION] trong runbook.

**Approach:**
- Thêm hai callback công khai cho Threads app (`POST /privacy/threads/{uninstall,delete}`). Hai route dùng lại toàn bộ đường của 9.1/9.2: verify `signed_request` bằng `THREADS_APP_SECRET`, ghi yêu cầu idempotent, phát `privacy.purge_requested` với `scope=all` thu hẹp về trang Threads của đúng người dùng. Các URL hiện ở Cài đặt › Tài khoản Meta, khối "Quyền riêng tư".
- Viết `deploy/app-review.md`: quyền lấy từ `META_LOGIN_SCOPES` / `THREADS_LOGIN_SCOPES`, đã đối chiếu tài liệu Meta ngày 24/10/2026, kèm kịch bản quay, URL, icon, các bước xác minh, checklist chuyển Live và checklist kiểm sau Live.
- Runbook thêm mục xác nhận secret ký webhook Threads, có chỗ trống để điền kết quả, và env tuỳ chọn `THREADS_WEBHOOK_SECRET` để đổi secret khi kết quả khác giả định mà không phải sửa code.

## Boundaries & Constraints

**Always:**
- **Callback Threads:**
  - Định dạng `signed_request` và luật verify giống hệt 9.1 (`verifySignedRequest`): HMAC-SHA256 trên chuỗi payload base64url, so sánh constant-time, `algorithm` = `HMAC-SHA256`, `user_id` dạng số.
  - Khoá verify là `THREADS_APP_SECRET`, không dùng `META_APP_SECRET`. Có sai gì, kể cả khi thiếu secret → 400 `VALIDATION_FAILED`, không ghi dòng nào, không phát sự kiện, không ngắt trang.
  - Body nhận dạng form hoặc JSON, tối đa 64 KB. Rate-limit 30/phút/IP, dùng chung parser và scope `/privacy` của 9.1.
- **Người dùng Threads:** `user_id` so với `pages.platform_account_id` của trang `platform='threads'` [ASSUMPTION: id trong `signed_request` = id `/me` của Threads, mục kiểm sau Live]. Trang đã gỡ (`removed_at`) vẫn tính là "đã biết", vì dữ liệu của nó vẫn còn tới khi bị dọn.
  - Đã biết → yêu cầu `scope=all`, `page_ids` = các trang Threads đó, `meta_account_id` = null. Phát `privacy.purge_requested` trong cùng transaction.
  - Không biết → dòng `completed`, `matched=false`, không phát sự kiện, như người lạ ở 9.1.
- **Uninstall** (người dùng đã biết, trang chưa gỡ) → chuyển trang Threads sang `disconnected`, lý do `THREADS_DEAUTHORIZED`, phát `page.disconnected`, trong cùng transaction. Trang Facebook / IG và trang Threads của người khác không bị đụng.
- **Idempotent, chống phát lại:**
  - Khoá theo người dùng: `subject_hash` = HMAC-SHA256(`THREADS_APP_SECRET`, `threads-user:<id>`), không trùng không gian với khoá của người dùng Meta.
  - Luật trả lại mã cũ và `findMetaReplay` theo `issued_at` giữ nguyên như 9.1/9.2.
  - `source` mới: `threads_uninstall`, `threads_delete`.
- **Phản hồi:** delete trả `{url, confirmation_code}`, `url` = `${PUBLIC_BASE_URL}/privacy/status/<code>`; uninstall trả 200 rỗng. Trang trạng thái của yêu cầu Threads ghi phạm vi "Dữ liệu gắn với tài khoản Threads đã cấp quyền".
- **Config:** `GET /api/v1/privacy/config` thêm `threadsUninstallUrl`, `threadsDeleteUrl`, `threadsSecretConfigured`. Cài đặt hiện thêm nhóm "Threads app" (Privacy Policy URL, Deauthorize/Uninstall, Data Deletion/Delete) kèm nút sao chép và cảnh báo khi thiếu `THREADS_APP_SECRET`.
- **`THREADS_WEBHOOK_SECRET`** (tuỳ chọn): đặt thì `/webhooks/threads` verify bằng nó, không đặt thì vẫn dùng `THREADS_APP_SECRET` (hành vi hiện tại). Không đổi gì ở OAuth hay callback.
- AD-1: `privacy` không import `adapters/meta`. Tra trang Threads và ngắt trang nằm ở `connections` (đọc `pages` qua public API của `pages`), ghép ở `app/privacy.ts`. Log không mang `user_id`, `signed_request`, mã xác nhận.

**Never:**
- Không tự động hoá việc nộp App Review hay chuyển Live, không gọi API Meta mới. Không đổi danh sách scope đang xin.
- Không chấp nhận `signed_request` Threads ký bằng `META_APP_SECRET` (mỗi app một secret). Không ghi giá trị secret vào tài liệu.
- Không làm phần AC "app đã Live → khách thật nhắn → webhook về đủ ba nguồn" trong repo. Đó là bước chủ dự án làm sau khi Meta duyệt, theo checklist ở `deploy/app-review.md` mục 8.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Delete, người dùng đã biết | chữ ký `THREADS_APP_SECRET` đúng, `user_id` = id trang Threads | 200 `{url, confirmation_code}`; 1 dòng `pending scope=all source=threads_delete page_ids=[th]`; 1 sự kiện `purge_requested` có `pageIds=[th]`, `metaAccountId=null`; trang không đổi | |
| Uninstall, đã biết | như trên, endpoint uninstall; có thêm FB/IG + Threads của người khác | 200 rỗng; trang Threads → `disconnected` `THREADS_DEAUTHORIZED` + `page.disconnected`; FB/IG/Threads khác giữ nguyên; 1 dòng `pending` | |
| Gọi lại | cùng user, gọi lại hoặc gọi endpoint kia khi yêu cầu còn mở | cùng mã; không thêm dòng / sự kiện; không phát lại `page.disconnected` | |
| Trang Threads đã gỡ | trang có `removed_at` | delete: yêu cầu `pending` gồm trang đó; uninstall: không ngắt (đã gỡ) | |
| Người dùng lạ | chữ ký đúng, `user_id` không khớp trang Threads nào (kể cả trùng `fb_user_id` của Meta) | 200 kèm mã; `completed matched=false`; không sự kiện | |
| Phát lại sau khi xong | yêu cầu gần nhất `completed`, `issued_at` không mới hơn | trả mã cũ, không ngắt trang, không yêu cầu mới | |
| Sai secret | ký bằng `META_APP_SECRET` hoặc secret lạ / payload bị sửa | 400, 0 dòng, 0 sự kiện, trang không đổi | |
| Thiếu secret | `THREADS_APP_SECRET` không đặt | 400 + log cảnh báo, không ghi | |
| Dữ liệu hỏng | thiếu `signed_request` / sai dạng / content-type lạ | 400 (content-type lạ: 415), không ghi | |
| Trạng thái | `GET /privacy/status/<code>` của yêu cầu Threads | 200 HTML, phạm vi ghi "tài khoản Threads" | |
| Config | `GET /api/v1/privacy/config` có phiên | thêm 2 URL Threads tuyệt đối + `threadsSecretConfigured` | không phiên → 401 |
| Webhook secret | `THREADS_WEBHOOK_SECRET` đặt | `/webhooks/threads` nhận chữ ký theo nó, chữ ký theo `THREADS_APP_SECRET` → 401; không đặt → như cũ | |
| Không PII trong log | mọi callback Threads | log không chứa `user_id`, `signed_request`, mã | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/enums.ts` -- `DELETION_SOURCES` thêm `threads_uninstall`, `threads_delete`.
- `packages/shared/src/privacy.ts` -- `PRIVACY_PATHS.threadsUninstall|threadsDelete`, `PrivacyConfigResponse` thêm 3 trường.
- `server/src/modules/pages/service.ts`, `index.ts` -- `findPageRefByPlatformAccount` (kể cả trang đã gỡ).
- `server/src/modules/connections/threads-deauthorize.ts` (mới), `index.ts` -- `threadsUserPurgeScope`, `disconnectThreadsUserTx`.
- `server/src/modules/privacy/requests.ts`, `index.ts` -- `threadsSubjectHash`, `RecordMetaRequestInput` nhận nguồn Threads và `metaAccountId` null.
- `server/src/app/privacy.ts`, `privacy-pages.ts`, `deps.ts`, `main.ts`, `webhooks` options; `server/src/platform/config/index.ts` -- route, nhãn phạm vi, env.
- `server/drizzle/` -- migration cho check constraint `source`.
- `deploy/docker-compose.yml` -- chuyển `THREADS_WEBHOOK_SECRET` vào api.
- `web/src/lib/privacy.ts` (+ test), `web/src/screens/Settings.tsx` -- nhóm URL Threads app.
- `deploy/app-review.md` (mới), `deploy/runbook.md`, `deploy/env.production.example`.
- `_bmad-output/implementation-artifacts/deferred-work.md` -- đóng mục callback Threads, gom việc kiểm bằng Meta thật về checklist sau Live.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/{enums,privacy}.ts` -- nguồn xoá + đường + config -- hợp đồng chung.
- [x] `server/src/modules/pages/*`, `connections/threads-deauthorize.ts`, `privacy/requests.ts` -- tra/ngắt trang Threads, khoá theo người dùng Threads -- AD-22, AD-1.
- [x] `server/src/app/privacy.ts`, `privacy-pages.ts`, `deps.ts`, `main.ts`, `platform/config` -- callback Threads, nhãn trạng thái, config, `THREADS_WEBHOOK_SECRET`.
- [x] `server/drizzle/*` -- `npm run db:generate -w server`.
- [x] `server/test/privacy-threads.test.ts`, `server/test/app-deps.test.ts`, `server/test/privacy.test.ts` -- phủ I/O matrix.
- [x] `web/src/lib/privacy.ts` + test, `Settings.tsx` -- nhóm "Threads app".
- [x] `deploy/app-review.md` -- quyền (nguồn + ngày tra), kịch bản quay, URL, icon, Business Verification, OpenAI Organization Verification, checklist chuyển Live + kiểm sau Live.
- [x] `deploy/runbook.md`, `env.production.example`, `docker-compose.yml` -- đường callback Threads thật (thay đường giữ chỗ ở 6.3), mục 9 thêm Threads app, mục mới xác nhận secret webhook Threads (chỗ trống).
- [x] `deferred-work.md` -- đóng mục callback Threads; các mục "xác nhận bằng Meta thật" trỏ về checklist sau Live.

**Acceptance Criteria:**
- Given `deploy/app-review.md`, when chủ shop làm theo, then hồ sơ có đủ: mọi quyền trong `META_LOGIN_SCOPES` và `THREADS_LOGIN_SCOPES` (kể cả `pages_show_list`, `business_management`, `pages_manage_engagement`, `pages_read_user_content`), mỗi quyền có lý do và kịch bản quay theo đúng màn của app, Privacy Policy URL, Data Deletion URL, Deauthorize URL cho cả hai app, icon, Business Verification, Organization Verification phía OpenAI.
- Given app đã Live (bước của chủ dự án), when khách thật nhắn Fanpage, IG và trả lời Threads, then checklist mục 8 của `app-review.md` cho cách kiểm webhook đủ ba nguồn ở Cài đặt › Webhook. Secret ký webhook Threads được ghi vào runbook mục 10.
- Given `npm run check`, when chạy ở gốc repo, then typecheck, lint, depcruise, test đều xanh.

## Implementation Notes

- **Callback Threads app** (`POST /privacy/threads/{uninstall,delete}`):
  - `app/privacy.ts` gom bốn nguồn callback vào một bảng `SOURCES`, mỗi nguồn có secret, env báo thiếu, hàm khoá người dùng, hàm ngắt trang và hàm tra phạm vi. Cả bốn chạy cùng `handleCallback` của 9.1/9.2 (`findMetaReplay` → ngắt trang → `recordMetaRequest`).
  - Delete và data-deletion dùng chung handler `deletionCallback`.
  - `privacy` vẫn không import `adapters/meta`, depcruise sạch.
- **Người dùng Threads:** `connections/threads-deauthorize.ts` (`threadsUserPurgeScope`, `disconnectThreadsUserTx`, lý do `THREADS_DEAUTHORIZED`) đọc trang qua `pages.findPageRefByPlatformAccount` (mới; tính cả trang đã gỡ). `(platform, platform_account_id)` là duy nhất nên mỗi người dùng tối đa một trang.
  - Yêu cầu `scope=all` có `page_ids=[trang Threads]`, `meta_account_id=null`. Mọi consumer purge của 9.2 đã xử lý `pageIds`; phần `connections` bỏ qua khi `metaAccountId` null.
  - Token trang Threads giữ nguyên, cùng quyết định hẹp của 9.2.
- **Khoá idempotent** `threadsSubjectHash` = HMAC(`THREADS_APP_SECRET`, `threads-user:<id>`). `source` mới `threads_uninstall|threads_delete` (`CallbackDeletionSource` ở shared). Migration `server/drizzle/0042_big_menace.sql` chỉ thay check constraint `deletion_requests_source_check`.
- **Trang công khai:** trang trạng thái ghi "Dữ liệu gắn với tài khoản Threads đã cấp quyền" cho yêu cầu từ Threads. Mục 7 của trang chính sách thêm cách gỡ app / xin xoá qua Threads. Trang 404 nhắc cả Facebook lẫn Threads. `POLICY_UPDATED_AT` giữ 24/10/2026, vì cùng ngày.
- **`THREADS_WEBHOOK_SECRET`** (tuỳ chọn): `webhooksOptionsFromConfig` ưu tiên nó, nếu không có thì dùng `THREADS_APP_SECRET`. Callback quyền riêng tư và OAuth không đổi. api log `info` khi biến này được đặt. Biến đi qua `docker-compose.yml` và có trong `env.production.example`.
- **Web:** khối "Quyền riêng tư cho Meta App và Threads app" ở Cài đặt › Tài khoản Meta chia hai nhóm (Meta App, Threads app) với `threadsAppPrivacyFields`, và thêm cảnh báo khi thiếu `THREADS_APP_SECRET`.
- **Tài liệu:**
  - `deploy/app-review.md`: quyền lấy từ `META_LOGIN_SCOPES` (14) và `THREADS_LOGIN_SCOPES` (5). Ngày 24/10/2026 đã đối chiếu với Permissions Reference và Threads Get started: đủ 19 quyền, không quyền nào deprecated.
  - Feature **Business Asset User Profile Access** được thêm vào hồ sơ vì `inbox/profile.ts` đọc tên PSID.
  - Còn "cần đối chiếu lúc nộp": có cần `business_management` không (app không gọi Business Manager API), dạng `signed_request` + secret của Threads app, App Purpose, có cần staging cho reviewer không, mức bắt buộc Organization Verification của từng model `gpt-image-*`.
  - Runbook: 6.3 đổi đường giữ chỗ `/oauth/threads/{uninstall,delete}` sang `/privacy/threads/*`; 6.1 trỏ về mục 10; mục 9 thêm URL Threads app; mục 10 mới để xác nhận secret webhook Threads, có bảng trống điền kết quả.
- **Không làm được trong repo** (bước của chủ dự án, `deploy/app-review.md` mục 1, 7, 8): Business Verification, OpenAI Organization Verification, icon, quay video, nộp, chuyển Live, kiểm webhook ba nguồn với khách thật, điền runbook mục 10. Đã ghi vào deferred-work; các mục hoãn "xác nhận bằng Meta thật" của 4.4 / 4.5 / 4.7 trỏ về checklist mục 8.3.
- `npm run check` xanh: server 79 file / 1570 test, web 25 file / 356 test.

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: một migration chỉ đổi check constraint `deletion_requests_source_check`.
- `npm run check` -- expected: exit 0.

**Manual checks (if no CLI):**
- Sau khi deploy: Cài đặt › Tài khoản Meta hiện đủ URL của Meta App và Threads app; `curl -X POST <api>/privacy/threads/delete` không có chữ ký → 400.

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Kịch bản quay `deploy/app-review.md` mục 6 trỏ tới điều khiển không có trong web: menu "Kết nối tài khoản" không có mục "Facebook và Instagram" (chỉ "Facebook Fanpage" / "Instagram Business" / "Threads"); Hộp thư không có bộ lọc Instagram (tab chỉ Tất cả / Cần xử lý / AI đang trả lời / Đã xong); Hiệu suất không có ô "chọn Fanpage" riêng; "Cài đặt › Model" là thẻ trong mục Kết nối OpenAI — reviewer / chủ shop quay theo sẽ lạc màn | medium | patch: `deploy/app-review.md` mục 3.2, 6.2 (A, C, G), 6.3 (T4) — đúng nhãn menu, chọn nền tảng / trang qua **Phạm vi** ở thanh trên, đường đúng tới ô "Model tạo ảnh" |
| Đã rà, không phải lỗi: 14 quyền mục 4 và 5 quyền mục 5 khớp từng dòng `META_LOGIN_SCOPES` / `THREADS_LOGIN_SCOPES` (gửi ở `connections/oauth.ts`), cột "Bắt buộc" khớp `PAGE_REQUIRED_SCOPES` / `INSTAGRAM_REQUIRED_SCOPES` / `THREADS_REQUIRED_SCOPES`; callback Threads verify bằng `THREADS_APP_SECRET`, Meta App bằng `META_APP_SECRET` (bảng `SOURCES` theo nguồn, test ký chéo → 400); tra người dùng lọc `platform='threads'` (unique `(platform, platform_account_id)`), id trùng `fb_user_id` → người lạ; `subject_hash` tách tiền tố `threads-user:` + secret riêng → `findMetaReplay` / watermark `issued_at` của 9.2 áp nguyên cho hai nguồn mới, phát lại không ngắt trang; `THREADS_WEBHOOK_SECRET` rỗng bị `parseWith` coi như thiếu → rơi về `THREADS_APP_SECRET`, không có đường bỏ verify; `metaAccountId: null` hợp lệ ở schema sự kiện và `connections.purge`; log callback chỉ mang nguồn / id yêu cầu / cờ; field webhook mục 7.1 khớp runbook 6.1; nginx đã chuyển `/privacy/*` về api | reject | — |
