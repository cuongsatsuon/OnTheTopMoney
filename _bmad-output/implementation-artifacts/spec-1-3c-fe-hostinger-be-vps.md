---
title: 'Thêm chế độ tách: web lên Hostinger (.htaccess), API ở VPS'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3b-thay-caddy-bang-nginx-tu-quan.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chủ shop quyết: mã BE chạy ở VPS (Docker Compose + nginx/certbot tự quản), còn FE (`web/dist`) đặt trên hosting Hostinger (Apache/LiteSpeed, `.htaccess`). Hiện web giả định cùng origin với API (`/api/v1` tương đối, `credentials: 'same-origin'`, OAuth trả về đường dẫn tương đối, deploy VPS xuất bản web vào `WEB_ROOT`), nên tách ra là hỏng đăng nhập, SSE và kết nối Meta.

**Approach:** Web gọi API theo origin cấu hình lúc build (`VITE_API_ORIGIN`, để trống = cùng origin như dev). Server thêm CORS có credentials theo `ALLOWED_ORIGINS` và biến `WEB_BASE_URL` để OAuth chuyển về đúng host web. Build web sinh `.htaccess` (SPA fallback, header bảo mật, cache).

**Quyết định (chủ shop, 2026-10-22):** Giữ nguyên chế độ web + BE cùng trên VPS (Story 1.3b: `publish_web`/`activate_web`, `WEB_ROOT`, `Dockerfile.web`, `deploy/nginx.conf.example`, job CI cũ). Hostinger là chế độ thứ hai, chọn bằng `WEB_MODE=vps|external` (mặc định `vps`); `external` thì deploy/rollback bỏ qua phần web và dùng mẫu mới `deploy/nginx-api.conf.example` (host API + `/media`, đường lạ → JSON 404). Cấu trúc thư mục `deploy/` giữ nguyên.

[ASSUMPTION] Web và API cùng tên miền gốc, vd `app.<miền>` (Hostinger) và `api.<miền>` (VPS): cookie `ottm_sid` SameSite=Lax chỉ đi kèm request same-site; khác tên miền gốc thì Safari/Chrome chặn cookie bên thứ ba và đăng nhập không chạy. Runbook nói rõ điều này.

## Boundaries & Constraints

**Always:** Cookie phiên giữ HttpOnly; Secure; SameSite=Lax, host-only (không đặt `Domain`). Kiểm Origin cho request ghi giữ nguyên. CORS chỉ phản hồi origin có trong `ALLOWED_ORIGINS` (so khớp chính xác, không `*`), luôn `Vary: Origin`, chỉ trên `/api/v1/*`. Dev giữ proxy Vite cùng origin (không đặt `VITE_API_ORIGIN` thì mọi thứ như cũ). `WEB_BASE_URL` không bắt buộc, mặc định = `PUBLIC_BASE_URL` (chế độ cùng VPS); khi đặt ở production phải https và nằm trong `ALLOWED_ORIGINS`.

