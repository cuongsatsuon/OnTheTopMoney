# Hồ sơ App Review và chuyển Live (Meta App + Threads app)

Tài liệu này để chủ shop tự nộp App Review cho **hai app Meta**: Meta App (Facebook Page, Messenger, Instagram qua
Facebook Login for Business) và Threads app (OAuth riêng). Duyệt xong, app chuyển sang Live và nhận tin của khách thật.
Mỗi bước bám đúng màn của OnTheTopMoney. Bước triển khai (env, nginx, webhook cấp app) xem `deploy/runbook.md`.

> **Nguồn và ngày tra: 24/10/2026.** Tên quyền, phụ thuộc và yêu cầu nộp đã đối chiếu với các trang Meta for
> Developers dưới đây. Meta có thể đổi tài liệu, nên **mở lại các trang này vào ngày nộp**. Dòng nào ghi "cần đối chiếu
> lúc nộp" là chỗ tài liệu chưa nói rõ hoặc chưa tra được.
> - Permissions Reference: <https://developers.facebook.com/docs/permissions>
> - App Review — Submission Guide: <https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review/submission-guide>
> - Data Deletion Callback: <https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback>
> - Threads API — Get started: <https://developers.facebook.com/docs/threads/get-started>
> - Threads use case (cài đặt app, điều kiện publish): <https://developers.facebook.com/docs/development/create-an-app/threads-use-case>
> - Messenger User Profile (Business Asset User Profile Access): <https://developers.facebook.com/docs/messenger-platform/user-profile>

Nguồn sự thật của danh sách quyền là code: `META_LOGIN_SCOPES` và `THREADS_LOGIN_SCOPES` ở
`packages/shared/src/connections.ts`. Hai danh sách đó được gửi trong hộp thoại OAuth
(`server/src/modules/connections/oauth.ts`). Code đổi scope thì phải sửa lại tài liệu này.

---

## 1. Việc chủ shop phải làm (không làm được trong repo)

| # | Việc | Ở đâu | Xong |
|---|------|-------|------|
| 1 | Đặt `PRIVACY_CONTROLLER_NAME`, `PRIVACY_CONTACT_EMAIL`, `META_APP_SECRET`, `THREADS_APP_SECRET` rồi deploy | `deploy/.env` (runbook mục 9) | [ ] |
| 2 | Rà nội dung trang chính sách (cơ sở pháp lý, vị trí máy chủ, có cần bản tiếng Anh cho reviewer không) | `server/src/app/privacy-pages.ts` | [ ] |
| 3 | Business Verification cho Business Portfolio sở hữu hai app | mục 3.1 | [ ] |
| 4 | Organization Verification ở OpenAI (nếu model ảnh đòi) | mục 3.2 | [ ] |
| 5 | Icon, thông tin app, URL quyền riêng tư cho cả hai app | mục 2 | [ ] |
| 6 | Mỗi quyền gọi thành công ít nhất một lần trong 30 ngày trước khi nộp | mục 6.1 | [ ] |
| 7 | Quay video, viết mô tả cho từng quyền, nộp | mục 4, 5, 6 | [ ] |
| 8 | Duyệt xong → chuyển Live, bật webhook cấp app trên app Live | mục 7 | [ ] |
| 9 | Kiểm webhook đủ ba nguồn với khách thật, xác nhận secret webhook Threads | mục 8, runbook mục 10 | [ ] |

---

## 2. Chuẩn bị chung

### 2.1 URL bắt buộc

Mở **Cài đặt › Tài khoản Meta › "Quyền riêng tư cho Meta App và Threads app"** (`/cai-dat?section=meta`) để sao chép
URL tuyệt đối theo `PUBLIC_BASE_URL` (host api). Ở chế độ tách, đó là `https://api.<miền>`, không phải host web trên
Hostinger.

