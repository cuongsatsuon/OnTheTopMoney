---
title: 'Story 1.3 — Triển khai production trên một VPS'
type: 'chore'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-1-3
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-2-dang-nhap-chu-so-huu-va-lop-goi-api.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** App chỉ chạy được trên máy dev. Meta cần một URL HTTPS công khai để gửi webhook, và chưa có sao lưu nên hỏng máy chủ là mất dữ liệu.

**Approach:** Thêm mọi thứ để chạy app trên một VPS bằng Docker Compose (caddy, migrate, api, worker, postgres), build image ngay trên VPS và gắn tag theo git SHA, sao lưu mã hoá hằng đêm sang kho của nhà cung cấp khác, `/healthz` báo cả đĩa đầy, và runbook vận hành. Kiểm bằng test local cho phần chạy được trên máy không có Docker, và một job CI dựng image rồi gọi thử qua Caddy.

## Boundaries & Constraints

**Always:** Theo Structural Seed › Container và triển khai, AD-12 (backup mã hoá, `APP_ENCRYPTION_KEYS` không nằm trong backup), AD-19 (header bảo mật, bề mặt công khai). Chỉ Caddy mở cổng ra ngoài (80/443); api, worker, postgres chỉ trong mạng nội bộ của compose. api chạy với `TRUST_PROXY=true`, `NODE_ENV=production`, `ALLOWED_ORIGINS` = origin HTTPS của `PUBLIC_BASE_URL`. Build image trên VPS từ mã nguồn, không cần registry [ASSUMPTION]. Sao lưu bằng `restic` tới kho S3-compatible (ví dụ Backblaze B2), giữ 14 bản hằng ngày, chạy bằng cron của máy chủ gọi `docker compose run --rm backup` [ASSUMPTION]. Máy dev không có Docker: phần Docker được kiểm bằng CI.

**Never:** Không tự triển khai lên máy chủ thật hay tạo tài nguyên cloud. Không đưa bí mật thật vào repo. Không mở cổng Postgres/api ra internet. Không thêm Kubernetes, registry, staging.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Healthz đĩa đầy | đĩa của `HEALTH_DISK_PATH` dùng >85% | 503 `{ok:false, disk:'full', …}` | lỗi đọc đĩa → `disk:'unknown'`, không làm 503 |
| Healthz bình thường | DB lên, heartbeat mới, đĩa ≤85% | 200 `{ok:true, db:'ok', worker:'ok', disk:'ok'}` | N/A |
| Production dùng app Meta thử | `NODE_ENV=production`, `META_APP_ID` đặt và `META_APP_ENV=test` (hoặc thiếu) | không khởi động, log tên biến `META_APP_ENV` | exit ≠ 0 |
| Thiếu biến production | thiếu `PUBLIC_BASE_URL` khi `NODE_ENV=production` | không khởi động, log tên biến | exit ≠ 0 |
| Route qua Caddy | `/healthz`, `/api/*`, `/webhooks/*`, `/oauth/*`, `/privacy/*` | tới api | N/A |
| SPA qua Caddy | `/hop-thu` (không có file) | `index.html` của web, 200 | N/A |
| Media qua Caddy | `/media/<file>` có thật / không có | file / 404 (không rơi về `index.html`) | N/A |
| Header bảo mật | mọi response qua Caddy | có CSP, HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy` | N/A |
| Backup | chạy job backup | dump `pg_dump -Fc` + thư mục media được restic mã hoá đẩy lên kho; giữ 14 bản hằng ngày | lỗi bất kỳ → exit ≠ 0, không xoá bản cũ |
| Backup thiếu cấu hình | thiếu `RESTIC_REPOSITORY` hoặc `RESTIC_PASSWORD` | dừng ngay, báo tên biến | exit ≠ 0 |

</frozen-after-approval>

## Code Map

- `server/src/app/healthz.ts` -- `checkHealth(sql, timeoutMs)`, `HealthStatus`; thêm kiểm đĩa bằng `fs.statfs` (Node 24).
- `server/src/platform/config/index.ts` -- `EnvSchema` có `superRefine` cho production (ALLOWED_ORIGINS https, COOKIE_SECURE); thêm `PUBLIC_BASE_URL` (bắt buộc ở production), `META_APP_ID` (tuỳ chọn ở story này), `META_APP_ENV` (`test|live`), `HEALTH_DISK_PATH` (mặc định `/`).
- `server/scripts/migrate.ts` -- đã chạy được với `DATABASE_URL` có sẵn; service `migrate` gọi script này.
- `server/package.json` -- `start:api`, `start:worker`; `embedded-postgres` chỉ là devDependency, chỉ import động khi thiếu `DATABASE_URL` ngoài production.
- `web/index.html` -- tải font từ `fonts.googleapis.com` / `fonts.gstatic.com`: CSP phải cho phép. Ảnh mẫu trong `web/src/data/mock.ts` lấy từ `https://picsum.photos`: CSP `img-src` cho phép tạm (ghi chú bỏ khi hết dữ liệu mẫu).
- `.github/workflows/ci.yml` -- job `check` hiện có; thêm job mới, không sửa job cũ.
- `server/test/healthz.test.ts`, `server/test/config.test.ts` -- mở rộng.

