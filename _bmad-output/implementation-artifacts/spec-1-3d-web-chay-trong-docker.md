---
title: 'Web chạy như service Docker (WEB_MODE=vps)'
type: 'refactor'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3c-fe-hostinger-be-vps.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Ở `WEB_MODE=vps`, Docker chỉ build web rồi script chép `dist` ra `WEB_ROOT/<tag>` trên máy chủ, đổi symlink `current`, và nginx của chủ shop phục vụ file. Chủ shop muốn mọi thứ chạy thuần bằng service Docker, không có phần "chép ra host".

**Approach:** Thêm service `web` vào compose: image `ottm-web:<tag>` (multi-stage: build Vite → nginx unprivileged phục vụ `dist`, SPA fallback, cache), publish `127.0.0.1:${WEB_HOST_PORT:-3080}`. nginx của chủ shop (vẫn tự quản + certbot) chuyển `/` tới đó, giữ nguyên phần api và `/media`. Bỏ toàn bộ cơ chế publish/activate/symlink/`WEB_ROOT`; rollback = đổi `IMAGE_TAG` rồi `compose up` (web đi cùng tag).

## Boundaries & Constraints

**Always:** Service `web` chỉ chạy khi `WEB_MODE=vps` (compose profile `web`); `external` không build, không chạy web, và nếu container web cũ còn chạy thì dừng + xoá nó. Container web: user không phải root, root FS chỉ đọc (tmpfs cho chỗ nginx cần ghi), healthcheck, logging như service khác, chỉ nghe loopback. Header bảo mật (CSP, HSTS…) giữ ở nginx máy chủ như hiện tại; mỗi response chỉ có đúng một `Cache-Control` (container web quyết cho file web: `/assets/*` immutable 1 năm, còn lại `no-cache`; `/assets/` thiếu → 404, không rơi về index.html). `/media` vẫn là thư mục máy chủ `MEDIA_DIR_HOST` do nginx máy chủ phục vụ. Lock deploy, kiểm cấu hình web (`check_web_config`), backup trước migrate, `wait_healthy`, smoke-test giữ nguyên hành vi. `deploy.sh` kiểm thêm web khoẻ (qua `127.0.0.1:WEB_HOST_PORT`) trước smoke-test. Giữ 5 tag gần nhất cho cả `ottm-server` và `ottm-web`.

**Never:** Không đưa nginx/certbot của máy chủ vào Docker. Không đổi gì ở `server/src` hay `web/src`. Không làm hỏng chế độ `external` (Hostinger) hay mẫu `nginx-api.conf.example`. Không tự xoá `/var/www/ottm` cũ trên máy chủ (runbook hướng dẫn xoá tay).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Deploy vps | `WEB_MODE=vps` | build `ottm-server` + `ottm-web` cùng tag; `web` lên, healthy; nginx máy chủ chuyển `/` → web | web không khoẻ → die kèm gợi ý rollback, `IMAGE_TAG` đã ghi như api |
| Deploy external | `WEB_MODE=external` | không build/chạy `web`; container web cũ (nếu có) bị dừng + xoá | |
| Rollback vps | `rollback.sh <tag>` | còn đủ `ottm-server:<tag>` và `ottm-web:<tag>` → đổi `IMAGE_TAG`, `compose up`; thiếu image web → từ chối kèm hướng dẫn | |
| Cổng bận | `WEB_HOST_PORT` không phải số 1–65535 hoặc trùng `API_HOST_PORT` | die trước mọi thay đổi | |
| Deep link | `GET /trang-nhom/abc` qua nginx máy chủ | 200 index.html, `Cache-Control: no-cache`, header bảo mật có | |
| Asset | `GET /assets/<hash>.js` / asset thiếu | 200 immutable / 404 (không phải HTML) | |

</frozen-after-approval>

## Code Map

