# Epic 2 Context: Kết nối trang và gom nhóm

<!-- Compiled from planning artifacts. Edit freely. Regenerate with compile-epic-context if planning docs change. -->

## Goal

Thay dữ liệu trang mẫu bằng trang thật: chủ shop kết nối Fanpage, Instagram Business (qua Facebook Login for Business) và Threads (OAuth riêng), theo dõi hạn token, kết nối lại đúng trang và gỡ trang mà không mất lịch sử. Chủ shop cũng gom trang vào Nhóm, và Bộ chọn phạm vi lọc dữ liệu thật. Epic này dựng cổng Meta duy nhất (`adapters/meta`) và module `connections` + `pages`. Mọi epic sau dựa vào đây để lấy token, gọi Meta và giải phạm vi.

## Stories

- Story 2.1: Meta client và Meta Test App cho môi trường dev
- Story 2.2: Kết nối Facebook Fanpage và Instagram Business
- Story 2.3: Kết nối Threads
- Story 2.4: Theo dõi hạn token và Kết nối lại
- Story 2.5: Nhóm và gán trang
- Story 2.6: Bộ chọn phạm vi lọc dữ liệu thật
- Story 2.7: Gỡ trang khỏi app

## Requirements & Constraints

- Một cửa sổ Meta cho Fanpage + IG Business đã liên kết Fanpage. Người dùng chọn trang ở bước chọn của app: backend không tự tạo mọi Fanpage được cấp. IG cá nhân hoặc IG chưa liên kết Fanpage thì không chọn được (`IG_NOT_BUSINESS`). Thiếu quyền bắt buộc thì báo `PERMISSIONS_MISSING{missing[]}` kèm "Thử lại". Huỷ cửa sổ thì báo `OAUTH_CANCELLED`.
- Scope OAuth phải gồm cả các quyền đã kiểm là bắt buộc: `pages_show_list`, `business_management`, `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`, `pages_manage_posts`, `read_insights`, `instagram_basic`, `instagram_manage_messages`, `instagram_manage_comments`, `instagram_content_publish`, `instagram_manage_insights`. Threads: `threads_basic`, `threads_content_publish`, `threads_read_replies`, `threads_manage_replies`, `threads_manage_insights`. Dùng "Instagram API with Facebook Login" (Page token, graph.facebook.com), không dùng `instagram_business_*`.
- Trạng thái kết nối: `active` · `expiring` (còn ≤7 ngày tới mốc hết hạn sớm nhất) · `disconnected` (token hỏng, bị thu hồi, thiếu quyền bắt buộc). Kết nối lại chỉ về `active` khi đủ quyền bắt buộc.
- Mỗi trang thuộc tối đa một nhóm. Chuyển trang sang nhóm khác phải trả danh sách ảnh hưởng để FE cảnh báo, và chỉ đổi sau khi người dùng xác nhận. Màu nhóm chỉ chọn trong 8 màu `group-1…8`.
- Phạm vi lọc Tổng quan, Hộp thư, Khách hàng, Lịch nội dung, Chiến dịch, Hiệu suất. Phạm vi không lọc Soạn bài AI, Trang & Nhóm, AI trả lời tự động, Cài đặt. Lựa chọn được nhớ giữa các lần mở app. Gõ không dấu vẫn tìm được.
- Gỡ trang là soft-delete: giữ lịch sử, không xoá cứng dữ liệu nghiệp vụ (xoá cứng chỉ qua luồng quyền riêng tư của Epic 9).
- Token mã hoá khi lưu, không bao giờ trả về client hay ghi log. Mọi `/api/v1/*` cần phiên. `/oauth/*/callback` là route công khai nên phải tự kiểm `state` gắn với session.
- Dev chỉ dùng Meta Test App + Threads test app riêng, callback trỏ về tunnel local. Không bao giờ đổi callback của app production.

## Technical Decisions