## Tasks & Acceptance

**Execution:**
- [x] `server/src/app/healthz.ts` + `server/test/healthz.test.ts` -- thêm `disk: 'ok'|'full'|'unknown'`, ngưỡng 85%, hàm đo đĩa truyền vào được để test.
- [x] `server/src/platform/config/index.ts` + `server/.env.example` + `server/test/config.test.ts` -- biến mới và luật production theo ma trận.
- [x] `deploy/Dockerfile.server` -- Node 24 slim, `npm ci --omit=dev` cho workspace `server` + `packages/shared`, user không phải root; dùng chung cho api, worker, migrate (khác lệnh).
- [x] `deploy/Dockerfile.caddy` -- stage build `web` (`npm ci`, `npm run build -w web`) rồi `caddy:2` chép `dist` + `Caddyfile`.
- [x] `deploy/Caddyfile` -- site `{$SITE_ADDRESS}`; route theo ma trận; `/media/*` phục vụ từ volume, 404 khi không có; SPA fallback; header bảo mật; `reverse_proxy` api với `flush_interval -1`.
- [x] `deploy/docker-compose.yml` -- services `caddy`, `migrate`, `api`, `worker`, `postgres:18`, `backup`(profile `backup`); volume `pgdata`, `media`, `caddy_data`; `api`/`worker` `depends_on: migrate: condition: service_completed_successfully`; log driver `json-file` có `max-size`/`max-file`; healthcheck.
- [x] `deploy/backup/Dockerfile` + `deploy/backup/backup.sh` -- image `postgres:18` + `restic`; script theo ma trận (`set -euo pipefail`, `pg_dump -Fc`, `restic backup` dump + media, `restic forget --keep-daily 14 --prune`, `restic check` nhẹ).
- [x] `deploy/env.production.example` -- mọi biến production kèm chú thích; bí mật để trống.
- [x] `deploy/deploy.sh` -- tag = `git rev-parse --short HEAD` (hoặc `IMAGE_TAG`), build hai image, ghi tag vào `.env`, `docker compose up -d`, giữ 5 tag gần nhất; `deploy/rollback.sh <tag>`.
- [x] `deploy/runbook.md` -- cài lần đầu (DNS, firewall, `.env`, set-password qua `docker compose run`), deploy, rollback, xem log, cron backup + khôi phục, uptime ping ngoài gọi `/healthz` mỗi 5 phút, cất `APP_ENCRYPTION_KEYS` riêng.
- [x] `.github/workflows/ci.yml` -- job `deploy-smoke` (cần job `check`): `docker compose config`, build image, chạy stack với `SITE_ADDRESS=:80` và bí mật thử, gọi qua Caddy kiểm từng dòng route/header của ma trận, `docker compose down -v`.
- [x] `deploy/backup/test-backup.sh` -- chạy `backup.sh` với Postgres nhúng của dev và repo restic thư mục cục bộ nếu máy có `restic`; ngược lại job CI chạy nó trong container.

**Acceptance Criteria:**
- Given `npm run check`, when chạy ở gốc, then thoát 0 với test mới cho healthz đĩa và config production.
- Given CI job `deploy-smoke`, when chạy trên GitHub Actions, then mọi dòng route/header/SPA/media của ma trận đều được kiểm bằng `curl` qua Caddy và job xanh.
- Given `deploy/runbook.md`, when một người làm theo trên VPS mới, then có đủ bước từ DNS tới đăng nhập, sao lưu, khôi phục, rollback mà không cần đọc mã.

