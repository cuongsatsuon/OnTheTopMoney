---
title: 'Bỏ script deploy — triển khai thủ công bằng docker compose'
type: 'refactor'
created: '2026-10-22'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'NO_VCS'
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Chủ shop deploy thủ công bằng `docker compose up -d --build` và chọn xoá hẳn `deploy.sh`, `rollback.sh`, `smoke-test.sh`, `lib.sh` cùng job CI `deploy-smoke`.

**Approach:** Xoá bốn script và job CI đó; cho compose chạy được không cần script (`IMAGE_TAG` mặc định `latest`, bỏ `WEB_MODE` — chế độ web chỉ do `COMPOSE_PROFILES`: `web` = web chạy trên VPS, trống = web ở Hostinger); viết lại runbook theo lệnh thủ công, gồm các bước script từng tự làm (kiểm cổng bận, backup trước khi lên bản có migration, kiểm `/healthz` + mở web, rollback bằng tag).

## Boundaries & Constraints

**Always:** Giữ nguyên: `docker-compose.yml` (trừ mặc định `IMAGE_TAG` và comment), `Dockerfile.*`, `web-nginx.conf`, mẫu nginx, `deploy/backup/*` (backup/restore chạy bằng `docker compose run`), `deploy/hostinger/*` (publish web lên Hostinger, check-htaccess). CI giữ job `check`; thay `deploy-smoke` bằng job nhỏ `deploy-config` (không dùng script đã xoá): `docker compose config` (profile web/không web), `nginx -t` hai mẫu nginx, build image và `test-backup.sh` nếu job cũ có chạy nó — chỉ giữ phần không phụ thuộc script đã xoá. Runbook nêu rõ: build lại cùng tag ghi đè image cũ → muốn rollback thì đặt tag mới mỗi lần (vd `IMAGE_TAG=v3 docker compose up -d --build`), rollback = sửa `IMAGE_TAG` về tag cũ rồi `docker compose up -d` (không `--build`). Kiểm cổng bận bằng `ss -ltnp` trước lần đầu / khi đổi cổng. `.gitignore` bỏ `deploy/.deploy.lock`.

**Never:** Không đổi code app (`server/src`, `web/src`). Không xoá `deploy/hostinger/*`, `deploy/backup/*`. Không sửa spec cũ trong `_bmad-output/implementation-artifacts/` (trừ spec này).

</frozen-after-approval>

## Code Map

- `deploy/deploy.sh`, `deploy/rollback.sh`, `deploy/smoke-test.sh`, `deploy/lib.sh` -- xoá.
- `deploy/docker-compose.yml` -- `${IMAGE_TAG:?…}` → `${IMAGE_TAG:-latest}` cho ottm-server/ottm-web/ottm-backup; comment đầu file theo cách chạy tay.
- `deploy/env.production.example` -- bỏ `WEB_MODE`; `COMPOSE_PROFILES` giải thích hai chế độ; `IMAGE_TAG=latest` kèm cách đặt tag để rollback.
- `deploy/Dockerfile.web`, `deploy/web-nginx.conf`, `deploy/nginx*.example`, `deploy/hostinger/*` -- chỉ sửa comment còn nhắc script đã xoá hoặc `WEB_MODE`.
- `deploy/runbook.md` -- 1.7 (deploy lần đầu), 2 (bản mới: backup → `IMAGE_TAG=<mới> docker compose up -d --build` → kiểm `/healthz`, mở web), 3 (rollback), 7 (tóm tắt lệnh), 8 (Hostinger: `COMPOSE_PROFILES=` thay `WEB_MODE=external`), 1.11–1.13 (lệnh tay thay script); mọi chỗ nhắc `deploy.sh`/`rollback.sh`/`smoke-test.sh`/`WEB_MODE`.
- `.github/workflows/ci.yml` -- như Boundaries.
- `.gitignore`; `_bmad-output/planning-artifacts/.../ARCHITECTURE-SPINE.md` (phần triển khai).

## Tasks & Acceptance

