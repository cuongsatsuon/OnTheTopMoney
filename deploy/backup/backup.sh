#!/usr/bin/env bash
# Sao lưu hằng đêm (AD-12, Structural Seed › Vận hành): pg_dump -Fc → restic (mã hoá phía máy, kho
# S3-compatible ở nhà cung cấp khác VPS), giữ 14 bản hằng ngày. Chỉ DB: ảnh/file nằm trên Cloudinary
# (AD-14) — dựa vào backup của Cloudinary (runbook.md mục Cloudinary).
# Lỗi bất kỳ → exit ≠ 0 và KHÔNG chạy forget/prune (bản cũ còn nguyên).
#
# Biến:
#   DATABASE_URL        bắt buộc — Postgres cần dump
#   RESTIC_REPOSITORY   bắt buộc — vd s3:s3.us-west-004.backblazeb2.com/ten-bucket/ottm
#   RESTIC_PASSWORD     bắt buộc — khoá mã hoá kho restic (cất riêng, mất là không khôi phục được)
#   BACKUP_STAGE_DIR    chỗ đặt file dump tạm (mặc định /var/tmp/ottm-backup) — giữ cố định để restic so bản
#   BACKUP_HOST         tên host ghi vào snapshot (mặc định ottm) — container mỗi lần một hostname
#   BACKUP_KEEP_DAILY   số bản hằng ngày giữ lại (mặc định 14)
set -euo pipefail

log() { printf '%s backup: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "LỖI: $*"; exit 1; }

missing=()
for var in DATABASE_URL RESTIC_REPOSITORY RESTIC_PASSWORD; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
((${#missing[@]} == 0)) || die "thiếu biến ${missing[*]}"

STAGE_DIR="${BACKUP_STAGE_DIR:-/var/tmp/ottm-backup}"
HOST_TAG="${BACKUP_HOST:-ottm}"
KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
[[ "$KEEP_DAILY" =~ ^[1-9][0-9]*$ ]] || die "BACKUP_KEEP_DAILY phải là số nguyên dương"
export RESTIC_REPOSITORY RESTIC_PASSWORD

if ! err="$(restic cat config 2>&1 >/dev/null)"; then
  log "$err"
  die "không mở được kho restic (sai RESTIC_REPOSITORY/RESTIC_PASSWORD/khoá truy cập, hoặc chưa init — xem runbook.md)"
fi

mkdir -p "$STAGE_DIR"
chmod 0700 "$STAGE_DIR"
cleanup() { rm -f "$STAGE_DIR/postgres.dump"; }
trap cleanup EXIT

log "pg_dump bắt đầu"
# --dbname nhận URL; lỗi pg_dump (kể cả dump dở) → set -e dừng trước khi restic chạm kho.
pg_dump --format=custom --no-owner --no-privileges \
  --dbname="$DATABASE_URL" --file="$STAGE_DIR/postgres.dump"
[[ -s "$STAGE_DIR/postgres.dump" ]] || die "file dump rỗng"
log "pg_dump xong ($(du -h "$STAGE_DIR/postgres.dump" | cut -f1))"

log "restic backup bắt đầu"
restic backup --host "$HOST_TAG" --tag ottm "$STAGE_DIR"

log "restic forget --keep-daily $KEEP_DAILY --prune"
restic forget --host "$HOST_TAG" --tag ottm --keep-daily "$KEEP_DAILY" --prune

log "restic check"
restic check

log "xong"
