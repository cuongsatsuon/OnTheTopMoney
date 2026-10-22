#!/usr/bin/env bash
# Kiểm backup.sh + restore.sh với Postgres thật và kho restic là thư mục cục bộ (không cần cloud).
#   Máy dev:  npm run db:dev  (Postgres nhúng :5433), rồi  bash deploy/backup/test-backup.sh
#             — cần restic, pg_dump, pg_restore, psql, rsync trong PATH; thiếu thì báo SKIP.
#   CI:       chạy trong container ottm-backup (job deploy-smoke), DATABASE_URL trỏ postgres của compose.
# Chỉ tạo/xoá database tạm ottm_bk_*; không đụng database trong DATABASE_URL.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKUP_SH="$HERE/backup.sh"
RESTORE_SH="$HERE/restore.sh"

for bin in restic pg_dump pg_restore psql rsync; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "SKIP test-backup: thiếu $bin (CI chạy test này trong container ottm-backup)"
    exit 0
  fi
done

BASE_URL="${DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:5433/ottm}"
SERVER_URL="${BASE_URL%/*}" # bỏ tên database
SUFFIX="$$_$RANDOM"
SRC_DB="ottm_bk_src_$SUFFIX"
DST_DB="ottm_bk_dst_$SUFFIX"
POP_DB="ottm_bk_pop_$SUFFIX"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ottm-test-backup.XXXXXX")"
failures=0
pass() { echo "ok   - $*"; }
fail() { echo "FAIL - $*"; failures=$((failures + 1)); }

psql_on() { psql "$1" -v ON_ERROR_STOP=1 -qtAX -c "$2"; }

cleanup() {
  psql_on "$BASE_URL" "drop database if exists $SRC_DB" >/dev/null 2>&1 || true
  psql_on "$BASE_URL" "drop database if exists $DST_DB" >/dev/null 2>&1 || true
  psql_on "$BASE_URL" "drop database if exists $POP_DB" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Môi trường chạy backup.sh: chỉ biến của test, không kế thừa kho thật.
REPO="$WORK/repo"
MEDIA="$WORK/media"
STAGE="$WORK/stage"
export RESTIC_PASSWORD_TEST="test-$SUFFIX"
run_backup() {
  env -u RESTIC_REPOSITORY -u RESTIC_PASSWORD -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY \
    MEDIA_DIR="$MEDIA" BACKUP_STAGE_DIR="$STAGE" XDG_CACHE_HOME="$WORK/cache" "$@"
}
latest_snapshot() {
  RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" XDG_CACHE_HOME="$WORK/cache" \
    restic snapshots --json --no-lock --latest 1 | grep -o '"short_id":"[0-9a-f]*"' | head -n1
}
snapshot_count() {
  RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" XDG_CACHE_HOME="$WORK/cache" \
    restic snapshots --json --no-lock | grep -o '"short_id"' | wc -l | tr -d ' '
}

mkdir -p "$MEDIA/sub"
printf 'xin chào media\n' >"$MEDIA/anh-1.txt"
printf 'lồng nhau\n' >"$MEDIA/sub/anh-2.txt"

psql_on "$BASE_URL" "create database $SRC_DB" >/dev/null
psql_on "$BASE_URL" "create database $DST_DB" >/dev/null
psql_on "$BASE_URL" "create database $POP_DB" >/dev/null
# Nguồn có đủ ba schema của app (public, drizzle, pgboss) như DB thật.
psql_on "$SERVER_URL/$SRC_DB" "
  create table marker (id int primary key, note text); insert into marker values (1, 'sao lưu tiếng Việt');
  create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text);
  insert into drizzle.__drizzle_migrations (hash) values ('m0000');
  create schema pgboss; create table pgboss.job (id int primary key); insert into pgboss.job values (7)" >/dev/null
# DB đích "đã migrate xa hơn snapshot": dữ liệu khác, thêm bảng mới, thêm dòng migration.
psql_on "$SERVER_URL/$POP_DB" "
  create table marker (id int primary key, note text); insert into marker values (1, 'dữ liệu mới hơn'), (2, 'thêm');
  create table bang_moi_hon (id int);
  create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text);
  insert into drizzle.__drizzle_migrations (hash) values ('m0000'), ('m0001-moi-hon');
  create schema pgboss; create table pgboss.job (id int primary key); create table pgboss.bang_moi (id int)" >/dev/null

