---
title: 'Thay đổi Story 1.3 — Bỏ Caddy, dùng nginx + certbot do chủ shop tự quản'
type: 'chore'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-1-3b
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3-trien-khai-production-tren-mot-vps.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chủ shop không muốn dùng Caddy. Họ tự chạy nginx trên VPS và tự quản chứng chỉ bằng certbot. Hiện stack production lại có service `caddy` đảm nhận TLS, định tuyến, phục vụ web tĩnh và `/media`, header bảo mật, SSE, cache.

**Approach:** Gỡ Caddy khỏi stack. Để nginx trên host làm được mọi việc Caddy đang làm:
- api lắng nghe ở `127.0.0.1:${API_HOST_PORT:-3000}`;
- `deploy.sh` xuất bản build web ra thư mục trên host;
- `/media` là thư mục trên host (bind mount);
- kèm `deploy/nginx.conf.example` ghi đủ các điểm bắt buộc để chủ shop tự chỉnh, còn certbot do họ tự lo.

CI kiểm cấu hình mẫu bằng image nginx chính thức.

## Boundaries & Constraints

**Always:**
- **Hành vi giữ nguyên như Caddy** (theo ma trận của spec 1.3, mục Route/SPA/Media/Header):
  - `/healthz`, `/api`, `/api/*`, `/webhooks`, `/webhooks/*`, `/oauth/*`, `/privacy`, `/privacy/*` → api;
  - `/media/*` từ thư mục media, thiếu file → 404, không rơi về `index.html`, kèm `CSP default-src 'none'; img-src 'self'; sandbox` + `nosniff`;
  - `/assets/*` thiếu → 404, có thì `Cache-Control: public, max-age=31536000, immutable`;
  - còn lại → file tĩnh hoặc `index.html` với `no-cache`;
  - CSP / HSTS / `X-Content-Type-Options` / `Referrer-Policy` / `X-Frame-Options` / `Permissions-Policy` như Caddyfile hiện tại (kể cả `img-src` cho `*.fbcdn.net`, `*.cdninstagram.com`);
  - SSE không đệm (`proxy_buffering off`, `proxy_read_timeout` ≥ 1 giờ cho `/api/v1/stream`), không gzip qua api;
  - lỗi 502/503/504 trên đường api trả JSON `{"error":{"code":"INTERNAL","message":"api unavailable"}}`;
  - không bật access log trên các đường `/oauth` và `/webhooks` (URL có thể mang `code` / `hub.verify_token`).
- **IP thật:** `TRUST_PROXY` vẫn bật (1 hop). nginx mẫu phải đặt `proxy_set_header X-Forwarded-For $remote_addr` (không dùng `$proxy_add_x_forwarded_for`, tránh bị giả IP) cùng `X-Forwarded-Proto` và `Host`.
- **Cổng:** chỉ nginx của chủ shop mở 80/443. api chỉ bind `127.0.0.1`; postgres, worker không publish cổng.
- **Thư mục trên host** [ASSUMPTION]:
  - web build ở `${WEB_ROOT:-/var/www/ottm}`: `deploy.sh` xuất bản bằng cách dựng image `ottm-web:<tag>` rồi chép `dist` ra một thư mục theo tag, sau đó đổi symlink `current` nguyên tử. Rollback trỏ lại bản trước.
  - media ở `${MEDIA_DIR_HOST:-/var/lib/ottm/media}` (bind mount, chủ sở hữu uid 1000, nginx chỉ đọc).
- **Smoke test:** `deploy/smoke-test.sh` giữ các kiểm tra hiện có, chạy qua nginx.