| Ô trong bảng điều khiển Meta | App | URL |
|---|---|---|
| **Privacy Policy URL** (App settings › Basic) | cả hai | `<PUBLIC_BASE_URL>/privacy/policy` |
| **Data Deletion Request URL / Data deletion callback URL** (App settings › Basic › User data deletion) | Meta App | `<PUBLIC_BASE_URL>/privacy/meta/data-deletion` |
| **Deauthorize callback URL** (Facebook Login for Business › Settings) | Meta App | `<PUBLIC_BASE_URL>/privacy/meta/deauthorize` |
| **Deauthorize callback URL** (cũ: *Uninstall Callback URL*) — Use cases › Access the Threads API › Settings | Threads app | `<PUBLIC_BASE_URL>/privacy/threads/uninstall` |
| **Data Deletion Requests URL** (cũ: *Delete Callback URL*) — cùng trang | Threads app | `<PUBLIC_BASE_URL>/privacy/threads/delete` |
| **Valid OAuth Redirect URIs** (Facebook Login for Business › Settings) | Meta App | `<PUBLIC_BASE_URL>/oauth/facebook/callback` |
| **Redirect Callback URLs** (Access the Threads API › Settings) | Threads app | `<PUBLIC_BASE_URL>/oauth/threads/callback` |
| **Webhooks › Callback URL** (Page, Instagram) | Meta App | `<PUBLIC_BASE_URL>/webhooks/meta` (Cài đặt › Webhook tin nhắn) |
| **Webhooks › Callback URL** (Threads) | Threads app | `<PUBLIC_BASE_URL>/webhooks/threads` |

Callback xoá dữ liệu nhận `signed_request` (HMAC-SHA256, khoá là app secret của **chính app đó**) và trả
`{url, confirmation_code}`. `url` dẫn tới trang trạng thái công khai `/privacy/status/<mã>`. Phía Threads app,
tài liệu Meta chưa ghi rõ dạng `signed_request` và secret ký. App giả định giống Meta App, ký bằng **Threads app
secret** (cần đối chiếu lúc nộp; kiểm thật ở mục 8.3).

Kiểm trước khi dán:

```bash
curl -sI https://<host api>/privacy/policy                 # 200, đúng một header Content-Security-Policy
curl -s -X POST https://<host api>/privacy/meta/data-deletion -d 'signed_request=x'     # 400 (chữ ký sai, không ghi gì)
curl -s -X POST https://<host api>/privacy/threads/delete -d 'signed_request=x'         # 400
```

Khối "Quyền riêng tư" ở Cài đặt hiện cảnh báo vàng khi còn thiếu tên/email đơn vị vận hành, `META_APP_SECRET` hoặc
`THREADS_APP_SECRET`. Phải hết cảnh báo mới nộp.

### 2.2 Icon và thông tin app

| Mục | Meta App | Threads app |
|---|---|---|
| App icon | **1024 × 1024 px** (App settings › Basic › App icon), không chứa logo/nhãn hiệu Meta | **512 × 512 tới 1024 × 1024 px**, JPEG/GIF/PNG, dưới 5 MB — dùng chung file 1024 × 1024 là đủ cả hai |
| App category | Business and pages (hoặc mục gần nhất — chọn đúng việc app làm) | như bên trái |
| Contact email | email chủ shop đọc được (Meta gửi kết quả duyệt về đây) | như bên trái |
| App Purpose | "Yourself or your own business" khi chỉ chủ shop dùng app (cần đối chiếu lúc nộp: ô này đổi luồng câu hỏi) | — |
| Data Protection Officer | chỉ khi kinh doanh ở EU | như bên trái |

Không có icon sẵn trong repo. Chủ shop tự làm một ảnh vuông 1024 × 1024, không có chữ "Facebook", "Instagram",
"Threads" hay logo của Meta.

### 2.3 Tài khoản và dữ liệu thử để quay video

- Một **Fanpage thử** do tài khoản Facebook của chủ shop quản lý (có vai trò Admin trên Meta App).
- Một **Instagram Business** đã liên kết với Fanpage đó (Meta Business Suite › Settings › Instagram accounts).
- Một **tài khoản Threads** của chủ shop. Trước khi Live, tài khoản này cần vai trò Threads Tester (runbook mục 6.3).
- Một tài khoản Facebook/Instagram/Threads **khác** để đóng vai khách: nhắn tin, bình luận, trả lời bài.
- App đã có khoá OpenAI (Cài đặt › Kết nối OpenAI) và hồ sơ thương hiệu, để quay được phần AI trả lời và tạo bài.

### 2.4 Cách để reviewer vào app

App chỉ có **một chủ sở hữu** đăng nhập bằng mật khẩu (`/dang-nhap`), không có đăng ký. Ở mục *App Verification /
Platform Settings*, nộp:

- URL web của app và mật khẩu đăng nhập **dành riêng cho kỳ duyệt**: trước khi nộp đổi mật khẩu chủ sở hữu (runbook
  mục 5 › Đổi mật khẩu), duyệt xong thì đổi lại. Không nộp mật khẩu tài khoản Facebook cá nhân; Meta dùng tài khoản
  thử của họ.
- Ghi rõ cho reviewer: "Bấm Trang & Nhóm › Kết nối tài khoản để đăng nhập Facebook/Threads của reviewer; Hộp thư
  hiện tin của trang".
- Chưa có môi trường staging tách biệt (cần đối chiếu lúc nộp: nếu Meta yêu cầu thì dựng thêm một VPS theo runbook
  với `META_APP_ID` của chính app nộp duyệt).

Tài khoản thử của Meta có thể không nhắn được vào Fanpage của reviewer. Vì thế video phải tự cho thấy trọn luồng
nhắn → hiện trong app → trả lời.

---

## 3. Xác minh

### 3.1 Business Verification (Meta)

Advanced Access cho `pages_messaging`, `instagram_manage_messages`, `business_management`… đòi Business Portfolio
đã xác minh. Tài liệu App Review nhắc bước này ngay sau khi chọn quyền ("start, continue, or complete business
verification").

1. <https://business.facebook.com/settings> › chọn Business Portfolio sở hữu app (Meta App và Threads app phải cùng
   portfolio, hoặc xác minh cả hai).
2. **Security Center › Start verification**: tên pháp lý, địa chỉ, số điện thoại, website khớp giấy đăng ký kinh
   doanh; tải giấy tờ (Giấy chứng nhận đăng ký doanh nghiệp/hộ kinh doanh, hoá đơn điện…). Tên miền của website nên
   trùng tên miền app hoặc đã xác minh ở **Brand safety › Domains**.
3. Meta xét vài ngày làm việc. Xong thì quay lại App Review: phần *Data Handling Questions* chỉ mở sau khi xác minh
   xong.

### 3.2 Organization Verification (OpenAI)

Model ảnh đang bật trong app nằm ở bảng `ai_models` (seed `server/drizzle/0003_openai_key_models.sql`:
`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2`). Họ model `gpt-image-*` thuộc nhóm OpenAI chỉ mở cho
tổ chức đã **API Organization Verification**. Chưa xác minh thì `POST /v1/images/generations` trả 403 và Soạn bài báo
lỗi tạo ảnh. Mức độ bắt buộc của từng model là **cần đối chiếu lúc nộp**: mở trang model trong OpenAI Platform.

1. <https://platform.openai.com/settings/organization/general> › **Verify Organization** → làm theo luồng xác minh danh
   tính (giấy tờ cá nhân của người đại diện).
2. Chờ tới khi trạng thái là *Verified*. OpenAI ghi có thể mất tới ~15 phút mới mở quyền model.
3. Kiểm trong app: **Cài đặt › Kết nối OpenAI › Kiểm tra lại**, rồi **Soạn bài › Tạo bằng AI** có kèm ảnh. Có ảnh
   là đạt. Vẫn 403 thì chọn model ảnh khác ở **Cài đặt › Kết nối OpenAI › Model** (ô "Model tạo ảnh").

Việc này không liên quan App Review của Meta, nhưng nên xong trước khi quay video Soạn bài có ảnh AI.

---

## 4. Danh sách quyền — Meta App (Facebook Login for Business)

Cả 14 quyền dưới đây đều **có trong Permissions Reference ngày 24/10/2026**, không quyền nào ghi deprecated. Cột
"Phụ thuộc" chép theo tài liệu; Meta tự cấp quyền phụ thuộc khi duyệt quyền chính. Cột "Bắt buộc": **trang** = thiếu
thì app không cho chọn trang (`PAGE_REQUIRED_SCOPES` / `INSTAGRAM_REQUIRED_SCOPES`); **tính năng** = thiếu thì chỉ
tính năng đó báo thiếu quyền.

