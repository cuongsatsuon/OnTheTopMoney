#!/usr/bin/env bash
# Khôi phục từ restic: GHI ĐÈ database và thư mục media. Dừng api/worker trước (runbook.md).
#   restore.sh <snapshot-id|latest> --yes [--db-only]
#
# Thứ tự: kiểm mọi điều kiện (biến, không còn phiên api/worker trên DB đích, đủ đĩa, snapshot có dump và
# media) → khôi phục DB trong MỘT transaction (xoá rồi tạo lại schema public/drizzle/pgboss) → chỉ khi DB
# xong mới đồng bộ media (rsync --delete-after: file cũ chỉ bị xoá sau khi chép xong).
#
# Biến như backup.sh; thêm RESTORE_DATABASE_URL (mặc định DATABASE_URL) và RESTORE_MEDIA_DIR
# (mặc định MEDIA_DIR) để khôi phục sang chỗ khác (diễn tập khôi phục, test-backup.sh).
set -euo pipefail

log() { printf '%s restore: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "LỖI: $*"; exit 1; }

USAGE="cách dùng: restore.sh <snapshot-id|latest> --yes [--db-only]"
SNAPSHOT="${1:-}"
[[ -n "$SNAPSHOT" && "$SNAPSHOT" != --* ]] || die "$USAGE"
shift
CONFIRMED=0
DB_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRMED=1 ;;
    --db-only) DB_ONLY=1 ;;
    *) die "tham số lạ '$arg' — $USAGE" ;;
  esac
done
((CONFIRMED)) || die "khôi phục ghi đè DB và media — thêm --yes để xác nhận ($USAGE)"

TARGET_DB="${RESTORE_DATABASE_URL:-${DATABASE_URL:-}}"
missing=()
[[ -n "$TARGET_DB" ]] || missing+=("DATABASE_URL")
for var in RESTIC_REPOSITORY RESTIC_PASSWORD; do
  [[ -n "${!var:-}" ]] || missing+=("$var")
done
((${#missing[@]} == 0)) || die "thiếu biến ${missing[*]}"

MEDIA_DIR="${MEDIA_DIR:-/data/media}"
DEST_MEDIA="${RESTORE_MEDIA_DIR:-$MEDIA_DIR}"
STAGE_DIR="${BACKUP_STAGE_DIR:-/var/tmp/ottm-backup}"
HOST_TAG="${BACKUP_HOST:-ottm}"
MEDIA_UID="${MEDIA_UID:-1000}" # user `node` của image ottm-server
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

# 2. Đủ đĩa cho bản giải nén (+10%).
need_bytes="$(restic stats "$SNAPSHOT" --host "$HOST_TAG" --mode restore-size --json \
  | grep -o '"total_size":[0-9]*' | head -n1 | cut -d: -f2)" || die "không đọc được kích thước snapshot $SNAPSHOT"
[[ -n "$need_bytes" ]] || die "không đọc được kích thước snapshot $SNAPSHOT"
free_kb="$(df -Pk "$WORK" | awk 'NR == 2 { print $4 }')"
if ((free_kb * 1024 < need_bytes + need_bytes / 10)); then
  die "không đủ đĩa ở $WORK: cần ~$((need_bytes / 1048576)) MB (+10%), còn $((free_kb / 1024)) MB"
fi

# 3. Giải nén snapshot và kiểm đủ thành phần trước khi đụng vào DB/media.
log "restic restore $SNAPSHOT"
if ((DB_ONLY)); then
  restic restore "$SNAPSHOT" --host "$HOST_TAG" --target "$WORK" --include "$STAGE_DIR/postgres.dump"
else
  restic restore "$SNAPSHOT" --host "$HOST_TAG" --target "$WORK"
fi
DUMP="$WORK$STAGE_DIR/postgres.dump"
MEDIA_SRC="$WORK$MEDIA_DIR"
[[ -s "$DUMP" ]] || die "snapshot không có $STAGE_DIR/postgres.dump"
if ((!DB_ONLY)) && [[ ! -d "$MEDIA_SRC" ]]; then
  die "snapshot không có thư mục media $MEDIA_DIR — chưa đổi gì. Chỉ khôi phục DB: thêm --db-only"
fi

# 4. DB trong một transaction: xoá schema của app (kể cả bảng mới hơn snapshot) rồi nạp dump.
#    Lỗi bất kỳ → rollback, DB giữ nguyên như trước.
log "khôi phục DB (một transaction)"
{
  echo "drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade;"
  echo "create schema public;"
  pg_restore --no-owner --no-privileges --file=- "$DUMP"
} | psql "$TARGET_DB" -v ON_ERROR_STOP=1 --single-transaction -qX >/dev/null

# 5. Media chỉ sau khi DB xong.
if ((DB_ONLY)); then
  log "--db-only — giữ nguyên $DEST_MEDIA"
else
  log "đồng bộ media vào $DEST_MEDIA"
  mkdir -p "$DEST_MEDIA"
  rsync -a --delete-after "$MEDIA_SRC/" "$DEST_MEDIA/"
  if [[ "$(id -u)" == 0 ]]; then
    chown "$MEDIA_UID:$MEDIA_UID" "$DEST_MEDIA"
  fi
fi

log "xong — khởi động lại api/worker"