**Never:**
- Không tự cài nginx/certbot hay sửa cấu hình hệ thống của VPS.
- Không đưa Caddy vào lại dưới dạng tuỳ chọn.
- Không đổi hành vi api/web ngoài phần cấu hình triển khai.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deploy | `./deploy/deploy.sh` | build server + web, xuất bản web ra `WEB_ROOT/<tag>`, symlink `current` → tag mới, `compose up -d`, healthz qua `127.0.0.1:API_HOST_PORT`, smoke qua `PUBLIC_BASE_URL` | xuất bản web lỗi → không đổi symlink, dừng |
| Rollback | `./deploy/rollback.sh <tag>` | symlink `current` → `WEB_ROOT/<tag>`, container về tag cũ | thiếu thư mục tag → dừng, báo rõ |
| Dọn bản cũ | sau deploy | giữ `KEEP_TAGS` thư mục web theo cùng tập tag giữ image | không xoá bản đang `current` |
| Cổng api | `docker compose ps` | api publish đúng `127.0.0.1:${API_HOST_PORT}`; không service nào publish 80/443 | N/A |
| CI | job `deploy-smoke` | dựng stack, chạy `nginx:1.27-alpine` (tag minor cố định) với `nginx.conf.example` đã thay host/đường dẫn ở cổng 80 (không TLS), `smoke-test.sh` qua nginx xanh | config sai → `nginx -t` đỏ |

</frozen-after-approval>

## Code Map

- `deploy/docker-compose.yml` -- service `caddy`, volume `caddy_data`, `media` named volume: bỏ caddy; `api` publish `127.0.0.1:${API_HOST_PORT:-3000}:3000`; `media` → bind `${MEDIA_DIR_HOST}`; giữ backup/restore đọc cùng thư mục.
- `deploy/Caddyfile`, `deploy/Dockerfile.caddy` -- xoá; chuyển nội dung thành `deploy/nginx.conf.example` và `deploy/Dockerfile.web` (stage build web, chỉ để lấy `dist`).
- `deploy/deploy.sh`, `deploy/rollback.sh`, `deploy/lib.sh` -- `SITE_ADDRESS`, image `ottm-caddy`, `wait_healthy`, `prune_images`: thay bằng xuất bản web + symlink, healthz qua cổng host.
- `deploy/smoke-test.sh` -- kiểm route/header/SPA/media: giữ, đổi chữ "Caddy" thành "reverse proxy".
- `deploy/env.production.example`, `deploy/runbook.md` -- bỏ `SITE_ADDRESS`; thêm `WEB_ROOT`, `MEDIA_DIR_HOST`, `API_HOST_PORT`; runbook: cài nginx site từ mẫu, certbot (`certbot --nginx` hoặc webroot), quyền thư mục (media uid 1000, nginx đọc), reload nginx sau deploy không cần.
- `.github/workflows/ci.yml` (`deploy-smoke`) -- dựng caddy: thay bằng nginx container dùng mẫu (mount `WEB_ROOT`, `MEDIA_DIR_HOST`, trỏ tới api trên host network).
- `server/src/app/app.ts`, `server/src/platform/config/index.ts`, `server/.env.example`, `web/vite.config.ts` -- chỉ chú thích nhắc Caddy: đổi thành "reverse proxy (nginx)".
- `_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md` -- Structural Seed và AD-19 nhắc Caddy: cập nhật thành nginx do chủ shop quản (người điều phối làm, không phải subagent).

## Tasks & Acceptance

**Execution:**
- [x] `deploy/docker-compose.yml` -- như Code Map.
- [x] `deploy/Dockerfile.web` + xoá `deploy/Caddyfile`, `deploy/Dockerfile.caddy`.
- [x] `deploy/nginx.conf.example` -- server block 443 (đường certbot mặc định `/etc/letsencrypt/live/<domain>/…`, có chú thích) + redirect 80→443; mọi điểm ở Boundaries; chú thích từng khối.
- [x] `deploy/{deploy.sh,rollback.sh,lib.sh}` -- xuất bản web, symlink, dọn bản cũ, healthz qua host.
- [x] `deploy/smoke-test.sh`, `deploy/env.production.example`, `deploy/runbook.md` -- như Code Map.
- [x] `.github/workflows/ci.yml` -- job deploy-smoke dùng nginx mẫu; kiểm `nginx -t`; kiểm không service nào publish 80/443 và api chỉ ở 127.0.0.1.
- [x] Chú thích trong server/web.

