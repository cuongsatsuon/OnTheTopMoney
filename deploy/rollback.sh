#!/usr/bin/env bash
# Quay về một tag đã deploy trước đó (deploy.sh giữ 5 tag gần nhất của ottm-server, ottm-web, ottm-backup). Không build
# lại: đổi IMAGE_TAG rồi `docker compose up` — api, worker và (WEB_MODE=vps) web cùng về tag đó.
#   ./deploy/rollback.sh <tag>        # liệt kê tag: docker image ls ottm-server ; docker image ls ottm-web
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
[[ "$TAG" =~ $TAG_RE ]] || die "tag không hợp lệ: $TAG"

require_env_file
take_lock
web_mode="$(web_mode)"
# WEB_BASE_URL / ALLOWED_ORIGINS khớp WEB_MODE, WEB_HOST_PORT hợp lệ (vps) — trước khi đổi IMAGE_TAG.
check_web_config
require_host_dirs
# Cổng api/web bị tiến trình khác giữ → dừng trước khi đổi IMAGE_TAG.
check_host_ports

# Kiểm đủ mọi thứ trước khi đổi gì.
docker image inspect "ottm-server:$TAG" >/dev/null 2>&1 || die "không có image ottm-server:$TAG trên máy này (đã bị dọn?)"
if [[ "$web_mode" == vps ]]; then
  web_status=0
  web_image_status "$TAG" || web_status=$?
  # Chỉ gợi ý tag có ottm-web phục vụ được (bỏ image kiểu cũ chỉ mang dist).
  web_tags=""
  while read -r t; do
    [[ -n "$t" && "$t" != "<none>" ]] || continue
    if web_image_status "$t"; then web_tags+="$t "; fi
  done < <(docker image ls ottm-web --format '{{.Tag}}' 2>/dev/null)
  case "$web_status" in
    0) ;;
    2) die "ottm-web:$TAG là image cũ (chỉ mang dist, từ trước khi web chạy như service Docker) — không chạy được, chưa đổi gì. Rollback tới tag deploy sau mốc đó (còn: ${web_tags:-không có}), hoặc checkout commit cần thiết rồi ./deploy/deploy.sh" ;;
    *) die "không có image ottm-web:$TAG (đã bị dọn?) — chưa đổi gì. Bản web còn giữ: ${web_tags:-không có}. Hoặc checkout commit $TAG rồi ./deploy/deploy.sh (build lại cả web)" ;;
  esac
fi
docker image inspect "ottm-backup:$TAG" >/dev/null 2>&1 \
  || log "CẢNH BÁO: không có ottm-backup:$TAG — cron backup sẽ lỗi tới lần deploy sau"

previous="$(env_get IMAGE_TAG)"
back_hint=""
if [[ "$previous" != "$TAG" ]] && can_rollback_to "$previous"; then back_hint=" — quay lại bản trước: ./deploy/rollback.sh $previous"; fi
log "rollback ${previous:-?} → $TAG"
export IMAGE_TAG="$TAG"
env_set IMAGE_TAG "$TAG"
# vps: compose() bật profile web → container web cũng đổi sang ottm-web:$TAG.
if ! compose up -d --no-build --remove-orphans; then
  compose ps -a || true
  die "docker compose up lỗi khi rollback về $TAG (deploy/.env IMAGE_TAG=$TAG). Xem: docker compose --profile web logs --tail=100 migrate api worker web$back_hint"
fi
if [[ "$web_mode" == external ]]; then remove_web_container; fi

if ! wait_healthy 120; then
  compose ps
  die "stack chưa khoẻ sau rollback (api hoặc web). Xem: docker compose --profile web logs --tail=100 api worker migrate web$back_hint"
fi
if [[ "$web_mode" == vps ]]; then
  log "xong: đang chạy $TAG (api, worker, web)"
else
  log "xong: đang chạy $TAG (WEB_MODE=external: web trên Hostinger không đổi)"
fi