# 1. Thiếu cấu hình → dừng ngay, nêu tên biến, exit ≠ 0, chưa dump gì.
for var in RESTIC_REPOSITORY RESTIC_PASSWORD; do
  if [[ "$var" == RESTIC_REPOSITORY ]]; then
    set +e; out="$(run_backup DATABASE_URL="$SERVER_URL/$SRC_DB" RESTIC_PASSWORD="x" "$BACKUP_SH" 2>&1)"; code=$?; set -e
  else
    set +e; out="$(run_backup DATABASE_URL="$SERVER_URL/$SRC_DB" RESTIC_REPOSITORY="$REPO" "$BACKUP_SH" 2>&1)"; code=$?; set -e
  fi
  if ((code != 0)) && [[ "$out" == *"$var"* ]] && [[ ! -e "$STAGE" ]]; then
    pass "thiếu $var → exit $code, báo tên biến, chưa dump"
  else
    fail "thiếu $var → exit $code, output: $out"
  fi
done

# 2. Kho chưa init → exit ≠ 0.
set +e
out="$(run_backup DATABASE_URL="$SERVER_URL/$SRC_DB" RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" "$BACKUP_SH" 2>&1)"
code=$?
set -e
if ((code != 0)); then pass "kho chưa init → exit $code"; else fail "kho chưa init mà exit 0"; fi

RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" XDG_CACHE_HOME="$WORK/cache" restic init >/dev/null

# 3. Backup thành công: snapshot có dump + media, file dump tạm đã xoá.
if run_backup DATABASE_URL="$SERVER_URL/$SRC_DB" RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" \
  "$BACKUP_SH" >"$WORK/backup1.log" 2>&1; then
  pass "backup lần 1 exit 0"
else
  fail "backup lần 1 lỗi: $(cat "$WORK/backup1.log")"
fi
listing="$(RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" XDG_CACHE_HOME="$WORK/cache" restic ls latest --host ottm 2>/dev/null || true)"
if [[ "$listing" == *"$STAGE/postgres.dump"* && "$listing" == *"$MEDIA/anh-1.txt"* && "$listing" == *"$MEDIA/sub/anh-2.txt"* ]]; then
  pass "snapshot có postgres.dump và media"
else
  fail "snapshot thiếu file: $listing"
fi
if [[ ! -e "$STAGE/postgres.dump" ]]; then pass "file dump tạm đã xoá"; else fail "file dump tạm còn lại"; fi
if grep -rqF "xin chào media" "$REPO"; then fail "dữ liệu trong kho không được mã hoá"; else pass "kho restic không chứa dữ liệu rõ"; fi

# 4. Backup lần 2 cùng ngày: --keep-daily giữ bản mới nhất của mỗi ngày → còn 1 snapshot.
run_backup DATABASE_URL="$SERVER_URL/$SRC_DB" RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" \
  "$BACKUP_SH" >"$WORK/backup2.log" 2>&1 || fail "backup lần 2 lỗi: $(cat "$WORK/backup2.log")"
count="$(snapshot_count || true)"
if [[ "$count" == 1 ]]; then pass "forget --keep-daily: 1 snapshot cho cùng ngày"; else fail "mong 1 snapshot, có $count"; fi

# 5. Lỗi giữa chừng (DB không tồn tại) → exit ≠ 0, không xoá hay thay bản cũ.
before="$(latest_snapshot || true)"
set +e
run_backup DATABASE_URL="$SERVER_URL/ottm_bk_khong_co_$SUFFIX" RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" \
  "$BACKUP_SH" >"$WORK/backup3.log" 2>&1
code=$?
set -e
count="$(snapshot_count || true)"
after="$(latest_snapshot || true)"
if ((code != 0)) && [[ "$count" == 1 && -n "$before" && "$after" == "$before" ]]; then
  pass "pg_dump lỗi → exit $code, snapshot cũ còn nguyên ($before)"
else
  fail "pg_dump lỗi → exit $code, còn $count snapshot, trước $before sau $after"
fi

# 6. restore.sh: thiếu --yes → từ chối; có --yes → DB đích có dữ liệu, media khớp.
set +e
run_backup RESTORE_DATABASE_URL="$SERVER_URL/$DST_DB" DATABASE_URL="$SERVER_URL/$DST_DB" RESTIC_REPOSITORY="$REPO" \
  RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" "$RESTORE_SH" latest >/dev/null 2>&1
code=$?
set -e
if ((code != 0)); then pass "restore thiếu --yes → exit $code"; else fail "restore thiếu --yes mà vẫn chạy"; fi