**Never:** Không thêm dependency mới (CORS tự viết). Không đổi cơ chế phiên sang token/header. Không sửa `/webhooks`, `/oauth` ngoài phần URL chuyển về. Không tự xoá file cũ trên Hostinger ngoài `assets/` cũ hơn bản đang chạy khi người dùng bật cờ dọn.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Preflight hợp lệ | `OPTIONS /api/v1/auth/login`, Origin trong danh sách | 204, `Access-Control-Allow-Origin: <origin>`, `-Credentials: true`, `-Methods`, `-Headers: Content-Type, Accept`, `Max-Age: 600`, `Vary: Origin`; không cần phiên | N/A |
| Preflight lạ | Origin ngoài danh sách | 204 không có header CORS (trình duyệt tự chặn) | không log ồn |
| GET/ghi cross-origin | Origin hợp lệ + cookie | phản hồi bình thường kèm header CORS (cả lỗi 4xx/5xx) | ghi với Origin lạ vẫn 403 như cũ |
| SSE cross-origin | `GET /api/v1/stream`, Origin hợp lệ | header CORS có trong `writeHead` sau `hijack` | 401 trước hijack cũng có header CORS |
| OAuth xong | callback ở host API | 302 về `${WEB_BASE_URL}/pages?ket-noi=…#` (tuyệt đối) | lỗi/`OAUTH_STATE_INVALID` cũng tuyệt đối |
| Config production | `WEB_BASE_URL` đặt nhưng không https hoặc không nằm trong `ALLOWED_ORIGINS` | khởi động lỗi kèm tên biến | không đặt → mặc định `PUBLIC_BASE_URL` |
| Build web | `VITE_API_ORIGIN` sai dạng origin (có path, không https khi production) | build dừng với thông báo rõ | trống → API tương đối, không sinh `.htaccess` CSP connect-src riêng |
| Deep link Hostinger | `GET /pages/abc` không có file | trả `index.html` 200; file thật trong `assets/` trả đúng; `assets/` thiếu file → 404 | |

</frozen-after-approval>

## Code Map

- `web/src/lib/api.ts` -- `API_BASE='/api/v1'`, `credentials:'same-origin'` → lấy origin từ `import.meta.env.VITE_API_ORIGIN`, `credentials:'include'`.
- `web/src/lib/realtime.ts:89` -- `new EventSource(url)` → `{ withCredentials: true }`; url dùng `API_BASE`.
- `web/vite.config.ts` -- proxy dev giữ nguyên; thêm plugin build: kiểm `VITE_API_ORIGIN`, phát `.htaccess` vào dist từ mẫu.
- `server/src/app/auth/index.ts:68-110` -- `originAllowed`, hook onRequest kiểm Origin ghi + phiên; CORS phải chạy trước (preflight không bị 401).
- `server/src/app/app.ts:38,100` -- `allowedOrigins` truyền vào plugin auth; đăng ký CORS ở đây.
- `server/src/app/stream.ts:18-25` -- `reply.hijack()` + `writeHead` làm mất header đặt qua `reply.header`; phải gộp `reply.getHeaders()`.
- `server/src/modules/connections/oauth.ts:53,202-213` -- `STATE_INVALID_LOCATION`, `resultLocation`, `errorLocation` trả đường tương đối; `server/src/app/oauth.ts:167,172` redirect.
- `server/src/platform/config/index.ts:66-190` -- `ALLOWED_ORIGINS`, `PUBLIC_BASE_URL` (host API; ràng buộc "ALLOWED_ORIGINS phải gồm PUBLIC_BASE_URL" chỉ áp khi `WEB_BASE_URL` không đặt hoặc bằng nó), thêm `WEB_BASE_URL` tuỳ chọn.
- `server/src/modules/connections/deps.ts` -- `ConnectionsConfig` thêm `WEB_BASE_URL`.
- `deploy/lib.sh`, `deploy/deploy.sh`, `deploy/rollback.sh`, `deploy/env.production.example` -- thêm `WEB_MODE=vps|external` (mặc định `vps`); `external` bỏ qua publish/activate/prune web và không đòi `WEB_ROOT`. Giữ nguyên mọi hành vi chế độ `vps`, `Dockerfile.web`, compose.
- `deploy/nginx.conf.example` -- GIỮ NGUYÊN (chế độ cùng VPS). `deploy/nginx-api.conf.example` (mới, chế độ tách) -- vhost `api.example.com`: mọi đường → api (SSE riêng), `/media/` alias; `/` và đường lạ → JSON 404.
- `deploy/smoke-test.sh`, `.github/workflows/ci.yml` -- giữ job deploy-smoke cũ; thêm `nginx -t` cho mẫu mới; smoke-test kiểm thêm preflight CORS khi `WEB_MODE=external`.
- `deploy/runbook.md` -- giữ nội dung cũ; thêm mục "Chế độ tách: web trên Hostinger".

## Tasks & Acceptance

