#!/usr/bin/env bash
# Build image trên VPS từ mã nguồn hiện tại, gắn tag git SHA, xuất bản web ra WEB_ROOT/<tag>, sao lưu, đổi
# WEB_ROOT/current, chạy stack, kiểm /healthz qua 127.0.0.1:API_HOST_PORT rồi smoke-test qua nginx (URL công khai),
# giữ 5 tag gần nhất (image + thư mục web).
#   cd ~/OnTheTopMoney && git pull && ./deploy/deploy.sh
#   IMAGE_TAG=abc1234 ./deploy/deploy.sh     # đặt tag thủ công (bỏ qua kiểm cây mã sạch)
# Biến tuỳ chọn:
#   SKIP_PREDEPLOY_BACKUP=1   không sao lưu trước khi chạy migration mới
#   SMOKE_URL=<url>           URL cho smoke-test sau deploy (mặc định PUBLIC_BASE_URL)
#   WEB_MODE (deploy/.env)    vps (mặc định) | external — external: web tĩnh ở Hostinger (deploy/hostinger/), script
#                             bỏ qua build/xuất bản web, không đòi WEB_ROOT, smoke-test kiểm host api (SMOKE_MODE=api)
# nginx do chủ shop tự quản (deploy/nginx.conf.example; external: deploy/nginx-api.conf.example): script không cài,
# không reload nginx.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_env_file
take_lock

if [[ -z "${IMAGE_TAG:-}" ]]; then
  IMAGE_TAG="$(git -C "$DEPLOY_DIR/.." rev-parse --short HEAD)" || die "không đọc được git SHA — đặt IMAGE_TAG"
  # Gồm cả file chưa track: mọi thứ trong các thư mục này được COPY vào image.
  dirty="$(git -C "$DEPLOY_DIR/.." status --porcelain -- server web packages deploy package.json package-lock.json)"
  if [[ -n "$dirty" ]]; then
    printf '%s\n' "$dirty" >&2
    die "cây mã có thay đổi chưa commit (kể cả file chưa track): tag $IMAGE_TAG sẽ không khớp mã. Commit/stash, hoặc đặt IMAGE_TAG."
  fi
fi
[[ "$IMAGE_TAG" =~ $TAG_RE ]] || die "IMAGE_TAG không hợp lệ: $IMAGE_TAG"
[[ "$IMAGE_TAG" != current ]] || die "IMAGE_TAG không được là 'current' (tên symlink trong WEB_ROOT)"
export IMAGE_TAG

public_url="$(env_get PUBLIC_BASE_URL)"
[[ -n "$public_url" ]] || die "chưa đặt PUBLIC_BASE_URL trong deploy/.env"
api_port="$(api_host_port)"
web_mode="$(web_mode)"
web_dir=""
previous_web=""
# WEB_BASE_URL / ALLOWED_ORIGINS khớp WEB_MODE — trước build, backup, ghi IMAGE_TAG.
check_web_config
if [[ "$web_mode" == vps ]]; then web_dir="$(web_root)"; fi
require_host_dirs

previous="$(env_get IMAGE_TAG)"
if [[ "$web_mode" == vps ]]; then previous_web="$(web_current_tag)"; fi
# Chỉ gợi ý rollback tới bản còn đủ image + thư mục web (máy vừa chuyển sang nginx: bản cũ chưa có thư mục web).
if [[ -z "$previous" ]]; then
  rollback_hint=""
elif can_rollback_to "$previous"; then
  rollback_hint=" — quay lại: ./deploy/rollback.sh $previous"
else
  rollback_hint=" — bản trước ($previous) không còn đủ image/thư mục web để rollback.sh: checkout commit cũ rồi chạy lại deploy.sh, hoặc khôi phục backup (runbook.md mục 4.2)"