- `deploy/Dockerfile.web` -- nay chỉ build và `FROM scratch` giữ `/dist`; đổi stage cuối thành nginx unprivileged (ghim phiên bản) + file cấu hình nginx của container (mới, vd `deploy/web-nginx.conf`).
- `deploy/docker-compose.yml` -- `x-server`, service `api` (mẫu ports loopback, healthcheck, logging); thêm service `web` (`profiles: [web]`, `image: ottm-web:${IMAGE_TAG}`, build `Dockerfile.web`).
- `deploy/lib.sh` -- bỏ `web_root`, `check_host_paths` (phần WEB_ROOT), `point_current`, `web_current_tag`, `cleanup_web_staging`, `publish_web`, `activate_web`, `switch_web`, `atomic_rename` nếu không còn dùng; sửa `require_host_dirs`, `can_rollback_to`, `prune_images` (image web thay thư mục web); thêm `web_host_port` (như `api_host_port:154`); `compose()` (:17) bật profile `web` khi vps; `wait_healthy` (:337) chờ cả web ở vps.
- `deploy/deploy.sh`, `deploy/rollback.sh` -- bỏ bước publish/activate/switch web; external dừng/xoá container web.
- `deploy/nginx.conf.example` -- `location /` và `/assets/` (:201-219) thành `proxy_pass` tới `127.0.0.1:3080`; bỏ `/.ottm-web-tag`; map cache (`$ottm_cache_control`) không đặt cho đường web (tránh 2 header). Giữ api, `/media`, header bảo mật, trang lỗi JSON.
- `deploy/env.production.example` -- bỏ `WEB_ROOT`, thêm `WEB_HOST_PORT=3080` (chú thích: đổi nếu bận, sửa cả upstream nginx).
- `deploy/smoke-test.sh` -- chế độ vps vẫn qua nginx; bỏ kiểm `.ottm-web-tag`/thư mục web nếu có.
- `.github/workflows/ci.yml` (job deploy-smoke) -- bỏ chuẩn bị/kiểm `WEB_ROOT`, symlink, marker, prune thư mục; thêm kiểm container `web` (healthy, non-root, read-only, chỉ 127.0.0.1), deep link/asset qua nginx CI, rollback đổi được web, external dừng web.
- `deploy/runbook.md`, `_bmad-output/planning-artifacts/ARCHITECTURE-SPINE.md` -- mô hình mới; mục chuyển từ bố cục cũ (sửa site nginx, xoá `/var/www/ottm` bằng tay sau khi chạy ổn).

## Tasks & Acceptance

**Execution:**
- [x] `deploy/Dockerfile.web` + `deploy/web-nginx.conf` -- image phục vụ web như Boundaries.
- [x] `deploy/docker-compose.yml` + `deploy/env.production.example` -- service `web`, `WEB_HOST_PORT`, bỏ `WEB_ROOT`.
- [x] `deploy/lib.sh`, `deploy/deploy.sh`, `deploy/rollback.sh` -- như Code Map và matrix.
- [x] `deploy/nginx.conf.example`, `deploy/smoke-test.sh` -- proxy `/` tới web, một `Cache-Control`.
- [x] `.github/workflows/ci.yml` -- như Code Map.
- [x] `deploy/runbook.md`, `ARCHITECTURE-SPINE.md` -- cập nhật; ghi chú các comment khác còn nhắc `WEB_ROOT` (grep toàn repo trừ `_bmad-output/implementation-artifacts`).

**Acceptance Criteria:**
- Given repo sau thay đổi, when `grep -rn "WEB_ROOT\|publish_web\|activate_web\|\.ottm-web-tag"` ngoài spec cũ, then không còn tham chiếu.
- Given `docker compose config` với `.env` mẫu (vps), then service `web` có ports `127.0.0.1:3080:8080` (hoặc cổng container đã chọn), user không root, `read_only: true`; với `COMPOSE_PROFILES` trống thì `web` không xuất hiện trong danh sách chạy.

## Verification

**Commands:**
- `bash -n deploy/*.sh deploy/hostinger/*.sh` -- expected: không lỗi.
- `npm run check` -- expected: qua (không đổi code app).
- `ruby -ryaml -e 'YAML.load_file(".github/workflows/ci.yml")'` -- expected: YAML hợp lệ.
- `nginx -t` với cấu hình của container web nếu có nginx cục bộ; không có Docker cục bộ → ghi rõ phần chưa chạy.

## Implementation Notes