mkdir -p "$WORK/restored-media"
printf 'file cũ sẽ bị thay\n' >"$WORK/restored-media/cu.txt"
if run_backup RESTORE_DATABASE_URL="$SERVER_URL/$DST_DB" RESTORE_MEDIA_DIR="$WORK/restored-media" \
  DATABASE_URL="$SERVER_URL/$DST_DB" RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" \
  "$RESTORE_SH" latest --yes >"$WORK/restore.log" 2>&1; then
  pass "restore exit 0"
else
  fail "restore lỗi: $(cat "$WORK/restore.log")"
fi
note="$(psql_on "$SERVER_URL/$DST_DB" "select note from marker where id = 1" 2>/dev/null || true)"
if [[ "$note" == "sao lưu tiếng Việt" ]]; then pass "DB khôi phục có dữ liệu"; else fail "DB khôi phục sai: '$note'"; fi
if diff -r "$MEDIA" "$WORK/restored-media" >/dev/null; then pass "media khôi phục khớp (file cũ đã bị thay)"; else fail "media khôi phục lệch"; fi

# 7. Khôi phục đè lên DB đã có dữ liệu và đã "migrate xa hơn": bảng/dòng mới hơn snapshot phải biến mất,
#    dữ liệu khớp nguồn (migrate của bản mới sẽ chạy lại migration từ đúng điểm snapshot — CI kiểm bằng
#    service migrate thật).
if run_backup RESTORE_DATABASE_URL="$SERVER_URL/$POP_DB" RESTORE_MEDIA_DIR="$WORK/restored-media-2" \
  DATABASE_URL="$SERVER_URL/$POP_DB" RESTIC_REPOSITORY="$REPO" RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" \
  "$RESTORE_SH" latest --yes >"$WORK/restore2.log" 2>&1; then
  pass "restore đè DB có dữ liệu exit 0"
else
  fail "restore đè DB có dữ liệu lỗi: $(cat "$WORK/restore2.log")"
fi
state="$(psql_on "$SERVER_URL/$POP_DB" "
  select (select string_agg(id || '=' || note, ',' order by id) from marker)
    || '|' || (select string_agg(hash, ',' order by id) from drizzle.__drizzle_migrations)
    || '|' || (select string_agg(id::text, ',') from pgboss.job)
    || '|' || (select count(*) from information_schema.tables
               where (table_schema, table_name) in (('public', 'bang_moi_hon'), ('pgboss', 'bang_moi')))" 2>&1 || true)"
if [[ "$state" == "1=sao lưu tiếng Việt|m0000|7|0" ]]; then
  pass "DB đè: dữ liệu khớp snapshot, bảng mới hơn đã bị xoá"
else
  fail "DB đè sai: '$state' (mong '1=sao lưu tiếng Việt|m0000|7|0')"
fi

# 8. Snapshot thiếu media → từ chối trừ khi --db-only (giả lập bằng MEDIA_DIR không có trong snapshot).
set +e
out="$(run_backup MEDIA_DIR="$WORK/khong-co-trong-snapshot" RESTORE_DATABASE_URL="$SERVER_URL/$DST_DB" \
  RESTORE_MEDIA_DIR="$WORK/restored-media-3" DATABASE_URL="$SERVER_URL/$DST_DB" RESTIC_REPOSITORY="$REPO" \
  RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" "$RESTORE_SH" latest --yes 2>&1)"
code=$?
set -e
if ((code != 0)) && [[ "$out" == *"--db-only"* ]]; then pass "snapshot thiếu media → từ chối, gợi ý --db-only"; else fail "snapshot thiếu media → exit $code: $out"; fi
if run_backup MEDIA_DIR="$WORK/khong-co-trong-snapshot" RESTORE_DATABASE_URL="$SERVER_URL/$DST_DB" \
  RESTORE_MEDIA_DIR="$WORK/restored-media-3" DATABASE_URL="$SERVER_URL/$DST_DB" RESTIC_REPOSITORY="$REPO" \
  RESTIC_PASSWORD="$RESTIC_PASSWORD_TEST" "$RESTORE_SH" latest --yes --db-only >"$WORK/restore3.log" 2>&1 \
  && [[ ! -e "$WORK/restored-media-3" ]]; then
  pass "--db-only khôi phục DB, không đụng media"
else
  fail "--db-only lỗi: $(cat "$WORK/restore3.log")"
fi

if ((failures > 0)); then
  echo "test-backup: $failures lỗi"
  exit 1
fi
echo "test-backup: tất cả ok"
