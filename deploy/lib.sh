#!/usr/bin/env bash
# Hàm dùng chung cho deploy.sh / rollback.sh (source, không chạy trực tiếp).

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env"
# ottm-web chỉ để mang dist ra WEB_ROOT; giữ cùng tập tag với các image khác.
IMAGES=(ottm-server ottm-web ottm-backup)
KEEP_TAGS="${KEEP_TAGS:-5}"
# Như tag Docker: không bắt đầu bằng "." hay "-" (tag cũng là tên thư mục trong WEB_ROOT).
TAG_RE='^[A-Za-z0-9_][A-Za-z0-9_.-]*$'
# Đánh dấu thư mục web do publish_web tạo (nội dung = tag). prune chỉ xoá thư mục có đánh dấu khớp tên.
WEB_MARKER=.ottm-web-tag

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'LỖI: %s\n' "$*" >&2; exit 1; }

compose() { docker compose --project-directory "$DEPLOY_DIR" -f "$DEPLOY_DIR/docker-compose.yml" "$@"; }

# Dọn container/thư mục tạm của publish_web khi script dừng giữa chừng (lỗi, Ctrl-C, kill).
_LIB_CID=""
_LIB_TMP=""
_lib_cleanup() {
  if [[ -n "$_LIB_CID" ]]; then docker rm -f "$_LIB_CID" >/dev/null 2>&1 || true; fi
  if [[ -n "$_LIB_TMP" ]]; then rm -rf -- "$_LIB_TMP"; fi
  _LIB_CID=""
  _LIB_TMP=""
}
trap _lib_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Một deploy.sh/rollback.sh tại một thời điểm (thư mục tạm, deploy/.env, `current`).
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

