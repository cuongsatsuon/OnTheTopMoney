#!/usr/bin/env bash
# Quay về một tag đã deploy trước đó (deploy.sh giữ 5 tag gần nhất: image + thư mục WEB_ROOT/<tag>). Không build lại.
#   ./deploy/rollback.sh <tag>        # liệt kê tag: docker image ls ottm-server ; ls WEB_ROOT
# Migration chỉ tiến và tương thích ngược một phiên bản: image cũ chạy được trên schema mới hơn một bản.
# WEB_MODE=external (web trên Hostinger): chỉ quay BE; web không đổi theo (xuất bản lại commit cũ nếu cần — runbook mục 8).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "Cách dùng: $0 <tag>" >&2
  echo "Các tag có sẵn:" >&2
  docker image ls ottm-server --format '  {{.Tag}}  ({{.CreatedSince}})' >&2 || true
  exit 2
fi
[[ "$TAG" =~ $TAG_RE && "$TAG" != current ]] || die "tag không hợp lệ: $TAG"

require_env_file
take_lock
web_mode="$(web_mode)"
web_dir=""
if [[ "$web_mode" == vps ]]; then web_dir="$(web_root)"; fi
require_host_dirs
# WEB_BASE_URL / ALLOWED_ORIGINS khớp WEB_MODE — trước khi đổi web hay IMAGE_TAG.
check_web_config

# Kiểm đủ mọi thứ trước khi đổi gì.
docker image inspect "ottm-server:$TAG" >/dev/null 2>&1 || die "không có image ottm-server:$TAG trên máy này (đã bị dọn?)"
[[ "$web_mode" == external || -f "$web_dir/$TAG/index.html" ]] \
  || die "không có thư mục web $web_dir/$TAG (đã bị dọn?) — chưa đổi gì. Các bản web còn giữ: $(cd "$web_dir" && ls -d -- */ 2>/dev/null | tr -d / | tr '\n' ' ')"
docker image inspect "ottm-backup:$TAG" >/dev/null 2>&1 \
  || log "CẢNH BÁO: không có ottm-backup:$TAG — cron backup sẽ lỗi tới lần deploy sau"

previous="$(env_get IMAGE_TAG)"
back_hint=""
if [[ "$previous" != "$TAG" ]] && can_rollback_to "$previous"; then back_hint=" — quay lại bản trước: ./deploy/rollback.sh $previous"; fi
log "rollback ${previous:-?} → $TAG"
# Đổi web trước rồi mới ghi IMAGE_TAG: đổi web lỗi → deploy/.env vẫn nêu đúng bản đang chạy.
if [[ "$web_mode" == vps ]]; then switch_web "$TAG"; fi
export IMAGE_TAG="$TAG"
env_set IMAGE_TAG "$TAG"
if ! compose up -d --no-build --remove-orphans; then
  compose ps -a || true
  die "docker compose up lỗi khi rollback về $TAG (web đã trỏ $TAG, deploy/.env IMAGE_TAG=$TAG). Xem: docker compose logs --tail=100 migrate api worker$back_hint"
fi

if ! wait_healthy 120; then
  compose ps
  die "stack chưa khoẻ sau rollback. Xem: docker compose logs --tail=100 api worker migrate"
fi
if [[ "$web_mode" == vps ]]; then
  log "xong: đang chạy $TAG (web: $web_dir/current → $TAG)"
else
  log "xong: đang chạy $TAG (WEB_MODE=external: web trên Hostinger không đổi)"
fi