| Quyền | App dùng để | Ở đâu trong code | Bắt buộc | Phụ thuộc (Meta) | Video |
|---|---|---|---|---|---|
| `pages_show_list` | Liệt kê Fanpage chủ shop quản lý lúc kết nối | `connections/oauth.ts`, `candidates.ts` (`/me/accounts`) | trang | — | A |
| `business_management` | Để `/me/accounts` trả cả Fanpage/IG thuộc Business Portfolio mà chủ shop được giao (Facebook Login for Business). App không gọi endpoint `/businesses` riêng | `connections/oauth.ts` (chỉ xin, không gọi API riêng) | không (cần đối chiếu lúc nộp: Meta có thể hỏi vì sao cần khi app không gọi Business Manager API; bỏ được nếu mọi trang do cá nhân quản lý) | `pages_read_engagement`, `pages_show_list` | A |
| `pages_manage_metadata` | Đăng ký webhook trang (`POST /{page}/subscribed_apps`) | `connections/subscribe.ts` | trang | `pages_show_list` | A |
| `pages_messaging` | Nhận tin Messenger qua webhook, trả lời trong 24 giờ, nhắn riêng người bình luận, AI tự trả lời | `inbox/send.ts` (`/me/messages`), `autoreply` | trang | `pages_manage_metadata`, `pages_show_list` | B, D |
| `pages_read_engagement` | Đọc bài và thông tin trang, nền cho insight và webhook `feed` | `content`, `analytics` | trang | `pages_show_list` | D, G |
| `pages_read_user_content` | Đọc bình luận của khách trên bài (webhook `feed`, nội dung bình luận) | `webhooks` / `inbox` (bình luận) | không | `pages_show_list` | D |
| `pages_manage_engagement` | Trả lời công khai bình luận Facebook (`POST /{comment}/comments`) | `inbox/send.ts` | trang | `pages_read_user_content`, `pages_show_list` | D |
| `pages_manage_posts` | Đăng bài Fanpage (`/{page}/feed`, `/{page}/photos`) theo lịch / ngay | `content/publish.ts` | trang | `pages_read_engagement`, `pages_show_list` | F |
| `read_insights` | Số liệu trang và bài Facebook ở Hiệu suất / Tổng quan | `analytics` (`INSIGHTS_SCOPES.facebook`) | không | `pages_read_engagement`, `pages_show_list` | G |
| `instagram_basic` | Hồ sơ và media của IG Business liên kết trang | `connections`, `content` | IG | `pages_read_user_content`, `pages_show_list` | A, C |
| `instagram_manage_messages` | Nhận / trả lời Instagram Direct, đọc tên khách IG | `inbox/send.ts`, `inbox/profile.ts` | IG | `instagram_basic`, `pages_read_engagement`, `pages_show_list` | C |
| `instagram_manage_comments` | Nhận và trả lời bình luận IG (`POST /{comment}/replies`) | `inbox/send.ts` | IG | `instagram_basic`, `pages_read_engagement`, `pages_show_list` | E |
| `instagram_content_publish` | Đăng bài IG (`/{ig}/media` → `/media_publish`) | `content/publish.ts` | IG | `instagram_basic`, `pages_read_engagement`, `pages_show_list` | F |
| `instagram_manage_insights` | Số liệu IG ở Hiệu suất | `analytics` (`INSIGHTS_SCOPES.instagram`) | không | `instagram_basic`, `pages_read_engagement`, `pages_show_list` | G |

**Feature, không phải scope, nhưng vẫn phải xin Advanced Access:**

| Feature | Vì sao | Video |
|---|---|---|
| **Business Asset User Profile Access** | `inbox/profile.ts` gọi `GET /{PSID}?fields=first_name,last_name,name` để hiện tên khách Messenger ở Hộp thư / Khách hàng. Tài liệu Messenger User Profile ghi phải có Advanced Access cho feature này. | B |

Những gì app **không** xin (đừng tick thêm, Meta từ chối quyền không dùng): `pages_manage_ads`,
`instagram_business_*` (app dùng "Instagram API with Facebook Login", token Page, không dùng "Instagram API with
Instagram Login"), `email`, `public_profile` ngoài mặc định, message tag `HUMAN_AGENT` (app chỉ gửi trong cửa sổ 24
giờ, `messaging_type: RESPONSE`).

Nếu dùng `META_LOGIN_CONFIG_ID` (Facebook Login for Business › Configurations): cấu hình phải chọn **đúng 14 quyền**
trên. Thiếu quyền nào thì trang báo "thiếu quyền" ở màn chọn trang.

## 5. Danh sách quyền — Threads app