- **Image `ottm-web`** (`deploy/Dockerfile.web`): stage build `node:24-slim` như cũ (không `VITE_API_ORIGIN` → không `.htaccess`); stage cuối `nginxinc/nginx-unprivileged:1.28.0-alpine` (ghim bản vá), `LABEL org.ottm.web=nginx` (để phân biệt image cũ chỉ mang `/dist`), bỏ `default.conf`, chép `deploy/web-nginx.conf` thành `/etc/nginx/nginx.conf`, `nginx -t` lúc build, `USER 101`; healthcheck chỉ khai ở compose.
- **`deploy/web-nginx.conf`**: nghe 8080; pid + mọi thư mục tạm ở `/tmp`; `access_log off` (nginx máy chủ đã log); `absolute_redirect off`; gzip ở container. `/healthz` (200 nếu có `index.html`, 503 nếu không; nginx máy chủ chuyển `/healthz` tới api nên không lộ). `/assets/` → `try_files $uri =404` + `Cache-Control: public, max-age=31536000, immutable` (không `always`); `/` → SPA `try_files $uri /index.html =404` + `no-cache`; mọi 404 → `@not_found` text/plain + `no-store`; dotfile → 404. Không đặt header bảo mật (nginx máy chủ đặt).
- **Compose**: service `web` (`profiles: [web]`, `image: ottm-web:${IMAGE_TAG}`, build `Dockerfile.web`, `user: "101:101"`, `read_only: true`, tmpfs `/tmp` 16 MB noexec, `cap_drop: [ALL]`, `no-new-privileges`, ports `127.0.0.1:${WEB_HOST_PORT:-3080}:8080`, healthcheck, `logging: *logging`, mạng riêng `web`). Không `COMPOSE_PROFILES` trong `.env` mẫu.
- **`lib.sh`**: bỏ `web_root`, `check_host_paths`, `atomic_rename`, `point_current`, `web_current_tag`, `cleanup_web_staging`, `publish_web`, `activate_web`, `switch_web`, marker, trap dọn tạm; tag không còn cấm `current`. `compose()` thêm `--profile web` khi `web_mode` = vps. Mới: `web_host_port` (1–65535, khác `API_HOST_PORT`, gọi trong `check_web_config` nhánh vps → dừng trước mọi thay đổi), `web_image_status` (0 có nhãn / 1 thiếu / 2 image cũ — đọc `{{json .Config.Labels}}`), `remove_web_container` (`compose --profile web ps -a -q web` → `rm --stop --force web`), `wait_web_healthy` (curl `127.0.0.1:WEB_HOST_PORT/healthz`); `wait_healthy` sau khi api ổn chờ thêm web ở vps (phần hạn còn lại, tối thiểu 30 s). `can_rollback_to` (vps) đòi `ottm-web:<tag>` có nhãn. `prune_images` chỉ còn image (cùng tập tag cho ottm-server/ottm-web/ottm-backup). `require_host_dirs` chỉ kiểm media.
- **`deploy.sh`**: build qua `compose --profile backup build` (vps tự kèm web); bỏ publish/activate; sau `compose up` ở external gọi `remove_web_container`; lỗi healthz/web → die kèm gợi ý rollback (IMAGE_TAG đã ghi). **`rollback.sh`**: vps kiểm `ottm-web:<tag>` (thiếu → hướng dẫn checkout + deploy; image cũ → nói rõ không rollback qua mốc chuyển); đổi `IMAGE_TAG`, `compose up --no-build`; external dọn container web.
- **`nginx.conf.example`**: `upstream ottm_web 127.0.0.1:3080`; `location /` → `proxy_pass http://ottm_web` với `error_page 502 503 504 = @ottm_web_unavailable` (502 text/plain `web unavailable`, không phải JSON api) + `413 = @ottm_too_large`; bỏ `location ^~ /assets/`, `location = /.ottm…`; map `$ottm_cache_control_want` chỉ còn `$status` → lỗi `no-store`, còn lại rỗng (upstream có `Cache-Control` thì không thêm) → mỗi response đúng một `Cache-Control`. `nginx-api.conf.example` không đổi (tên mới không trùng tiền tố `ottm_api_`).
- **`smoke-test.sh`** (vps): thêm deep link `/trang-nhom/abc`, `expect_cache_control` (đúng một header) cho `/`, deep link, asset (immutable), asset thiếu (no-store). Kiểm Content-Type text/plain của asset thiếu đặt trong CI (gọi thẳng container) chứ không ở smoke-test, để `deploy.sh` lần đầu sau nâng cấp (nginx máy chủ còn cấu hình cũ — runbook 1.12 bước 2) vẫn qua smoke.
- **CI deploy-smoke**: bỏ `CI_WEB_ROOT`, thêm `CI_WEB_PORT=3180`; compose config (COMPOSE_PROFILES trống → không có `web`; `--profile web` → api + web publish 127.0.0.1, web 3180→8080, `user 101:101`, `read_only`, tmpfs, `cap_drop ALL`); `WEB_HOST_PORT` 0/70000/abc/=API → deploy dừng, không build, IMAGE_TAG giữ; sau deploy ci-a: container web healthy, nhãn, uid ≠ 0, root FS không ghi được, `/tmp` ghi được, chỉ 127.0.0.1, gọi thẳng: deep link 200 một `no-cache` không CSP, `/.env` 404, asset thiếu 404 text/plain no-store, asset immutable; dừng web → nginx 502 `web unavailable` no-store + header bảo mật, api vẫn 401; deploy ci-b/rollback ci-a đổi cả api/worker/web; rollback tới tag thiếu ottm-web hoặc image web kiểu cũ (`FROM scratch`) → từ chối, không đổi gì; prune gỡ `ottm-web:ci-old`; external: deploy không build web, dừng + xoá container web, rollback không cần/không chạy web; về vps bằng `rollback.sh ci-a` (chạy lại web). Dọn/log thêm `--profile web`.
- **Sau review (vòng 1)**: named location `@not_found` / `@ottm_web_unavailable` thêm `types { }` (luôn text/plain); `compose()`/`_wait_web_if_vps` tính `web_mode` một lần (`|| exit 1`); `remove_web_container` die khi `compose ps` lỗi; `check_host_ports` (deploy.sh, rollback.sh, trước mọi thay đổi): cổng api/web đang có tiến trình nghe (`ss`) mà không phải cổng container api/web của project publish (`docker port`) → die nêu cổng + gợi ý; không `ss` → log bỏ qua. `deploy.sh` vps: sau smoke so `index.html` của container với URL công khai, khác → CẢNH BÁO (nginx chưa chuyển); gợi ý rollback nói rõ bản trước là bản trước mốc web-trong-Docker. `rollback.sh` chỉ gợi ý tag có ottm-web phục vụ được. Runbook: cảnh báo trước bước 2 của 1.12, sửa câu "không gián đoạn", hành vi lệnh compose gõ tay không `--profile web` (down, `--remove-orphans`, khôi phục, bảng tra). Dockerfile bỏ HEALTHCHECK. CI thêm: jq networks/security_opt/tmpfs, wait_* lỗi khi web dừng, 413 JSON trên đường web, rollback với `WEB_HOST_PORT` trùng API dừng, external rollback dọn container web dựng lại, cổng bận (python http.server) → deploy dừng.
- **Docs**: runbook (sơ đồ, bảng thành phần, profile `web` và `--profile web` cho lệnh gõ tay, 1.4 `WEB_HOST_PORT`, 1.5 chỉ media, 1.6 upstream/Cache-Control, 1.7, **1.12 chuyển từ bố cục cũ** — deploy trước, sửa site nginx sau, xoá `/var/www/ottm` bằng tay, không rollback qua mốc; mục 2, 3, 5, 7, 8.2, 8.6). ARCHITECTURE-SPINE: bảng hạ tầng, sơ đồ container (node Web), đoạn Triển khai, cây `deploy/`.
- **Đã kiểm local (không Docker, không nginx trên máy)**: `bash -n` mọi `deploy/*.sh`, `deploy/hostinger/*.sh` và từng khối `run:` của `ci.yml`; YAML `ci.yml` + compose parse được (Ruby); harness bash với `docker` giả: `compose()` thêm/không thêm `--profile web` theo WEB_MODE, `remove_web_container`, `web_image_status` (0/2/1), `can_rollback_to`; `check_web_config` từ chối `WEB_HOST_PORT` = API / abc / 65536 / trùng khi đổi API. `npm run check` exit 0 (server 549, web 105 — lần chạy đầu có 1 test `notifications.test.ts` chập chờn do tải, chạy lại riêng 3 lần + toàn bộ đều xanh; không đổi code app). Grep AC (`WEB_ROOT|publish_web|activate_web|.ottm-web-tag`) ngoài `_bmad-output/implementation-artifacts`: không còn.
- **Chưa xác minh (cần CI/máy có Docker)**: build image `ottm-web` thật, `nginx -t` của `web-nginx.conf` (chạy trong Dockerfile lúc build) và của `nginx.conf.example` mới, `docker compose config` thật, mọi bước deploy-smoke; tồn tại tag `nginxinc/nginx-unprivileged:1.28.0-alpine`; entrypoint của image unprivileged chạy êm trên root FS chỉ đọc với `cap_drop: ALL`.
- **Rủi ro còn lại**: thay container web lúc deploy/rollback có khoảng ~1 s nginx trả 502 `web unavailable` (trước đây đổi symlink không gián đoạn). Không thể rollback tới tag deploy trước mốc này (image ottm-web cũ không chạy được) — script từ chối kèm hướng dẫn. Lệnh `docker compose …` gõ tay không kèm `--profile web` không thấy service web (runbook ghi rõ).

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap)