**Acceptance Criteria:**
- Given repo sau thay đổi, when tìm "caddy" (không phân biệt hoa thường) ngoài `_bmad-output`, then không còn kết quả.
- Given `deploy/nginx.conf.example`, when đối chiếu với ma trận route/header/SPA/media của spec 1.3, then có đủ từng dòng.
- Given `npm run check` và `bash -n` mọi script deploy, when chạy, then thoát 0.

## Implementation Notes

- **Compose:** bỏ service proxy, volume chứng chỉ, mạng `edge`, named volume `media`. `api` publish `127.0.0.1:${API_HOST_PORT:-3000}:3000`; không service nào khác có `ports`. Media là bind mount `${MEDIA_DIR_HOST:-/var/lib/ottm/media}` → `/data/media` (anchor `x-media-rw`/`x-media-ro`, `create_host_path: false` để Docker không tự tạo thư mục thuộc root) cho api, worker, restore (ghi) và backup (chỉ đọc). `HEALTH_DISK_PATH=/data/media` nay đo đĩa máy chủ chứa media.
- **Web:** `deploy/Dockerfile.web` (stage build `node:24-slim`, stage cuối `scratch` chỉ có `/dist`). `lib.sh`: `publish_web <tag>` (`docker create … noop` + `docker cp /dist/.` vào `WEB_ROOT/.publish-<tag>.<pid>`, kiểm `index.html`, `chmod a+rX`, rename thành `WEB_ROOT/<tag>`; deploy lại cùng tag thì đổi chỗ thư mục cũ), `switch_web <tag>` (`ln -sfn` symlink tạm + `mv -T` → `current`, symlink tương đối). `deploy.sh`: build → `docker build ottm-web:<tag>` → `publish_web` (lỗi → dừng, chưa đổi gì) → backup trước deploy → ghi `IMAGE_TAG` → `switch_web` → `compose up` → `wait_healthy` → smoke qua `PUBLIC_BASE_URL`. `rollback.sh` kiểm `ottm-server:<tag>` và `WEB_ROOT/<tag>/index.html` trước khi đổi gì.
- **Cấu hình host:** `cfg()` đọc theo thứ tự của compose (biến shell > `deploy/.env` > mặc định). `WEB_ROOT`/`MEDIA_DIR_HOST` phải tuyệt đối, chỉ ký tự an toàn, không `/`, không `..`; `API_HOST_PORT` 1–65535. `require_host_dirs`: `WEB_ROOT` ghi được bởi người chạy script, `MEDIA_DIR_HOST` thuộc uid 1000 (sai → dừng kèm lệnh `sudo install`/`chown` để sửa; script không dùng sudo).
- **Healthz:** `wait_healthy` gọi `curl http://127.0.0.1:API_HOST_PORT/healthz` trên máy chủ (thay `docker compose exec`), giữ luật "503 chỉ vì đĩa đầy = qua kèm cảnh báo".
- **Dọn bản cũ:** `prune_images` tính một tập tag giữ (KEEP_TAGS tag mới nhất của ottm-server + tag đang chạy + tag mà `current` trỏ tới) và áp cho `ottm-server`, `ottm-web`, `ottm-backup` và các thư mục `WEB_ROOT/<tag>` (bỏ qua `current`, symlink, thư mục ẩn).
- **nginx mẫu:** mọi `add_header` ở cấp `server` với `always`; khác biệt theo đường dẫn tính bằng `map` (tránh bẫy kế thừa add_header): CSP theo `"$status:$uri"` (2xx/304 của `/media/` → CSP sandbox, lỗi → CSP chung, khớp smoke-test hiện có), Cache-Control theo `$uri` (rỗng cho api/media), Referrer-Policy chỉ thêm khi api chưa đặt (`$upstream_http_referrer_policy`; api đặt `no-referrer` cho trang OAuth — Caddy cũ để giá trị của api thắng, nginx `add_header` sẽ thêm header thứ hai). `proxy_set_header` ở cấp server (`X-Forwarded-For $remote_addr`, `X-Forwarded-Proto`, `Host`, `X-Forwarded-Host`). `error_page 502|503|504 = @ottm_api_50x` → JSON INTERNAL giữ mã (chỉ lỗi do nginx sinh; 503 của api đi thẳng). `gzip off` cấp server, bật trong `/assets/` và `/`. `/media/`: `alias` + `disable_symlinks on from=<media>` (thư mục do api ghi). `/oauth`, `/webhooks`: `access_log off` và `error_log … crit` (dòng lỗi upstream in nguyên request line kèm query). `listen 443 ssl http2` (chạy trên nginx 1.22/1.24 của Debian 12/Ubuntu 24.04). `client_max_body_size 2m` để lỗi 413 đến từ api (giới hạn 1 MB của Fastify). Ký hiệu cho CI: khối `# >>> REDIRECT-80`…`# <<< REDIRECT-80`, dòng `ssl_*`, `listen 443 ssl http2;`, `listen [::]:443`.
- **CI `deploy-smoke`:** thư mục `/srv/ottm-ci/{www,media}` và `API_HOST_PORT=3100` (khác mặc định để kiểm việc thay mẫu); `docker compose config` + jq: chỉ `api` publish, đúng `127.0.0.1:3100→3000`, không ai publish 80/443, media là bind ở cả 4 service, không còn named volume `media`; sed mẫu → `nginx -t` bằng `nginx:1.27-alpine` rồi chạy container nginx `--network host`; deploy ci-a; `ss` + curl qua IP máy: api chỉ ở 127.0.0.1; smoke qua nginx; access log không có `/oauth`, `/webhooks`; dừng api → `/api/v1/auth/me` 502 JSON INTERNAL có CSP; `publish_web` image thiếu → `current` không đổi, không còn `.publish-*`; deploy ci-b/rollback ci-a kiểm cả symlink + smoke; rollback tới tag thiếu thư mục web → dừng, không đổi gì; prune xoá thư mục web lạ `ci-old`, giữ `ci-a`.
- **Runbook:** kiến trúc mới, mục 1.5 (thư mục máy chủ, uid 1000), 1.6 (cài nginx/certbot, `certbot certonly --nginx … --deploy-hook "systemctl reload nginx"`, webroot tuỳ chọn, cài site từ mẫu, các điểm bắt buộc giữ, không cần reload sau deploy), đánh số lại 1.7–1.10, 1.11 chuyển từ stack cũ (chép media từ volume `ottm_media`), rollback/log/TLS/đĩa đầy theo nginx + certbot.
- **Đã kiểm local (không Docker/nginx):** `npm run check` exit 0; `bash -n` mọi script deploy; YAML của compose và CI parse được (Ruby), compose có đúng ports/volumes/networks; harness bash với `docker`/`curl` giả cho `cfg`/`web_root`/`api_host_port` (từ chối `/`, đường tương đối, khoảng trắng, `..`, cổng sai), `publish_web` (thành công, cp lỗi, thiếu `index.html`, image thiếu → không đổi `current`, không còn thư mục tạm; xuất bản lại cùng tag thay nội dung), `switch_web` (tag thiếu → từ chối), `wait_healthy` (200, 503 đĩa đầy, 503 db down). `prune_images` dùng mảng kết hợp (bash ≥ 4) nên chỉ kiểm bằng CI (máy dev là bash 3.2). Tìm "caddy" (không phân biệt hoa thường) ngoài `_bmad-output`: không còn.
- **Chưa xác minh (cần job CI `deploy-smoke` xanh):** hành vi thật của nginx (map theo `$status`, error_page về named location giữ mã, `disable_symlinks`, nén), image `ottm-web` + `docker cp` từ image `scratch`, bind mount `create_host_path: false`, toàn bộ deploy/rollback/prune/restore trên stack thật.
- **Sau review (vòng 1):** `lib.sh` — đường dẫn dạng chuẩn (không `//`, đoạn `.`/`..`, ≥ 2 cấp, từ chối thư mục hệ thống), `WEB_ROOT`/`MEDIA_DIR_HOST` không trùng/lồng nhau; `TAG_RE` không cho tag bắt đầu bằng `.`/`-`; `require_host_dirs` kiểm media uid 1000 có `u+rwx`, nginx đọc được (`o+rx` hoặc nhóm www-data/nginx), WEB_ROOT `o+rx`, mọi thư mục cha `o+x`, in lệnh sửa; khoá `flock` trên `deploy/.deploy.lock` (đã gitignore) cho deploy/rollback; `publish_web` chỉ chuẩn bị `.publish-new-<tag>.<pid>` + đánh dấu `.ottm-web-tag`, trap EXIT/INT/TERM dọn container + thư mục tạm; `activate_web` (sau backup, trước `up`) đưa vào `WEB_ROOT/<tag>` — cùng tag thì trỏ `current` vào bản chuẩn bị, dời bản cũ, `cp -a`, trỏ lại `<tag>`, lỗi thì trả bản cũ; `.publish-old-*` không bao giờ bị dọn tự động; rename symlink bằng GNU `mv -T` hoặc `python3 os.rename`, không có thì dừng; web đổi trước khi ghi `IMAGE_TAG` (deploy và rollback); prune chỉ xoá thư mục có đánh dấu khớp tên; `wait_healthy` hạn theo `SECONDS`. Gợi ý rollback chỉ khi tag trước còn image + thư mục web, không thì hướng dẫn checkout/khôi phục; `compose up` của rollback lỗi có thông báo rõ. nginx: named location lỗi `access_log off`; `try_files $uri /index.html =404`; `error_page 413` → JSON `VALIDATION_FAILED`; Cache-Control `always` qua map `"$status:$uri"` (lỗi → `no-store`) và không thêm khi api đã đặt; chặn `/.ottm-web-tag`. CI: `ss`/`hostname -I` rỗng → đỏ; kiểm 413 JSON, 502 có `no-store`, query `/oauth` khi api chết không vào log nginx, marker + không còn container tạm, prune giữ thư mục không đánh dấu / đánh dấu sai. Harness local mở rộng (đường dẫn, chồng lấn, quyền, deploy lại cùng tag, `cp` lỗi khi thay, ngắt TERM, thoát trước activate, cleanup, hạn `wait_healthy`).
- **Rủi ro còn lại:** sau deploy, tab trình duyệt còn mở bản cũ sẽ 404 khi tải chunk JS cũ (`/assets/*` chỉ tra trong `current`) — giống hành vi Caddy trước đây; người dùng tải lại trang là xong.

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | edge | prune `rm -rf` mọi thư mục mang tên tag trong WEB_ROOT; đường dẫn `/.`, `//` lọt kiểm | high | lib.sh prune/check_abs_dir_path; patch (marker + kiểm chồng lấn) |
| 2 | edge | Không khoá; switch_web lỗi sau env_set; deploy lại cùng tag thay web đang chạy; mv cuối lỗi làm current treo; rò container; mv -T chỉ có ở GNU | medium | lib.sh publish_web/switch_web; patch |
| 3 | edge | wait_healthy đếm sai thời gian | low | sửa trực tiếp; patch |
| 4 | edge | Quyền thư mục media/WEB_ROOT sai vẫn qua kiểm | medium | require_host_dirs; patch |
| 5 | edge | Gợi ý rollback trỏ tag không có web; rollback compose up lỗi im lặng | low | patch |
| 6 | edge (claim) | Khi api sập, /oauth và /webhooks vẫn ghi access log qua named location | high | error_page chuyển sang @ottm_api_50x có log; patch |
| 7 | edge | Thiếu index.html → vòng lặp 500; 413 dạng HTML; lỗi 5xx thiếu no-store (Caddy có) | low | nginx mẫu; patch |
| 8 | edge | Bước CI kiểm api chỉ ở loopback có thể qua khi không đo được gì | medium | ci.yml; patch |

Ghi chú: thay đổi nhỏ, chỉ chạy lớp Edge Case Hunter; người điều phối tự đọc nginx.conf.example.

## Verification

**Commands:**
- `npm run check` -- expected: exit 0, không dòng failed
- `for f in deploy/*.sh deploy/backup/*.sh; do bash -n "$f"; done` -- expected: không lỗi
- Manual: job CI `deploy-smoke` xanh khi repo lên GitHub (máy dev không có Docker/nginx).