Cả 5 quyền đều có trong *Threads API — Get started* (tra 24/10/2026). Cả 5 đều bắt buộc (`THREADS_REQUIRED_SCOPES`):
thiếu quyền nào thì tài khoản Threads không chọn được.

| Quyền | App dùng để | Ở đâu trong code | Video |
|---|---|---|---|
| `threads_basic` | Hồ sơ `/me` (id, username, ảnh) lúc kết nối; nền cho mọi endpoint | `connections/oauth.ts`, `candidates.ts` | T1 |
| `threads_content_publish` | Đăng bài Threads (`/me/threads` → `/me/threads_publish`), hạn mức `threads_publishing_limit` | `content/publish.ts` | T2 |
| `threads_read_replies` | Nhận trả lời của khách qua webhook `replies`, đọc luồng trả lời | `webhooks`, `inbox` | T3 |
| `threads_manage_replies` | Trả lời khách trên Threads từ Hộp thư (`reply_to_id`) | `inbox/send.ts` | T3 |
| `threads_manage_insights` | Số liệu bài / tài khoản Threads ở Hiệu suất | `analytics` (`INSIGHTS_SCOPES.threads`) | T4 |

Webhook Threads cần app đã publish nhưng không cần App Review (tài liệu Threads use case). Quyền thì vẫn phải duyệt mới
dùng được với người không có vai trò trên app.

---

## 6. Kịch bản quay màn hình

### 6.1 Trước khi quay

- **Gọi thử mỗi quyền ít nhất một lần thành công trong 30 ngày trước khi nộp.** Không có lời gọi thì nút "Request
  advanced access" bị mờ. Cách nhanh nhất là chạy hết các video dưới đây một lần không quay, bằng app ở Development
  mode với tài khoản có vai trò.
- Màn hình **1080p trở lên**, thu nhỏ cửa sổ trình duyệt rộng tối đa 1440 px, chỉ quay cửa sổ app, phóng to con trỏ,
  **không cần tiếng** (reviewer không nghe).
- **UI app là tiếng Việt.** Meta muốn UI tiếng Anh, hoặc có chú thích để reviewer hiểu từng nút. Vì vậy mỗi video phải
  có **phụ đề tiếng Anh** cho mỗi bước ("Click *Kết nối tài khoản* = Connect account"…). Dịch sẵn các nhãn hay gặp:
  Trang & Nhóm = Pages & Groups, Hộp thư = Inbox, Soạn bài = Compose, Lịch = Calendar, Hiệu suất = Performance, Cài đặt =
  Settings, Trả lời công khai = Public reply, Nhắn riêng = Private reply, Đăng ngay = Publish now, Tiếp quản = Take over.
- Mỗi video mở đầu bằng **đăng nhập Facebook/Threads và màn đồng ý của Meta có danh sách quyền**. Sau đó mới cho thấy
  app dùng quyền đó. Video A và T1 quay trọn luồng đăng nhập; video khác có thể cắt từ cùng bản quay dài, miễn mỗi quyền
  có đoạn riêng.

### 6.2 Meta App

**A — Kết nối Fanpage + Instagram** (`pages_show_list`, `business_management`, `pages_manage_metadata`,
`instagram_basic`)
1. Đăng nhập app → **Trang & Nhóm** (`/trang-nhom`) → **Kết nối tài khoản** → **Facebook Fanpage** (hoặc **Instagram Business**: cả hai mở chung một cửa sổ Meta).
2. Hộp thoại Facebook Login for Business: chọn Business Portfolio / Fanpage / IG → màn liệt kê quyền → **Tiếp tục**.
3. App quay về, mở hộp "Kết nối Facebook và Instagram" liệt kê Fanpage + IG (đây là `pages_show_list` /
   `business_management` / `instagram_basic`) → tick trang → **Kết nối n trang**.
4. Trang hiện trong danh sách, trạng thái "Đang hoạt động". Mở **Cài đặt › Webhook tin nhắn**: trang không nằm ở
   "Trang chưa đăng ký nhận tin được" (`pages_manage_metadata` đã đăng ký webhook).

