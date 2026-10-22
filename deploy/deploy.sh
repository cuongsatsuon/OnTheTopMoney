#!/usr/bin/env bash
# Build image trên VPS từ mã nguồn hiện tại (ottm-server, ottm-backup và — WEB_MODE=vps — ottm-web), gắn tag git SHA,
# sao lưu, chạy stack (web là service `web` cùng tag với api), kiểm /healthz qua 127.0.0.1:API_HOST_PORT và web qua
# 127.0.0.1:WEB_HOST_PORT rồi smoke-test qua nginx (URL công khai), giữ 5 tag gần nhất của mọi image.
#   cd ~/OnTheTopMoney && git pull && ./deploy/deploy.sh
#   IMAGE_TAG=abc1234 ./deploy/deploy.sh     # đặt tag thủ công (bỏ qua kiểm cây mã sạch)
# Biến tuỳ chọn:
#   SKIP_PREDEPLOY_BACKUP=1   không sao lưu trước khi chạy migration mới
#   SMOKE_URL=<url>           URL cho smoke-test sau deploy (mặc định PUBLIC_BASE_URL)
#   WEB_MODE (deploy/.env)    vps (mặc định) | external — external: web tĩnh ở Hostinger (deploy/hostinger/), script
#                             không build/chạy service web (dừng + xoá container web cũ nếu có), smoke-test kiểm host
#                             api (SMOKE_MODE=api)
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
export IMAGE_TAG

public_url="$(env_get PUBLIC_BASE_URL)"
[[ -n "$public_url" ]] || die "chưa đặt PUBLIC_BASE_URL trong deploy/.env"
api_port="$(api_host_port)"
web_mode="$(web_mode)"
# WEB_BASE_URL / ALLOWED_ORIGINS khớp WEB_MODE, WEB_HOST_PORT hợp lệ (vps) — trước build, backup, ghi IMAGE_TAG.
check_web_config
web_port=""
if [[ "$web_mode" == vps ]]; then web_port="$(web_host_port)"; fi
require_host_dirs
# Cổng api/web bị tiến trình khác giữ → dừng ngay (không thì chỉ lộ ở compose up, sau backup và ghi IMAGE_TAG).
check_host_ports

previous="$(env_get IMAGE_TAG)"
# Bản trước có ottm-web kiểu cũ (chỉ mang dist) = bản trước mốc web chạy trong Docker (runbook 1.12).
previous_web=0
if [[ "$web_mode" == vps && -n "$previous" ]]; then web_image_status "$previous" || previous_web=$?; fi
# Chỉ gợi ý rollback tới bản còn đủ image (vps: cả ottm-web phục vụ được).
if [[ -z "$previous" ]]; then
  rollback_hint=""
elif [[ "$previous_web" == 2 ]]; then
  rollback_hint=" — bản trước ($previous) là bản trước mốc web chạy trong Docker, rollback.sh không quay về được: checkout commit cũ, đổi lại site nginx cũ (phục vụ /var/www/ottm/current) rồi chạy deploy.sh của commit đó, hoặc khôi phục backup (runbook.md mục 1.12, 4.2)"
elif can_rollback_to "$previous"; then
  rollback_hint=" — quay lại: ./deploy/rollback.sh $previous"
else
  rollback_hint=" — bản trước ($previous) không còn đủ image để rollback.sh: checkout commit cũ rồi chạy lại deploy.sh, hoặc khôi phục backup (runbook.md mục 4.2)"
fi
log "build tag $IMAGE_TAG (WEB_MODE=$web_mode; đang chạy: ${previous:-chưa có})"
# vps: compose() bật profile web → build cả ottm-web:<tag>. Lỗi build → chưa đổi gì.
compose --profile backup build

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

log "ghi IMAGE_TAG=$IMAGE_TAG vào deploy/.env"
env_set IMAGE_TAG "$IMAGE_TAG"

log "khởi động (migrate chạy trước api/worker)"
if ! compose up -d --remove-orphans; then
  compose ps -a || true
  die "docker compose up lỗi. Xem log: docker compose --profile web logs --tail=100 migrate api worker web$rollback_hint"
fi
# external: web không chạy trên VPS — dọn container web còn lại từ chế độ vps.
if [[ "$web_mode" == external ]]; then remove_web_container; fi

if ! wait_healthy 120; then
  compose ps
  die "stack chưa khoẻ (api hoặc web). Xem log: docker compose --profile web logs --tail=100 api worker migrate web$rollback_hint"
fi

smoke_url="${SMOKE_URL:-$public_url}"
if [[ "$web_mode" == vps ]]; then
  log "smoke-test qua $smoke_url (nginx → web 127.0.0.1:$web_port, api 127.0.0.1:$api_port)"
  smoke_env=(SMOKE_MODE=vps "ORIGIN=${ORIGIN:-$public_url}")
else
  # Host api (nginx-api.conf.example): / và đường lạ → JSON 404; CORS kiểm với Origin = origin web.
  log "smoke-test qua $smoke_url (nginx → api 127.0.0.1:$api_port; web ở $(cfg WEB_BASE_URL ""))"
  smoke_env=(SMOKE_MODE=api "ORIGIN=${ORIGIN:-$(cfg WEB_BASE_URL "")}")
fi
if ! env "${smoke_env[@]}" SMOKE_LOGIN=0 SMOKE_ALLOW_DISK_FULL=1 bash "$DEPLOY_DIR/smoke-test.sh" "$smoke_url"; then
  die "smoke-test qua $smoke_url lỗi (cấu hình nginx/DNS/TLS?). Kiểm: sudo nginx -t; sudo tail -n 50 /var/log/nginx/error.log$rollback_hint"
fi

# nginx máy chủ có chuyển / sang container web chưa (runbook 1.12 bước 3)? Không dừng: lần chuyển đầu cố ý deploy
# trước khi đổi site nginx.
if [[ "$web_mode" == vps ]]; then
  local_index="$(curl -sS --max-time 10 "http://127.0.0.1:$web_port/" 2>/dev/null)" || local_index=""
  public_index="$(curl -sS --max-time 10 "$smoke_url/" 2>/dev/null)" || public_index=""
  if [[ -z "$local_index" || "$local_index" != "$public_index" ]]; then
    log "CẢNH BÁO: index.html qua $smoke_url KHÁC bản của container web (127.0.0.1:$web_port) — nginx máy chủ chưa chuyển / sang container web, người dùng vẫn thấy web CŨ. Sửa site nginx theo deploy/nginx.conf.example (upstream ottm_web 127.0.0.1:$web_port; runbook.md mục 1.12 bước 3) rồi: sudo nginx -t && sudo systemctl reload nginx"
  fi
fi

prune_images "$IMAGE_TAG"
log "xong: $IMAGE_TAG${previous:+ (bản trước: $previous — ./deploy/rollback.sh $previous)}"
if [[ "$web_mode" == external ]]; then
  log "WEB_MODE=external: web trên Hostinger xuất bản riêng — deploy/hostinger/publish-web-hostinger.sh (runbook.md mục 8)"
fi
