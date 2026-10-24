---
title: 'Story 9.1 — Trang chính sách và callback xoá dữ liệu của Meta'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: '77a2b8dccd579e18e998d2b58c11621167af5f47'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 9.1, AD-22, AD-19, AD-1, AD-3; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Meta không cho app lên Live mode khi thiếu Privacy Policy URL và Data Deletion callback. Hiện chưa có route `/privacy/*`, chưa có module `privacy` hay bảng `deletion_requests`. Vì vậy chưa có đường nào ghi nhận yêu cầu xoá khi chủ shop gỡ app hoặc xin xoá dữ liệu trên Facebook.

**Approach:** Thêm module `privacy` (bảng `deletion_requests`, verify `signed_request`, ghi yêu cầu idempotent, phát `privacy.purge_requested`). Entrypoint `app/privacy.ts` phục vụ trên host api (`PUBLIC_BASE_URL`, cả hai chế độ deploy): trang tĩnh `/privacy/policy`, trang trạng thái `/privacy/status/<code>`, hai callback `POST /privacy/meta/{deauthorize,data-deletion}`, và `GET /api/v1/privacy/config` cho Cài đặt. **9.1 chỉ ghi nhận + phát sự kiện.** Việc xoá thật (consumer từng module, đóng yêu cầu) thuộc 9.2, nên trong 9.1 yêu cầu của người dùng đã biết sẽ nằm ở `pending`.

## Boundaries & Constraints

**Always:**
- **`signed_request`** = `<chữ ký base64url>.<payload base64url>`. Chữ ký = HMAC-SHA256 trên **chuỗi payload đã mã hoá**, khoá là `META_APP_SECRET`, so sánh `timingSafeEqual` (kiểm độ dài trước). Kiểm chữ ký TRƯỚC khi parse payload. Payload phải có `algorithm` = `HMAC-SHA256` và `user_id` dạng số. Bất kỳ sai nào (cả thiếu secret) → 400 `VALIDATION_FAILED`, không ghi dòng nào, không phát sự kiện, không ngắt trang. Log chỉ ghi lý do, không ghi giá trị.
- **Body:** `application/x-www-form-urlencoded` (Meta gửi dạng này) hoặc JSON `{signed_request}`, giới hạn 64 KB, parser đóng gói trong scope `/privacy`.
- **Người dùng Meta:** `user_id` (id theo app) so với `connections.meta_accounts.fb_user_id`.
  - Đã biết → yêu cầu `scope=all`, `target_id=null`, `status=pending`, `matched=true`, rồi phát `privacy.purge_requested{id: requestId, scope:'all', targetId:null}` trong CÙNG transaction.
  - Không biết (app không giữ dữ liệu gì của người này) → vẫn trả mã, nhưng dòng ghi luôn `completed` với `matched=false` và KHÔNG phát sự kiện. Lý do: không để một tài khoản Facebook lạ xoá sạch dữ liệu của shop.
- **Deauthorize** (người dùng đã biết) → `connections` chuyển mọi trang có `page_credentials.meta_account_id` của tài khoản đó, cùng IG dùng chung token, sang `disconnected` (lý do `META_DEAUTHORIZED`, phát `page.disconnected`), cùng transaction với yêu cầu. Trang Threads và trang của tài khoản Meta khác không bị đụng [ASSUMPTION: Threads có app/token riêng].
- **Idempotent theo user id:** khoá = `subject_hash` = HMAC-SHA256(`META_APP_SECRET`, `meta-user:<user_id>`) — không lưu id thô. Trong transaction có `pg_advisory_xact_lock` theo khoá này. Gặp lại cùng người dùng (qua endpoint nào cũng vậy):
  - còn yêu cầu mở → trả lại đúng mã đó;
  - yêu cầu gần nhất là `completed`+`matched=false` và người dùng vẫn không biết → trả lại mã đó;
  - các trường hợp khác → tạo yêu cầu mới.
  Thêm unique index một phần trên `subject_hash` cho các dòng chưa `completed` làm lưới an toàn.