**B — Tin nhắn Messenger** (`pages_messaging`, Business Asset User Profile Access)
1. Điện thoại / cửa sổ khác: tài khoản "khách" nhắn Fanpage "Còn hàng size M không?".
2. App: **Hộp thư** (`/hop-thu`) → tin hiện ngay với **tên khách** (User Profile) → mở hội thoại.
3. Gõ trả lời ở ô soạn → **Gửi** (⌘↵) → bong bóng hết "Đang gửi…".
4. Quay lại Messenger của khách: tin trả lời đã tới.
5. (Nên có) Bật **AI trả lời** (`/ai-tra-loi`) cho trang → khách nhắn tiếp → Hộp thư hiện nhãn "AI trả lời" → khách
   nhận câu trả lời. Phụ đề ghi rõ: AI soạn bằng OpenAI theo hồ sơ shop, chủ shop **Tiếp quản** được bất cứ lúc nào.

**C — Instagram Direct** (`instagram_manage_messages`, `instagram_basic`)
1. Tài khoản IG "khách" nhắn IG Business.
2. **Phạm vi** ở thanh trên → chọn tài khoản IG (Hộp thư không có bộ lọc nền tảng riêng) → **Hộp thư** → tin hiện kèm tên / username → trả lời → khách nhận trên Instagram.

**D — Bình luận Facebook** (`pages_read_user_content`, `pages_read_engagement`, `pages_manage_engagement`,
`pages_messaging` cho nhắn riêng)
1. Tài khoản "khách" bình luận dưới một bài của Fanpage.
2. **Hộp thư** → bình luận hiện kèm bài gốc.
3. Chọn **Trả lời công khai** → gửi → trả lời hiện dưới bình luận trên Facebook.
4. Chọn **Nhắn riêng** → gửi → khách nhận tin Messenger (private reply).

**E — Bình luận Instagram** (`instagram_manage_comments`)
1. "Khách" bình luận bài IG → **Hộp thư** → **Trả lời công khai** → trả lời hiện dưới bình luận trên Instagram.

**F — Đăng bài** (`pages_manage_posts`, `instagram_content_publish`)
1. **Soạn bài** (`/soan-bai`) → chọn Fanpage + IG → nhập ý tưởng → **Tạo bằng AI** (caption + ảnh, nếu đã xong mục 3.2)
   hoặc tự viết, đính ảnh (IG bắt buộc có ảnh).
2. **Đăng ngay** → **Lịch** (`/lich`) hiện bài "Đã đăng".
3. Mở Fanpage và IG: bài đã lên. Quay thêm **Lên lịch** một bài sau vài phút cho thấy app đăng theo lịch.

**G — Số liệu** (`read_insights`, `instagram_manage_insights`, `pages_read_engagement`)
1. Cần trang có bài đã đăng và đã qua ít nhất một lượt thu số liệu (cron 6 giờ / hằng ngày, spec 8.1).
2. **Hiệu suất** (`/hieu-suat`) → **Phạm vi** ở thanh trên chọn Fanpage (hoặc bấm dòng Fanpage trong bảng) → lượt xem, tiếp cận, tương tác theo ngày; "Bài hiệu quả nhất".
3. Đổi **Phạm vi** sang IG → số liệu IG. **Tổng quan** (`/`) cũng hiện KPI.

### 6.3 Threads app

**T1 — Kết nối Threads** (`threads_basic`)
1. **Trang & Nhóm** → **Kết nối tài khoản** → **Threads** (hoặc **Cài đặt › Tài khoản Meta › Kết nối Threads**).
2. Màn đồng ý của Threads liệt kê 5 quyền → **Cho phép**.
3. Hộp "Kết nối Threads" hiện username + ảnh → **Kết nối 1 tài khoản** → tài khoản hiện "Đang hoạt động".

**T2 — Đăng bài Threads** (`threads_content_publish`)
1. **Soạn bài** → chọn tài khoản Threads → viết (≤ 500 ký tự) → **Đăng ngay** → bài hiện trên Threads.

**T3 — Trả lời Threads** (`threads_read_replies`, `threads_manage_replies`)
1. Tài khoản Threads "khách" trả lời bài vừa đăng.
2. **Hộp thư** → trả lời hiện trong hội thoại Threads (webhook `replies`).
3. **Trả lời công khai** → gửi → trả lời của shop hiện dưới trả lời của khách trên Threads.

**T4 — Số liệu Threads** (`threads_manage_insights`)
1. **Hiệu suất** → **Phạm vi** ở thanh trên chọn tài khoản Threads → lượt xem, thích, trả lời, đăng lại.

### 6.4 Mô tả cho từng quyền