fi
log "build tag $IMAGE_TAG (WEB_MODE=$web_mode; đang chạy: ${previous:-chưa có}; web: ${previous_web:-chưa có})"
compose --profile backup build
if [[ "$web_mode" == vps ]]; then
  docker build -f "$DEPLOY_DIR/Dockerfile.web" -t "ottm-web:$IMAGE_TAG" "$DEPLOY_DIR/.."
  # Chuẩn bị web trước mọi thay đổi (thư mục tạm, chưa phục vụ): lỗi ở đây → `current` và stack giữ nguyên.
  publish_web "$IMAGE_TAG"
fi

# Migration chỉ tiến: sao lưu trước khi bản mới chạy migrate (bỏ qua ở lần deploy đầu, chưa có dữ liệu).
if [[ "${SKIP_PREDEPLOY_BACKUP:-0}" == 1 ]]; then
  log "SKIP_PREDEPLOY_BACKUP=1 — không sao lưu trước deploy"
elif [[ -z "$(env_get RESTIC_REPOSITORY)" ]]; then
  log "CẢNH BÁO: chưa cấu hình RESTIC_REPOSITORY — deploy không có bản sao lưu trước"
elif [[ -z "$previous" ]]; then
  log "lần deploy đầu — bỏ qua sao lưu trước deploy"
else
  log "sao lưu trước deploy"
  compose --profile backup run --rm -T backup \
    || die "sao lưu trước deploy lỗi — chưa đổi gì. Sửa backup, hoặc chạy lại với SKIP_PREDEPLOY_BACKUP=1"
fi

# Đổi web trước rồi mới ghi IMAGE_TAG: đổi web lỗi → deploy/.env vẫn nêu đúng bản đang chạy.
if [[ "$web_mode" == vps ]]; then activate_web "$IMAGE_TAG" "$STAGED_WEB"; fi
log "ghi IMAGE_TAG=$IMAGE_TAG vào deploy/.env"
env_set IMAGE_TAG "$IMAGE_TAG"

log "khởi động (migrate chạy trước api/worker)"
if ! compose up -d --remove-orphans; then
  compose ps -a || true
  die "docker compose up lỗi. Xem log: docker compose logs --tail=100 migrate api worker$rollback_hint"
fi

if ! wait_healthy 120; then
  compose ps
  die "stack chưa khoẻ. Xem log: docker compose logs --tail=100 api worker migrate$rollback_hint"
fi

smoke_url="${SMOKE_URL:-$public_url}"
if [[ "$web_mode" == vps ]]; then
  log "smoke-test qua $smoke_url (nginx → web $web_dir/current, api 127.0.0.1:$api_port)"
  smoke_env=(SMOKE_MODE=vps "ORIGIN=${ORIGIN:-$public_url}")
else
  # Host api (nginx-api.conf.example): / và đường lạ → JSON 404; CORS kiểm với Origin = origin web.
  log "smoke-test qua $smoke_url (nginx → api 127.0.0.1:$api_port; web ở $(cfg WEB_BASE_URL ""))"
  smoke_env=(SMOKE_MODE=api "ORIGIN=${ORIGIN:-$(cfg WEB_BASE_URL "")}")
fi
if ! env "${smoke_env[@]}" SMOKE_LOGIN=0 SMOKE_ALLOW_DISK_FULL=1 bash "$DEPLOY_DIR/smoke-test.sh" "$smoke_url"; then
  die "smoke-test qua $smoke_url lỗi (cấu hình nginx/DNS/TLS?). Kiểm: sudo nginx -t; sudo tail -n 50 /var/log/nginx/error.log$rollback_hint"
fi

prune_images "$IMAGE_TAG"
log "xong: $IMAGE_TAG${previous:+ (bản trước: $previous — ./deploy/rollback.sh $previous)}"
if [[ "$web_mode" == external ]]; then
  log "WEB_MODE=external: web trên Hostinger xuất bản riêng — deploy/hostinger/publish-web-hostinger.sh (runbook.md mục 8)"
fi