- **Mã xác nhận:** 16 byte ngẫu nhiên dạng hex (32 ký tự). `url` = `${PUBLIC_BASE_URL}/privacy/status/<code>`.
- **Trang HTML** (policy, status, 404 của status): tiếng Việt, không JS. CSS ở `/privacy/assets/privacy.css`. api tự đặt CSP chặt `default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. Mẫu nginx host api chỉ thêm CSP mặc định khi upstream chưa đặt. Trang status thêm `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`.
- **Nội dung chính sách:** dữ liệu thu thập (trang, token mã hoá, tin/bình luận và tệp của khách, hồ sơ khách chủ shop nhập, bài/số liệu, nhật ký kỹ thuật); mục đích; bên xử lý (Meta, OpenAI với `store: false`, Cloudinary, máy chủ); thời hạn lưu theo AD-22; bảo mật; cách yêu cầu xoá (gỡ app trên Facebook → mã + trang trạng thái; khách liên hệ email / nhắn trang); ngày cập nhật. Tên đơn vị vận hành + email liên hệ lấy từ env `PRIVACY_CONTROLLER_NAME`, `PRIVACY_CONTACT_EMAIL` (tuỳ chọn, giá trị được escape). Thiếu env → hiện chỗ trống được đánh dấu rõ, api log cảnh báo lúc khởi động, Cài đặt hiện cảnh báo.
- **Rate-limit theo IP** (route tự khai, vì rate-limit mặc định chỉ áp `/api/v1`): callback POST 30/phút, trang GET 120/phút. Vượt → 429, không ghi.
- AD-1: `privacy` chỉ gọi `pages`/`settings` (không gọi module nào trong 9.1), không import `adapters/meta`. Việc ghép với `connections` nằm ở `app/privacy.ts`.

**Never:**
- Không xoá dữ liệu thật, không thêm consumer / job `privacy.*`, không làm màn "Xoá khách" (9.2). Không làm cron retention (9.3), không viết `app-review.md` (9.4).
- Không trả hay log `signed_request`, `user_id`, `subject_hash`, mã xác nhận, app secret. Không đặt CORS cho `/privacy/*` (Meta gọi server-to-server).
- Không làm callback Threads (uninstall/delete của Threads app) — ghi vào hoãn cho 9.4.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Chính sách | `GET /privacy/policy`, không phiên, có env PRIVACY_* | 200 HTML có đủ các mục, tên + email đã escape, CSP của api | |
| Chính sách thiếu env | không đặt PRIVACY_* | 200, chỗ trống đánh dấu; `/api/v1/privacy/config` → `operatorConfigured:false` | |
| Gốc | `GET /privacy` | 302 → `/privacy/policy` | |
| Data-deletion, người dùng đã biết | chữ ký đúng, `user_id` có trong `meta_accounts` | 200 `{url, confirmation_code}`; 1 dòng `pending scope=all source=meta_data_deletion`; 1 sự kiện `purge_requested`; trang không đổi | |
| Deauthorize, người dùng đã biết | chữ ký đúng; tài khoản có FB + IG liên kết; có thêm Threads và FB của tài khoản khác | 200; FB + IG → `disconnected` + `page.disconnected`; Threads / tài khoản khác giữ nguyên; 1 dòng `pending`; 1 sự kiện | |
| Gọi lại | cùng user, gọi lại hoặc qua endpoint kia khi yêu cầu còn mở | cùng mã; không thêm dòng / sự kiện; deauthorize lần 2 không phát `page.disconnected` | |
| Người dùng lạ | chữ ký đúng, `user_id` không có trong `meta_accounts` | 200 kèm mã; dòng `completed matched=false`; không sự kiện; gọi lại → cùng mã | |
| Yêu cầu cũ đã xong | yêu cầu gần nhất `completed matched=true`, người dùng vẫn đã biết | mã mới, dòng `pending` mới, 1 sự kiện | |
| Sai chữ ký | secret khác / payload bị sửa / chữ ký cắt ngắn | 400, 0 dòng, 0 sự kiện, trang không đổi | |
| Dữ liệu hỏng | thiếu `signed_request`, không có `.`, base64 lỗi, `algorithm` khác, không có `user_id`, content-type lạ | 400 (content-type lạ: 415), không ghi gì | |
| Thiếu secret | `META_APP_SECRET` không đặt | 400 + log cảnh báo, không ghi gì | |
| Trạng thái | `GET /privacy/status/<code>` với yêu cầu `pending` / `completed` | 200 HTML "Đang chờ xử lý" / "Đã hoàn tất" + ngày giờ VN; header no-store, no-referrer, noindex | |
| Mã lạ | mã đúng dạng nhưng không có / sai dạng | 404 HTML "Không tìm thấy yêu cầu" | |
| Rate-limit | vượt hạn mức POST trong 1 phút từ một IP | 429, không ghi | |
| Không PII trong log | mọi lời gọi callback | log không chứa `user_id`, `signed_request`, mã | |
| Config | `GET /api/v1/privacy/config` không phiên / có phiên | 401 / URL tuyệt đối theo `PUBLIC_BASE_URL` + `operatorConfigured` + `metaSecretConfigured` | |

</frozen-after-approval>

## Code Map

- `packages/shared/src/enums.ts` -- `DeletionScope`, `DeletionStatus` đã có; thêm `DeletionSource`.
- `packages/shared/src/events.ts` -- `privacy.purge_requested|purge_part_completed|purge_completed` đã khai (giữ nguyên).
- `packages/shared/src/privacy.ts` (mới) -- đường `/privacy/*`, `MetaDataDeletionResponse`, `PrivacyConfigResponse`.
- `server/src/modules/privacy/` (mới) -- `schema.ts`, `signed-request.ts`, `requests.ts`, `index.ts`.
- `server/src/modules/connections/deauthorize.ts` (mới) + `index.ts` -- `isKnownMetaUser`, `disconnectMetaUserTx` (dùng lại `markDisconnectedTx`).
- `server/src/app/privacy.ts`, `server/src/app/privacy-pages.ts` (mới) -- route + HTML/CSS.
- `server/src/app/app.ts`, `deps.ts`, `main.ts`; `server/src/platform/config/index.ts` -- nối deps, env PRIVACY_*.
- `server/drizzle/` -- migration sinh bằng `drizzle-kit generate`.
- `web/vite.config.ts` (proxy `/privacy`), `web/src/lib/api.ts` (`apiPublicUrl`), `web/src/lib/privacy.ts` (mới), `web/src/screens/Settings.tsx`, `web/src/screens/Login.tsx`.
- `deploy/nginx-api.conf.example`, `deploy/env.production.example`, `deploy/runbook.md`.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/{enums,privacy,index}.ts` -- thêm `DELETION_SOURCES`, đường dẫn, schema phản hồi -- hợp đồng chung server/web.
- [x] `server/src/modules/privacy/*` -- bảng, verify chữ ký, ghi yêu cầu idempotent + phát sự kiện, đọc trạng thái theo mã -- lõi AD-22.
- [x] `server/src/modules/connections/deauthorize.ts` -- tra tài khoản Meta, ngắt trang của tài khoản trong transaction của bên gọi -- deauthorize.
- [x] `server/src/app/privacy.ts`, `privacy-pages.ts`, `app.ts`, `deps.ts`, `main.ts`, `platform/config` -- route công khai + rate-limit + parser form + config env -- AD-19.
- [x] `server/drizzle/*` -- `npm run db:generate -w server` -- migration.
- [x] `server/test/privacy-signed-request.test.ts`, `server/test/privacy.test.ts`, `server/test/config.test.ts` -- phủ mọi dòng I/O matrix.
- [x] Web (`vite.config.ts`, `lib/api.ts`, `lib/privacy.ts` + test, `Settings.tsx`, `Login.tsx`) -- liên kết chính sách theo `API_ORIGIN`, khối "Quyền riêng tư" ở Cài đặt › Tài khoản Meta với 3 URL để dán vào Meta App.
- [x] `deploy/*` -- CSP host api tôn trọng CSP của api, env mẫu PRIVACY_*, runbook mục cấu hình URL quyền riêng tư ở Meta App.
- [x] `_bmad-output/implementation-artifacts/deferred-work.md` -- đóng mục `apiUrl` cho `/privacy/*`, thêm mục callback Threads.

**Acceptance Criteria:**
- Given chủ shop dán ba URL ở Cài đặt vào Meta App, when Meta gửi data-deletion cho chủ shop, then Meta nhận `{url, confirmation_code}`, và `url` mở được trang trạng thái công khai trên host api (cả chế độ cùng VPS lẫn chế độ tách).
- Given `npm run check`, when chạy ở gốc repo, then typecheck, lint, depcruise (AD-1: `privacy` không import module ngoài nền / `adapters/meta`) và test đều xanh.

## Implementation Notes

- **Phạm vi 9.1 = ghi nhận + phát sự kiện.** Người dùng đã biết → `deletion_requests` `pending` + `privacy.purge_requested{id, scope:'all', targetId:null}`; chưa có consumer nên yêu cầu nằm ở "đang chờ xoá" tới Story 9.2. Người dùng lạ → `completed` + `matched=false`, không sự kiện (cột `matched` thêm ngoài danh sách cột của AD-22, cùng `source`, `subject_hash`).
- **Ranh giới:** verify `signed_request` đặt ở `modules/privacy/signed-request.ts` (không thêm `privacy` vào `metaCallers`). `app/privacy.ts` ghép `connections.disconnectMetaUserTx` / `isKnownMetaUser` với `privacy.recordMetaRequest` trong một transaction. depcruise sạch.
- **CSP:** api đặt CSP riêng cho HTML `/privacy/*`. Hai mẫu nginx đổi CSP cố định thành map `$ottm_csp` / `$ottm_api_csp` (giữ CSP của upstream nếu có, như `Cache-Control` / `Referrer-Policy`), để luôn chỉ có một header. CI đổi lệnh grep CSP theo map. `nginx -t` hai mẫu (riêng + cùng nhau) đã chạy cục bộ bằng `nginx:1.27-alpine`. Thêm `location ^~ /privacy/status/` không ghi access log. `platform/log.redactUrl` che mã trong đường trạng thái.
- **Content-type:** `text/plain` có parser mặc định của Fastify → body không phải form → 400 (vẫn 4xx, không ghi); loại không có parser (vd `application/octet-stream`) → 415.
- **Web:** `apiPublicUrl()` (đường ngoài `/api/v1` theo `API_ORIGIN`) thay cho `apiUrl()` mà mục hoãn 1.3c gợi ý, vì `apiUrl` thêm tiền tố `/api/v1`. Link "Chính sách quyền riêng tư" ở màn đăng nhập. Cài đặt › Tài khoản Meta có thẻ "Quyền riêng tư cho Meta App" (3 URL + cảnh báo khi thiếu PRIVACY_* / `META_APP_SECRET`). Proxy Vite thêm `/privacy`.
- **Nội dung pháp lý:** khung tiếng Việt theo AD-22 ở `server/src/app/privacy-pages.ts` (`POLICY_UPDATED_AT = 24/10/2026`). Chủ dự án cần đặt `PRIVACY_CONTROLLER_NAME` + `PRIVACY_CONTACT_EMAIL` và rà lại nội dung (cơ sở pháp lý, vị trí máy chủ, có cần bản tiếng Anh cho reviewer của Meta không) trước khi nộp 9.4.
- **Hoãn** (deferred-work): callback Threads app; ai xoá `meta_accounts` khi `scope=all` (9.2); thời hạn lưu trên trang chính sách chỉ đúng khi có 9.3.
- `npm run check` xanh: server 76 file / 1515 test, web 25 file / 353 test. Migration `server/drizzle/0039_luxuriant_kat_farrell.sql` (chỉ `deletion_requests`).

## Verification

**Commands:**
- `npm run db:generate -w server` -- expected: một migration mới tạo `deletion_requests`, không đổi bảng khác.
- `npm run check` -- expected: exit 0.

**Manual checks (if no CLI):**
- Mở `/privacy/policy` qua nginx host api, kiểm CSP chỉ có một header và CSS tải được (để 9.4 kiểm khi deploy).

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| `signed_request` không kiểm `issued_at` (độ mới) → một `signed_request` hợp lệ bị lộ có thể gửi lại sau khi yêu cầu cũ đã `completed matched=true` và chủ shop đã kết nối lại cùng tài khoản → tạo yêu cầu `scope=all` mới (xoá sạch lần nữa ở 9.2) | low–medium — thật nhưng khó khai thác (cần lấy được body POST HTTPS của Meta; log / nginx không ghi body) | defer: chọn ngưỡng tuổi cùng 9.2 khi xoá thật chạy (Meta không nêu cửa sổ retry) |
| Đã rà, không phải lỗi: base64url + đệm `=`, `algorithm` kiểm sau chữ ký, `timingSafeEqual` cùng độ dài, secret rỗng → 400 trước khi đụng DB; mã 128 bit + regex, trang trạng thái không lộ yêu cầu khác; mọi giá trị env / mã qua `escapeHtml`; data-deletion trả `{url, confirmation_code}` JSON, deauthorize 200; rate-limit theo `req.ip` (nginx ghi đè `X-Forwarded-For` = `$remote_addr`, tin một hop); deauthorize chỉ chọn trang theo `page_credentials.meta_account_id` (cập nhật khi kết nối lại) + IG trỏ token về đúng trang đó; map CSP / Referrer-Policy chỉ bỏ header nginx khi upstream tự đặt (chỉ trang `/privacy/*` của api); `redactUrl` che mã trong log; parser form nhận cả `; charset=UTF-8` | reject | — |