Meta muốn mỗi quyền một mô tả **riêng**, không chép giống nhau. Mô tả nêu: tính năng giúp người dùng việc gì, vì
sao cần quyền, app dùng dữ liệu thế nào, thiếu quyền thì app kém đi ra sao. Nộp bằng tiếng Anh. Khung gợi ý (sửa
theo đúng shop):

- `pages_messaging`: "OnTheTopMoney is a single-business inbox. The Page owner reads Messenger messages from customers
  and replies within 24 hours from the app's Inbox. Optional AI replies are drafted with OpenAI (store: false) from the
  shop's own FAQ and can be taken over by the owner at any time. Without this permission the owner cannot answer
  customers from the app."
- `pages_manage_posts`: "The owner composes and schedules posts for their own Page in the Compose and Calendar
  screens; the app publishes at the scheduled time."
- `read_insights`: "The Performance screen shows views, reach and engagement of the owner's own Page and posts so the
  owner can see which posts work."
- Các quyền còn lại: viết theo cột "App dùng để" ở mục 4 và 5, mỗi quyền một đoạn 2–4 câu.

Câu hỏi *Data Handling* (sau Business Verification): dữ liệu lưu trên VPS của chủ shop, token mã hoá AES-GCM
(`APP_ENCRYPTION_KEYS`), nội dung tin gửi OpenAI với `store: false`, file trên Cloudinary, thời hạn lưu theo trang
chính sách mục 5 (`RETENTION`), xoá theo yêu cầu qua callback ở mục 2.1 và Khách hàng › Xoá khách. App không bán hay
chia sẻ dữ liệu cho bên thứ ba ngoài các bên xử lý nêu trong chính sách.

---

## 7. Nộp và chuyển Live

### 7.1 Meta App

- [ ] Mục 2.1: Privacy Policy URL, Data deletion callback URL, Deauthorize callback URL đã dán; mở được từ ngoài mạng.
- [ ] Mục 2.2: icon 1024 × 1024, category, contact email.
- [ ] Mục 3.1: Business Verification *Verified*.
- [ ] **App Review › Permissions and Features**: request Advanced Access cho 14 quyền ở mục 4 và feature Business Asset
      User Profile Access; mỗi mục có mô tả + video.
- [ ] *App Verification*: hướng dẫn truy cập theo mục 2.4.
- [ ] **Submit for Review**, chấp nhận Platform Onboarding Terms. Meta thường trả lời trong khoảng một tuần.
- [ ] Duyệt xong: **App Mode › Live**. Ở Live chỉ quyền **đã duyệt** chạy được, kể cả với tài khoản có vai trò. Dữ liệu
      thử tạo ở Development mode sẽ hiện với mọi người.
- [ ] **Webhooks** trên app Live: Page (`messages`, `messaging_postbacks`, `message_echoes`, `message_deliveries`,
      `message_reads`, `feed`) và Instagram (`messages`, `messaging_seen`, `comments`) → callback `/webhooks/meta`,
      verify token `META_VERIFY_TOKEN` (runbook mục 6.1).
- [ ] `deploy/.env`: `META_APP_ID` / `META_APP_SECRET` là của app Live (không phải Test App), `META_APP_ENV` không phải
      `test`; deploy lại.
- [ ] Trong app: **Kết nối lại** từng Fanpage (Trang & Nhóm › Kết nối lại) để token mang quyền đã duyệt và worker
      đăng ký lại webhook trang.

### 7.2 Threads app

- [ ] Use cases › Access the Threads API › Settings: Redirect Callback URLs, **Deauthorize callback URL** =
      `/privacy/threads/uninstall`, **Data Deletion Requests URL** = `/privacy/threads/delete` (thay hai đường giữ chỗ cũ
      `/oauth/threads/{uninstall,delete}` nếu từng dán theo bản runbook cũ).
- [ ] App settings › Basic: icon, Privacy Policy URL.
- [ ] App Review cho 5 quyền ở mục 5 (video T1–T4) → Submit.
- [ ] Duyệt xong → **Publish** app. **Webhooks**: callback `/webhooks/threads`, cùng verify token, field `replies`.
- [ ] `deploy/.env`: `THREADS_APP_ID` / `THREADS_APP_SECRET` của app thật, `THREADS_APP_ENV=live`; deploy lại.
- [ ] Trong app: kết nối lại tài khoản Threads.

