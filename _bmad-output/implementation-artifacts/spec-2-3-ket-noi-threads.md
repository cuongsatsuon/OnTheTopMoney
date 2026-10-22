---
title: 'Story 2.3 — Kết nối Threads'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-2-3
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-2-ket-noi-fanpage-va-instagram-business.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chủ shop chưa kết nối được tài khoản Threads. Ở Trang & Nhóm và Màn chào, mục Threads vẫn ghi "Sắp có"; Cài đặt › Tài khoản Meta vẫn dùng dữ liệu mẫu và gộp Threads chung với tài khoản Facebook.

**Approach:** Thêm luồng OAuth Threads riêng (app Threads, cửa sổ đồng ý của Threads), dùng lại toàn bộ khung của Story 2.2:
- `oauth_states` gắn với phiên đăng nhập;
- `oauth_results` + bước chọn trong `ConnectResultModal`;
- `confirm` + `pages.upsertFromPlatform`;
- `page_credentials` mã hoá;
- sự kiện `page.connected` / `page.reconnected`.

Đổi token ngắn hạn sang token dài hạn 60 ngày, đọc hồ sơ Threads, đọc quyền đã cấp bằng `debug_token`. Cài đặt › Tài khoản Meta hiện danh sách trang thật, tách khối Facebook (Fanpage + IG) và khối Threads.

## Boundaries & Constraints

**Always:**
- **Tài liệu Threads (kiểm 2026-10-22):**
  - Cửa sổ đồng ý: `https://threads.com/oauth/authorize` với `client_id`, `redirect_uri`, `scope` (phẩy ngăn cách), `response_type=code`, `state`.
  - Bỏ hậu tố `#_` khỏi `code` nếu có.
  - Đổi mã: `POST https://graph.threads.com/oauth/access_token` (`client_id`, `client_secret`, `grant_type=authorization_code`, `redirect_uri`, `code`), trả về `access_token` và `user_id`.
  - Token dài hạn: `GET https://graph.threads.com/access_token?grant_type=th_exchange_token&client_secret&access_token`, trả `expires_in` (khoảng 60 ngày).
  - Hồ sơ: `GET /v1.0/me?fields=id,username,name,threads_profile_picture_url`.
  - Quyền đã cấp: `GET /v1.0/debug_token?input_token=…` dùng app token `TH|<THREADS_APP_ID>|<THREADS_APP_SECRET>`, đọc `data.scopes` và kiểm `data.app_id` khớp app.
- **Host:** đổi `THREADS_BASE_URL` của adapter sang `https://graph.threads.com` (giữ `/v1.0`).
- **Quyền:**
  - Xin `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`, `threads_manage_insights`.
  - Cả năm là quyền bắt buộc; thiếu quyền nào thì ứng viên không chọn được, FE hiện modal thiếu quyền như Story 2.2, với tiêu đề "Chưa cấp đủ quyền Threads".
  - Không có `data.scopes` thì coi như đã cấp đủ những gì đã xin [ASSUMPTION: tài liệu không nói người dùng bỏ được từng quyền].
- **Lưu trữ:**
  - Trang Threads: `platform='threads'`, `platform_account_id = user_id`.
  - Token Threads lưu mã hoá trong `page_credentials` với `expires_at = now + expires_in`; Threads không có `meta_accounts`.
  - Luồng dùng `THREADS_APP_ID` / `THREADS_APP_SECRET`; thiếu thì `start` trả `META_NOT_CONFIGURED`.
  - `redirect_uri = PUBLIC_BASE_URL + /oauth/threads/callback`.
- **Meta giả:** `META_FAKE=1` phủ cả Threads, với trang đồng ý giả `/oauth/threads/fake-consent` (Đồng ý / Huỷ / "bỏ quyền trả lời").