## Implementation Notes

- **Healthz:** `checkHealth(sql, { timeoutMs, diskPath, diskUsage })` (thay tham số `timeoutMs` vị trí); DB và đĩa đo song song, cùng timeout 2 giây. `measureDiskUsage` = `1 - bavail/blocks` qua `statfs`; > 0,85 → `full` (đúng 85% vẫn `ok`); lỗi/treo/NaN → `unknown`, không làm 503. `buildApp` nhận `health` (test truyền hàm đo giả), `main.ts` truyền `HEALTH_DISK_PATH`. Compose đặt `HEALTH_DISK_PATH=/data/media` (volume media, cùng đĩa với volume Postgres).
- **Config:** `PUBLIC_BASE_URL` phải là origin (không path, không `/` cuối); production bắt buộc https và phải nằm trong `ALLOWED_ORIGINS` (compose đặt `ALLOWED_ORIGINS=${PUBLIC_BASE_URL}`). `META_APP_ID` chỉ chữ số; production + `META_APP_ID` + `META_APP_ENV≠live` → lỗi `META_APP_ENV`. Chiều ngược (dev dùng app live) chưa chặn vì ma trận không yêu cầu. `HEALTH_DISK_PATH` phải tuyệt đối, mặc định `/`.
- **Compose:** mỗi service chỉ nhận biến nó cần qua `environment` nội suy từ `deploy/.env` (không `env_file` chung) — api/worker không thấy khoá kho backup, backup không thấy `APP_ENCRYPTION_KEYS`. Hai mạng: `edge` (caddy, api) và `backend` (api, worker, migrate, postgres, backup); không mạng nào `internal` vì api/worker/backup cần ra internet; chỉ caddy publish 80/443(+udp). Postgres 18 mount `/var/lib/postgresql` (PGDATA mới của image 18). Image `ottm-server` tạo `/data/media` chủ `node` để volume media nhận quyền đó ở lần mount đầu (api khởi động trước caddy). Healthcheck: postgres `pg_isready`, api (mọi phản hồi 200/503 = sống), caddy (admin API); worker không có healthcheck HTTP — `/healthz` phủ heartbeat. Thêm service `restore` (profile `restore`, cùng image backup, media ghi được) để runbook khôi phục bằng một lệnh.
- **Caddy:** snippet `security_headers` (CSP, HSTS, nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy, bỏ `Server`) áp cho site và `handle_errors` (404 /media vẫn có header, trả chữ thuần). `encode` chỉ ở handle SPA để SSE qua api không bị nén/gom. Không bật access log (URL OAuth/webhook có thể mang `code`, `hub.verify_token`). CSP cho phép Google Fonts và `picsum.photos` + `fastly.picsum.photos` (redirect), ghi chú bỏ khi hết dữ liệu mẫu. Image Caddy chạy `caddy validate` lúc build.
- **Backup:** `backup.sh` kiểm biến trước mọi việc, kiểm mở được kho (`restic cat config`; không tự `init` để URL gõ sai không lặng lẽ tạo kho mới), dump vào thư mục cố định `/var/tmp/ottm-backup` và `--host ottm` cố định để restic so bản/forget đúng nhóm, rồi `forget --keep-daily 14 --prune` và `restic check` (không đọc data). `restore.sh <snapshot> --yes` (thiếu `--yes` → từ chối): `pg_restore --clean --if-exists --single-transaction`, thay thư mục media; `RESTORE_DATABASE_URL`/`RESTORE_MEDIA_DIR` cho diễn tập. `test-backup.sh` dùng database tạm `ottm_bk_*` (không đụng DB thật) và kho restic thư mục tạm: thiếu biến, kho chưa init, backup đúng (dump + media, kho không chứa chữ rõ), keep-daily, pg_dump lỗi không xoá bản cũ, restore vào DB/thư mục khác. Máy dev hiện không có restic/pg_dump → SKIP; CI chạy trong container `ottm-backup`.
- **Deploy:** `deploy/lib.sh` (dùng chung): đọc/ghi `deploy/.env` bằng awk (không source), chờ `/healthz` 200 qua `docker compose exec api`, dọn image giữ 5 tag mới nhất + tag đang chạy cho `ottm-server`, `ottm-caddy`, `ottm-backup`. `deploy.sh` từ chối cây mã bẩn khi không đặt `IMAGE_TAG`. `rollback.sh` kiểm image tồn tại, `up --no-build`.
- **Smoke:** `deploy/smoke-test.sh <url>` kiểm từng dòng route/header/SPA/media của ma trận (thêm: login với Origin hợp lệ → 401 `INVALID_CREDENTIALS`, Origin lạ → 403, asset JS không rơi về index.html); dùng được sau deploy trên VPS. CI `deploy-smoke` (cần `check`): giải phóng đĩa runner, `docker compose config` + kiểm chỉ caddy publish cổng, build 3 image, `bash -n`, up, kiểm migrate exit 0, cổng 3000/5432 không mở trên máy chủ, smoke qua Caddy (`SMOKE_ALLOW_DISK_FULL=1`: chấp nhận 503 khi lý do duy nhất là đĩa runner >85%), `test-backup.sh` trong container, backup thiếu cấu hình → exit ≠ 0, `down -v`.
- **`.dockerignore`** ở gốc repo (build context của các Dockerfile là gốc): bỏ `node_modules`, `dist`, `.data`, `.env`, `_bmad*`, `.git`.
- **Kiểm local (không Docker):** `npm run check` xanh (healthz + config mới). `npm ci --omit=dev -w server -w packages/shared --os=linux --cpu=x64` và `npm ci -w web -w packages/shared && npm run build -w web` chạy thử trong thư mục tạm chỉ có các file mà Dockerfile COPY — cài đúng gói (có `@node-rs/argon2-linux-x64-gnu`, không có gói dev/web) và build web được. Chạy api/worker với env giống compose trên Postgres nhúng: `/healthz` 200 có `disk`, `smoke-test.sh` gọi thẳng api qua hết các dòng phía api; production + Meta Test App / thiếu `PUBLIC_BASE_URL` → exit 1 với tên biến. CSP của Caddyfile áp lên `web/dist` (server Node mô phỏng) trên trình duyệt: đăng nhập, đi qua mọi màn — không có vi phạm CSP, font Google tải được, ảnh picsum tải được, ảnh domain lạ bị chặn.
- **Sau review:** Caddy thêm `/api`, `/webhooks`, `/privacy` trần vào matcher api; lỗi do Caddy sinh trên đường api trả JSON `INTERNAL`; `/assets/*` không fallback, `immutable`; SPA `no-cache`; `/media` có CSP riêng `default-src 'none'; img-src 'self'; sandbox`. `wait_healthy` có `timeout`/`AbortSignal.timeout`, 503 chỉ vì đĩa đầy = qua kèm cảnh báo. `prune_images` tính một tập tag giữ (theo thứ tự ottm-server + tag đang chạy) cho mọi image, `KEEP_TAGS` phải nguyên dương. `deploy.sh`: kiểm cây mã gồm file chưa track, so host `SITE_ADDRESS`/`PUBLIC_BASE_URL`, sao lưu trước deploy (`SKIP_PREDEPLOY_BACKUP=1`, bỏ qua lần đầu), gợi ý rollback khi `up` lỗi, smoke qua `PUBLIC_BASE_URL` (hoặc `SMOKE_URL`). `smoke-test.sh`: kiểm đăng nhập chỉ khi `SMOKE_LOGIN=1` (nhận 401/429), curl có timeout. `restore.sh`: kiểm phiên api/worker, đĩa trống, đủ dump/media (`--db-only`) trước khi đụng gì; drop/create schema `public`/`drizzle`/`pgboss` + nạp dump trong một transaction psql; rsync `--delete-after` media sau DB; chown 1000. Image backup có rsync, compose `backup`/`restore` có `build` (context `deploy/`, `backup/Dockerfile.dockerignore` chỉ gửi hai script). `test-backup.sh` kiểm short_id không đổi khi backup lỗi, khôi phục đè DB đã "migrate xa hơn", snapshot thiếu media/`--db-only`. CI chạy deploy.sh ci-a/ci-b, rollback, prune, restore thiếu `--yes`, và khôi phục đè DB thật rồi `migrate` chạy lại được. Runbook: công thức đĩa của healthz so với `df`, dead-man ping bắt buộc, logrotate log backup.