**Execution:**
- [x] `server/src/app/cors.ts` (mới) + `app.ts` -- hook onRequest cho `/api/v1/*`: đặt header CORS khi Origin hợp lệ; `OPTIONS` trả 204 ngay; đăng ký trước plugin auth.
- [x] `server/src/app/stream.ts` -- gộp `reply.getHeaders()` vào `writeHead`.
- [x] `server/src/platform/config/index.ts`, `connections/deps.ts`, `connections/oauth.ts`, `app/deps.ts` -- `WEB_BASE_URL` (origin, tuỳ chọn, mặc định `PUBLIC_BASE_URL`); khi đặt ở production: https, thuộc `ALLOWED_ORIGINS`; mọi location OAuth thành tuyệt đối theo `WEB_BASE_URL`.
- [x] `server/.env.example`, `deploy/env.production.example` -- thêm `WEB_BASE_URL`; giải thích `PUBLIC_BASE_URL` = host API, `ALLOWED_ORIGINS` = host web.
- [x] `web/src/lib/api.ts`, `web/src/lib/realtime.ts`, `web/src/vite-env.d.ts` -- base URL + credentials như Code Map.
- [x] `deploy/hostinger/htaccess.template` (mới) + `web/vite.config.ts` -- `.htaccess`: HTTPS redirect, SPA fallback (`RewriteCond -f/-d` trừ `assets/`), header bảo mật (CSP `connect-src 'self' <api>`, `img-src 'self' data: <api>`, HSTS, nosniff, Referrer-Policy, frame-ancestors none), `index.html` no-cache, `assets/` immutable 1 năm, chặn liệt kê thư mục; bọc `<IfModule>`.
- [x] `deploy/publish-web-hostinger.sh` (mới) -- build với `VITE_API_ORIGIN`, rsync qua SSH: `assets/` trước, `index.html`/`.htaccess`/file gốc sau; cờ `--prune-assets` xoá assets không còn được `index.html` tham chiếu; không có SSH thì in hướng dẫn upload qua File Manager.
- [x] Các file deploy VPS + nginx + smoke + CI -- như Code Map.
- [x] `deploy/runbook.md`, `_bmad-output/planning-artifacts/ARCHITECTURE-SPINE.md` (AD-3/AD-19/deployment) -- cập nhật mô hình 2 host.
- [x] Test: `server` (CORS preflight/GET/lỗi/SSE, config, location tuyệt đối), `web` (`apiFetch` dùng origin + include; EventSource withCredentials).

**Acceptance Criteria:**
- Given `VITE_API_ORIGIN` trống, when chạy dev, then web vẫn gọi `/api/v1` qua proxy và mọi test cũ qua.
- Given web build với `VITE_API_ORIGIN=https://api.example.com`, when mở dist bằng Apache có `AllowOverride All`, then deep link trả index.html, header bảo mật có mặt, `assets/*` có cache immutable.
- Given web chạy ở origin khác API trong danh sách, when đăng nhập, mở SSE và kết nối Meta giả, then cookie được đặt/gửi, SSE nhận `ready`, OAuth quay về đúng host web.

## Verification

**Commands:**
- `npm run check` -- expected: lint, typecheck, depcruise, toàn bộ test qua.
- `bash -n deploy/*.sh` và `shellcheck` nếu có -- expected: không lỗi.
- `/usr/sbin/httpd` cục bộ (macOS) với `AllowOverride All` phục vụ `web/dist` -- expected: SPA fallback, header, cache như AC.

**Manual checks:**
- Trình duyệt: web ở `http://localhost:4173` (vite preview) gọi API `http://localhost:3000` với `ALLOWED_ORIGINS`/`WEB_BASE_URL` trỏ 4173, `COOKIE_SECURE=0`: đăng nhập, SSE, kết nối Meta giả chạy.

## Implementation Notes

