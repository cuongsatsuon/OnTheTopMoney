#!/usr/bin/env bash
# Hàm dùng chung cho deploy.sh / rollback.sh (source, không chạy trực tiếp).

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
# Cùng một tập tag cho mọi image (web chạy cùng IMAGE_TAG với api — rollback đổi cả hai).
IMAGES=(ottm-server ottm-web ottm-backup)
KEEP_TAGS="${KEEP_TAGS:-5}"
# Như tag Docker: không bắt đầu bằng "." hay "-".
TAG_RE='^[A-Za-z0-9_][A-Za-z0-9_.-]*$'
# Nhãn của image ottm-web phục vụ được (deploy/Dockerfile.web). Image ottm-web cũ (chỉ mang /dist) không có nhãn này.
WEB_IMAGE_LABEL=org.ottm.web

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'LỖI: %s\n' "$*" >&2; exit 1; }

# docker compose của stack. WEB_MODE=vps → bật profile `web` (service web được build/chạy/đổi tag cùng api);
# external → không bật (service web nằm ngoài mọi lệnh; remove_web_container dọn container cũ).
compose() {
  local m
  local -a profiles=()
  m="$(web_mode)" || exit 1
  if [[ "$m" == vps ]]; then profiles=(--profile web); fi
  docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" ${profiles[@]+"${profiles[@]}"} "$@"
}

# Một deploy.sh/rollback.sh tại một thời điểm (deploy/.env, image).
take_lock() {
  command -v flock >/dev/null || die "chưa có flock (gói util-linux)"
  exec 9>"$DEPLOY_DIR/.deploy.lock" || die "không mở được $DEPLOY_DIR/.deploy.lock"
  flock -n 9 || die "đang có deploy.sh/rollback.sh khác chạy (khoá $DEPLOY_DIR/.deploy.lock) — chờ nó xong"
}

# Đọc giá trị một biến trong deploy/.env (không source file: giá trị có thể chứa ký tự đặc biệt).
env_get() {
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); v = $0 } END { print v }' "$ENV_FILE"
}