- **Sở hữu bảng:** `pages` sở hữu `groups` và `pages`. Module này không gọi module nào. `connections` sở hữu `page_credentials`, `oauth_states`, `oauth_results`, `meta_accounts`, `meta_rate_state`. `pages` có `UNIQUE(platform, platform_account_id)`, `group_id` nullable, `removed_at`, `connection_status` + `connection_status_reason`. Không có cột `auto_reply`: `Page.autoReply`/`brandSource` là trường dẫn xuất do read-model của epic sau ghép.
- **Chủ token (AD-5):** chỉ `connections` giữ token, trong `page_credentials`, kèm `expires_at` (0 nghĩa là không hết hạn, thường gặp với Page token), `data_access_expires_at` (90 ngày, khi hết chủ yếu chặn quyền `instagram_*`) và `granular_scopes` lấy từ `debug_token` (quyền theo từng trang). Trang IG không giữ token riêng: `token_source_page_id` trỏ tới Fanpage. Module khác gọi `connections.getAccessToken(pageId)` ngay trước mỗi lời gọi, không cache. Trạng thái **tính** ở `connections`, **lưu** qua `pages.setConnectionStatus`, và chỉ `connections` được gọi hàm này. `TOKEN_INVALID` → `connections.markDisconnected` lan sang mọi trang IG cùng nguồn token.
- **OAuth (AD-23):** `oauth_states(intent: connect | reconnect:<pageId>, TTL 15 phút)`. Callback đổi token dài hạn rồi lưu ứng viên vào `oauth_results` và chuyển FE sang bước chọn. FE gọi `GET /api/v1/connections/oauth-results/:id` rồi `POST /api/v1/connections/confirm {resultId, accountIds[]}`. Confirm gọi `pages.upsertFromPlatform` (khôi phục dòng cũ và xoá `removed_at`, giữ nhóm, cấu hình, lịch sử), lưu token mã hoá, enqueue `connections.subscribe_page`. Kết nối lại dùng `auth_type=reauthorize`. FB: `fb_exchange_token` → `/me/accounts`. Threads: `th_exchange_token` bằng Threads app secret, được token 60 ngày. Muốn làm mới (`th_refresh_token`) thì token phải ≥24 giờ tuổi và còn hạn.
- **Meta client (AD-6):** mọi lời gọi đi qua `adapters/meta` (`graph.ts`, `threads.ts`, `errors.ts`, `normalize.ts`, `rate.ts`, `fake.ts`), pin `META_GRAPH_VERSION=v26.0`. Trên v26, `GET /?ids=` báo lỗi, nên không dựa vào batch ids. `errors.ts` là chỗ duy nhất biết mã số Meta. Xét subcode trước mã chính:
  - `190` → `TOKEN_INVALID`.
  - `4/17/32/613/80001/80002/80006/341` → `RATE_LIMITED`. Ngoại lệ: `613/2018338` và `368` → `REJECTED`, không retry.
  - `10/2018278`, `10/2534022`, `10/2018065` → `OUTSIDE_WINDOW`.
  - `551/1545041`, `200/1545041`, `10/2018108`, `100/2018001` → `RECIPIENT_UNAVAILABLE`.
  - Các trường hợp `10` hoặc `200–299` còn lại → `PERMISSION_DENIED`.
  - `1`, `2`, 5xx → `TRANSIENT`.
