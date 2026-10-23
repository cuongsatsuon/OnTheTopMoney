#!/usr/bin/env bash
# Kiểm web tĩnh do Apache/LiteSpeed phục vụ theo dist/.htaccess (Hostinger, hoặc httpd cục bộ/CI với AllowOverride All):
# SPA fallback, /assets thiếu → 404, header bảo mật, CSP có origin api, cache.
#   ./deploy/hostinger/check-htaccess.sh http://localhost:8088 https://api.example.com
#   ./deploy/hostinger/check-htaccess.sh https://app.example.com https://api.example.com   # sau khi upload lên Hostinger
set -uo pipefail

BASE="${1:?cách dùng: check-htaccess.sh <url-web> <origin-api>}"
BASE="${BASE%/}"
API="${2:?cách dùng: check-htaccess.sh <url-web> <origin-api>}"
API="${API%/}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ottm-htaccess.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok   - $*"; }
fail() { echo "FAIL - $*"; failures=$((failures + 1)); }

get() {
  HEADERS="$WORK/h"
  # curl lỗi (không kết nối…) không được để lại header/body của request trước.
  : >"$HEADERS"
  : >"$WORK/b"
  STATUS="$(curl -sS --max-time 15 -o "$WORK/b" -D "$HEADERS" -w '%{http_code}' "$BASE$1" 2>/dev/null)" || STATUS=000
  BODY="$(cat "$WORK/b" 2>/dev/null || true)"
}
hv() { grep -i "^$1:" "$HEADERS" | head -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

security() {
  local csp
  csp="$(hv Content-Security-Policy)"
  [[ "$csp" == *"connect-src 'self' $API"* && "$csp" == *"img-src 'self' data: blob: $API"* && "$csp" == *"media-src 'self' blob: $API"* \
    && "$csp" == *"frame-ancestors 'none'"* ]] \
    && pass "$1: CSP có origin api, frame-ancestors" || fail "$1: CSP '$csp'"
  [[ -n "$(hv Strict-Transport-Security)" && "$(hv X-Content-Type-Options)" == nosniff && -n "$(hv Referrer-Policy)" \
    && "$(hv X-Frame-Options)" == DENY && -n "$(hv Permissions-Policy)" ]] \
    && pass "$1: HSTS, nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy" || fail "$1: thiếu header bảo mật"
}

for path in / /trang-nhom /pages/abc; do
  get "$path"
  [[ "$STATUS" == 200 && "$BODY" == *'id="root"'* ]] && pass "$path: 200 index.html" || fail "$path: HTTP $STATUS"
  [[ "$(hv Cache-Control)" == no-cache ]] && pass "$path: Cache-Control no-cache" || fail "$path: Cache-Control '$(hv Cache-Control)'"
  security "$path"
done

get /
asset="$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' <<<"$BODY" | head -n1 || true)"
if [[ -n "$asset" ]]; then
  get "$asset"
  [[ "$STATUS" == 200 && "$BODY" != *'id="root"'* ]] && pass "$asset: 200 JS" || fail "$asset: HTTP $STATUS"
  [[ "$(hv Cache-Control)" == "public, max-age=31536000, immutable" ]] && pass "$asset: immutable 1 năm" \
    || fail "$asset: Cache-Control '$(hv Cache-Control)'"
  security "$asset"
else
  fail "index.html không tham chiếu /assets/*.js"
fi

get /assets/khong-ton-tai-0190.js
[[ "$STATUS" == 404 && "$BODY" != *'id="root"'* ]] && pass "/assets/<thiếu>: 404, không rơi về index.html" || fail "/assets/<thiếu>: HTTP $STATUS"
security "/assets/<thiếu>"

get /assets/
[[ "$STATUS" == 403 || "$STATUS" == 404 ]] && pass "/assets/: không liệt kê thư mục ($STATUS)" || fail "/assets/: HTTP $STATUS"

get /.htaccess
[[ "$STATUS" == 403 || "$STATUS" == 404 ]] && pass "/.htaccess: không lộ ($STATUS)" || fail "/.htaccess: HTTP $STATUS"

# File ẩn khác (không phải .ht*, không được Apache chặn sẵn): 404 của .htaccess, không phải index.html 200.
for path in /.env /.git/config; do
  get "$path"
  [[ ("$STATUS" == 403 || "$STATUS" == 404) && "$BODY" != *'id="root"'* ]] && pass "$path: không lộ, không rơi về index.html ($STATUS)" \
    || fail "$path: HTTP $STATUS"
done

if ((failures > 0)); then
  echo "check-htaccess: $failures lỗi"
  exit 1
fi
echo "check-htaccess: tất cả ok"
