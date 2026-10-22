#!/usr/bin/env bash
# Gọi stack qua reverse proxy (nginx của chủ shop) và kiểm route, header bảo mật, CORS, SPA fallback, /media theo ma
# trận của story 1.3 (+ 1.3c; 1.3d: web là container sau nginx — deep link, asset, đúng một Cache-Control).
#   ./deploy/smoke-test.sh http://localhost            # CI (nginx mẫu ở cổng 80, không TLS)
#   ./deploy/smoke-test.sh https://app.example.com     # sau deploy trên VPS (WEB_MODE=vps)
#   SMOKE_MODE=api ORIGIN=https://app.example.com ./deploy/smoke-test.sh https://api.example.com   # WEB_MODE=external
# Biến tuỳ chọn:
#   SMOKE_MODE              vps (mặc định: web + api cùng host, mẫu nginx.conf.example) | api (host api của chế độ
#                           tách, mẫu nginx-api.conf.example: / và đường lạ → JSON 404, không có SPA; bắt buộc ORIGIN)
#   ORIGIN                  origin web hợp lệ (trong ALLOWED_ORIGINS) cho request ghi (mặc định = URL gốc truyền vào).
#                           Chỉ khi đặt ORIGIN mới kiểm CORS (preflight, GET kèm Origin) — deploy.sh luôn đặt.
#   SMOKE_MEDIA_FILE        tên file có thật trong volume media (vd smoke.txt) để kiểm /media/<file> → 200
#   SMOKE_MEDIA_CONTENT     nội dung mong đợi của file đó
#   SMOKE_ALLOW_DISK_FULL=1 chấp nhận /healthz 503 khi lý do duy nhất là disk:"full" (máy CI ít đĩa trống)
#   SMOKE_LOGIN=1           kiểm thêm POST /api/v1/auth/login (Origin hợp lệ/lạ). Mặc định tắt: mỗi lần chạy
#                           là một lần đăng nhập sai, tốn hạn mức 5 lần/15 phút của chủ shop trên production.
set -uo pipefail

BASE="${1:?cách dùng: smoke-test.sh <url-gốc>}"
BASE="${BASE%/}"
CHECK_CORS=0
[[ -n "${ORIGIN:-}" ]] && CHECK_CORS=1
ORIGIN="${ORIGIN:-$BASE}"
ORIGIN="${ORIGIN%/}"
SMOKE_MODE="${SMOKE_MODE:-vps}"
[[ "$SMOKE_MODE" == vps || "$SMOKE_MODE" == api ]] || { echo "SMOKE_MODE phải là vps hoặc api"; exit 2; }
# Host api không phải origin web (không nằm trong ALLOWED_ORIGINS) → mặc định ORIGIN = URL gốc sẽ cho 403 khó hiểu.
if [[ "$SMOKE_MODE" == api && "$CHECK_CORS" != 1 ]]; then
  echo "SMOKE_MODE=api cần ORIGIN = origin web trong ALLOWED_ORIGINS (vd ORIGIN=https://app.example.com)"
  exit 2
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ottm-smoke.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok   - $*"; }
fail() { echo "FAIL - $*"; failures=$((failures + 1)); }

# request <tên> <method> <path> [curl args...] → đặt STATUS, BODY, HEADERS (file).
request() {
  local name="$1" method="$2" path="$3"
  shift 3
  HEADERS="$WORK/$name.headers"
  BODY_FILE="$WORK/$name.body"
  STATUS="$(curl -sS --connect-timeout 5 --max-time 20 -o "$BODY_FILE" -D "$HEADERS" -w '%{http_code}' -X "$method" "$@" "$BASE$path" 2>"$WORK/$name.err")" || STATUS="000"
  BODY="$(cat "$BODY_FILE" 2>/dev/null || true)"
}

