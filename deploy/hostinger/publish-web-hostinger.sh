#!/usr/bin/env bash
# Build web cho Hostinger (api ở VPS) và đưa lên hosting qua SSH (rsync). Chạy trên máy dev hoặc VPS — nơi có
# mã nguồn + Node 24. Hướng dẫn đầy đủ: deploy/runbook.md mục 8 "Chế độ tách: web trên Hostinger".
#
#   VITE_API_ORIGIN=https://api.example.com \
#   HOSTINGER_SSH=u123456789@145.1.2.3 HOSTINGER_SSH_PORT=65002 \
#   HOSTINGER_PATH=domains/app.example.com/public_html \
#   WEB_BASE_URL=https://app.example.com \
#     ./deploy/hostinger/publish-web-hostinger.sh [--prune-assets] [--skip-build]
#
# Biến:
#   VITE_API_ORIGIN    (bắt buộc) origin của api trên VPS, https, không path. Nhúng vào bundle + CSP của .htaccess.
#   HOSTINGER_SSH      user@host SSH của Hostinger (hPanel › Advanced › SSH Access). Trống → chỉ build rồi in hướng
#                      dẫn upload bằng File Manager.
#   HOSTINGER_SSH_PORT cổng SSH (Hostinger thường là 65002). Mặc định 22.
#   HOSTINGER_PATH     thư mục gốc web trên hosting, tương đối với home hoặc tuyệt đối (vd domains/<miền>/public_html).
#   ALLOW_DIRTY=1      cho phép build/xuất bản khi web/, packages/, deploy/hostinger/, package*.json có thay đổi chưa
#                      commit (mặc định từ chối — dist phải khớp một commit).
#   WEB_BASE_URL       (tuỳ chọn) URL web để kiểm sau khi upload bằng check-htaccess.sh (deep link 200, CSP có
#                      origin api, assets immutable).
# Cờ:
#   --prune-assets     sau khi index.html mới đã lên: xoá file trong assets/ trên hosting không thuộc bản build này
#                      (tức không còn được index.html mới tải, trực tiếp hay qua chunk). Tab còn mở bản cũ sẽ lỗi khi
#                      tải chunk cũ → người dùng tải lại trang. Mặc định KHÔNG xoá gì trên hosting.
#   --skip-build       dùng web/dist có sẵn (đã build với đúng VITE_API_ORIGIN).
#
# Thứ tự upload: assets/ trước (file mới có hash, chưa ai tham chiếu), rồi file gốc + .htaccess, index.html cuối cùng
# — trình duyệt không bao giờ thấy index.html trỏ tới asset chưa có.
set -euo pipefail

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'LỖI: %s\n' "$*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST="$REPO_DIR/web/dist"
PRUNE=0
BUILD=1
for arg in "$@"; do
  case "$arg" in
    --prune-assets) PRUNE=1 ;;
    --skip-build) BUILD=0 ;;
    -h | --help)
      sed -n '2,28p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "cờ lạ: $arg (xem --help)" ;;
  esac
done