- **Rate limit:** mỗi lời gọi khai báo hạng `interactive|publish|background`. Adapter đọc `X-Business-Use-Case-Usage`/`X-App-Usage` và ghi `meta_rate_state(scope, bucket, usage_pct, blocked_until)`. Usage ≥75% chặn hạng `background`, ≥90% chặn hạng `publish`. `interactive` chỉ dừng khi Meta chặn. `blocked_until` lấy từ `estimated_time_to_regain_access`. `normalize.ts` trả `PublishedRef {platformPostId, permalink}`: FB `{pageId}_{postId}`, IG media id, Threads media id.
- **Job & cron:** `connections.*` dùng queue `standard`, retry 3, concurrency 2, chống trùng bằng trạng thái bản ghi. Cron `connections.token_check` chạy hằng ngày với `tz: 'Asia/Ho_Chi_Minh'` (nên đặt `missed: 'once'`): làm mới token Threads còn ≤15 ngày, tính lại mọi trạng thái theo mốc sớm nhất giữa `expires_at` và `data_access_expires_at`, phát `page.expiring` một lần mỗi chu kỳ. Handler bắt lỗi không retry được, ghi trạng thái rồi kết thúc job bình thường.
- **Nhóm (AD-8):** thành viên nhóm chỉ đổi qua `pages.assignGroup / unassignGroup / deleteGroup`, và các hàm này phát `page.group_changed` / `group.deleted {groupId, memberPageIds}` trong cùng transaction. Danh sách ảnh hưởng khi chuyển nhóm (chiến dịch đang chạy) lấy qua read-model, hiện trả rỗng.
- **Phạm vi & tìm kiếm (AD-18):** `scope=all|group:<id>|page:<id>` giải thành tập `pageId` chỉ qua `pages.resolveScope()`, và trang đã gỡ bị loại. Thực thể nhiều trang thuộc phạm vi khi tập trang của nó giao với tập phạm vi khác rỗng. `pages.search` dùng `unaccent` + `pg_trgm`.
- **Env mới cần thêm vào `platform/config`:** `META_APP_SECRET`, `THREADS_APP_ID/SECRET`, `META_GRAPH_VERSION`, và `META_VERIFY_TOKEN` nếu story cần. Giữ quy tắc: production mà dùng id Meta Test App (hoặc ngược lại) thì không khởi động.

### Epic 1 đã có, phải dùng lại (không tự viết lại)

- **Mã hoá:** `adapters/crypto` (`createSecretCipher`, envelope `v1:<keyId>:…`) và `cipherFromConfig` ở `app/deps.ts` dùng để mã hoá token Meta. Thiếu khoá chủ thì báo `ENCRYPTION_NOT_CONFIGURED`. Việc hoãn còn tồn: dựng `crypto.reencrypt` (dùng `SecretCipher.keyIdOf`) trong Epic 2, khi token Meta cũng được mã hoá.
- **Sự kiện:** `platform/events` `publishEvent(tx, name, payload)` (pg-boss publish trong transaction). `packages/shared/events.ts` đã khai báo `page.connected|reconnected|disconnected|expiring|removed|group_changed` và `group.deleted` với `realtime=true`; story bổ sung khoá payload khi cần (vd `memberPageIds`). `platform/realtime` lo NOTIFY → SSE. Web `lib/realtime.ts` chỉ vô hiệu hoá cache rồi refetch.
- **Job:** registry `platform/jobs/queues.ts` (khai báo queue và payload ở đây; `send()` từ chối tên lạ). `bossDbFor(tx)` dùng để enqueue cùng transaction. `newId()` sinh UUIDv7. `AppError(code, details)`.
- **Thông báo:** `events.notifications` đã subscribe `page.expiring` và tạo thông báo `token_expiring` có dedupe, nên không cần làm lại.
- **Hợp đồng:** `ErrorCode` đã có `PAGE_DISCONNECTED`, `PAGE_REMOVED`, `PERMISSION_DENIED`, `PERMISSIONS_MISSING`, `IG_NOT_BUSINESS`, `OAUTH_CANCELLED`, `RATE_LIMITED`, `RECIPIENT_UNAVAILABLE`. Enum `Platform`, `ConnectionStatus` đã có. Web `lib/error-messages.ts` đã có microcopy cho các mã này.
- **Hạ tầng:** `META_APP_ID`/`META_APP_ENV` (kiểm `live` ở production) và `PUBLIC_BASE_URL` (gốc của callback). Caddy đã định tuyến `/oauth/*` và `/webhooks/*` sang api. Auth chỉ chặn `/api/v1/*`. `modules/pages/index.ts` mới là khung rỗng.
- **Web:** `lib/api.ts` (client chung), `lib/app-context.tsx` (kiểu `Scope`, localStorage `ottm.scope`, hiện lọc trên `mock.ts`: chuyển sang API và `scope=`), `Skeleton`. Các màn `PagesGroups`, `GroupDetail`, `Welcome`, `Settings` đang dùng dữ liệu mẫu.