header_value() { grep -i "^$1:" "$HEADERS" | head -n1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
header_count() { grep -ci "^$1:" "$HEADERS"; }

# Đúng một Cache-Control (container web quyết cho đường web; nginx máy chủ không thêm cái thứ hai) và chứa $2.
expect_cache_control() {
  local name="$1" want="$2" n
  n="$(header_count Cache-Control)"
  if [[ "$n" == 1 && "$(header_value Cache-Control)" == *"$want"* ]]; then
    pass "$name: Cache-Control $(header_value Cache-Control)"
  else
    fail "$name: mong đúng một Cache-Control chứa '$want', nhận $n: $(grep -i '^Cache-Control:' "$HEADERS" | tr -d '\r' | tr '\n' ' ')"
  fi
}

check_security_headers() {
  local name="$1" missing=() h
  for h in Content-Security-Policy Strict-Transport-Security Referrer-Policy; do
    [[ -n "$(header_value "$h")" ]] || missing+=("$h")
  done
  [[ "$(header_value X-Content-Type-Options)" == "nosniff" ]] || missing+=("X-Content-Type-Options: nosniff")
  local csp
  csp="$(header_value Content-Security-Policy)"
  # Host web (vps): CSP của app; host api (api): không cho tải gì (default-src 'none').
  local want_default="default-src 'self'"
  [[ "$SMOKE_MODE" == api ]] && want_default="default-src 'none'"
  [[ "$csp" == *"$want_default"* && "$csp" == *"frame-ancestors 'none'"* ]] || missing+=("CSP $want_default/frame-ancestors")
  if ((${#missing[@]} == 0)); then
    pass "$name: header bảo mật đủ"
  else
    fail "$name: thiếu ${missing[*]}"
  fi
}

expect_status() {
  local name="$1" want="$2"
  if [[ "$STATUS" == "$want" ]]; then pass "$name: HTTP $STATUS"; else fail "$name: mong $want, nhận $STATUS — $(head -c 300 "$BODY_FILE" 2>/dev/null)"; fi
}

expect_body_contains() {
  local name="$1" needle="$2"
  if [[ "$BODY" == *"$needle"* ]]; then pass "$name: body có $needle"; else fail "$name: body thiếu $needle — $(printf '%s' "$BODY" | head -c 300)"; fi
}

expect_api_json() {
  local name="$1" code="$2"
  local ctype
  ctype="$(header_value Content-Type)"
  if [[ "$ctype" == application/json* && "$BODY" == *"\"code\":\"$code\""* ]]; then
    pass "$name: JSON lỗi $code từ api"
  else
    fail "$name: không phải JSON $code của api (Content-Type: $ctype) — $(printf '%s' "$BODY" | head -c 300)"
  fi
}

# --- /healthz → api
request healthz GET /healthz
check_security_headers "/healthz"
if [[ "$STATUS" == 200 && "$BODY" == *'"ok":true'* && "$BODY" == *'"db":"ok"'* && "$BODY" == *'"worker":"ok"'* && "$BODY" == *'"disk":"ok"'* ]]; then
  pass "/healthz: 200 $BODY"
elif [[ "${SMOKE_ALLOW_DISK_FULL:-0}" == 1 && "$STATUS" == 503 && "$BODY" == *'"db":"ok"'* && "$BODY" == *'"worker":"ok"'* && "$BODY" == *'"disk":"full"'* ]]; then
  pass "/healthz: 503 chỉ vì đĩa máy chạy >85% (được phép ở CI) $BODY"
else
  fail "/healthz: HTTP $STATUS $BODY"
fi

# --- /api/* → api (cần phiên)
request api-me GET /api/v1/auth/me
expect_status "/api/v1/auth/me" 401
expect_api_json "/api/v1/auth/me" UNAUTHENTICATED
check_security_headers "/api/v1/auth/me"

# --- CORS /api/v1/* (api tự đặt theo ALLOWED_ORIGINS; nginx chuyển nguyên). Cùng host thì ORIGIN = PUBLIC_BASE_URL,
# cũng nằm trong ALLOWED_ORIGINS nên cũng nhận header CORS.
if ((CHECK_CORS)); then
  request cors-preflight OPTIONS /api/v1/auth/login -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type'
  expect_status "OPTIONS /api/v1/auth/login (Origin $ORIGIN)" 204
  if [[ "$(header_value Access-Control-Allow-Origin)" == "$ORIGIN" && "$(header_value Access-Control-Allow-Credentials)" == true ]]; then
    pass "preflight: Allow-Origin $ORIGIN, Allow-Credentials true"
  else
    fail "preflight: Allow-Origin '$(header_value Access-Control-Allow-Origin)', Allow-Credentials '$(header_value Access-Control-Allow-Credentials)' (ALLOWED_ORIGINS có $ORIGIN?)"
  fi
  [[ "$(header_value Access-Control-Allow-Headers)" == *Content-Type* ]] && pass "preflight: Allow-Headers có Content-Type" \
    || fail "preflight: Allow-Headers '$(header_value Access-Control-Allow-Headers)'"
  [[ "$(header_value Vary)" == *Origin* ]] && pass "preflight: Vary: Origin" || fail "preflight: Vary '$(header_value Vary)'"

  request cors-preflight-evil OPTIONS /api/v1/auth/login -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST'
  expect_status "OPTIONS /api/v1/auth/login (Origin lạ)" 204
  [[ -z "$(header_value Access-Control-Allow-Origin)" ]] && pass "preflight Origin lạ: không có Allow-Origin" \
    || fail "preflight Origin lạ: có Allow-Origin '$(header_value Access-Control-Allow-Origin)'"

  request cors-me GET /api/v1/auth/me -H "Origin: $ORIGIN"
  expect_status "GET /api/v1/auth/me (Origin $ORIGIN)" 401
  [[ "$(header_value Access-Control-Allow-Origin)" == "$ORIGIN" ]] && pass "GET 401 có Allow-Origin" \
    || fail "GET 401: Allow-Origin '$(header_value Access-Control-Allow-Origin)'"
else
  echo "skip - CORS: chưa đặt ORIGIN"
fi

if [[ "${SMOKE_LOGIN:-0}" == 1 ]]; then
  # Request ghi với Origin hợp lệ (trong ALLOWED_ORIGINS) tới được bước kiểm mật khẩu.
  # 429 cũng được: IP đã hết lượt thử (vẫn chứng tỏ qua được kiểm Origin).
  request api-login POST /api/v1/auth/login -H "Origin: $ORIGIN" -H 'Content-Type: application/json' \
    --data '{"password":"smoke-test-sai-mat-khau"}'
  if [[ "$STATUS" == 401 ]]; then
    expect_api_json "POST /api/v1/auth/login (Origin hợp lệ)" INVALID_CREDENTIALS
  elif [[ "$STATUS" == 429 ]]; then
    expect_api_json "POST /api/v1/auth/login (Origin hợp lệ, đã hết lượt)" RATE_LIMITED
  else
    fail "POST /api/v1/auth/login (Origin hợp lệ): mong 401/429, nhận $STATUS — $(printf '%s' "$BODY" | head -c 300)"
  fi

  request api-login-evil POST /api/v1/auth/login -H 'Origin: https://evil.example' -H 'Content-Type: application/json' \
    --data '{"password":"smoke-test-sai-mat-khau"}'
  expect_status "POST /api/v1/auth/login (Origin lạ)" 403
  expect_api_json "POST /api/v1/auth/login (Origin lạ)" FORBIDDEN
fi

# --- /webhooks/*, /oauth/*, /privacy/* → api (chưa có route ở story này: 404 JSON của api, không phải index.html)
for path in /webhooks/meta /oauth/meta/callback /privacy/xoa-du-lieu /api /webhooks /privacy; do
  name="api${path//\//-}"
  request "$name" GET "$path"
  expect_status "$path" 404
  expect_api_json "$path" NOT_FOUND
  check_security_headers "$path"
done

if [[ "$SMOKE_MODE" == api ]]; then
  # --- Host api không phục vụ web (web ở Hostinger): / và đường lạ → JSON 404, không bao giờ index.html
  for path in / /hop-thu /assets/index.js; do
    name="not-api${path//\//-}"
    request "$name" GET "$path"
    expect_status "$path" 404
    expect_api_json "$path" NOT_FOUND
    [[ "$BODY" != *'id="root"'* ]] && pass "$path: không phải index.html" || fail "$path: trả index.html"
    check_security_headers "$path"
    [[ "$(header_value Cache-Control)" == *no-store* ]] && pass "$path: Cache-Control no-store" || fail "$path: Cache-Control '$(header_value Cache-Control)'"
  done
else
  # --- SPA (container web sau nginx)
  request spa-root GET /
  expect_status "/" 200
  expect_body_contains "/" 'id="root"'
  check_security_headers "/"
  expect_cache_control "/" no-cache

  for path in /hop-thu /trang-nhom/abc; do
    name="spa${path//\//-}"
    request "$name" GET "$path"
    expect_status "$path (SPA fallback)" 200
    expect_body_contains "$path (SPA fallback)" 'id="root"'
    [[ "$(header_value Content-Type)" == text/html* ]] && pass "$path: text/html" || fail "$path: Content-Type $(header_value Content-Type)"
    check_security_headers "$path"
    expect_cache_control "$path" no-cache
  done

  asset="$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$WORK/spa-root.body" | head -n1 || true)"
  if [[ -n "$asset" ]]; then
    request spa-asset GET "$asset"
    expect_status "$asset" 200
    [[ "$BODY" != *'id="root"'* ]] && pass "$asset: là file JS, không phải index.html" || fail "$asset: trả index.html"
    check_security_headers "$asset"
    expect_cache_control "$asset" immutable
  else
    fail "index.html không tham chiếu file /assets/*.js"
  fi

  request asset-missing GET /assets/khong-ton-tai-0190.js
  expect_status "/assets/<thiếu>" 404
  [[ "$BODY" != *'id="root"'* ]] && pass "/assets/<thiếu>: không rơi về index.html" || fail "/assets/<thiếu>: trả index.html"
  check_security_headers "/assets/<thiếu>"
  expect_cache_control "/assets/<thiếu>" no-store
fi

# --- /media
if [[ -n "${SMOKE_MEDIA_FILE:-}" ]]; then
  request media-ok GET "/media/$SMOKE_MEDIA_FILE"
  expect_status "/media/$SMOKE_MEDIA_FILE" 200
  [[ -z "${SMOKE_MEDIA_CONTENT:-}" ]] || expect_body_contains "/media/$SMOKE_MEDIA_FILE" "$SMOKE_MEDIA_CONTENT"
  csp="$(header_value Content-Security-Policy)"
  [[ "$csp" == *sandbox* && "$csp" == *"default-src 'none'"* ]] && pass "/media/$SMOKE_MEDIA_FILE: CSP sandbox" || fail "/media/$SMOKE_MEDIA_FILE: CSP '$csp'"
  [[ "$(header_value X-Content-Type-Options)" == nosniff ]] && pass "/media/$SMOKE_MEDIA_FILE: nosniff" || fail "/media/$SMOKE_MEDIA_FILE: thiếu nosniff"
  [[ -n "$(header_value Strict-Transport-Security)" && -n "$(header_value Referrer-Policy)" ]] \
    && pass "/media/$SMOKE_MEDIA_FILE: HSTS, Referrer-Policy" || fail "/media/$SMOKE_MEDIA_FILE: thiếu HSTS/Referrer-Policy"
fi

request media-missing GET /media/khong-ton-tai-0190.png
expect_status "/media/<thiếu>" 404
[[ "$BODY" != *'id="root"'* ]] && pass "/media/<thiếu>: không rơi về index.html" || fail "/media/<thiếu>: trả index.html"
check_security_headers "/media/<thiếu>"

if ((failures > 0)); then
  echo "smoke-test: $failures lỗi"
  exit 1
fi
echo "smoke-test: tất cả ok"