**Execution:**
- [x] Xoá 4 script; sửa compose, env example, comment các file deploy.
- [x] Viết lại runbook như Code Map.
- [x] CI: bỏ `deploy-smoke`, thêm `deploy-config` như Boundaries.
- [x] Spine, `.gitignore`.

**Acceptance Criteria:**
- Given repo sau thay đổi, when grep `deploy\.sh|rollback\.sh|smoke-test\.sh|lib\.sh|WEB_MODE` ngoài `_bmad-output/implementation-artifacts`, then không còn (trừ tên `publish-web-hostinger.sh`, `check-htaccess.sh`, `test-backup.sh` hợp lệ).
- Given `deploy/.env` tạo từ mẫu và điền 4 biến bắt buộc, when `docker compose up -d --build` trong `deploy/`, then compose không đòi `IMAGE_TAG` và chạy cả web (COMPOSE_PROFILES=web).

## Verification

**Commands:**
- `npm run check` -- expected: qua.
- `bash -n deploy/backup/*.sh deploy/hostinger/*.sh`; `ruby -ryaml` cho ci.yml và compose -- expected: hợp lệ.

## Implementation Notes

- Xoá `deploy/{deploy,rollback,smoke-test,lib}.sh`. Compose: `${IMAGE_TAG:-latest}` cho cả 6 service dùng image ottm-*; comment đầu file theo lệnh tay (khuyên ghi tag vào `.env` — `IMAGE_TAG=v3 docker compose …` một lần thì lệnh sau không kèm biến quay về tag trong `.env`). `env.production.example`: bỏ `WEB_MODE`, `COMPOSE_PROFILES` giải thích hai chế độ, `IMAGE_TAG=latest` + cách đặt tag/rollback. Comment ở `Dockerfile.{server,web}`, `web-nginx.conf`, hai mẫu nginx, `htaccess.template`, `test-backup.sh` (tên job CI) không còn nhắc script/`WEB_MODE`. `.gitignore` bỏ `deploy/.deploy.lock`.
- Runbook: phần đầu (lệnh tay, quy tắc tag), 1.4 (bảng: `COMPOSE_PROFILES`, `IMAGE_TAG`), 1.6, 1.7 (kiểm cổng `ss -ltnp`, đặt tag = git SHA, `up -d --build`, `ps`, `/healthz` api/web qua 127.0.0.1 và qua tên miền, header, mở web/deep link), 1.11–1.13, 2 (ghi tag cũ → backup → tag mới vào `.env` → `up -d --build` → kiểm; build lỗi/migrate lỗi; dọn image tay), 3 (sửa `IMAGE_TAG` về tag cũ, `up -d` không `--build`; thiếu image thì compose build từ mã đang checkout; image web kiểu cũ), 4.3, 5, 7, 8 (`COMPOSE_PROFILES=` thay chế độ external; container web cũ dọn bằng `docker compose --profile web rm -sf web`; 8.5 kiểm host api bằng curl: healthz, JSON 404, preflight CORS).
- CI: bỏ `deploy-smoke`, thêm `deploy-config` (needs check): tạo `.env` thử bằng sed; `docker compose config` (IMAGE_TAG vắng → mọi image ottm-* `:latest`; COMPOSE_PROFILES=web có/không web; cổng loopback, web không root/chỉ đọc/cap_drop/tmpfs/mạng; không mount media; env CLOUDINARY_*); `bash -n` backup/hostinger; `nginx -t` hai mẫu (riêng và song song; không `/media`, CSP có Cloudinary); build image (`--profile web --profile backup build`); `media:check` qua `docker compose run --no-deps api` (thiếu khoá → exit 1); `up -d --wait postgres` rồi `test-backup.sh`, backup thiếu cấu hình, restore thiếu `--yes`. Bỏ phần cần stack chạy + script (smoke qua nginx, deploy/rollback/prune, 413/502, khôi phục đè DB rồi smoke).
- Đã kiểm local: grep AC không còn kết quả; `bash -n` backup/hostinger và từng khối `run:` của `ci.yml`; YAML ci + compose; `npm run check` exit 0 (server 606, web 105). Chưa chạy (không Docker local): `docker compose config/up` thật, job `deploy-config`.

## Spec Change Log

## Review Triage Log
