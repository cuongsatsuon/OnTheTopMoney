---
title: 'Lưu media trên Cloudinary, bỏ lưu file trên máy chủ'
type: 'feature'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-3d-web-chay-trong-docker.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chưa có code lưu ảnh/file nào; hạ tầng hiện chỉ chuẩn bị lưu cục bộ (thư mục `MEDIA_DIR_HOST` bind mount vào api/worker, nginx phục vụ `/media`, backup restic gồm thư mục media). Chủ shop muốn dùng Cloudinary và bỏ hẳn lưu trên máy chủ.

**Approach:** Viết adapter `server/src/adapters/media/` với hai cổng theo AD-14 — `MediaStore` (công khai: ảnh bài đăng, logo; trả URL `https://res.cloudinary.com/...`) và `PrivateFileStore` (riêng tư: file kho kiến thức, đính kèm của khách; Cloudinary `type: authenticated`, chỉ server tải về qua API có chữ ký) — gọi Cloudinary bằng `fetch` (như adapter OpenAI, không SDK), cấu hình bằng `CLOUDINARY_URL`. Gỡ toàn bộ phần lưu media cục bộ khỏi compose, script deploy/backup, nginx, CI, runbook; CSP cho phép ảnh từ `res.cloudinary.com`.

[ASSUMPTION] File riêng tư cũng lên Cloudinary (chủ shop nói bỏ lưu local) dưới dạng `authenticated`, không có URL công khai dùng được. Backup restic chỉ còn DB; media dựa vào Cloudinary (runbook ghi rõ, gợi ý bật backup của Cloudinary).

## Boundaries & Constraints

**Always:** Adapter không biết nghiệp vụ, không log, trả lỗi đã phân loại (`ok:false, kind`) như adapter OpenAI; không bao giờ đưa api secret/chữ ký vào lỗi hay log (thêm khoá vào danh sách redact). `CLOUDINARY_URL` dạng `cloudinary://<api_key>:<api_secret>@<cloud_name>`, tuỳ chọn; thiếu → `createMediaStores` trả trạng thái chưa cấu hình và mọi thao tác trả `MEDIA_NOT_CONFIGURED` (thêm vào `ErrorCode` shared); sai định dạng → config lỗi khởi động (nêu tên biến, không giá trị). `CLOUDINARY_FOLDER` tuỳ chọn (mặc định `ottm`), public_id = `<folder>/<public|private>/<uuidv7>`. `MediaStore.put` nhận bytes + mime (jpeg/png/webp) và tuỳ chọn `asJpeg` (Cloudinary đổi sang JPEG khi upload, cho IG); trả `{publicId, url, width, height, bytes, format}`. `PrivateFileStore.put/get/delete` dùng `resource_type: raw` cho pdf/docx/txt và `image` cho ảnh, `type: authenticated`. Khởi động không gọi mạng. Có script `server/scripts/media-check.ts` (`npm run media:check -w server`, chạy được trong container api) thử upload ảnh nhỏ công khai + riêng tư, tải lại, xoá — để chủ shop kiểm cấu hình. `/healthz` đo đĩa ở `/` (không còn `/data/media`).

**Never:** Không thêm dependency SDK Cloudinary. Không xây tính năng dùng media (upload logo, ảnh bài, ảnh AI…) — chỉ adapter + hạ tầng. Không gọi Cloudinary trong `/healthz`. Không tự xoá thư mục media cũ trên VPS.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Upload công khai | jpeg/png/webp ≤ giới hạn | `url` https res.cloudinary.com, public_id trong `<folder>/public/` | |
| Upload IG | `asJpeg: true`, ảnh png | kết quả `format: jpg` | |
| Riêng tư | put pdf → get | bytes giống hệt; URL giao thường (không chữ ký) trả 401/404 | |
| Chưa cấu hình | không có `CLOUDINARY_URL` | `MEDIA_NOT_CONFIGURED`, không gọi mạng | |
| Sai khoá / bị chặn | Cloudinary 401/403 | `kind: AUTH_FAILED` | không retry |
| Lỗi tạm | 5xx, 429, hết giờ, lỗi mạng | `kind: TRANSIENT` (429 `RATE_LIMITED`) | caller quyết retry |
| Request sai | 400 (file hỏng, quá lớn) | `kind: INVALID_REQUEST` | |
| Xoá | delete id không tồn tại | ok (idempotent, `not found` coi như xong) | |
| Config sai | `CLOUDINARY_URL=abc` | không khởi động, nêu `CLOUDINARY_URL` | |