- **Server — CORS** (`server/src/app/cors.ts`, đăng ký trong `app.ts` trước plugin auth): hook `onRequest` chỉ cho path bắt đầu `/api/v1/`; luôn thêm `Vary: Origin`; Origin khớp chính xác `ALLOWED_ORIGINS` → `Access-Control-Allow-Origin: <origin>` + `-Credentials: true`; `OPTIONS` → 204 ngay (origin hợp lệ thêm `-Methods: GET, POST, PUT, PATCH, DELETE`, `-Headers: Content-Type, Accept`, `-Max-Age: 600`; origin lạ → 204 trống, không log). Header đặt sớm nên có trên 401/403/404/400 do guard/route ném. Kiểm Origin ghi trong auth giữ nguyên (origin lạ → 403, không header CORS).
- **SSE** (`stream.ts`): gộp `reply.getHeaders()` vào `writeHead` sau `hijack`.
- **Config**: `WEB_BASE_URL` (origin, tuỳ chọn, mặc định = `PUBLIC_BASE_URL`). Production: nếu `WEB_BASE_URL` đặt và khác `PUBLIC_BASE_URL` (chế độ tách) → phải https và thuộc `ALLOWED_ORIGINS` (lỗi nêu `WEB_BASE_URL`); ngược lại giữ ràng buộc cũ "ALLOWED_ORIGINS phải gồm PUBLIC_BASE_URL".
- **OAuth**: `webLocation(config, path)` (export từ `modules/connections`) — mọi Location sau callback (kết quả, lỗi, `OAUTH_STATE_INVALID`, lỗi bất ngờ ở `app/oauth.ts`) thành `${WEB_BASE_URL}<path>#`. `errorLocation`/`STATE_INVALID_LOCATION` vẫn trả đường dẫn tương đối (dùng nội bộ). Thêm: URL trang đồng ý giả (`META_FAKE`, chỉ dev) thành tuyệt đối theo `PUBLIC_BASE_URL` — nếu không, web ở origin khác sẽ mở `/oauth/...` trên host web. Không đổi gì khác ở `/oauth`, `/webhooks`.
- **Web**: `API_ORIGIN` = `VITE_API_ORIGIN` (bỏ `/` cuối), `API_BASE = ${API_ORIGIN}/api/v1`; `credentials: 'include'`; `browserEventSource` mở `EventSource(url, { withCredentials: true })`. Trống → mọi thứ như cũ (proxy Vite).
- **`.htaccess` — chọn: chỉ sinh khi đặt `VITE_API_ORIGIN`** (chế độ tách). Build cùng origin (Dockerfile.web, chế độ VPS) không có `.htaccess` trong dist → nginx cùng VPS không phục vụ file thừa. Plugin `ottm-hostinger-htaccess` trong `web/vite.config.ts`; phần thuần ở `web/vite-htaccess.ts` (+ test). Build production chỉ nhận `VITE_API_ORIGIN` https, trừ host loopback (để thử `vite preview` cục bộ). Mẫu `deploy/hostinger/htaccess.template`: HTTPS (trừ localhost, xét cả `X-Forwarded-Proto`), file ẩn → 404 (chừa `.well-known/`), `assets/` không fallback + cờ env `OTTM_ASSET` → `immutable`, còn lại `no-cache`, `Options -Indexes`, header bảo mật `always`, tắt `mod_expires`, deflate bọc thêm `<IfModule mod_filter.c>`.
- **Hostinger**: `deploy/hostinger/publish-web-hostinger.sh` (build, kiểm dist mang đúng origin, rsync `assets/` → file gốc + `.htaccess` → `index.html`, không xoá gì; `--prune-assets` = `rsync --delete` chỉ trên `assets/` sau khi `index.html` mới lên — **xoá file không thuộc bản build hiện tại**, không phải "không được index.html tham chiếu trực tiếp", vì chunk lazy chỉ được entry JS tham chiếu; không SSH → in hướng dẫn File Manager; có `WEB_BASE_URL` → chạy `check-htaccess.sh`). `deploy/hostinger/check-htaccess.sh` kiểm deep link, header, CSP, cache, 404, `.htaccess` không lộ.
- **Deploy VPS**: giữ nguyên chế độ cùng VPS (1.3b). `WEB_MODE=vps|external` (mặc định `vps`, `lib.sh: web_mode`). `external`: `deploy.sh` không build `ottm-web`, không `publish_web`/`activate_web`, không đòi `WEB_ROOT` (`require_host_dirs` chỉ kiểm media), đòi `WEB_BASE_URL` + `ALLOWED_ORIGINS` trong `deploy/.env`; smoke `SMOKE_MODE=api` với `ORIGIN=WEB_BASE_URL`; `rollback.sh` không `switch_web`; `can_rollback_to`/`prune_images` bỏ phần thư mục web. Compose: `ALLOWED_ORIGINS: ${ALLOWED_ORIGINS:-${PUBLIC_BASE_URL}}`, `WEB_BASE_URL: ${WEB_BASE_URL:-}` (rỗng = mặc định). `smoke-test.sh`: thêm `SMOKE_MODE=api` (/, đường lạ → JSON 404, CSP `default-src 'none'`) và kiểm CORS (preflight hợp lệ/lạ, GET 401 có Allow-Origin) khi đặt `ORIGIN` — `deploy.sh` luôn đặt (vps: `PUBLIC_BASE_URL`).
- **nginx-api**: `deploy/nginx-api.conf.example` — tên map/upstream/zone TLS/named location tiền tố `ottm_api_` để cài song song mẫu cùng VPS (lúc chuyển chế độ). CI: `nginx -t` riêng và cùng mẫu cũ (cổng 8081). Job check: build web không origin (không `.htaccess`), build sai dạng phải dừng, build có origin + Apache `httpd:2.4-alpine` (`AllowOverride All`) chạy `check-htaccess.sh`.
- **Docs**: runbook giữ nội dung cũ, thêm `WEB_MODE` ở bảng 1.4, mục 6.8 (thử khác origin khi dev), dòng ở mục 7 và mục 8 "Chế độ tách: web trên Hostinger". ARCHITECTURE-SPINE: AD-3, AD-19, bảng hạ tầng, triển khai, cây thư mục.
- **Đã kiểm local**: `npm run check` exit 0 (server 547 test, web 105 test); `bash -n` mọi script deploy; build web với/không/sai `VITE_API_ORIGIN`; Apache 2.4 macOS (`AllowOverride All`) + `check-htaccess.sh` tất cả ok (deep link 200, header, CSP có api, assets immutable, assets thiếu 404, `/assets/` và `/.htaccess` 404, gzip); `publish-web-hostinger.sh` với `ssh` giả (rsync cục bộ): thứ tự upload, không xoá file lạ, `--prune-assets` chỉ xoá asset cũ, chặn origin sai/dist lệch; trình duyệt: web `vite preview` :4173 + api :3000 (DB nhúng tạm, `ALLOWED_ORIGINS`/`WEB_BASE_URL`=4173, `COOKIE_SECURE=0`, `META_FAKE=1`) — đăng nhập (cookie đi kèm), `/api/v1/stream` 200, kết nối Facebook giả: trang đồng ý ở :3000, quay về `http://localhost:4173/trang-nhom?ket-noi=…`, xác nhận trang thành công; `SMOKE_MODE=api` chạy thẳng vào api: phần route/CORS/JSON 404 ok (header bảo mật thiếu vì không có nginx — đúng dự kiến).
- **Sau review (vòng 1)**: test nhánh catch của callback (DB ném khi tiêu state → `${WEB}/trang-nhom?ket-noi-loi=INTERNAL#`, Threads thêm `&nen-tang=threads`); `lib.sh: check_web_config` gọi trước build/backup/ghi `IMAGE_TAG` ở `deploy.sh` và trước đổi web/`IMAGE_TAG` ở `rollback.sh` (external: `WEB_BASE_URL` origin https, ≠ `PUBLIC_BASE_URL`, thuộc `ALLOWED_ORIGINS`; vps: từ chối `WEB_BASE_URL` ≠ `PUBLIC_BASE_URL`); CI deploy-smoke chạy nginx-api ở 8081 với `SMOKE_MODE=api` (+ 413/502 JSON) và một vòng `WEB_MODE=external` (từ chối cấu hình sai, deploy/rollback không build `ottm-web`, không đổi `WEB_ROOT`, env api đúng) rồi trả về vps; `publish-web-hostinger.sh` neo `public_html` theo đoạn đường dẫn + từ chối cây mã bẩn (`ALLOW_DIRTY=1`); `check-htaccess.sh` xoá file tạm trước mỗi request + kiểm `/.env`, `/.git/config`; `VITE_API_ORIGIN` đòi https ở mọi `--mode` (trừ loopback); `SMOKE_MODE=api` bắt buộc `ORIGIN`; runbook 6.8 (`PUBLIC_BASE_URL=http://localhost:3000`), 8.2 (chứng chỉ trước, đủ giá trị cần sửa), 8.6 (thứ tự DNS/SSL, đăng xuất một lần).
- **Chưa xác minh (cần CI/máy thật)**: nginx thật cho `nginx-api.conf.example` (CI chỉ `nginx -t`, chưa chạy deploy `WEB_MODE=external` end-to-end); `httpd:2.4-alpine` trong CI; LiteSpeed thật của Hostinger (hỗ trợ `Header ... env=`, lookahead PCRE trong RewriteRule, `<IfModule>`) — runbook 8.5 yêu cầu chạy `check-htaccess.sh` sau upload; rsync/SSH thật tới Hostinger (macOS dùng openrsync — đã dùng `--chmod=u=rwX,go=rX` tương thích cả GNU rsync). Không có shellcheck trên máy dev.
- **Rủi ro còn lại**: 502/503 do nginx sinh trên host api không có header CORS → trình duyệt báo lỗi mạng (web hiện "Không kết nối được máy chủ" và thử lại) — chấp nhận được. Web và api khác tên miền gốc → đăng nhập không chạy (ghi rõ trong runbook 8.1).

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap)