API_ORIGIN="${VITE_API_ORIGIN:-}"
API_ORIGIN="${API_ORIGIN%/}"
[[ -n "$API_ORIGIN" ]] || die "đặt VITE_API_ORIGIN=https://api.<miền> (origin api trên VPS)"
[[ "$API_ORIGIN" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
  || die "VITE_API_ORIGIN phải là origin https, không path (vd https://api.example.com), đang là '$API_ORIGIN'"

# dist phải đúng mã đã commit (kể cả khi --skip-build: dist lấy từ cây hiện tại). ALLOW_DIRTY=1 để bỏ qua.
if [[ "${ALLOW_DIRTY:-0}" != 1 ]]; then
  dirty="$(git -C "$REPO_DIR" status --porcelain -- web packages deploy/hostinger package.json package-lock.json 2>/dev/null)" \
    || die "không kiểm được cây mã bằng git ($REPO_DIR không phải git repo?) — đặt ALLOW_DIRTY=1 nếu chắc chắn"
  if [[ -n "$dirty" ]]; then
    printf '%s\n' "$dirty" >&2
    die "cây mã có thay đổi chưa commit (kể cả file chưa track) — web xuất bản sẽ không khớp commit nào. Commit/stash, hoặc đặt ALLOW_DIRTY=1."
  fi
fi

if ((BUILD)); then
  command -v npm >/dev/null || die "chưa cài Node/npm (cần Node 24)"
  log "build web với VITE_API_ORIGIN=$API_ORIGIN"
  (cd "$REPO_DIR" && VITE_API_ORIGIN="$API_ORIGIN" npm run build -w web)
fi

[[ -f "$DIST/index.html" ]] || die "không có $DIST/index.html — build lỗi?"
[[ -f "$DIST/.htaccess" ]] || die "không có $DIST/.htaccess — build bằng vite.config.ts của repo này"
[[ -d "$DIST/assets" ]] && [[ -n "$(ls -A "$DIST/assets")" ]] || die "$DIST/assets trống — build lỗi?"
grep -q "connect-src 'self' $API_ORIGIN;" "$DIST/.htaccess" \
  || die "$DIST/.htaccess không mang origin api $API_ORIGIN (build với VITE_API_ORIGIN khác?) — build lại, bỏ --skip-build"
grep -rqF "$API_ORIGIN" "$DIST/assets" \
  || die "bundle trong $DIST/assets không mang origin api $API_ORIGIN — build lại với đúng VITE_API_ORIGIN, bỏ --skip-build"
log "dist sẵn sàng: $(find "$DIST" -type f | wc -l | tr -d ' ') file"

if [[ -z "${HOSTINGER_SSH:-}" ]]; then
  cat >&2 <<EOF

Chưa đặt HOSTINGER_SSH — không upload. Upload tay bằng hPanel › Files › File Manager vào thư mục gốc web
(thường là public_html của tên miền web), ĐÚNG THỨ TỰ:
  1. Bật "Show hidden files" (để thấy .htaccess).
  2. Upload toàn bộ thư mục  $DIST/assets  vào  public_html/assets  (ghi đè nếu trùng tên; không xoá file cũ).
  3. Upload các file gốc trong  $DIST  trừ index.html:  .htaccess, favicon.svg, icons.svg, …
  4. Upload  $DIST/index.html  cuối cùng.
  5. Mở  <web>/trang-nhom  (deep link) → phải thấy app, không phải 404.
Không xoá file nào khác trên hosting. Tuỳ chọn: sau vài ngày, xoá trong public_html/assets các file không có trong
$DIST/assets (bản cũ).
EOF
  exit 0
fi

command -v rsync >/dev/null || die "chưa cài rsync"
command -v ssh >/dev/null || die "chưa cài ssh"
REMOTE_PATH="${HOSTINGER_PATH:-}"
REMOTE_PATH="${REMOTE_PATH%/}"
[[ -n "$REMOTE_PATH" ]] || die "đặt HOSTINGER_PATH (vd domains/app.example.com/public_html)"
[[ "$REMOTE_PATH" =~ ^/?[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$ ]] \
  || die "HOSTINGER_PATH chỉ gồm chữ, số, _ . - và /, đang là '$REMOTE_PATH'"
[[ "/$REMOTE_PATH/" != *"/../"* && "/$REMOTE_PATH/" != *"/./"* ]] || die "HOSTINGER_PATH không được có '.' hoặc '..'"
# Neo theo đoạn đường dẫn: nhận public_html, domains/<miền>/public_html[/…]; không nhận x/public_html_old.
[[ "/$REMOTE_PATH/" == */public_html/* || "${HOSTINGER_ALLOW_ANY_PATH:-0}" == 1 ]] \
  || die "HOSTINGER_PATH '$REMOTE_PATH' không nằm trong public_html — đặt HOSTINGER_ALLOW_ANY_PATH=1 nếu chắc chắn"
PORT="${HOSTINGER_SSH_PORT:-22}"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] || die "HOSTINGER_SSH_PORT phải là số cổng"
SSH=(ssh -p "$PORT" -o BatchMode=yes)
DEST="$HOSTINGER_SSH:$REMOTE_PATH"
# Không đẩy chủ sở hữu của máy build; quyền thư mục 755, file 644 như Hostinger mặc định (u=rwX,go=rX).
RSYNC=(rsync -rlt --chmod=u=rwX,go=rX -e "${SSH[*]}")

log "kiểm SSH tới $HOSTINGER_SSH (cổng $PORT)"
"${SSH[@]}" "$HOSTINGER_SSH" "mkdir -p '$REMOTE_PATH/assets' && test -w '$REMOTE_PATH'" \
  || die "không SSH được hoặc không ghi được $REMOTE_PATH (khoá SSH đã thêm ở hPanel? đúng cổng?)"

log "1/3 assets/ (chỉ thêm, không xoá)"
"${RSYNC[@]}" "$DIST/assets/" "$DEST/assets/"
log "2/3 file gốc + .htaccess (trừ index.html)"
"${RSYNC[@]}" --exclude '/assets/' --exclude '/index.html' "$DIST/" "$DEST/"
log "3/3 index.html"
"${RSYNC[@]}" "$DIST/index.html" "$DEST/index.html"

if ((PRUNE)); then
  log "--prune-assets: xoá trong $REMOTE_PATH/assets các file không thuộc bản build này"
  "${RSYNC[@]}" --delete --itemize-changes "$DIST/assets/" "$DEST/assets/"
fi

if [[ -n "${WEB_BASE_URL:-}" ]]; then
  log "kiểm ${WEB_BASE_URL%/} (SPA fallback, header, cache)"
  bash "$(dirname "${BASH_SOURCE[0]}")/check-htaccess.sh" "$WEB_BASE_URL" "$API_ORIGIN" \
    || die "web đã upload nhưng kiểm sau upload lỗi — xem deploy/runbook.md mục 8"
fi
log "xong: web lên $DEST (api: $API_ORIGIN)"