**Never:**
- Không làm cron làm mới token Threads hay tính `expiring` (Story 2.4).
- Không làm webhook Threads (Epic 4).
- Không nhận callback Uninstall/Delete của Threads (Story 9.1).
- Không trả token ra client, không đưa token vào log hay URL chuyển hướng.
- Không đổi luồng Facebook trừ phần dùng chung cần tham số hoá theo nền tảng.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bắt đầu | `POST /api/v1/connections/threads/start {from}` | `{url}` tới `threads.com/oauth/authorize` (hoặc trang giả) | thiếu cặp Threads và không bật giả → `META_NOT_CONFIGURED` |
| Callback thành công | `GET /oauth/threads/callback?code=…#_&state` | bỏ `#_`, đổi token ngắn → dài, đọc hồ sơ + quyền, lưu 1 ứng viên Threads vào `oauth_results`, 302 về màn bắt đầu | N/A |
| Huỷ | `error=access_denied` | kết quả `OAUTH_CANCELLED` | N/A |
| Mã hết hạn/đã dùng | đổi mã trả lỗi | kết quả `OAUTH_FAILED` | N/A |
| State sai/khác phiên | như Story 2.2 | `OAUTH_STATE_INVALID`, không đổi mã | N/A |
| Thiếu quyền | `debug_token` thiếu quyền bắt buộc | ứng viên có `missing[]`; FE modal "Chưa cấp đủ quyền Threads" + danh sách + "Thử lại" | N/A |
| Token app khác | `debug_token.app_id` khác app | `OAUTH_FAILED` | N/A |
| Xác nhận | `POST /api/v1/connections/confirm` với ứng viên Threads | upsert trang Threads, lưu token mã hoá có `expires_at`, `active`, phát `page.connected` (hoặc `page.reconnected` nếu từng gỡ/mất kết nối) | N/A |
| Hiển thị | Trang & Nhóm, Màn chào, Cài đặt › Tài khoản Meta | Threads là tài khoản OAuth riêng, không gộp vào khối Facebook; mục "Sắp có" biến mất | N/A |

</frozen-after-approval>

## Code Map