# Ghi/thay KEY=VALUE trong deploy/.env, giữ nguyên các dòng khác.
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  awk -F= -v k="$key" -v v="$value" '
    $1 == k { if (!done) print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

# Giá trị cấu hình theo đúng thứ tự docker compose dùng: biến môi trường của shell > deploy/.env > mặc định.
cfg() {
  local name="$1" default="$2" v="${!1:-}"
  [[ -n "$v" ]] || v="$(env_get "$name")"
  printf '%s' "${v:-$default}"
}

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
file_uid() { stat -c %u "$1" 2>/dev/null || stat -f %u "$1"; }
file_group() { stat -c %G "$1" 2>/dev/null || stat -f %Sg "$1"; }

# Đường dẫn tuyệt đối dạng chuẩn (dùng trong bind mount và cấu hình nginx): chỉ chữ, số, _ . -; mỗi đoạn ngăn bằng
# đúng một "/"; không đoạn "." / ".."; ít nhất hai cấp; không phải thư mục hệ thống.
check_abs_dir_path() {
  local name="$1" path="$2" slashes
  [[ "$path" =~ ^(/[A-Za-z0-9_.-]+)+$ ]] \
    || die "$name phải là đường dẫn tuyệt đối (chữ, số, _ . -, mỗi cấp ngăn bằng một /, không / cuối), đang là '$path'"
  [[ "$path/" != *"/./"* && "$path/" != *"/../"* ]] || die "$name không được có đoạn '.' hoặc '..': '$path'"
  slashes="${path//[^\/]/}"
  ((${#slashes} >= 2)) || die "$name không được là thư mục cấp một ('$path') — dùng vd /var/lib/ottm/media"
  case "$path" in
    /etc/* | /proc/* | /sys/* | /dev/* | /boot/* | /run/* | /bin/* | /sbin/* | /lib/* | /lib32/* | /lib64/* | /root/* | \
      /usr/bin | /usr/bin/* | /usr/sbin | /usr/sbin/* | /usr/lib | /usr/lib/* | /usr/include | /usr/include/* | \
      /usr/share | /usr/share/* | /usr/local | /var/lib/docker | /var/lib/docker/* | /var/lib/postgresql | \
      /var/lib/postgresql/* | /var/lib | /var/log | /var/log/* | /var/www | /var/cache | /var/tmp | /var/spool | \
      /var/backups | /var/mail | /var/opt | /opt/* | /home/*)
      # /opt/<x>/<y> và /home/<user>/<x> (sâu hơn hai cấp) vẫn được.
      if [[ ("$path" == /opt/* || "$path" == /home/*) && ${#slashes} -ge 3 ]]; then return 0; fi
      die "$name không được là thư mục hệ thống '$path' — dùng thư mục riêng, vd /var/lib/ottm/media"
      ;;
  esac
}

# Chế độ web (WEB_MODE): `vps` (mặc định — web + api cùng VPS: service `web` của compose, nginx máy chủ theo
# nginx.conf.example chuyển `/` tới 127.0.0.1:WEB_HOST_PORT) | `external` (web tĩnh trên Hostinger — deploy/hostinger/;
# VPS chỉ chạy BE, nginx theo nginx-api.conf.example; deploy.sh/rollback.sh không build/chạy service web).
web_mode() {
  local v
  v="$(cfg WEB_MODE vps)"
  [[ "$v" == vps || "$v" == external ]] || die "WEB_MODE phải là vps hoặc external, đang là '$v'"
  printf '%s' "$v"
}

# Kiểm cấu hình theo WEB_MODE trước mọi thay đổi (build, backup, ghi IMAGE_TAG) — dùng chung cho deploy.sh, rollback.sh.
# Giá trị theo thứ tự compose (cfg). ALLOWED_ORIGINS trống = PUBLIC_BASE_URL (như docker-compose.yml).
#   external: WEB_BASE_URL là origin https, khác PUBLIC_BASE_URL (host api), nằm trong ALLOWED_ORIGINS (phẩy ngăn cách).
#   vps:      WEB_BASE_URL trống hoặc bằng PUBLIC_BASE_URL (sót lại từ chế độ tách → OAuth chuyển về sai host);
#             WEB_HOST_PORT là số cổng 1–65535, khác API_HOST_PORT.
check_web_config() {
  local mode public web allowed item found=0 has_web=0
  local -a _origins=() _profiles=()
  mode="$(web_mode)" || exit 1
  public="$(cfg PUBLIC_BASE_URL "")"
  web="$(cfg WEB_BASE_URL "")"
  allowed="$(cfg ALLOWED_ORIGINS "$public")"
  # COMPOSE_PROFILES (lệnh compose gõ tay) phải khớp WEB_MODE: vps có `web`, external không.
  IFS=',' read -r -a _profiles <<<"$(cfg COMPOSE_PROFILES "")"
  for item in "${_profiles[@]}"; do
    item="${item//[[:space:]]/}"
    [[ "$item" == web || "$item" == '*' ]] && has_web=1
  done
  if [[ "$mode" == vps ]] && ((!has_web)); then
    log "CẢNH BÁO: WEB_MODE=vps nhưng COMPOSE_PROFILES không có 'web' — lệnh 'docker compose …' gõ tay sẽ bỏ qua service web. Thêm COMPOSE_PROFILES=web vào deploy/.env"
  fi
  if [[ "$mode" == external ]] && ((has_web)); then
    die "WEB_MODE=external nhưng COMPOSE_PROFILES bật 'web' — compose sẽ chạy container web trên VPS. Để trống COMPOSE_PROFILES trong deploy/.env"
  fi
  if [[ "$mode" == vps ]]; then
    [[ -z "$web" || "$web" == "$public" ]] \
      || die "WEB_MODE=vps nhưng WEB_BASE_URL=$web khác PUBLIC_BASE_URL=$public — bỏ dòng WEB_BASE_URL (và ALLOWED_ORIGINS nếu không cần) trong deploy/.env, hoặc đặt WEB_MODE=external nếu web ở Hostinger (runbook.md mục 8)"
    web_host_port >/dev/null || exit 1
    return 0
  fi
  [[ -n "$web" ]] || die "WEB_MODE=external cần WEB_BASE_URL (origin web trên Hostinger, vd https://app.example.com) trong deploy/.env"
  [[ "$web" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
    || die "WEB_BASE_URL phải là origin https, không path, không / cuối (vd https://app.example.com), đang là '$web'"
  [[ "$web" != "$public" ]] \
    || die "WEB_MODE=external: WEB_BASE_URL ($web) phải khác PUBLIC_BASE_URL (host api, vd https://api.example.com)"
  IFS=',' read -r -a _origins <<<"$allowed"
  for item in "${_origins[@]}"; do
    item="${item#"${item%%[![:space:]]*}"}"
    item="${item%"${item##*[![:space:]]}"}"
    [[ "$item" == "$web" ]] && found=1
  done
  ((found)) || die "WEB_MODE=external: ALLOWED_ORIGINS ($allowed) phải gồm WEB_BASE_URL ($web) — thiếu thì trình duyệt chặn CORS và api không khởi động"
}

media_dir_host() {
  local v
  v="$(cfg MEDIA_DIR_HOST /var/lib/ottm/media)"
  check_abs_dir_path MEDIA_DIR_HOST "$v"
  printf '%s' "$v"
}

api_host_port() {
  local v
  v="$(cfg API_HOST_PORT 3000)"
  [[ "$v" =~ ^[1-9][0-9]{0,4}$ ]] && ((v <= 65535)) || die "API_HOST_PORT phải là số cổng 1–65535, đang là '$v'"
  printf '%s' "$v"
}

# Cổng loopback của container web (chỉ WEB_MODE=vps). Phải khác API_HOST_PORT (hai service không publish chung cổng).
web_host_port() {
  local v api
  v="$(cfg WEB_HOST_PORT 3080)"
  [[ "$v" =~ ^[1-9][0-9]{0,4}$ ]] && ((v <= 65535)) || die "WEB_HOST_PORT phải là số cổng 1–65535, đang là '$v'"
  api="$(api_host_port)" || exit 1
  [[ "$v" != "$api" ]] || die "WEB_HOST_PORT ($v) trùng API_HOST_PORT — đổi một trong hai trong deploy/.env (và upstream tương ứng trong nginx)"
  printf '%s' "$v"
}

# Cổng loopback của api và (vps) web đang bị tiến trình KHÁC giữ → `compose up` chỉ lỗi sau backup và ghi IMAGE_TAG.
# Kiểm trước mọi thay đổi: cổng đang có tiến trình nghe (ss) mà không phải cổng do container api/web của project này
# publish (docker port) → dừng. Không có `ss` → bỏ qua kèm log.
check_host_ports() {
  local mode api web="" tag ids id p name listening
  local -a owned=() checks=()
  mode="$(web_mode)" || exit 1
  api="$(api_host_port)" || exit 1
  checks=("API_HOST_PORT:$api")
  if [[ "$mode" == vps ]]; then
    web="$(web_host_port)" || exit 1
    checks+=("WEB_HOST_PORT:$web")
  fi
  if ! command -v ss >/dev/null; then
    log "CẢNH BÁO: không có lệnh ss — bỏ qua kiểm cổng ${api}${web:+, $web} có bị tiến trình khác giữ không"
    return 0
  fi
  tag="${IMAGE_TAG:-$(env_get IMAGE_TAG)}"
  ids="$(export IMAGE_TAG="${tag:-port-check}"; compose --profile web ps -q api web)" \
    || die "không liệt kê được container api/web (docker compose ps) — không kiểm được cổng"
  for id in $ids; do
    while read -r p; do [[ -n "$p" ]] && owned+=("${p##*:}"); done < <(docker port "$id" 2>/dev/null)
  done
  for p in "${checks[@]}"; do
    name="${p%%:*}"
    p="${p#*:}"
    listening="$(ss -ltnH "( sport = :$p )" 2>/dev/null)"
    [[ -n "$listening" ]] || continue
    [[ " ${owned[*]-} " == *" $p "* ]] && continue
    die "cổng $p ($name) trên máy chủ đang bị tiến trình khác giữ ($(awk '{print $4}' <<<"$listening" | tr '\n' ' ')) — chưa đổi gì. Đổi $name trong deploy/.env (và upstream $([[ $name == API_HOST_PORT ]] && echo ottm_api || echo ottm_web) trong site nginx), hoặc dừng tiến trình đó (xem: sudo ss -ltnp '( sport = :$p )')"
  done
}

require_env_file() {
  [[ -f "$ENV_FILE" ]] || die "chưa có $ENV_FILE — sao chép từ env.production.example rồi điền (runbook.md)"
  command -v docker >/dev/null || die "chưa cài docker"
  docker compose version >/dev/null 2>&1 || die "chưa có docker compose v2"
  command -v curl >/dev/null || die "chưa cài curl"
}

# Mọi thư mục cha của $1 phải cho người khác đi qua (o+x) để nginx (www-data) tới được.
require_traversable_parents() {
  local p="$1" mode
  while [[ "$p" != / ]]; do
    p="$(dirname "$p")"
    mode="$(file_mode "$p")" || die "không đọc được quyền của $p"
    (((8#$mode & 8#001) != 0)) || die "nginx không đi qua được $p (quyền $mode) — sửa: sudo chmod o+x $p"
  done
}

# Thư mục trên máy chủ phải có sẵn với đúng quyền (runbook mục 1.5) — script không dùng sudo. Web chạy trong
# container (không có thư mục web trên máy chủ): chỉ cần thư mục media.
require_host_dirs() {
  local media mode group
  media="$(media_dir_host)" || exit 1

  [[ -d "$media" ]] \
    || die "MEDIA_DIR_HOST $media chưa có — tạo: sudo install -d -o 1000 -g 1000 -m 755 $media"
  [[ "$(file_uid "$media")" == 1000 ]] \
    || die "MEDIA_DIR_HOST $media thuộc uid $(file_uid "$media"), api (uid 1000) không ghi được — sửa: sudo chown 1000:1000 $media"
  mode="$(file_mode "$media")" || die "không đọc được quyền của $media"
  (((8#$mode & 8#700) == 8#700)) || die "uid 1000 không ghi được MEDIA_DIR_HOST $media (quyền $mode) — sửa: sudo chmod u+rwx $media"
  if (((8#$mode & 8#005) != 8#005)); then
    # Chấp nhận nhóm của nginx (www-data / nginx) có r-x thay cho người khác.
    group="$(file_group "$media")"
    if [[ "$group" != www-data && "$group" != nginx ]] || (((8#$mode & 8#050) != 8#050)); then
      die "nginx không đọc được MEDIA_DIR_HOST $media (quyền $mode, nhóm $group) — sửa: sudo chmod 755 $media"
    fi
  fi
  require_traversable_parents "$media"
}

# image ottm-web:<tag> có và phục vụ được (nhãn của Dockerfile.web hiện tại). 0 = được; 1 = không có; 2 = image cũ
# (chỉ mang /dist, từ trước khi web chạy như service — không chạy được).
web_image_status() {
  local tag="$1" labels
  labels="$(docker image inspect --format '{{json .Config.Labels}}' "ottm-web:$tag" 2>/dev/null)" || return 1
  [[ "$labels" == *"\"$WEB_IMAGE_LABEL\":\"nginx\""* ]] || return 2
}

# Tag còn rollback được: có image ottm-server, và (WEB_MODE=vps) image ottm-web phục vụ được.
can_rollback_to() {
  local tag="$1" wmode
  [[ -n "$tag" && "$tag" =~ $TAG_RE ]] || return 1
  wmode="$(web_mode)" || return 1
  if [[ "$wmode" == vps ]]; then
    web_image_status "$tag" || return 1
  fi
  docker image inspect "ottm-server:$tag" >/dev/null 2>&1
}

# WEB_MODE=external: dừng + xoá container web còn lại từ chế độ vps (nếu có). Không đụng image.
remove_web_container() {
  local ids
  ids="$(compose --profile web ps -a -q web)" \
    || die "không liệt kê được container web (docker compose --profile web ps -a web) — chưa dọn được container web cũ"
  [[ -n "$ids" ]] || return 0
  log "WEB_MODE=external: dừng và xoá container web cũ"
  compose --profile web rm --stop --force web >/dev/null || die "không dừng/xoá được container web — xem: docker compose --profile web ps -a web"
}

# Chờ container web (WEB_MODE=vps) trả /healthz 200 qua 127.0.0.1:WEB_HOST_PORT. Trả 1 nếu quá hạn.
wait_web_healthy() {
  local timeout="${1:-60}" deadline url status=""
  url="$(web_host_port)" || exit 1
  url="http://127.0.0.1:$url/healthz"
  deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    status="$(curl -sS --connect-timeout 3 --max-time 5 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" || status=""
    if [[ "$status" == 200 ]]; then
      log "web: $url 200"
      return 0
    fi
    if ((SECONDS + 2 >= deadline)); then break; fi
    sleep 2
  done
  log "web ($url) chưa 200 sau ${timeout}s (nhận ${status:-không phản hồi}) — xem: docker compose --profile web logs --tail=100 web"
  return 1
}

# Chờ api trả /healthz 200 qua cổng loopback của máy chủ (không phụ thuộc nginx/DNS/TLS), rồi (WEB_MODE=vps) chờ
# container web khoẻ qua 127.0.0.1:WEB_HOST_PORT. Trả 1 nếu quá hạn (hạn tính theo đồng hồ, gồm cả thời gian curl chờ).
# 503 chỉ vì đĩa >85% (db ok, worker ok) vẫn tính là bản chạy được, kèm cảnh báo to.
wait_healthy() {
  local timeout="${1:-120}" deadline out="" body="" status url left
  url="$(api_host_port)" || exit 1
  url="http://127.0.0.1:$url/healthz"
  deadline=$((SECONDS + timeout))
  while ((SECONDS < deadline)); do
    left=$((deadline - SECONDS))
    if ((left > 10)); then left=10; fi
    out="$(curl -sS --connect-timeout 3 --max-time "$left" -w '\n%{http_code}' "$url" 2>/dev/null)" || out=""
    status="${out##*$'\n'}"
    body="${out%$'\n'*}"
    if [[ "$status" == 200 ]]; then
      log "healthz: $body"
      _wait_web_if_vps "$deadline"
      return
    fi
    if [[ "$status" == 503 && "$body" == *'"db":"ok"'* && "$body" == *'"worker":"ok"'* && "$body" == *'"disk":"full"'* ]]; then
      log "CẢNH BÁO: ĐĨA ĐÃ DÙNG >85% — app chạy nhưng /healthz trả 503 (runbook.md mục 5). $body"
      _wait_web_if_vps "$deadline"
      return
    fi
    if ((SECONDS + 3 >= deadline)); then break; fi
    sleep 3
  done
  log "healthz ($url) chưa 200 sau ${timeout}s: ${body:-không phản hồi}"
  return 1
}

# Phần web của wait_healthy: dùng thời gian còn lại của cùng hạn (tối thiểu 30s — healthcheck của container cần vài giây).
_wait_web_if_vps() {
  local deadline="$1" left m
  m="$(web_mode)" || exit 1
  [[ "$m" == vps ]] || return 0
  left=$((deadline - SECONDS))
  if ((left < 30)); then left=30; fi
  wait_web_healthy "$left"
}

# Giữ KEEP_TAGS tag mới nhất (theo thứ tự tag của ottm-server) + tag đang chạy, áp CÙNG một tập cho mọi image
# (ottm-server, ottm-web, ottm-backup), để rollback luôn có đủ server/web/backup của một tag.
prune_images() {
  local current="$1" image tag
  [[ "$KEEP_TAGS" =~ ^[1-9][0-9]*$ ]] || die "KEEP_TAGS phải là số nguyên dương (đang là '$KEEP_TAGS')"
  local -A keep=(["$current"]=1)
  local n=0
  # docker image ls liệt kê mới nhất trước.
  while read -r tag; do
    [[ -z "$tag" || "$tag" == "<none>" ]] && continue
    ((n < KEEP_TAGS)) || break
    keep["$tag"]=1
    n=$((n + 1))
  done < <(docker image ls ottm-server --format '{{.Tag}}')
  log "giữ tag: ${!keep[*]}"
  for image in "${IMAGES[@]}"; do
    while read -r tag; do
      [[ -z "$tag" || "$tag" == "<none>" || -n "${keep[$tag]:-}" ]] && continue
      log "xoá image cũ $image:$tag"
      docker image rm "$image:$tag" >/dev/null 2>&1 || log "không xoá được $image:$tag (đang dùng?) — bỏ qua"
    done < <(docker image ls "$image" --format '{{.Tag}}')
  done
  docker image prune -f >/dev/null 2>&1 || true
}