- **Chưa xác minh (cần làm khi repo lên GitHub):** máy dev không có Docker/restic/rsync, nên image, Caddy, compose, `restore.sh`, `test-backup.sh`, `deploy.sh`/`rollback.sh` chỉ được kiểm bằng `bash -n` và đọc mã. Job CI `deploy-smoke` là bài kiểm thật đầu tiên; AC thứ hai chỉ coi là đạt khi job này xanh.

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind | CI `bash -n` chỉ kiểm file đầu tiên | medium | `ci.yml:87` truyền nhiều file cho một `bash -n`; patch |
| 2 | blind | SPA trả index.html cho asset băm bị thiếu; không có Cache-Control | medium | `try_files {path} /index.html` áp cả `/assets/*`; patch |
| 3 | blind | /media cùng origin, nằm trong `script-src 'self'` | medium | Caddyfile không có header riêng cho /media; patch |
| 4 | edge | `/api`, `/webhooks`, `/privacy` không có đoạn sau rơi vào SPA; lỗi Caddy trên api là text/plain | low | matcher dòng 21 chỉ có `/api/*`; sửa trực tiếp; patch |
| 5 | blind, edge | `wait_healthy` không có timeout; đĩa >85% làm deploy và rollback đều thất bại | medium | `lib.sh:43` exec/fetch không timeout, yêu cầu 200; patch |
| 6 | edge (claim) | Giữ tag theo từng image lệch nhau; KEEP_TAGS=0 xoá hết | medium | `lib.sh:55-71` sắp theo thời gian tạo mỗi image; patch |
| 7 | blind, edge | deploy.sh: up lỗi không gợi ý rollback; file untracked lọt vào image; không kiểm Caddy; không backup trước migration; SITE_ADDRESS lệch PUBLIC_BASE_URL | medium | `deploy.sh:12,27`; patch |
| 8 | blind, edge | smoke-test gửi mật khẩu sai lên production; curl không timeout | medium | `smoke-test.sh:90,95,28`; patch |
| 9 | blind, edge | restore.sh xoá media trước khi chép, cần 2× đĩa, `--clean` để lại bảng mới, chạy chồng khi api/worker còn chạy, snapshot thiếu media vẫn exit 0, volume mới thuộc root | high | `restore.sh:41-51` xác nhận thứ tự xoá-rồi-chép; patch |
| 10 | edge | restore/backup chỉ trỏ image theo tag, tag bị dọn thì không khôi phục được | medium | compose `restore.image` không có `build`; patch |
| 11 | vgap | Backup lỗi có thể thay bản tốt mà test vẫn qua | medium | vgap đã xác minh; patch |
| 12 | blind | Khôi phục chồng lên DB có dữ liệu chưa được test | medium | test chỉ restore vào DB rỗng; patch |
| 13 | vgap, blind | deploy.sh, rollback.sh, prune_images, service restore chưa từng chạy | medium | vgap đã xác minh; patch |
| 14 | blind | Tỉ lệ đĩa healthz khác `df`; lỗi backup im lặng; log cron không xoay | low | runbook; sửa tài liệu; patch |
| 15 | edge | test-backup lệch khi chạy qua nửa đêm UTC | low | gộp vào patch so short_id |
| 16 | blind | Image nền không pin minor/digest | low | pg_dump 18.x tương thích các minor 18; chưa kiểm tag tồn tại; reject |
| 17 | edge | test-backup hỏng khi DATABASE_URL có query string | low | chỉ chạy trong CI với URL cố định; reject |
| 18 | vgap | Đường `HEALTH_DISK_PATH` từ main.ts chưa có test | low | volume mặc định cùng đĩa host; reject |
| 19 | blind | Chưa kiểm SSE và không nén qua Caddy | low | chưa có route SSE (Story 1.4); reject, thêm khi có SSE |

## Design Notes

Đo đĩa không cần gói ngoài:

```ts
const s = await statfs(path) // node:fs/promises
const usedPct = 1 - s.bavail / s.blocks
```

Caddy: đặt `handle /media/*` trước `handle` SPA và dùng `file_server` không có `try_files` để file thiếu trả 404; SPA dùng `try_files {path} /index.html`.

## Verification

**Commands:**
- `npm run check` -- expected: exit 0
- `bash -n deploy/*.sh deploy/backup/*.sh` -- expected: không lỗi cú pháp
- Manual: job `deploy-smoke` xanh khi repo có trên GitHub (máy dev không có Docker nên không chạy được ở đây).
