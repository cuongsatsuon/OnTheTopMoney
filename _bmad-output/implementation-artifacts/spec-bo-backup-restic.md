---
title: 'Bỏ hệ thống backup restic'
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

**Problem:** Chủ shop không dùng restic/kho S3 (Backblaze B2) và muốn bỏ hẳn khỏi hệ thống: biến `RESTIC_REPOSITORY`, `RESTIC_PASSWORD`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION` cùng mọi thứ phục vụ chúng.

**Approach:** Xoá thư mục `deploy/backup/` (Dockerfile, backup.sh, restore.sh, test-backup.sh, dockerignore), service `backup`/`restore` và image `ottm-backup` khỏi compose, các biến trên khỏi env mẫu, các bước backup trong CI, và mọi phần runbook/spine nói về restic, cron backup, dead-man ping backup, khôi phục từ restic. Runbook chỉ giữ một mục ngắn "Sao lưu tay (tuỳ chọn)": lệnh `pg_dump` qua `docker compose exec postgres` ra file và lệnh khôi phục tương ứng, kèm cảnh báo rõ rằng hệ thống không còn backup tự động.

## Boundaries & Constraints

**Always:** Giữ nguyên code app, các service còn lại (migrate, api, worker, postgres, web), mẫu nginx, `deploy/hostinger/*`. CI job `deploy-config` vẫn chạy phần không liên quan backup (compose config, nginx -t, build image, media check). Runbook đánh lại số mục cho liền mạch và sửa mọi tham chiếu chéo (vd "mục 4.2"). Kiểm compose: không service nào còn nhắc `ottm-backup`, profile `backup`/`restore`.

**Never:** Không thêm công cụ backup thay thế. Không đổi code `server/src`, `web/src`. Không sửa spec cũ trong `_bmad-output/implementation-artifacts/` (trừ spec này).

</frozen-after-approval>

## Code Map

- `deploy/backup/` -- xoá cả thư mục.
- `deploy/docker-compose.yml` -- bỏ service `backup`, `restore`, anchor/biến chỉ chúng dùng; comment đầu file.
- `deploy/env.production.example` -- bỏ nhóm "Sao lưu"; đánh lại số nhóm.
- `.github/workflows/ci.yml` (job `deploy-config`) -- bỏ build `ottm-backup`, `test-backup.sh`, ca "backup không cấu hình", "restore không --yes", `bash -n deploy/backup/*`, khởi động Postgres nếu chỉ phục vụ backup test.
- `deploy/runbook.md` -- 1.4 (bảng biến, "cất riêng"), 1.9 (khởi tạo kho + cron) → bỏ; mục 2 (bước "sao lưu trước") → thay bằng "nên `pg_dump` tay trước bản có migration" trỏ mục sao lưu tay; mục 3, 4.x, 5, 7, 1.11–1.13, Cloudinary (câu "backup chỉ DB") và mọi chỗ nhắc `ottm-backup`/restic/B2.
- `_bmad-output/planning-artifacts/.../ARCHITECTURE-SPINE.md` -- phần backup/vận hành (RPO, `platform.backup`, sơ đồ kho backup) cập nhật: không backup tự động.
- `.dockerignore`, `.gitignore` -- bỏ mục chỉ dành cho backup nếu có.

## Tasks & Acceptance

**Execution:**
- [x] Xoá `deploy/backup/`; sửa compose, env mẫu, CI.
- [x] Runbook + spine như Code Map.

**Acceptance Criteria:**
- Given repo sau thay đổi, when grep `restic|RESTIC_|AWS_ACCESS|AWS_SECRET|AWS_DEFAULT|ottm-backup|backblaze|test-backup` ngoài `_bmad-output/implementation-artifacts`, then không còn.
- Given `deploy/.env` từ mẫu, when `docker compose config`, then hợp lệ và không có service `backup`/`restore`.

## Verification

**Commands:**
- `npm run check` -- expected: qua.
- `ruby -ryaml` cho ci.yml và compose; `bash -n deploy/hostinger/*.sh` -- expected: hợp lệ.

## Implementation Notes

- Xoá `deploy/backup/` (Dockerfile, dockerignore, backup.sh, restore.sh, test-backup.sh). Compose: bỏ service `backup`, `restore` (anchor `backup-build`, `backup-env`), volume `restic_cache`; comment đầu file (không backup tự động, trỏ runbook mục 4) và comment mạng. `.dockerignore`/`.gitignore` không có mục riêng cho backup.
- `env.production.example`: bỏ nhóm "Sao lưu DB", đánh lại số nhóm (5 = tag image, 6 = Hostinger) và tham chiếu "mục 6"; câu `APP_ENCRYPTION_KEYS`/Cloudinary không còn nhắc backup.
- CI `deploy-config`: bỏ profile backup/restore khỏi mọi lệnh compose, build chỉ `--profile web`, bỏ `bash -n backup/*`, test-backup, hai ca backup/restore và bước khởi động Postgres; kiểm thêm: bật mọi profile vẫn chỉ đúng `api migrate postgres web worker`, image chỉ ottm-server/ottm-web/postgres, profile duy nhất `web`, volume duy nhất `pgdata`; số image ottm-* khi không có tag = 4.
- Runbook: cảnh báo "Không có backup tự động" ở phần đầu và mục 4; bỏ bucket ở 1.1, biến kho ở 1.4 (+ mục "cất riêng"), 1.9 cũ (kho + cron + dead-man ping + logrotate) → đánh lại 1.10–1.13 thành 1.9–1.12 và sửa tham chiếu (mục 1.9 uptime, 1.11 mốc web-trong-Docker); mục 2 bước 2 → "nên `pg_dump` tay (mục 4.1)"; mục 3; mục 4 thành "Sao lưu tay (tuỳ chọn)": 4.1 `docker compose exec -T postgres pg_dump -Fc` ra `~/ottm-dumps` + chép ra ngoài VPS, 4.2 khôi phục (stop api worker → drop schema public/drizzle/pgboss → `pg_restore --single-transaction` → `up -d`), sang VPS mới; mục 5, 7, 8; Cloudinary bước 4.
- Spine: AD-12 (Binds/Prevents/Rule), AD-22 (Binds, retention: không backup tự động), bỏ cron `platform.backup`, bỏ node Backup khỏi sơ đồ, Triển khai/Vận hành (RPO = lần `pg_dump` tay gần nhất), cây `deploy/`.
- Đã kiểm local: grep AC không còn kết quả; YAML ci + compose (services `migrate, api, worker, web, postgres`, volume `pgdata`); `bash -n` hostinger và từng khối `run:` của ci.yml; `npm run check` exit 0 (server 606, web 105). Chưa chạy (không Docker local): `docker compose config` thật, job `deploy-config`, các lệnh `pg_dump`/`pg_restore` của runbook.

## Spec Change Log

## Review Triage Log