- `server/src/modules/connections/{oauth.ts,candidates.ts,confirm.ts,credentials.ts,fake-meta.ts,meta-clients.ts,schema.ts}` -- luồng Facebook của Story 2.2: tham số hoá theo `provider: 'facebook'|'threads'` (`oauth_states.provider`), thêm hàm Threads; `confirm` đã nhận ứng viên nhiều nền tảng.
- `server/src/adapters/meta/client.ts:20,259` -- `THREADS_BASE_URL` đang là `graph.threads.net`: đổi sang `graph.threads.com`; test adapter liên quan.
- `server/src/app/{connections.ts,oauth.ts}` -- route start/callback/fake-consent Facebook: thêm bản Threads.
- `server/src/platform/config/index.ts` -- `THREADS_APP_ID/SECRET/ENV` đã có (Story 2.1).
- `packages/shared/src/connections.ts` -- `THREADS_SCOPES` / bắt buộc; kiểu ứng viên đã có `platform`.
- `web/src/components/ConnectResultModal.tsx` -- tiêu đề modal thiếu quyền theo nền tảng.
- `web/src/screens/PagesGroups.tsx:276`, `web/src/screens/Welcome.tsx:169` -- "Sắp có" của Threads: nối luồng thật.
- `web/src/screens/Settings.tsx:603+` -- mục Tài khoản Meta đang dùng dữ liệu mẫu: đọc `usePages()`, nhóm thành "Facebook (Fanpage + Instagram)" và "Threads"; "Kết nối lại" chạy lại OAuth đúng nền tảng.
- `deploy/runbook.md` §6.3 -- redirect URI Threads `/oauth/threads/callback`.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/adapters/meta/client.ts` + test -- host Threads mới.
- [x] `server/src/modules/connections/*` + migration (nếu cần cột `provider`) -- start/callback/fake cho Threads, debug_token Threads, ứng viên Threads, xác nhận Threads.
- [x] `server/src/app/{connections.ts,oauth.ts}` -- route Threads.
- [x] `server/test/connections-threads.test.ts` -- mọi dòng ma trận phía server (fake), gồm bỏ `#_`, `expires_at`, envelope trong DB, log/URL không có token, app_id sai.
- [x] `packages/shared/src/connections.ts` -- quyền Threads, request start Threads.
- [x] `web/src/lib/connections.ts`, `ConnectResultModal.tsx`, `PagesGroups.tsx`, `Welcome.tsx`, `Settings.tsx` -- như Code Map.
- [x] `deploy/runbook.md`, `server/.env.example` -- cập nhật đường callback, host.

**Acceptance Criteria:**
- Given `npm run dev` với `META_FAKE=1`, when chọn "+ Kết nối tài khoản" › Threads, đồng ý ở trang giả và xác nhận, then bảng Trang & Nhóm có trang Threads "Đang hoạt động", và Cài đặt › Tài khoản Meta hiện Threads ở khối riêng.
- Given trang giả với "bỏ quyền trả lời", when quay về, then thấy modal "Chưa cấp đủ quyền Threads" kèm danh sách quyền thiếu và "Thử lại".
- Given `npm run check`, when chạy, then thoát 0 và không dòng failed.

## Implementation Notes

- **Adapter:** `THREADS_BASE_URL = https://graph.threads.com` (giữ `/v1.0`). Thêm `MetaCallOptions.unversioned` để gọi đúng hai endpoint token không phiên bản theo tài liệu (`POST /oauth/access_token`, `GET /access_token`); vẫn chặn path thoát gốc. Test ở `meta-client.test.ts`.
- **Hợp đồng (`packages/shared/src/connections.ts`):** `THREADS_LOGIN_SCOPES` = `THREADS_REQUIRED_SCOPES` (5 quyền), `OAUTH_PROVIDERS`/`OAuthProvider`, `StartConnectRequest` (giữ alias `StartFacebookConnectRequest`, thêm `StartThreadsConnectRequest`). `OAuthResultResponse` thêm `provider` (FE chọn tiêu đề / modal thiếu quyền / "Thử lại").
- **Server:** `startThreadsOAuth` / `handleThreadsCallback` dùng chung khung với Facebook (`createState`, `handleCallback(provider, collector)`). State chỉ nhận ở callback cùng `provider` (state Facebook ở callback Threads → `OAUTH_STATE_INVALID`). Callback Threads chuyển về `…?ket-noi=<id>&nen-tang=threads` (Facebook giữ nguyên URL cũ) để FE "Thử lại" đúng luồng kể cả khi kết quả hết hạn. Chuỗi gọi: `POST /oauth/access_token` (bỏ `#_`) → `GET /access_token` (`th_exchange_token`) → `GET /v1.0/debug_token` (app token `TH|id|secret`; `is_valid === false` hoặc `app_id` khác → `OAUTH_FAILED`) → `GET /v1.0/me`. Lỗi khi đổi mã → `OAUTH_FAILED` (chỉ `RATE_LIMITED` giữ nguyên); bước sau dùng bảng lỗi của Story 2.2.
- **Id tài khoản:** `platform_account_id` lấy `me.id` (chuỗi) thay cho `user_id` của phản hồi đổi mã — Threads trả `user_id` dạng số JSON, id ~1.7e16 vượt 2^53 nên có thể mất chính xác khi `JSON.parse`. `debug_token.user_id` (nếu là chuỗi) khác `me.id` → `OAUTH_FAILED`.
- **Lưu trữ:** ứng viên Threads giữ `tokenEnvelope` + `tokenExpiresAt` (= now + `expires_in`; thiếu → `debug_token.expires_at` → 60 ngày). Xác nhận: `page_credentials.access_token` = envelope, `expires_at` như trên, `meta_account_id = null`, `granular_scopes` = quyền Threads đã cấp. Không có `data.scopes` → coi như đủ 5 quyền. Migration `0009_connections_threads_provider`: CHECK `oauth_states.provider` và `oauth_results.provider` ∈ (`facebook`, `threads`).
- **Meta giả:** `createMetaClients` với `META_FAKE` trả cả `threads` giả (`createFakeThreads` trong `fake-meta.ts`, app id/secret giả riêng). Trang `/oauth/threads/fake-consent`: Đồng ý / Huỷ / "Bỏ quyền trả lời" (bỏ `threads_read_replies` + `threads_manage_replies`); code giả gửi kèm `#_`. Tài khoản giả `@lananh.threads`.
- **Web:** `useStartConnect({provider, from})` thay `useStartFacebookConnect`; `CONNECT_PROVIDER_PARAM`, `providerFromParam`, `providerOfPlatform`, `splitPagesByProvider`, `MISSING_TITLES`, nhãn quyền Threads. `ConnectResultModal` theo `provider` (tiêu đề "Kết nối Threads", modal "Chưa cấp đủ quyền Threads", danh sách tài khoản Threads một cột). Trang & Nhóm và Màn chào bỏ "Sắp có", nút Threads mở luồng Threads; "Kết nối lại" theo nền tảng của trang. Cài đặt › Tài khoản Meta đọc `usePages()`: khối "Facebook (Fanpage + Instagram)" và khối "Threads", mỗi khối có nút kết nối riêng, dòng trang có "Kết nối từ <ngày>", chip trạng thái, "Kết nối lại" khi không `active` (callback đưa về Trang & Nhóm). Bỏ dữ liệu mẫu `META_ACCOUNTS` / `TOKEN_EXPIRY`; ngày hết hạn token chưa hiện (PageDto chưa có, Story 2.4).
- `META_NOT_CONFIGURED` microcopy nhắc cả cặp Threads; api log cảnh báo khi thiếu cặp Threads.
- Sau review (vòng 1):
  - Đổi mã Threads gửi bằng form body (`MetaPostOptions.form`, `application/x-www-form-urlencoded`): `client_secret`/`code` không còn trong URL. GET `th_exchange_token` / `debug_token` giữ nguyên; log client chỉ có path.
  - `debug_token` Threads: bắt buộc `is_valid === true`, `type === 'USER'` khi có, so `app_id`/`user_id` dạng chuỗi mọi kiểu JSON. `expires_at` làm tròn xuống (cột bigint).
  - Callback: Location luôn kết thúc `#` (đè `#_`/`#_=_` mà trình duyệt giữ qua 302); web `stripOAuthFragment` bỏ phần đuôi. Trang giả Threads đặt `#_` ở fragment của `action`; Đồng ý bật lại ô code sau Huỷ + bfcache (cả trang giả Facebook).
  - Lỗi khi lưu kết quả → `errorLocation(provider, returnTo, 'INTERNAL')` (đúng màn gốc + `nen-tang`); catch ở route → Trang & Nhóm kèm `nen-tang`.
  - `CONNECT_PROVIDER_PARAM` chuyển sang `@ottm/shared`; `providerFromParam` parse bằng `OAuthProvider`. `CONNECT_FROM` thêm `settings` (`/cai-dat`, migration `0010_oauth_return_settings`); Cài đặt tự xử lý `?ket-noi=` bằng cùng modal, khối Threads đếm "tài khoản", có dòng hướng dẫn thêm tài khoản Threads thứ hai (cả runbook §6.7).
  - Câu lỗi theo nền tảng: `errorMessage(code, provider?)` / `errorMessageOf(err, provider?)` (Threads: `OAUTH_FAILED`, `META_NOT_CONFIGURED` chỉ nhắc `THREADS_*`, `PERMISSION_DENIED`). `candidateGroupsFor`, `resultProvider` tách vào `lib/connections.ts` có test.
- **Kiểm tra:** `npm run check` thoát 0 (server 24 file / 509 test, web 7 file / 79 test, depcruise sạch), `drizzle-kit check` sạch. Thử trình duyệt với `META_FAKE=1`: AC1 (Trang & Nhóm › Threads → đồng ý → chọn → bảng có "Lan Anh Threads (giả)" Đang hoạt động; Cài đặt › Tài khoản Meta có khối Threads riêng), AC2 ("Bỏ quyền trả lời" → modal "Chưa cấp đủ quyền Threads" + 2 quyền + "Thử lại" mở lại trang đồng ý Threads), Kết nối lại từ Cài đặt khi trang Threads mất kết nối → khôi phục, Huỷ từ Màn chào → "Bạn đã huỷ kết nối". DB: token `v1:` envelope, `expires_at` ≈ now + 60 ngày, không `meta_account_id`. Log api không có token. Chưa thử với Threads test app thật.

- **Kiểm thử trên trình duyệt (người điều phối, `META_FAKE=1`):**
  - Trang & Nhóm → "+ Kết nối tài khoản" › Threads (không còn "Sắp có") → trang đồng ý Threads giả → hộp thoại "Kết nối Threads", URL không còn `#_` → xác nhận → bảng có trang Threads "Đang hoạt động".
  - Cài đặt › Tài khoản Meta: hai khối Facebook / Threads, kèm gợi ý thêm tài khoản thứ hai.
  - Từ Cài đặt, "Bỏ quyền trả lời" → quay về `/cai-dat`, modal "Chưa cấp đủ quyền Threads" + 2 quyền + "Thử lại".
  - DB: token `v1:`, còn 60 ngày, không `meta_account_id`. Log không có `client_secret`.
  - Chưa thử với Threads test app thật.

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind | Mã OAuth và secret Threads nằm trong query của POST đổi mã | medium | test meta-client xác nhận `searchParams.get('code')`; patch (form body) |
| 2 | blind, edge | debug_token: thiếu is_valid vẫn qua; không kiểm type; user_id số bị bỏ qua kiểm | medium | oauth.ts:1144-1157; patch |
| 3 | edge, vgap | expires_in lẻ gây 500; các nhánh dự phòng hạn token, RATE_LIMITED ở bước đổi mã, nhánh invalid chưa test | medium | oauth.ts:1160-1166; patch |
| 4 | blind, edge | `#_` thật là fragment, trình duyệt giữ lại sau 302; trang giả gửi sai chỗ; mã bị khoá sau Huỷ + back | low | sửa trực tiếp; patch |
| 5 | blind | Chuyển hướng lỗi dự phòng bỏ qua nền tảng/màn quay về | low | catch ở app/oauth.ts; patch |
| 6 | blind | Tham số `nen-tang` định nghĩa hai nơi, parse cứng 'threads' | low | sửa trực tiếp; patch |
| 7 | blind | Thông báo lỗi không theo nền tảng (OAUTH_FAILED nói Meta) | low | patch |
| 8 | vgap | Gom ứng viên Threads và chọn nền tảng khi thử lại chưa test | medium | vgap đã xác minh; patch (tách hàm thuần) |
| 9 | blind | Cài đặt: kết nối xong bị đưa sang Trang & Nhóm; "trang" vs "tài khoản"; không hướng dẫn thêm tài khoản Threads thứ hai | low | patch |
| 10 | blind | Chỉ test một chiều state chéo nền tảng | low | patch |
| 11 | blind | Không có data.scopes thì coi như đã cấp đủ (mở cửa) | false | đúng [ASSUMPTION] đã chốt trong spec; giữ nguyên |
| 12 | blind | Hạn token Threads lưu nhưng không hiển thị, không tự chuyển disconnected | low | thuộc Story 2.4 (theo dõi hạn token); reject cho story này |

## Verification

**Commands:**
- `npm run check` -- expected: exit 0, không dòng failed
- Manual: hai AC đầu trên trình duyệt với `META_FAKE=1`.