# Đường dẫn tuyệt đối dạng chuẩn (dùng trong rm -rf và cấu hình nginx): chỉ chữ, số, _ . -; mỗi đoạn ngăn bằng
# đúng một "/"; không đoạn "." / ".."; ít nhất hai cấp; không phải thư mục hệ thống.
check_abs_dir_path() {
  local name="$1" path="$2" slashes
  [[ "$path" =~ ^(/[A-Za-z0-9_.-]+)+$ ]] \
    || die "$name phải là đường dẫn tuyệt đối (chữ, số, _ . -, mỗi cấp ngăn bằng một /, không / cuối), đang là '$path'"
  [[ "$path/" != *"/./"* && "$path/" != *"/../"* ]] || die "$name không được có đoạn '.' hoặc '..': '$path'"
  slashes="${path//[^\/]/}"
  ((${#slashes} >= 2)) || die "$name không được là thư mục cấp một ('$path') — dùng vd /var/www/ottm"
  case "$path" in
    /etc/* | /proc/* | /sys/* | /dev/* | /boot/* | /run/* | /bin/* | /sbin/* | /lib/* | /lib32/* | /lib64/* | /root/* | \
      /usr/bin | /usr/bin/* | /usr/sbin | /usr/sbin/* | /usr/lib | /usr/lib/* | /usr/include | /usr/include/* | \
      /usr/share | /usr/share/* | /usr/local | /var/lib/docker | /var/lib/docker/* | /var/lib/postgresql | \
      /var/lib/postgresql/* | /var/lib | /var/log | /var/log/* | /var/www | /var/cache | /var/tmp | /var/spool | \
      /var/backups | /var/mail | /var/opt | /opt/* | /home/*)
      # /opt/<x>/<y> và /home/<user>/<x> (sâu hơn hai cấp) vẫn được.
      if [[ ("$path" == /opt/* || "$path" == /home/*) && ${#slashes} -ge 3 ]]; then return 0; fi
      die "$name không được là thư mục hệ thống '$path' — dùng thư mục riêng, vd /var/www/ottm, /var/lib/ottm/media"
      ;;
  esac
}

# Chế độ web (WEB_MODE): `vps` (mặc định — web + api cùng VPS: deploy.sh xuất bản web ra WEB_ROOT, nginx theo
# nginx.conf.example) | `external` (web tĩnh trên Hostinger — deploy/hostinger/; VPS chỉ chạy BE, nginx theo
# nginx-api.conf.example; deploy.sh/rollback.sh bỏ qua mọi bước web và không đòi WEB_ROOT).
web_mode() {
  local v
  v="$(cfg WEB_MODE vps)"
  [[ "$v" == vps || "$v" == external ]] || die "WEB_MODE phải là vps hoặc external, đang là '$v'"
  printf '%s' "$v"
}

# Kiểm cấu hình theo WEB_MODE trước mọi thay đổi (build, backup, ghi IMAGE_TAG) — dùng chung cho deploy.sh, rollback.sh.
# Giá trị theo thứ tự compose (cfg). ALLOWED_ORIGINS trống = PUBLIC_BASE_URL (như docker-compose.yml).
#   external: WEB_BASE_URL là origin https, khác PUBLIC_BASE_URL (host api), nằm trong ALLOWED_ORIGINS (phẩy ngăn cách).
#   vps:      WEB_BASE_URL trống hoặc bằng PUBLIC_BASE_URL (sót lại từ chế độ tách → OAuth chuyển về sai host).
check_web_config() {
  local mode public web allowed item found=0
  local -a _origins=()
  mode="$(web_mode)" || exit 1
  public="$(cfg PUBLIC_BASE_URL "")"
  web="$(cfg WEB_BASE_URL "")"
  allowed="$(cfg ALLOWED_ORIGINS "$public")"
  if [[ "$mode" == vps ]]; then
    [[ -z "$web" || "$web" == "$public" ]] \
      || die "WEB_MODE=vps nhưng WEB_BASE_URL=$web khác PUBLIC_BASE_URL=$public — bỏ dòng WEB_BASE_URL (và ALLOWED_ORIGINS nếu không cần) trong deploy/.env, hoặc đặt WEB_MODE=external nếu web ở Hostinger (runbook.md mục 8)"
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

web_root() {
  local v
  v="$(cfg WEB_ROOT /var/www/ottm)"
  check_abs_dir_path WEB_ROOT "$v"
  printf '%s' "$v"
}

media_dir_host() {
  local v
  v="$(cfg MEDIA_DIR_HOST /var/lib/ottm/media)"
  check_abs_dir_path MEDIA_DIR_HOST "$v"
  printf '%s' "$v"
}

# WEB_ROOT và MEDIA_DIR_HOST không được trùng hay nằm trong nhau (prune xoá thư mục con của WEB_ROOT).
check_host_paths() {
  local web media
  web="$(web_root)" || exit 1
  media="$(media_dir_host)" || exit 1
  [[ "$web" != "$media" && "$media/" != "$web/"* && "$web/" != "$media/"* ]] \
    || die "WEB_ROOT ($web) và MEDIA_DIR_HOST ($media) phải là hai thư mục tách biệt, không cái nào nằm trong cái kia"
}

api_host_port() {
  local v
  v="$(cfg API_HOST_PORT 3000)"
  [[ "$v" =~ ^[1-9][0-9]{0,4}$ ]] && ((v <= 65535)) || die "API_HOST_PORT phải là số cổng 1–65535, đang là '$v'"
  printf '%s' "$v"
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

# Thư mục trên máy chủ phải có sẵn với đúng quyền (runbook mục 1.5) — script không dùng sudo.
require_host_dirs() {
  local web media mode group wmode
  wmode="$(web_mode)" || exit 1
  media="$(media_dir_host)" || exit 1
  # WEB_MODE=external: web không nằm trên VPS — chỉ cần thư mục media.
  if [[ "$wmode" == vps ]]; then
    check_host_paths
    web="$(web_root)" || exit 1
    [[ -d "$web" && -w "$web" ]] \
      || die "WEB_ROOT $web chưa có hoặc người dùng $(id -un) không ghi được — tạo: sudo install -d -o $(id -un) -g $(id -gn) -m 755 $web"
    mode="$(file_mode "$web")" || die "không đọc được quyền của $web"
    (((8#$mode & 8#005) == 8#005)) || die "nginx không đọc được WEB_ROOT $web (quyền $mode) — sửa: sudo chmod o+rx $web"
    require_traversable_parents "$web"
  fi

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

# Đổi tên nguyên tử, ghi đè đích kể cả khi đích là symlink tới thư mục (rename(2)).
atomic_rename() {
  if [[ "$(mv --version 2>/dev/null)" == *GNU* ]]; then
    mv -T -- "$1" "$2"
  elif command -v python3 >/dev/null; then
    python3 -c 'import os, sys; os.rename(sys.argv[1], sys.argv[2])' "$1" "$2"
  else
    die "cần GNU mv (coreutils) hoặc python3 để đổi symlink WEB_ROOT/current nguyên tử"
  fi
}

# Trỏ WEB_ROOT/current → <tên thư mục con> nguyên tử (symlink tạm + rename). nginx thấy ngay, không cần reload.
point_current() {
  local target="$1" root
  root="$(web_root)" || exit 1
  ln -sfn "$target" "$root/.current.$$" || return 1
  atomic_rename "$root/.current.$$" "$root/current" || { rm -f "$root/.current.$$"; return 1; }
}

# Tag mà WEB_ROOT/current đang trỏ tới (rỗng nếu chưa có).
web_current_tag() {
  local link
  link="$(web_root)" || exit 1
  link="$link/current"
  [[ -L "$link" ]] || return 0
  basename "$(readlink "$link")"
}

# Xoá bản chuẩn bị dở (.publish-new-*) và symlink tạm của lần chạy trước — trừ thư mục `current` đang trỏ tới.
# Không bao giờ xoá .publish-old-* (bản cũ để lại khi thay thất bại): chỉ cảnh báo.
cleanup_web_staging() {
  local root="$1" cur entry
  cur="$(readlink "$root/current" 2>/dev/null || true)"
  for entry in "$root"/.publish-new-* "$root"/.current.*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    [[ "$(basename "$entry")" == "$cur" ]] && continue
    rm -rf -- "$entry"
  done
  for entry in "$root"/.publish-old-*; do
    [[ -e "$entry" ]] && log "CẢNH BÁO: còn $entry từ một lần thay web lỗi trước — kiểm rồi xoá tay"
  done
  return 0
}

# Chép dist của image ottm-web:<tag> ra thư mục chuẩn bị WEB_ROOT/.publish-new-<tag>.<pid> (chưa phục vụ, chưa đụng
# thư mục đang chạy). Đặt STAGED_WEB. Lỗi/ngắt → thư mục tạm và container tạm bị dọn. activate_web đưa nó vào chỗ.
publish_web() {
  local tag="$1" root staged
  [[ "$tag" =~ $TAG_RE && "$tag" != current ]] || die "tag không hợp lệ: $tag"
  root="$(web_root)" || exit 1
  cleanup_web_staging "$root"
  staged="$root/.publish-new-$tag.$$"
  mkdir "$staged" || die "không tạo được $staged"
  _LIB_TMP="$staged"
  _LIB_CID="$(docker create "ottm-web:$tag" noop 2>/dev/null)" || { _LIB_CID=""; die "không có image ottm-web:$tag"; }
  docker cp "$_LIB_CID:/dist/." "$staged/" >/dev/null || die "không chép được dist từ ottm-web:$tag"
  docker rm "$_LIB_CID" >/dev/null 2>&1 || true
  _LIB_CID=""
  [[ -f "$staged/index.html" ]] || die "ottm-web:$tag không có index.html — build web hỏng"
  printf '%s\n' "$tag" >"$staged/$WEB_MARKER"
  # nginx (www-data) chỉ cần đọc.
  chmod -R a+rX,go-w "$staged"
  STAGED_WEB="$staged"
  log "web đã chuẩn bị: $staged (chưa phục vụ)"
}

# Đưa bản chuẩn bị vào WEB_ROOT/<tag> và trỏ `current` sang. Không lúc nào `current` trỏ vào thư mục thiếu.
activate_web() {
  local tag="$1" staged="$2" root dest old prev
  root="$(web_root)" || exit 1
  dest="$root/$tag"
  prev="$(readlink "$root/current" 2>/dev/null || true)"
  [[ -f "$staged/index.html" ]] || die "không có bản chuẩn bị $staged"
  _LIB_TMP="" # từ đây tự xử lý lỗi (staged có thể đang được phục vụ)
  if [[ ! -e "$dest" && ! -L "$dest" ]]; then
    mv -- "$staged" "$dest" || { rm -rf -- "$staged"; die "không đổi tên $staged thành $dest — web chưa đổi"; }
    point_current "$tag" || die "không đổi được $root/current — web vẫn là ${prev:-chưa có}"
    log "web: $root/current → $tag"
    return 0
  fi
  # Deploy lại cùng tag: phục vụ bản chuẩn bị trong lúc thay thư mục cũ, rồi mới trỏ về <tag>.
  old="$root/.publish-old-$tag.$$"
  point_current "$(basename "$staged")" || { rm -rf -- "$staged"; die "không đổi được $root/current — web chưa đổi"; }
  if ! mv -- "$dest" "$old"; then
    [[ -z "$prev" ]] || point_current "$prev" || true
    rm -rf -- "$staged"
    die "không dời được $dest — web giữ nguyên"
  fi
  if ! cp -a -- "$staged" "$dest"; then
    rm -rf -- "$dest"
    if mv -- "$old" "$dest"; then
      [[ -z "$prev" ]] || point_current "$prev" || true
      rm -rf -- "$staged"
      die "không chép được bản mới vào $dest — đã trả lại bản cũ"
    fi
    die "không chép được bản mới vào $dest và không trả lại được bản cũ ($old) — current đang trỏ $(basename "$staged"); sửa tay"
  fi
  point_current "$tag" || die "không đổi được $root/current về $tag — đang trỏ $(basename "$staged"); sửa tay"
  rm -rf -- "$staged" "$old"
  log "web: $root/current → $tag (thay bản cùng tag)"
}

# Trỏ `current` về một tag đã có thư mục (rollback).
switch_web() {
  local tag="$1" root
  [[ "$tag" =~ $TAG_RE && "$tag" != current ]] || die "tag không hợp lệ: $tag"
  root="$(web_root)" || exit 1
  [[ -f "$root/$tag/index.html" ]] || die "không có $root/$tag/index.html — chưa xuất bản web của tag $tag"
  point_current "$tag" || die "không đổi được $root/current"
  log "web: $root/current → $tag"
}

# Tag còn rollback được: có image ottm-server và thư mục web.
can_rollback_to() {
  local tag="$1" root wmode
  [[ -n "$tag" && "$tag" =~ $TAG_RE && "$tag" != current ]] || return 1
  wmode="$(web_mode)" || return 1
  if [[ "$wmode" == vps ]]; then
    root="$(web_root)" || return 1
    [[ -f "$root/$tag/index.html" ]] || return 1
  fi
  docker image inspect "ottm-server:$tag" >/dev/null 2>&1
}

# Chờ api trả /healthz 200 qua cổng loopback của máy chủ (không phụ thuộc nginx/DNS/TLS). Trả 1 nếu quá hạn
# (hạn tính theo đồng hồ, gồm cả thời gian curl chờ).
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
      return 0
    fi
    if [[ "$status" == 503 && "$body" == *'"db":"ok"'* && "$body" == *'"worker":"ok"'* && "$body" == *'"disk":"full"'* ]]; then
      log "CẢNH BÁO: ĐĨA ĐÃ DÙNG >85% — app chạy nhưng /healthz trả 503 (runbook.md mục 5). $body"
      return 0
    fi
    if ((SECONDS + 3 >= deadline)); then break; fi
    sleep 3
  done
  log "healthz ($url) chưa 200 sau ${timeout}s: ${body:-không phản hồi}"
  return 1
}

# Giữ KEEP_TAGS tag mới nhất (theo thứ tự tag của ottm-server) + tag đang chạy + tag web đang `current`, áp CÙNG
# một tập cho mọi image và cho thư mục WEB_ROOT/<tag>, để rollback luôn có đủ server/backup/web của một tag.
prune_images() {
  local current="$1" image tag root="" web_current="" dir name wmode
  [[ "$KEEP_TAGS" =~ ^[1-9][0-9]*$ ]] || die "KEEP_TAGS phải là số nguyên dương (đang là '$KEEP_TAGS')"
  wmode="$(web_mode)" || exit 1
  # WEB_MODE=external: không có thư mục web trên VPS — chỉ dọn image.
  if [[ "$wmode" == vps ]]; then
    check_host_paths
    root="$(web_root)" || exit 1
    web_current="$(web_current_tag)" || exit 1
  fi
  local -A keep=(["$current"]=1)
  [[ -n "$web_current" ]] && keep["$web_current"]=1
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
  # Thư mục web: chỉ thư mục thật do publish_web tạo (có $WEB_MARKER khớp tên), không phải `current`.
  if [[ -n "$root" && -d "$root" ]]; then
    for dir in "$root"/*/; do
      dir="${dir%/}"
      name="$(basename "$dir")"
      [[ -d "$dir" && ! -L "$dir" && "$name" != current && "$name" =~ $TAG_RE && -z "${keep[$name]:-}" ]] || continue
      [[ -f "$dir/$WEB_MARKER" && "$(head -n1 "$dir/$WEB_MARKER")" == "$name" ]] || continue
      log "xoá web cũ $dir"
      rm -rf -- "$dir"
    done
  fi
}
