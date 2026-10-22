#!/usr/bin/env bash
# Khôi phục từ restic: GHI ĐÈ database. Dừng api/worker trước (runbook.md).
#   restore.sh <snapshot-id|latest> --yes
#
# Chỉ DB: ảnh/file nằm trên Cloudinary (AD-14), không nằm trong backup. Snapshot cũ (trước khi chuyển sang
# Cloudinary) có cả thư mục media — chỉ lấy file dump, bỏ qua media. `--db-only` vẫn được nhận (không còn
# tác dụng) để lệnh cũ trong ghi chép không hỏng.
#
# Thứ tự: kiểm mọi điều kiện (biến, không còn phiên api/worker trên DB đích, đủ đĩa, snapshot có dump) →
# khôi phục DB trong MỘT transaction (xoá rồi tạo lại schema public/drizzle/pgboss).
#
# Biến như backup.sh; thêm RESTORE_DATABASE_URL (mặc định DATABASE_URL) để khôi phục sang chỗ khác
# (diễn tập khôi phục, test-backup.sh).
set -euo pipefail

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "LỖI: $*"; exit 1; }

USAGE="cách dùng: restore.sh <snapshot-id|latest> --yes"
SNAPSHOT="${1:-}"
[[ -n "$SNAPSHOT" && "$SNAPSHOT" != --* ]] || die "$USAGE"
shift
CONFIRMED=0
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=1 ;;
    --db-only) ;; # không còn tác dụng: luôn chỉ khôi phục DB
    *) die "tham số lạ '$arg' — $USAGE" ;;
  esac
done
((CONFIRMED)) || die "khôi phục ghi đè DB — thêm --yes để xác nhận ($USAGE)"

TARGET_DB="${RESTORE_DATABASE_URL:-${DATABASE_URL:-}}"
missing=()
[[ -n "$TARGET_DB" ]] || missing+=("DATABASE_URL")
for var in RESTIC_REPOSITORY RESTIC_PASSWORD; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
((${#missing[@]} == 0)) || die "thiếu biến ${missing[*]}"

STAGE_DIR="${BACKUP_STAGE_DIR:-/var/tmp/ottm-backup}"
HOST_TAG="${BACKUP_HOST:-ottm}"
export RESTIC_REPOSITORY RESTIC_PASSWORD
export PGAPPNAME=ottm-restore

# 1. Không chạy song song api/worker trên DB đích.
busy="$(psql "$TARGET_DB" -v ON_ERROR_STOP=1 -qtAX -c "
  select string_agg(distinct application_name, ', ') from pg_stat_activity
  where datname = current_database() and pid <> pg_backend_pid()
    and application_name in ('ottm-api', 'ottm-worker', 'ottm-worker-boss')")" \
  || die "không kết nối được DB đích"
[[ -z "$busy" ]] || die "DB đích còn phiên của: $busy — chạy 'docker compose stop api worker' trước"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ottm-restore.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 2. Đủ đĩa cho file dump sẽ giải nén (+10%). Tính theo kích thước entry postgres.dump trong snapshot (không phải cả
#    snapshot: snapshot cũ còn thư mục media lớn mà ta không giải nén). `restic ls --json` in mỗi node một dòng JSON.
need_bytes="$(restic ls --json "$SNAPSHOT" --host "$HOST_TAG" "$STAGE_DIR" \
  | grep -F "\"path\":\"$STAGE_DIR/postgres.dump\"" | grep -o '"size":[0-9]*' | head -n1 | cut -d: -f2)" \
  || die "snapshot $SNAPSHOT không có $STAGE_DIR/postgres.dump (hoặc không đọc được snapshot)"
[[ -n "$need_bytes" ]] || die "không đọc được kích thước $STAGE_DIR/postgres.dump trong snapshot $SNAPSHOT"
free_kb="$(df -Pk "$WORK" | awk 'NR == 2 { print $4 }')"
if ((free_kb * 1024 < need_bytes + need_bytes / 10)); then
  die "không đủ đĩa ở $WORK: cần ~$((need_bytes / 1048576)) MB (+10%), còn $((free_kb / 1024)) MB"
fi

# 3. Chỉ giải nén file dump (snapshot cũ có thư mục media: bỏ qua) và kiểm trước khi đụng vào DB.
log "restic restore $SNAPSHOT (chỉ DB)"
restic restore "$SNAPSHOT" --host "$HOST_TAG" --target "$WORK" --include "$STAGE_DIR/postgres.dump"
DUMP="$WORK$STAGE_DIR/postgres.dump"
[[ -s "$DUMP" ]] || die "snapshot không có $STAGE_DIR/postgres.dump"

# 4. DB trong một transaction: xoá schema của app (kể cả bảng mới hơn snapshot) rồi nạp dump.
#    Lỗi bất kỳ → rollback, DB giữ nguyên như trước.
log "khôi phục DB (một transaction)"
{
  echo "drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade;"
  echo "create schema public;"
  pg_restore --no-owner --no-privileges --file=- "$DUMP"
} | psql "$TARGET_DB" -v ON_ERROR_STOP=1 --single-transaction -qX >/dev/null

log "xong — khởi động lại api/worker"
