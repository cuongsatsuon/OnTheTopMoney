---
title: 'Story 2.2 — Kết nối Facebook Fanpage và Instagram Business'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-2-2
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-2-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-2-1-meta-client-va-meta-test-app.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chủ shop chưa kết nối được Fanpage và Instagram Business thật. Bảng Trang & Nhóm và bước 1 của Màn chào vẫn dùng dữ liệu mẫu.

**Approach:** Thêm luồng OAuth "Facebook Login for Business":
1. Bắt đầu từ app.
2. Callback kiểm `state` gắn với phiên đăng nhập.
3. Đổi token dài hạn, đọc Fanpage và IG liên kết, đọc quyền theo từng trang.
4. Lưu danh sách ứng viên.
5. Đưa chủ shop về bước chọn trang.

Xác nhận thì tạo hoặc khôi phục trang (`pages.upsertFromPlatform`), lưu token Page mã hoá; trang IG trỏ token của Fanpage nguồn. Bảng Trang & Nhóm và Màn chào bước 1 đọc danh sách trang thật. Có chế độ Meta giả chỉ dùng khi dev để thử trọn luồng mà không cần app Meta.

## Boundaries & Constraints

**Always:** AD-5, AD-23, AD-12, AD-1. Chỉ `connections` giữ token (`page_credentials`, envelope từ `adapters/crypto`). Chỉ `connections` gọi `pages.setConnectionStatus` / `pages.upsertFromPlatform`.
- **Quyền:** xin đủ danh sách quyền ở `epic-2-context.md` dòng 22 (phần Facebook/Instagram). Nếu có `META_LOGIN_CONFIG_ID` thì dùng `config_id`, ngược lại dùng `scope`.
- **Quyền bắt buộc tính theo trang:** đọc `granular_scopes` của `debug_token`. Gồm `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`; với IG thêm `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `instagram_content_publish`.
- **Token:** đổi sang user token dài hạn (`fb_exchange_token`), rồi lấy Page token qua `/me/accounts`. Lưu `expires_at` (0 nghĩa là không hết hạn), `data_access_expires_at`, `granular_scopes`.
- **Cookie và kết quả:** `state` là chuỗi ngẫu nhiên lưu ở `oauth_states` (TTL 15 phút) cùng id phiên; callback chỉ nhận khi cookie phiên khớp. Kết quả callback lưu ở `oauth_results` (TTL 15 phút), chuyển hướng về `/trang-nhom?ket-noi=<resultId>`, hoặc `/bat-dau?ket-noi=<resultId>` nếu bắt đầu từ Màn chào.
- **Phát sự kiện:** `page.connected` cho trang mới, `page.reconnected` cho trang được khôi phục.
- **Meta giả** [ASSUMPTION]: bật bằng `META_FAKE=1`; production từ chối khởi động nếu bật. Nút "Kết nối Facebook" đi tới trang đồng ý giả cục bộ `/oauth/facebook/fake-consent`, có nút "Đồng ý" và "Huỷ" cùng lựa chọn "bỏ quyền tin nhắn". Dữ liệu trả về: 2 Fanpage (một có IG Business liên kết, một có IG chưa phải tài khoản Business). Mọi lời gọi Meta khi bật đi qua `adapters/meta/fake.ts`.

**Never:**
- Không đăng ký webhook trang (thuộc Story 4.2).
- Không làm Threads (2.3), theo dõi hạn token (2.4), nhóm (2.5), Phạm vi (2.6).
- Không tự tạo mọi Fanpage được cấp: chỉ tạo trang người dùng chọn.
- Không gửi token ra client, không đưa token vào log hay URL chuyển hướng.
- Không đổi các màn khác đang dùng `mock.ts`, trừ Trang & Nhóm (bảng trang) và Màn chào bước 1.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Bắt đầu | `POST /api/v1/connections/facebook/start {from:'pages'|'welcome'}` (có phiên) | `{url}` tới hộp thoại Meta (hoặc trang giả), `state` lưu kèm phiên | thiếu `META_APP_ID` và không bật giả → 500 `META_NOT_CONFIGURED` |
| Callback thành công | `GET /oauth/facebook/callback?code&state` | đổi token, lưu ứng viên + quyền thiếu theo trang vào `oauth_results`, 302 về trang chọn | N/A |
| State sai/hết hạn/không khớp phiên | `state` lạ hoặc cookie khác | 302 về `/trang-nhom?ket-noi-loi=OAUTH_STATE_INVALID` | không đổi `code` |
| Huỷ | `error=access_denied` | kết quả `OAUTH_CANCELLED`; FE hiện "Bạn đã huỷ kết nối" + "Thử lại" | N/A |
| Thiếu quyền | `granular_scopes` không có quyền bắt buộc cho trang | ứng viên đó có `missing[]`; FE hiện modal "Chưa cấp đủ quyền quản lý tin nhắn" + danh sách + "Thử lại" | ứng viên thiếu quyền không chọn được |
| IG cá nhân/không liên kết | Fanpage không có `instagram_business_account` hoặc IG không phải Business | ứng viên IG khoá, dòng "Chỉ hỗ trợ tài khoản Instagram Business đã liên kết Fanpage" (`IG_NOT_BUSINESS`) | N/A |
| Đọc kết quả | `GET /api/v1/connections/oauth-results/:id` | `{status, candidates:[{accountId, platform, name, handle, avatarUrl, linkedToAccountId?, selectable, missing[], reason?}], errorCode?}` — không có token | hết hạn/không thuộc phiên → 404 |
| Xác nhận | `POST /api/v1/connections/confirm {resultId, accountIds[]}` | upsert trang (khoá `UNIQUE(platform, platform_account_id)`), lưu token Fanpage mã hoá, IG có `token_source_page_id`, trạng thái `active`, phát sự kiện; kết quả bị xoá | chọn IG mà không chọn Fanpage nguồn → tự gồm Fanpage nguồn; id không có trong kết quả hoặc không chọn được → 400 |
| Kết nối lại trang đã có/đã gỡ | trang cùng `platform_account_id` | khôi phục đúng dòng cũ (xoá `removed_at`, giữ id), cập nhật token, phát `page.reconnected` | N/A |
| Danh sách trang | `GET /api/v1/pages` | trang chưa gỡ: `{id, platform, name, handle, avatarUrl, connectionStatus, connectedAt}` | N/A |

</frozen-after-approval>

## Code Map

- `server/src/modules/connections/{index.ts,meta-clients.ts,rate-store.ts,schema.ts}` -- `createMetaClients({config, db, log})` trả `{graph}`; thêm OAuth, `page_credentials`, `oauth_states`, `oauth_results`, `meta_accounts` (user token dài hạn mã hoá, theo FB user id) ở đây.
- `server/src/adapters/meta/{client.ts,fake.ts,errors.ts}` -- `graph.get/post` có tier/scope; fake lập trình được; dùng `ABORTED`/`TOKEN_INVALID`.
- `server/src/adapters/crypto` + `server/src/app/deps.ts` (`cipherFromConfig`) -- mã hoá token như khoá OpenAI.
- `server/src/modules/pages/index.ts` -- module nền đang rỗng: thêm bảng `pages`, `upsertFromPlatform`, `setConnectionStatus`, `listPages`; bảng `groups` để Story 2.5 (`group_id` cột nullable, chưa FK).
- `server/src/modules/settings/auth.ts` -- `resolveSession` / id phiên để gắn `state`.
- `server/src/app/auth/index.ts` -- guard chỉ áp `/api/v1/*`; route `/oauth/facebook/*` ngoài guard nên tự kiểm phiên bằng cookie.
- `server/src/platform/config/index.ts` -- thêm `META_LOGIN_CONFIG_ID` (tuỳ chọn), `META_FAKE` (dev), `PUBLIC_BASE_URL` (dev mặc định `http://localhost:5173`) để dựng `redirect_uri`.
- `web/src/screens/PagesGroups.tsx:124-262` -- menu "+ Kết nối tài khoản" và dialog `connect` đang giả lập; nối API; bảng trang đọc `GET /api/v1/pages` (nhóm vẫn mẫu tới 2.5).
- `web/src/screens/Welcome.tsx:85-160` -- bước 1 đang dựa `connected` mẫu: dùng danh sách trang thật.
- `web/src/lib/error-messages.ts` -- thêm `META_NOT_CONFIGURED`, `OAUTH_STATE_INVALID`, `OAUTH_CANCELLED`, `PERMISSIONS_MISSING`, `IG_NOT_BUSINESS`.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/modules/pages/{schema.ts,service.ts,index.ts}` + migration -- bảng `pages(id uuidv7, platform, platform_account_id, name, handle, avatar_url, group_id null, connection_status, connection_status_reason, connected_at, removed_at, unique(platform, platform_account_id))`; `upsertFromPlatform`, `setConnectionStatus`, `listPages`.
- [x] `server/src/modules/connections/{schema.ts,oauth.ts,candidates.ts,confirm.ts,credentials.ts,index.ts}` + migration -- bảng `page_credentials`, `oauth_states`, `oauth_results`, `meta_accounts`; `startFacebookOAuth`, `handleFacebookCallback`, `getOAuthResult`, `confirmConnections`, `getAccessToken(pageId)` (IG lấy theo nguồn); dọn bản ghi OAuth hết hạn khi đọc.
- [x] `server/src/modules/connections/fake-meta.ts` -- dữ liệu và phản hồi Meta giả cho `META_FAKE=1`.
- [x] `server/src/app/{connections.ts,oauth.ts,pages.ts}` + đăng ký trong `app.ts` -- routes theo ma trận; `/oauth/facebook/fake-consent` chỉ khi bật giả.
- [x] `server/src/platform/config/index.ts` + test -- biến mới, production cấm `META_FAKE`.
- [x] `server/test/connections-oauth.test.ts` -- mọi dòng ma trận phía server bằng fake adapter, gồm kiểm DB chỉ chứa envelope, log/URL không chứa token, IG không có token riêng.
- [x] `packages/shared/src/connections.ts` -- zod request/response, kiểu ứng viên, `Page` DTO.
- [x] `web/src/lib/connections.ts` -- hooks start/result/confirm, `usePages` (khoá `['pages']`).
- [x] `web/src/screens/PagesGroups.tsx` -- "Kết nối Facebook" gọi start rồi chuyển hướng; khi có `?ket-noi=` mở dialog chọn trang (Fanpage và IG liên kết hiển thị cạnh nhau, ứng viên khoá có lý do), modal thiếu quyền, thông báo huỷ; bảng trang từ API với chip trạng thái.
- [x] `web/src/screens/Welcome.tsx` -- bước 1 dùng `usePages`, nút kết nối dùng cùng luồng (`from:'welcome'`).
- [x] `server/.env.example`, `deploy/runbook.md` -- `META_FAKE`, `META_LOGIN_CONFIG_ID`, redirect URI cần khai báo trong app Meta.

**Acceptance Criteria:**
- Given `npm run dev` với `META_FAKE=1` và đã đăng nhập, when bấm "+ Kết nối tài khoản" › Facebook, đồng ý ở trang giả, chọn Fanpage và IG Business rồi xác nhận, then bảng Trang & Nhóm hiện hai trang mới với chip "Đang hoạt động"; IG cá nhân hiện khoá kèm dòng giải thích.
- Given trang giả với "bỏ quyền tin nhắn", when quay về, then thấy modal "Chưa cấp đủ quyền quản lý tin nhắn" kèm danh sách quyền thiếu và "Thử lại"; bấm "Huỷ" ở trang giả thì thấy thông báo huỷ.
- Given `npm run check`, when chạy, then thoát 0 và không dòng failed.

## Implementation Notes

- Thêm file ngoài Code Map: `modules/connections/deps.ts` (`ConnectionsDeps`), `web/src/components/ConnectResultModal.tsx` (bước chọn trang dùng chung cho Trang & Nhóm và Màn chào), `web/src/lib/connections.test.ts`; launch config `app-meta-fake` trong `.claude/launch.json` (`META_FAKE=1 npm run dev`).
- Hợp đồng (`packages/shared/src/connections.ts`): `META_LOGIN_SCOPES`, `PAGE_REQUIRED_SCOPES`, `INSTAGRAM_REQUIRED_SCOPES`, `OAuthResultResponse.status = 'ok' | 'error'`, `GET /api/v1/pages` → `{items: PageDto[]}`, confirm → `{pages: PageDto[]}`. `ErrorCode` thêm `OAUTH_STATE_INVALID`, `META_NOT_CONFIGURED` (microcopy ở `web/src/lib/error-messages.ts`).
- Config: `PUBLIC_BASE_URL` mặc định `http://localhost:5173` ngoài production (transform); `META_FAKE` (EnvBool, production → lỗi); `META_LOGIN_CONFIG_ID` (chữ số) — truyền qua `deploy/docker-compose.yml` và `env.production.example`.
- State: chỉ xoá (dùng một lần) khi khớp cả `state`, `session_id` của cookie và còn hạn — cookie phiên khác không tiêu state. Callback lỗi bất ngờ → 302 `/trang-nhom?ket-noi-loi=INTERNAL`. Huỷ: `error=access_denied` → `OAUTH_CANCELLED`; `error` khác hoặc thiếu `code` → `INTERNAL`. Lỗi Meta khi đổi token: `RATE_LIMITED`/`PERMISSION_DENIED` giữ nguyên, còn lại `INTERNAL` (log chỉ bước + loại lỗi).
- Chuỗi gọi Meta: `GET /oauth/access_token` (code) → `GET /oauth/access_token` (`fb_exchange_token`) → `GET /debug_token` (app token `appId|secret`) → `GET /me` → `GET /me/accounts` (phân trang theo `after`, tối đa 10 trang). Hạng `interactive`, scope `oauth:facebook` / `user:<fbUserId>`.
- Quyền theo trang: mục `granular_scopes` không có `target_ids` coi như cấp cho mọi đối tượng. IG Business thiếu quyền = quyền IG thiếu theo id IG ∪ quyền Fanpage nguồn thiếu (token đi theo Fanpage). Fanpage không có `access_token` trong `/me/accounts` bị bỏ qua.
- [ASSUMPTION] IG chưa chuyên nghiệp: chỉ xin `connected_instagram_account` (id) vì các trường khác bị hạn chế với tài khoản cá nhân → tên hiển thị "Instagram của <Fanpage>" khi Meta không trả `username`. Chưa thử với Meta thật.
- [ASSUMPTION] Page token lấy từ user token dài hạn coi như không hết hạn: `page_credentials.expires_at = 0`; `data_access_expires_at` chép từ `debug_token` của user token; `granular_scopes` của trang = các quyền trong danh sách xin đã cấp cho id đó. Không gọi `debug_token` cho từng Page token (Story 2.4 theo dõi hạn).
- `oauth_results.candidates` (jsonb) giữ envelope token Page (`tokenEnvelope`) — không có token rõ; bản trả FE lọc qua `toPublicCandidate`. `meta_accounts.user_token` là envelope. Không khoá ngoại sang `pages` (bảng của module khác); `page_credentials` có CHECK đúng một trong `access_token` / `token_source_page_id`.
- `pages.upsertFromPlatform` khoá dòng cũ (`FOR UPDATE`) để biết tạo mới hay khôi phục; mọi dòng đã có (đang kết nối hoặc đã gỡ) → `page.reconnected`, giữ id và `group_id`. Payload sự kiện `{id, pageId}` (= id trang).
- Web: bảng "Tất cả trang" đọc `usePages`; nhóm / AI trả lời / hồ sơ vẫn là dữ liệu mẫu, thay đổi chỉ giữ cục bộ trong màn (lớp phủ theo id trang), không ghi lại `mock.pages`. Bỏ cột "Người theo dõi" (API chưa có số liệu) và mục "Ngắt kết nối" (gỡ trang là Story 2.7). "Kết nối lại" chạy lại luồng OAuth. Mục Threads ở menu và Màn chào hiện "Sắp có" (Story 2.3). Facebook và Instagram trong menu cùng mở một luồng Meta.
- Runbook: sửa redirect URI dev từ `/oauth/meta/callback` thành `/oauth/facebook/callback`, thêm mục 6.6 (Meta giả + thử với Test App). `deploy/smoke-test.sh` vẫn kiểm `/oauth/meta/callback` → 404 (đúng: route không tồn tại), không đổi.
- Sau review (vòng 1):
  - Callback: lỗi bất ngờ sau khi đọc state → ghi `oauth_results` lỗi `INTERNAL`, 302 về đúng màn gốc. Mã mới `OAUTH_FAILED` ("Không hoàn tất được đăng nhập Meta. Thử lại."): `debug_token` khác `app_id` hoặc `type !== 'USER'`, Meta 100 khi đổi code, `error` khác `access_denied`, thiếu `code`.
  - Không có `granular_scopes` → dùng `scopes` (cấp chung). Hạn user token không rõ → now + 60 ngày. `/me/accounts` vượt `OAUTH_MAX_PAGES` (1.000) → cảnh báo log + `truncated: true` (cột mới), FE hiện "Chỉ hiện 1.000 trang đầu". `accountIds` tối đa `OAUTH_MAX_CANDIDATES` (2.000).
  - `getAccessToken`: trang mất kết nối → `PAGE_DISCONNECTED`, đã gỡ → `PAGE_REMOVED`; IG có Fanpage nguồn mất kết nối hoặc đã gỡ → `PAGE_DISCONNECTED`.
  - Xác nhận: `created` suy từ `xmax = 0`; `page.reconnected` chỉ khi dòng đã gỡ hoặc `disconnected`; trang đang hoạt động xác nhận lại giữ `connected_at`, không phát sự kiện.
  - Migration `0008`: FK `page_credentials.page_id → pages` (cascade), `token_source_page_id → pages` (restrict), `meta_account_id → meta_accounts` (set null, cả `oauth_results`). `pages` export `pagesTable` chỉ để khai FK.
  - Cron `connections.oauth_gc` (mỗi giờ, giờ VN) dọn state/kết quả hết hạn; đăng xuất xoá state/kết quả OAuth của phiên.
  - Caddy `img-src` thêm `https://*.fbcdn.net https://*.cdninstagram.com`.
  - Web: `usePages` chép trang thật vào kho mẫu `mock.pages` (giữ nhóm/AI/hồ sơ) để Chi tiết trang, Chi tiết nhóm, bộ chọn phạm vi thấy trang thật; sửa nhóm/AI ở Trang & Nhóm ghi ngược vào kho mẫu. `AppShell`, `PageDetail`, `GroupDetail` gọi `usePages()` (PageDetail chờ tải trước khi báo không tìm thấy). Modal chọn trang không chọn sẵn; xác nhận 404 → "Thử lại". Màn chào: lỗi tải trang + "Thử lại", gợi ý IG cần liên kết Fanpage.
- **Kiểm tra:** `npm run check` thoát 0 (server 463 test, web 75 test, depcruise sạch), `drizzle-kit check` sạch. Thử trình duyệt với `META_FAKE=1`: AC1 (chọn Fanpage + IG Business → bảng hiện 2 trang "Đang hoạt động", IG cá nhân khoá kèm dòng giải thích), AC2 (bỏ quyền tin nhắn → modal thiếu quyền + "Thử lại"; Huỷ → "Bạn đã huỷ kết nối"), state lạ → toast, Màn chào bước 1 "Xong" theo trang thật. Log api không chứa token giả. Chưa thử với Meta Test App thật. DB dev (`.data/pg`) còn 2 trang giả từ lần thử.

- **Kiểm thử trên trình duyệt (người điều phối, `META_FAKE=1`):**
  - Trang & Nhóm → "+ Kết nối tài khoản" → Facebook → trang đồng ý giả → bước chọn: không ô nào chọn sẵn, IG cá nhân bị khoá kèm lý do; chọn IG thì Fanpage nguồn tự được chọn → "Kết nối 2 trang" → bảng có 2 trang "Đang hoạt động".
  - DB: Fanpage có token `v1:` (envelope), IG không có token mà trỏ `token_source_page_id`. Trang chi tiết của trang thật mở đúng.
  - Bỏ quyền tin nhắn → modal "Chưa cấp đủ quyền quản lý tin nhắn" + 2 quyền + "Thử lại"; "Thử lại" rồi "Huỷ" → "Bạn đã huỷ kết nối". Log không có `access_token=`.
  - Chưa thử với Meta Test App thật. Hai trang giả còn lại trong DB dev.

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind, edge (deletion), vgap | Trang thật mở PageDetail mock → "Không tìm thấy"; sửa nhóm/AI chỉ sống trong overlay cục bộ | high | `PageDetail.tsx:40` tìm trong mock; bỏ write-back `commitPages`; patch |
| 2 | blind, edge | Bước chọn đánh dấu sẵn mọi trang; confirm 404 không có "Thử lại" | medium | `defaultSelection` chọn hết; patch |
| 3 | blind, edge, vgap | Lỗi trong callback: bỏ qua returnTo, state đã đốt, không có kết quả để thử lại | medium | catch ở `app/oauth.ts` chuyển cứng /trang-nhom; patch |
| 4 | blind, edge, vgap | debug_token không kiểm app_id/type; thiếu granular_scopes báo nhầm thiếu quyền; hạn không rõ ghi thành 0; phân trang và cắt cụt chưa test; mapping lỗi chưa test | medium | oauth.ts collectCandidates; patch |
| 5 | blind, edge | getAccessToken trả token cho trang disconnected; IG dùng token của Fanpage đã gỡ | high | credentials.ts không kiểm trạng thái; patch |
| 6 | blind, edge | Xác nhận lại trang đang active phát `page.reconnected`, đổi connected_at; `created` sai khi đồng thời | medium | confirm.ts chỉ xét `created`; patch |
| 7 | blind | Bảng token không có khoá ngoại | medium | migration 0007 không FK; patch |
| 8 | blind | Token trong kết quả OAuth bỏ dở nằm mãi | medium | chỉ dọn khi dùng OAuth lại; patch (cron + xoá khi đăng xuất) |
| 9 | blind | Ảnh đại diện Meta bị CSP chặn ở production | medium | img-src thiếu fbcdn/cdninstagram; patch |
| 10 | edge | accountIds tối đa 200 thấp hơn số ứng viên | low | sửa trực tiếp; patch |
| 11 | blind | Welcome: lỗi tải trang trông như "chưa có trang"; thẻ IG không gợi ý cần liên kết Fanpage | low | patch |
| 12 | vgap | connectionsOptionsFromConfig và nhánh META_FAKE chưa có test | medium | vgap đã xác minh; patch |
| 13 | blind, edge (deletion) | Bỏ "Ngắt kết nối" mà chưa có thay thế | low | nút cũ chỉ giả lập; gỡ trang là Story 2.7; reject (làm ở 2.7) |
| 14 | blind | config_id không đủ quyền chỉ hiện "thiếu quyền" không gợi ý cấu hình | low | runbook đã yêu cầu cấu hình đủ quyền; reject |
| 15 | blind | Chưa có test component modal/URL param | low | logic chính đã tách hàm thuần có test; reject |

## Design Notes

Callback nằm ngoài `/api/v1` (Meta chuyển hướng trình duyệt tới đó), nên route tự đọc cookie phiên và so với id phiên lưu cùng `state`; không khớp thì không đổi `code`. Kết quả OAuth giữ ở server, FE chỉ nhận `resultId` qua URL; token không bao giờ rời server.

## Verification

**Commands:**
- `npm run check` -- expected: exit 0, không dòng failed
- Manual: hai AC đầu trên trình duyệt với `META_FAKE=1`.