| # | Nguồn | Phát hiện | Verdict | Bằng chứng | Route |
|---|-------|-----------|---------|------------|-------|
| 1 | VG | rollback.sh external chưa bao giờ chạy khi còn container web | medium | CI gọi rollback external ngay sau deploy external đã xoá container | patch |
| 2 | VG | Nhánh web không khoẻ của `wait_healthy` không được test | medium | Mọi lần gọi trong CI đều khi web khoẻ | patch |
| 3 | VG, blind | Không kiểm `networks: [web]`, `no-new-privileges`, cờ tmpfs | medium | jq trong CI không có các khoá này | patch |
| 4 | VG | 413 JSON trên đường web không được test | low | CI chỉ gửi 3 MB tới `/api/v1/auth/login` | patch |
| 5 | VG | gzip dời vào container, không kiểm | low | Tính năng hiệu năng | defer |
| 6 | VG | `rollback.sh` với `WEB_HOST_PORT` sai không được test | medium | Bước CI chỉ chạy deploy.sh | patch |
| 7 | VG, edge | `remove_web_container` nuốt lỗi `compose ps` | medium | `lib.sh:211` `|| ids=""` rồi return 0 | patch |
| 8 | blind | `@not_found` / `@ottm_web_unavailable` trả Content-Type theo đuôi file (vd `.js`), không phải text/plain | medium | `return` dùng bảng `types` theo phần mở rộng URI | patch |
| 9 | blind, edge | `WEB_HOST_PORT` (và `API_HOST_PORT`) đang bị tiến trình khác giữ chỉ lộ ở `compose up`, sau backup và ghi `IMAGE_TAG` | medium | Chủ shop đã có cổng 3000/5432 bận trên VPS; `web_host_port` chỉ so với API | patch |
| 10 | blind | Deploy đầu sau khi chuyển bố cục không rollback được; gợi ý nói "không còn đủ image" gây hiểu nhầm | medium | `ottm-web:<tag cũ>` là image chỉ mang dist | patch (runbook cảnh báo + câu gợi ý) |
| 11 | blind | Runbook 1.12 bước 2 nói "không gián đoạn" nhưng web cũ chạy với api mới; smoke kiểm thư mục cũ | low | nginx máy chủ còn root `/var/www/ottm/current` tới bước 3 | patch |
| 12 | blind, edge | `compose()`/`_wait_web_if_vps` nuốt `die` của `web_mode` trong `[[ ]]` | medium | errexit không áp trong command substitution trong `[[ ]]` | patch |
| 13 | blind | Mất test "bước web lỗi → không đổi gì" | medium | Bước CI cũ bị xoá, chưa có thay thế; cần cách cố ý làm hỏng build web | defer |
| 14 | blind | Script không kiểm container web đúng tag | low | `compose up` tạo lại theo image mới; lệch chỉ khi compose lỗi mà vẫn exit 0 | reject |
| 15 | blind | 503/504 bị đổi thành 502 | low | Chỉ khác mã trong log | reject |
| 16 | blind | Runbook chưa nói `docker compose down` / `--remove-orphans` không profile ảnh hưởng web | low | Thiếu ghi chú | patch |
| 17 | blind | Healthcheck khai hai nơi; comment ghép với `NGINX_IMAGE` CI sai | low | Dockerfile.web + compose | patch |
| 18 | blind | `/assets/` bỏ qua chặn dotfile | low | dist không có dotfile | reject |
| 19 | blind | Healthcheck chậm báo healthy (30 s) | low | `deploy.sh` dùng `wait_web_healthy` qua HTTP, không chờ trạng thái docker | reject |
| 20 | edge | `GET /assets/` trả 403 HTML | low | Hiếm gặp; không ai gọi | reject |
| 21 | edge | Body 1–2 MB tới đường web → 413 HTML từ container | low | Web chỉ nhận GET; không luồng nào gửi body | reject |
| 22 | edge | nginx máy chủ chưa chuyển `/` sang container → web cũ phục vụ mãi, smoke vẫn qua | medium | `smoke-test.sh` chỉ kiểm qua nginx | patch (cảnh báo khi index.html qua nginx khác container) |
| 23 | edge | Thông báo rollback liệt kê cả tag web kiểu cũ | low | `rollback.sh:31` liệt kê mọi tag | patch |