| # | Nguồn | Phát hiện | Verdict | Bằng chứng | Route |
|---|-------|-----------|---------|------------|-------|
| 1 | VG | Nhánh catch ngoài của callback OAuth (`app/oauth.ts:174`) không test nào chạm | medium | Chỉ nhánh catch trong `callbackPath` được test; đổi lại về đường tương đối thì test vẫn xanh | patch |
| 2 | VG, blind, edge | Nhánh `WEB_MODE=external` của deploy/rollback/prune và compose passthrough không chạy trong CI | medium | `ci.yml` không có `WEB_MODE`/`external`; chỉ `bash -n` | patch |
| 3 | VG, blind, edge | `nginx-api.conf.example` + `SMOKE_MODE=api` chỉ được `nginx -t` | medium | Không bước CI nào gửi request qua mẫu mới | patch |
| 4 | VG | `publish-web-hostinger.sh` không có test tự động | medium | Chỉ `bash -n`; script chạy tay với hosting bên thứ ba | defer |
| 5 | VG, edge | Runbook 6.8 thiếu `PUBLIC_BASE_URL=http://localhost:3000`, mô tả sai nơi mở trang đồng ý giả | low | Không đặt thì mặc định `DEV_PUBLIC_BASE_URL`=5173, URL giả và callback đi qua Vite | patch |
| 6 | VG, blind | Comment trong `nginx-api.conf.example` nói CI đổi thành `listen 80` | low | CI đổi thành `listen 8081` | patch |
| 7 | blind | Không kiểm web và api cùng tên miền gốc | low | Đúng là không kiểm; cách sửa cần Public Suffix List (thêm phức tạp), runbook 8.1 đã nói rõ | reject |
| 8 | edge, blind | `deploy.sh` external chỉ kiểm khác rỗng; `WEB_BASE_URL` http hoặc không thuộc `ALLOWED_ORIGINS` (hoặc bằng `PUBLIC_BASE_URL`) chỉ lộ khi api không khởi động, sau backup và ghi `IMAGE_TAG` | medium | `deploy.sh:44-46` | patch |
| 9 | edge, blind | `WEB_MODE=vps` còn sót `WEB_BASE_URL` khác `PUBLIC_BASE_URL` → OAuth chuyển về host Hostinger cũ | medium | compose truyền `WEB_BASE_URL` sang api bất kể chế độ | patch |
| 10 | blind | Không ghi bản web nào đang chạy trên Hostinger; rollback BE không cảnh báo lệch web | medium | Không có marker/tag web ở chế độ external | defer |
| 11 | blind | Script publish build từ cây mã bẩn | medium | Không có kiểm `git status` như `deploy.sh` | patch |
| 12 | blind, edge | Guard `HOSTINGER_PATH` từ chối `public_html` (gốc tên miền chính) và nhận `x/public_html_old` | medium | `*/public_html*` cần `/` phía trước, không neo theo đoạn đường dẫn | patch |
| 13 | blind | Runbook 8.6: kiểm 8.5 trước khi DNS trỏ Hostinger; không nói cookie cũ mất hiệu lực (mọi người bị đăng xuất) | low | Thứ tự bước trong 8.6 | patch |
| 14 | blind | Runbook 8.2 bước 4: chứng chỉ sau `nginx -t`, thiếu `--deploy-hook`, `sed` chỉ thay hostname | medium | `nginx -t` lỗi khi chưa có file chứng chỉ; gia hạn không reload nginx | patch |
| 15 | blind | CSP lặp ở `htaccess.template` và `nginx.conf.example`, không kiểm khớp | low | Cách sửa cần sinh từ một nguồn chung (thêm phức tạp) | reject |
| 16 | blind, edge | CSP host api chặn trang HTML ở `/oauth`, `/privacy` | false | Production cấm `META_FAKE` (config:203); chưa có route `/privacy`. Story trang chính sách sẽ thêm ngoại lệ | reject |
| 17 | blind | Web chưa có helper URL `/media` theo `API_ORIGIN`; `/media/x` tương đối trên Hostinger rơi vào SPA (200 HTML) | medium (chưa xác minh — chưa có chỗ nào dựng URL media) | Epic 3+ sẽ hiển thị media | defer |
| 18 | blind | `.htaccess`: HTTPS redirect và chặn dotfile (ngoài `.ht*`) không được kiểm | low | `check-htaccess.sh` không thử `/.env`/`.git` | patch (gộp #19) |
| 19 | blind | `check-htaccess.sh` dùng lại file header/body của request trước khi curl lỗi | low | `get()` không làm rỗng `$WORK/h`, `$WORK/b` | patch |
| 20 | blind | `vite build --mode staging` nhận origin http | low | Kiểm https chỉ khi `mode==='production'` | patch |
| 21 | blind | `api.ts` bỏ `/` cuối trong khi build đã từ chối | low | Vô hại; không có lỗi thực | reject |
| 22 | edge | nginx tự sinh 413/502/503/504 không có header CORS → web thấy lỗi mạng | medium | Ghi nhận trong Implementation Notes; cần map origin trong nginx | defer |
| 23 | edge | `--prune-assets` xoá trước khi kiểm | low | Tuỳ chọn opt-in; quay lại = build commit cũ và xuất bản lại (tải lại assets) | reject |
| 24 | edge | `SMOKE_MODE=api` không đặt `ORIGIN` → mặc định host api, đăng nhập 403 | low | `smoke-test.sh:23`; `deploy.sh` luôn đặt, chỉ ảnh hưởng chạy tay | patch |
| 25 | edge | Script ở `deploy/hostinger/` khác đường trong spec | low | Sửa là sửa spec | reject |