## UX & Interaction Patterns

- Trang & Nhóm (`/trang-nhom`): nút "+ Kết nối tài khoản" (Facebook/Instagram/Threads). Thẻ nhóm hiện chip nhóm (nền màu nhóm 12%, chữ và chấm màu đầy đủ). Bảng trang cho chọn nhiều, thanh thao tác có "Thêm vào nhóm" → "Tạo nhóm mới". Khi chưa có nhóm thì hiện "Chưa có nhóm nào. Gom các trang cùng chủ đề để dùng chung cấu hình."
- Chip trạng thái luôn có chữ: xanh "Đang hoạt động", vàng "Token sắp hết hạn", đỏ "Mất kết nối". Chip vàng và đỏ kèm "Kết nối lại", hiện ở Trang & Nhóm, Tổng quan, Cài đặt › Tài khoản Meta. Token sắp hết hạn thì chiến dịch vẫn chạy.
- Modal thiếu quyền: "Chưa cấp đủ quyền quản lý tin nhắn" + danh sách quyền thiếu + "Thử lại". Ứng viên IG cá nhân bị khoá, kèm dòng "Chỉ hỗ trợ tài khoản Instagram Business đã liên kết Fanpage".
- Modal chuyển nhóm: "Trang này sẽ chuyển khỏi Nhóm Gia dụng và dùng cấu hình của Nhóm Mỹ phẩm", xác nhận rồi mới đổi.
- Threads hiện là tài khoản OAuth riêng, không gộp vào tài khoản Facebook. Cài đặt › Tài khoản Meta liệt kê các trang kèm ngày hết hạn token, "Kết nối lại" và "Gỡ trang" ([ASSUMPTION] vị trí của "Gỡ trang").
- Bộ chọn phạm vi ở thanh trên, gồm "Tất cả trang", các nhóm (kèm chip màu) và từng trang (kèm icon nền tảng). Đổi phạm vi thì lọc lại màn hiện tại, không chuyển trang.
- Màn chào `/bat-dau` bước 1 dùng chung luồng kết nối. Thao tác nền (kết nối xong…) báo bằng toast từ sự kiện SSE. Luôn hiện icon nền tảng cạnh tên trang.

## Cross-Story Dependencies

- 2.1 (adapter, bảng lỗi, `fake.ts`, runbook Test App) là nền cho 2.2–2.4. 2.2 dựng `pages`/`page_credentials`/OAuth. 2.3 dùng lại modal và `upsertFromPlatform` của 2.2. 2.4 cần trang đã kết nối từ 2.2 và 2.3. 2.5–2.7 cần bảng `pages`. 2.6 cần thêm `groups` từ 2.5.
- Hàm và sự kiện mà epic sau tiêu thụ:
  - Epic 3 (`profiles`) phản ứng với `page.group_changed`/`group.deleted` để giữ cấu hình.
  - Epic 4 xử lý job `connections.subscribe_page` (đăng ký `subscribed_apps`, Story 4.2) và gọi `getAccessToken`.
  - Epic 6 huỷ target chưa đăng khi nhận `page.removed`.
  - Epic 7 tạm dừng chiến dịch khi nhận `page.disconnected` và bỏ trang khi nhận `page.removed`. Kết nối lại không tự chạy lại chiến dịch.
  - Mọi màn danh sách có dữ liệu trang dùng `pages.resolveScope`.