</frozen-after-approval>

## Code Map

- `server/src/adapters/openai/index.ts`, `fake.ts` -- mẫu adapter fetch + phân loại lỗi + server giả cho test; làm theo.
- `server/src/adapters/media/` (mới) -- `index.ts` (cổng, `createMediaStores(config, {fetch?, now?})`, ký tham số theo tài liệu Cloudinary: tham số sắp xếp + api_secret, SHA-1), `fake.ts` (Cloudinary giả cho test).
- `server/src/platform/config/index.ts` -- thêm `CLOUDINARY_URL` (parse thành cloudName/apiKey/apiSecret), `CLOUDINARY_FOLDER`; `HEALTH_DISK_PATH` mặc định `/`.
- `server/src/platform/log/index.ts` -- redact `CLOUDINARY_URL`, `api_secret`, `apiSecret`, `signature`.
- `packages/shared` -- `ErrorCode` thêm `MEDIA_NOT_CONFIGURED` (và mã lỗi media nếu cần, kèm câu tiếng Việt ở `web/src/lib/error-messages.ts` nếu ErrorCode yêu cầu đủ bản dịch).
- `.dependency-cruiser.*` -- adapter media chỉ được import từ module/app như các adapter khác.
- `deploy/docker-compose.yml` -- bỏ `x-media-rw/ro` và mount media khỏi api/worker/backup/restore; `HEALTH_DISK_PATH` bỏ (dùng mặc định); thêm `CLOUDINARY_URL`, `CLOUDINARY_FOLDER` vào `x-app-env`.
- `deploy/env.production.example` -- bỏ `MEDIA_DIR_HOST`; thêm nhóm Cloudinary (`CLOUDINARY_URL` lấy ở Cloudinary Console › API Keys; `CLOUDINARY_FOLDER`).
- `deploy/lib.sh` -- bỏ `media_dir_host`, phần media trong `require_host_dirs`/kiểm đường dẫn.
- `deploy/backup/{backup,restore,test-backup}.sh`, `deploy/backup/Dockerfile` -- chỉ DB; restore nhận cả snapshot cũ có media (bỏ qua media), bỏ cờ `--db-only` hoặc giữ như no-op có ghi chú.
- `deploy/nginx.conf.example`, `deploy/nginx-api.conf.example` -- bỏ `location /media/`, map CSP sandbox của media; CSP `img-src` thêm `https://res.cloudinary.com`. `deploy/hostinger/htaccess.template` -- `img-src` thêm `https://res.cloudinary.com`.
- `deploy/smoke-test.sh` -- bỏ kiểm `/media` (`SMOKE_MEDIA_FILE`).
- `.github/workflows/ci.yml` -- bỏ chuẩn bị/kiểm thư mục media, mount, `/media`; backup/restore test theo DB-only.
- `deploy/runbook.md` -- bỏ thư mục media ở 1.5; mục mới "Cloudinary" (tạo tài khoản, lấy `CLOUDINARY_URL`, chạy `media:check` trong container, bật backup của Cloudinary); sao lưu/khôi phục chỉ DB.
- `_bmad-output/planning-artifacts/.../ARCHITECTURE-SPINE.md` -- AD-14 + phần triển khai/backup theo Cloudinary.
- `server/.env.example` -- `CLOUDINARY_URL` (comment, dev dùng tài khoản/folder riêng).

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared` + `server/src/platform/config` + `log` -- ErrorCode, config, redact.
- [x] `server/src/adapters/media/index.ts`, `fake.ts` + `server/test/media-adapter.test.ts` -- cổng, ký, phân loại lỗi; test phủ mọi dòng matrix (dùng fake, không gọi mạng); test chữ ký khớp ví dụ trong tài liệu Cloudinary.
- [x] `server/scripts/media-check.ts` + script npm.
- [x] Hạ tầng deploy + nginx + htaccess + smoke + CI -- như Code Map.
- [x] `deploy/runbook.md`, `ARCHITECTURE-SPINE.md`, `server/.env.example`.

**Acceptance Criteria:**
- Given repo sau thay đổi, when grep `MEDIA_DIR_HOST|/data/media|location \^~ /media` ngoài spec cũ, then không còn.
- Given `CLOUDINARY_URL` thật trong `server/.env`, when `npm run media:check -w server`, then in ra URL công khai tải được và xác nhận file riêng tư không tải được bằng URL thường (chủ shop tự chạy; agent không có khoá thật).

## Verification

**Commands:**
- `npm run check` -- expected: lint, typecheck, depcruise, toàn bộ test qua.
- `bash -n deploy/*.sh deploy/backup/*.sh deploy/hostinger/*.sh`; YAML hợp lệ (`ruby -ryaml`).

## Implementation Notes

- **Config**: `CLOUDINARY_URL` parse bằng regex `cloudinary://<key>:<secret>@<cloud>` → `CloudinaryCredentials` đóng băng, `toJSON` che `apiSecret`; lỗi chỉ nêu dạng mong đợi. `CLOUDINARY_FOLDER` mặc định `ottm` (đoạn `[A-Za-z0-9_-]` ngăn `/`). `parseMediaEnv()` (cùng luật, không đòi `DATABASE_URL`) cho `media:check`. `HEALTH_DISK_PATH` vốn mặc định `/`; compose bỏ biến này. Redact thêm `CLOUDINARY_URL`, `api_secret`, `apiSecret`, `signature` (cả query param `signature`, `api_secret`).
- **Adapter** (`server/src/adapters/media/index.ts`): `createMediaStores(config, {fetch, now, apiBaseUrl, timeoutMs, uploadTimeoutMs})` → `{configured, publicStore, privateStore}`. Upload multipart `POST /v1_1/<cloud>/<image|raw>/upload` (ký: bỏ file/cloud_name/resource_type/api_key và rỗng, sort, `+secret`, SHA-1); `asJpeg` → tham số `format=jpg`; private `type=authenticated`, không trả `secure_url`; `get` = `GET …/download?…` có chữ ký; `delete` = `destroy` (`invalidate=true`), `not found`/404 → ok. Lỗi: 401/403 `AUTH_FAILED`, 420/429 `RATE_LIMITED`, 400/413/422 `INVALID_REQUEST`, 404 `NOT_FOUND`, còn lại/mạng/hết giờ/body hỏng `TRANSIENT`. Kiểm trước khi gửi: MIME ngoài allowlist, rỗng, > 10 MB [ASSUMPTION: giới hạn gói Free] → `INVALID_REQUEST`. Lỗi không mang message của Cloudinary (message 401 của Cloudinary có chuỗi đã ký).
- **Fake** (`fake.ts`): `fetch` trong bộ nhớ, kiểm api_key + chữ ký như Cloudinary, nhận dạng ảnh theo magic bytes (ảnh hỏng → 400), phục vụ cả URL giao `res.cloudinary.com` (authenticated không chữ ký → 401), `failNext(status | 'network' | 'hang' | 'bad-json')`.
- **media:check**: lõi ở `server/scripts/lib/media-check.ts` (test được với fake), CLI `server/scripts/media-check.ts`, `npm run media:check -w server` / trong container `docker compose exec api npm run media:check`. PNG→JPEG công khai + tải URL; txt (raw) và png riêng tư → get so bytes; URL thường `…/authenticated/…` và `…/upload/…` phải ≠ 2xx; xoá mỗi thứ hai lần (idempotent), dọn cả khi lỗi giữa chừng.
- **depcruise**: luật `ad14-media-adapter-callers` (chỉ `modules/`, `app/`, `worker/` import `adapters/media`), fixture vi phạm `platform/uses-media.ts`.
- **Hạ tầng**: compose bỏ `x-media-rw/ro`, mount, `MEDIA_DIR`, `HEALTH_DISK_PATH`; thêm `CLOUDINARY_URL`, `CLOUDINARY_FOLDER` vào `x-app-env` (backup/restore không nhận). `lib.sh` bỏ `media_dir_host`, `require_host_dirs`, `require_traversable_parents`, `check_abs_dir_path`, `file_*` (không còn dùng); deploy/rollback bỏ lời gọi. Backup chỉ dump; restore luôn `--include` file dump (snapshot cũ có media vẫn khôi phục được), `--db-only` giữ như no-op; image backup bỏ `rsync`; Dockerfile.server bỏ `/data/media`. nginx (cả hai mẫu): bỏ `location ^~ /media/`, bỏ map CSP (CSP đặt thẳng ở `add_header`), `img-src` + `https://res.cloudinary.com` (mẫu cùng VPS; host api vẫn `default-src 'none'`); htaccess `img-src` + Cloudinary (giữ origin api ngay sau `blob:` cho `check-htaccess.sh`). smoke-test bỏ `/media`. CI: bỏ thư mục/mount/smoke media, kiểm không còn mount media, env CLOUDINARY_* đúng service, mẫu nginx không còn `/media`/`alias`, CSP có Cloudinary, `media:check` chạy được trong container api (thiếu khoá → exit 1).
- **Docs**: runbook 1.5 thành "Cloudinary (ảnh và file)" (tạo tài khoản, `CLOUDINARY_URL`, `media:check`, bật backup Cloudinary), 1.11 không chép media, 1.13 mới (chuyển từ media trên máy chủ: sửa `.env`, site nginx, tự xoá thư mục cũ), 4.2–4.4 chỉ DB, mục 5/7/8 bỏ media. ARCHITECTURE-SPINE: AD-14, AD-19 (bỏ `/media/*` công khai), sơ đồ container, Triển khai/Vận hành, bảng phiên bản, cây thư mục.
- **Đã kiểm local**: `npm run check` exit 0 (server 603 test, web 105); `bash -n` mọi script và từng khối `run:` của `ci.yml`; YAML ci + compose parse được; grep AC không còn kết quả; `media:check` CLI: thiếu khoá → exit 1, `CLOUDINARY_URL=abc` → lỗi nêu tên biến không chép giá trị, khoá giả với Cloudinary thật → `AUTH_FAILED (HTTP 401)` (xác nhận endpoint + phân loại thật).
- **Chưa xác minh**: vòng `media:check` với tài khoản Cloudinary thật (chủ shop chạy — AC 2), đặc biệt API `download` cho `authenticated` image/raw và việc Cloudinary giữ nguyên bytes ảnh riêng tư; `test-backup.sh` (máy không có restic/pg_dump — CI chạy); job deploy-smoke (không có Docker local).

## Spec Change Log

## Review Triage Log

### Lượt 1 (blind / edge / verification-gap)

| # | Nguồn | Phát hiện | Verdict | Bằng chứng | Route |
|---|-------|-----------|---------|------------|-------|
| 1 | VG, edge | `lib.sh` mất `api_host_port`, `web_host_port`, `check_host_ports`, `require_env_file` (xoá lẫn khi gỡ hàm media) — deploy.sh/rollback.sh chết ngay | high | `grep` cây thật: không còn định nghĩa; baseline có ở dòng 147–197 | patch |
| 2 | edge, VG | Test âm trong CI chỉ kiểm exit ≠ 0, nên qua cả khi script chết vì thiếu hàm | medium | `ci.yml` ~198, 445, 452, 458 | patch |
| 3 | blind | Adapter chưa được dựng trong app/worker; `CLOUDINARY_URL` chưa ai đọc ngoài script kiểm | false | Intent: chỉ adapter + hạ tầng, tính năng dùng media thuộc Epic 3 | reject |
| 4 | blind | Các `MediaErrorKind` chưa có `ErrorCode`/câu cho người dùng, chưa có hàm ánh xạ | medium | Chỉ có `MEDIA_NOT_CONFIGURED` | defer |
| 5 | blind, edge | Kiểm "kho restic đã mã hoá" trong `test-backup.sh` không thể lỗi (dump `-Fc` đã nén) | medium | Marker chỉ nằm trong dump nén | patch |
| 6 | blind | smoke-test không kiểm CSP `img-src` thật có `res.cloudinary.com` (site nginx cũ chưa sửa vẫn qua) | medium | Chỉ CI grep mẫu | patch |
| 7 | blind | `img-src https://res.cloudinary.com` cho phép mọi tài khoản Cloudinary | low | Chỉ là nguồn ảnh; siết theo cloud name cần thêm biến ở nginx và build web | reject |
| 8 | blind, edge | `restore.sh` kiểm đĩa theo cả snapshot (gồm media cũ) dù chỉ giải nén dump | medium | `restic stats --mode restore-size` | patch |
| 9 | blind | Runbook 1.13 chưa nói thời hạn giữ media cũ trong snapshot | low | Chưa tính năng nào ghi media | reject |
| 10 | blind | Không có cách dọn file mồ côi trên Cloudinary | medium | Adapter không có liệt kê theo prefix | defer |
| 11 | blind | Fake ký bằng chính `signParams`; chưa có test với Cloudinary thật | medium | Chỉ vector ví dụ trong tài liệu | defer |
| 12 | blind | Regex `CLOUDINARY_URL` từ chối dạng có query (`?secure_distribution=…`) → api không khởi động | medium | `CLOUDINARY_URL_RE` neo `$` sau cloud name | patch |
| 13 | blind | `apiSecret` vẫn enumerable (lộ qua `console.log`) | low | Giống các secret config khác; log dùng pino redact | reject |
| 14 | blind | Câu lỗi web nêu tên biến môi trường cho người dùng | low | `error-messages.ts` | patch |
| 15 | blind | Chưa ghi chú video / `media-src` | low | Chưa có tính năng video | reject |
| 16 | blind | Runbook chưa nhắc chọn vùng dữ liệu / chuyển dữ liệu cá nhân ra nước ngoài | low | Runbook 1.5 bước 5 | patch |
| 17 | VG | `redactUrl` với `signature`/`api_secret` không có test | medium | `log.test.ts` không có ca này | patch |
| 18 | edge | Upload đã tới Cloudinary nhưng client lỗi sau đó → file mồ côi | low | Hiếm; gộp với #10 | reject |
| 19 | edge | `asJpeg` nhưng Cloudinary trả định dạng khác jpg vẫn coi là ok | low | Không kiểm `format` | patch |
| 20 | edge | Tài khoản dùng CDN riêng (host khác `res.cloudinary.com`) bị CSP chặn | low | Tài khoản thường dùng `res.cloudinary.com` | reject |
| 21 | edge | `media-check` coi 3xx là "đã chặn" | low | `redirect: 'manual'` | patch |
| 22 | edge | Rollback về tag trước thay đổi: image backup cũ đòi thư mục media | low | Chưa deploy tag nào giữa hai mốc | reject |
| 23 | edge | `/media/*` giờ rơi vào SPA (200 HTML) | low | Không còn gì dùng `/media` | reject |