---

## 8. Kiểm sau Live (chủ dự án làm, sau khi Meta duyệt)

AC "app đã Live → khách thật nhắn → webhook về đủ ba nguồn" chỉ kiểm được với app Live và người thật. Repo không tự
động hoá được bước này. Làm theo thứ tự, ghi ngày + kết quả vào cột cuối.

### 8.1 Webhook đủ ba nguồn

Màn kiểm: **Cài đặt › Webhook tin nhắn** (`/cai-dat?section=webhook`). Thẻ "Tình trạng nhận tin" hiện mốc sự kiện gần
nhất riêng cho Facebook/Instagram và Threads (cron `webhooks.health`, spec 4.2). Thẻ "Nhật ký sự kiện" ghi từng sự
kiện kèm sản phẩm, field và trạng thái xử lý.

| # | Việc | Mong đợi | Kết quả |
|---|------|----------|---------|
| 1 | Một tài khoản **không có vai trò** trên app nhắn Fanpage | Nhật ký: sự kiện `meta` / `messages` đã xử lý; Hộp thư có tin + tên khách | |
| 2 | Tài khoản đó bình luận bài Fanpage | sự kiện `feed`; Hộp thư có bình luận | |
| 3 | Tài khoản IG không vai trò nhắn IG Business | sự kiện `meta` / `messages` (object `instagram`); Hộp thư có tin | |
| 4 | Bình luận bài IG | sự kiện `comments` | |
| 5 | Tài khoản Threads không vai trò **trả lời** bài Threads của shop | sự kiện `threads` / `replies` đã xử lý; Hộp thư có trả lời. Nhận `401` ở log → mục 8.2 | |
| 6 | Trả lời từng nguồn từ Hộp thư | khách nhận được; echo không tắt AI (Hộp thư không ghi "trả lời ngoài app") | |
| 7 | Thẻ "Tình trạng nhận tin" | cả hai sản phẩm có mốc sự kiện gần nhất mới, không có chip "Ngừng nhận tin", Hộp thư không có banner "Chưa nhận tin mới 30 phút" | |

Không thấy sự kiện: kiểm field cấp app (mục 7), app còn Live, trang không nằm trong "Trang chưa đăng ký nhận tin được",
log `docker compose logs api | grep webhook` có `401` hay không.

### 8.2 Secret ký webhook Threads

Làm theo **runbook mục 10** và ghi kết quả ở đó. Tóm tắt: sự kiện ở bước 5 vào được (không `401`) thì
`THREADS_APP_SECRET` đúng. Nếu `401`, đặt `THREADS_WEBHOOK_SECRET` = **App Secret** ở App settings › Basic của Threads
app, deploy lại, thử lại.

### 8.3 Xác nhận các giả định còn lại bằng sự kiện thật

Các mục hoãn ở `_bmad-output/implementation-artifacts/deferred-work.md` chỉ kiểm được với app Live:

| Giả định | Cách kiểm | Kết quả |
|---|---|---|
| Payload Threads `replies` có dạng `values` + `root_post.owner_id`; trả lời lồng nhiều cấp | Nhật ký sự kiện › mở sự kiện `replies` (payload thô giữ 30 ngày) | |
| Bình luận FB luôn có `from.id` | sự kiện `feed` của bình luận khách; không có mục *malformed* | |
| Echo IG có `app_id` / `metadata`; IG `messaging_seen` dạng `read.mid` | trả lời IG từ app → sự kiện echo; khách xem tin | |
| Threads gửi `signed_request` dạng Meta, ký bằng Threads app secret, `user_id` = id `/me` của Threads | Tài khoản Threads thử (không phải tài khoản thật của shop) gỡ app: Threads › Settings › Account › Website permissions › Remove. Log `privacy: nhận yêu cầu từ Meta` với `source: threads_uninstall`, `matched: true`, trang Threads chuyển "Mất kết nối". `400` + `signed_request không hợp lệ` → secret / dạng khác giả định | |
| Callback Meta App thật | Tài khoản Facebook thử gỡ app (Settings › Apps and websites) → `source: meta_deauthorize`, `matched: true` | |
| Send API IG (`/me/messages` với token Fanpage nguồn), giới hạn 1000 ký tự IG, Threads publish ngay sau khi tạo container | bước 6 của 8.1 | |
