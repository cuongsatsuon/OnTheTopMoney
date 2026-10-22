---
title: 'Story 1.2 — Đăng nhập chủ sở hữu và lớp gọi API của web'
type: 'feature'
created: '2026-10-22'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot scratchpad/baseline-1-2
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-1-1-khung-monorepo-server-va-hop-dong-chung.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** App chưa có cửa đăng nhập; ai mở được URL là thấy và điều khiển mọi thứ. `web/` cũng chưa có lớp gọi API chung, chưa có chỗ duy nhất ánh xạ mã lỗi sang câu tiếng Việt.

**Approach:** Thêm đăng nhập một chủ sở hữu (mật khẩu argon2id đặt bằng CLI, session cookie trong Postgres), chặn mọi `/api/v1/*` khi chưa có phiên, giới hạn thử sai, kiểm `Origin` cho request ghi. Phía web: màn đăng nhập tối giản, chặn route khi chưa đăng nhập, lớp client API dùng TanStack Query, một file ánh xạ `ErrorCode` → microcopy, và component skeleton dùng chung.

## Boundaries & Constraints

**Always:** AD-19 (session 30 ngày trượt, xoay id khi đăng nhập, cookie `HttpOnly; Secure; SameSite=Lax`, 5 lần sai/15 phút/IP, `Origin` cho request ghi, công khai chỉ `/healthz`, `/webhooks/*`, `/media/*`, `/api/v1/auth/login`, `/oauth/*/callback`, `/privacy/*`), AD-18 (lỗi `{error:{code,message,details?}}`, FE ánh xạ `code` ở một chỗ), AD-12 (không log mật khẩu, token phiên). Bảng thuộc module `settings` (`secrets`, `sessions`). Không có cách tạo tài khoản qua web. Mật khẩu tối thiểu 12 ký tự [ASSUMPTION]. Màn đăng nhập theo token của `web/src/index.css` và Voice and Tone [ASSUMPTION: EXPERIENCE.md chưa có màn này]. Nút "Đăng xuất" đặt ở cuối sidebar [ASSUMPTION].

**Never:** Không nối các màn hiện có sang API thật (giữ dữ liệu mẫu; các story sau nối dần). Không thêm OAuth, TOTP, đa người dùng. Không lưu token phiên dạng thô trong DB.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Đặt mật khẩu | `npm run set-password -w server`, nhập 2 lần khớp, ≥12 ký tự | lưu hash argon2id, xoá mọi phiên cũ | lệch hoặc ngắn → báo, exit ≠ 0 |
| Đăng nhập đúng | `POST /api/v1/auth/login {password}` | 204 + cookie phiên mới; phiên cũ trình kèm bị xoá | N/A |
| Sai mật khẩu | mật khẩu sai | 401 `INVALID_CREDENTIALS` | không lộ đã đặt mật khẩu hay chưa |
| Chưa đặt mật khẩu | login khi chưa có hash | 401 `INVALID_CREDENTIALS` | như trên |
| Thử sai lần 6 | 5 lần sai trong 15 phút cùng IP | 429 `RATE_LIMITED` (kể cả mật khẩu đúng) | đăng nhập đúng xoá bộ đếm của IP |
| Chưa có phiên | `GET /api/v1/auth/me` không cookie / cookie hết hạn / sai | 401 `UNAUTHENTICATED` | N/A |
| Có phiên | `GET /api/v1/auth/me` | 200 `{authenticated:true}`; gia hạn khi còn <29 ngày | N/A |
| Origin lạ | request ghi `/api/v1/*` với `Origin` ngoài danh sách cho phép, hoặc thiếu cả `Origin` lẫn `Sec-Fetch-Site: same-origin` | 403 `FORBIDDEN` | N/A |
| Đăng xuất | `POST /api/v1/auth/logout` | 204, xoá phiên, xoá cookie | không có phiên → vẫn 204 |
| Web chưa đăng nhập | mở `/hop-thu` | chuyển tới `/dang-nhap?next=/hop-thu`; đăng nhập xong quay lại `/hop-thu` | `next` chỉ nhận đường dẫn nội bộ bắt đầu bằng `/` |
| Lỗi API trên web | mọi response lỗi | hiện câu tiếng Việt từ bản đồ mã lỗi; 401 ở route bảo vệ → về màn đăng nhập | mã lạ → câu chung |

</frozen-after-approval>

## Code Map

- `server/src/app/app.ts` -- `buildApp`, error handler đã ánh xạ mã; thêm plugin cookie, auth guard, route auth.
- `server/src/platform/config/index.ts` -- `EnvSchema`; thêm `ALLOWED_ORIGINS` (danh sách, mặc định dev `http://localhost:5173,http://localhost:5174`), `TRUST_PROXY` (bool, mặc định false), `COOKIE_SECURE` (mặc định true).
- `server/src/platform/db/schema.ts`, `server/drizzle.config.ts` -- glob đã gồm `src/modules/*/schema.ts`; sinh migration mới bằng `npm run db:generate -w server`.
- `server/src/modules/settings/index.ts` -- module nền, đang rỗng: đặt ở đây schema + service auth (hash, session).
- `server/test/app-errors.test.ts`, `server/test/global-setup.ts` -- mẫu test `buildApp` + `inject` và DB thật (`inject('databaseUrl')`).
- `packages/shared/src/errors.ts` -- `ERROR_CODES`: thêm `FORBIDDEN`, `INVALID_CREDENTIALS`.
- `web/src/App.tsx` -- router; thêm route `/dang-nhap` ngoài `AppShell`, bọc các route còn lại (kể cả `/bat-dau`) bằng guard.
- `web/src/components/AppShell.tsx` -- sidebar; thêm nút "Đăng xuất" ở cuối.
- `web/src/components/ui.tsx` -- `Button`, `Field`, `Input`, `Card`: dùng lại cho màn đăng nhập.
- `web/vite.config.ts` -- thêm proxy `/api`, `/healthz` → `http://localhost:3000` để cookie cùng origin.
- `web/src/data/mock.ts` -- KHÔNG sửa.

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/errors.ts`, `packages/shared/src/auth.ts` -- thêm mã lỗi; zod `LoginRequest {password}`, `MeResponse` -- hợp đồng chung.
- [x] `server/src/modules/settings/schema.ts` + migration -- bảng `secrets(name pk, kind, value, updated_at)` (hash mật khẩu: `name='owner_password'`, `kind='argon2id'`) và `sessions(id uuidv7, token_hash unique, created_at, last_seen_at, expires_at)`.
- [x] `server/src/modules/settings/auth.ts` + `index.ts` -- `setOwnerPassword`, `verifyOwnerPassword` (`@node-rs/argon2`), `createSession` (token 32 byte ngẫu nhiên, lưu sha256), `resolveSession` (gia hạn trượt), `deleteSession`, `deleteAllSessions`.
- [x] `server/src/app/auth/` -- plugin: cookie `ottm_sid`, guard cho `/api/v1/*` trừ danh sách công khai, kiểm `Origin`, bộ đếm thử sai trong bộ nhớ theo IP (cửa sổ trượt 15 phút), `@fastify/rate-limit` 60 request/phút cho route ghi; route `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`, `GET /api/v1/auth/me`.
- [x] `server/scripts/set-password.ts` + script `set-password` trong `server/package.json` -- nhập ẩn 2 lần, kiểm độ dài, gọi `setOwnerPassword`.
- [x] `server/test/auth.test.ts` -- phủ từng dòng ma trận phía server.
- [x] `web/src/lib/api.ts` -- `apiFetch` (credentials same-origin, JSON, ném `ApiError{code,status,details}` đã parse bằng `ErrorResponse`), `QueryClient` với 401 → đá về đăng nhập.
- [x] `web/src/lib/error-messages.ts` -- `Record<ErrorCode, string>` đầy đủ (TypeScript bắt thiếu mã), hàm `errorMessage(code)`.
- [x] `web/src/components/Skeleton.tsx` -- primitive skeleton dùng lại; `App.tsx` dùng nó cho `Loading`.
- [x] `web/src/lib/auth.tsx` + `web/src/screens/Login.tsx` + `web/src/App.tsx` -- `RequireAuth` (query `/auth/me`, skeleton khi đang tải), màn `/dang-nhap`, điều hướng `next` an toàn.
- [x] `web/src/components/AppShell.tsx` -- nút "Đăng xuất".
- [x] `web/vite.config.ts` -- proxy dev.

**Acceptance Criteria:**
- Given đã chạy `npm run set-password -w server`, when mở `http://localhost:5173/hop-thu` qua `npm run dev`, then thấy màn đăng nhập; nhập đúng mật khẩu thì vào thẳng Hộp thư; bấm "Đăng xuất" thì về màn đăng nhập.
- Given `npm run check`, when chạy ở gốc, then thoát 0 và test mới phủ mọi dòng ma trận phía server.
- Given log của api khi đăng nhập, when đọc, then không có mật khẩu, token phiên hay giá trị cookie.

## Implementation Notes

- **Phụ thuộc mới:** server `@fastify/cookie` 11.1.3, `@fastify/rate-limit` 11.2.1, `@node-rs/argon2` 2.2.2, `fastify-plugin` 6.0.1 (pin chính xác); web `@tanstack/react-query` ^5.104.5. Migration `server/drizzle/0001_settings_auth.sql` sinh bằng drizzle-kit (`drizzle-kit check` sạch).
- **Lỗi miền:** thêm `AppError(code, status, {message, details})` ở `server/src/platform/errors/`; error handler dùng `code` của nó, thêm 403 → `FORBIDDEN`. `@fastify/rate-limit` trả `AppError('RATE_LIMITED')` qua `errorResponseBuilder`.
- **Guard (`server/src/app/auth/`):** plugin không đóng gói (fastify-plugin). Chỉ áp cho `/api/v1/*` (đúng Approach); đường dẫn công khai so khớp chính xác theo mẫu route đã định tuyến, không theo chuỗi URL thô. `POST /api/v1/auth/logout` cũng được miễn phiên vì ma trận yêu cầu "không có phiên → vẫn 204" (chỉ xoá cookie/phiên trình kèm, vô hại) — vẫn qua kiểm `Origin` và rate-limit. Hằng `PUBLIC` giữ đủ danh sách AD-19 cho route ngoài `/api/v1` ở story sau. Kiểm `Origin` chạy trước kiểm phiên, áp cả cho login (chống login CSRF).
- **Phiên:** token 32 byte base64url trong cookie `ottm_sid` (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30 ngày`), DB lưu sha256 hex. `resolveSession` chỉ `UPDATE` khi còn < 29 ngày; khi gia hạn, api đặt lại cookie để Max-Age cũng trượt. Cookie sai/hết hạn → 401 và xoá cookie. Phiên hết hạn được dọn mỗi lần đăng nhập. Chưa đặt mật khẩu → vẫn verify trên một hash giả để thời gian phản hồi không lộ trạng thái.
- **Tham số argon2id:** m=19456 KiB, t=2, p=1 (mặc định OWASP của thư viện). `@node-rs/argon2` khai `Algorithm` là const enum → dùng hằng số 2.
- **Bộ đếm thử sai:** `LoginLimiter` trong bộ nhớ, cửa sổ trượt 15 phút theo `req.ip` (`TRUST_PROXY` bật `trustProxy` của Fastify); body sai schema không tính là lần sai. `buildApp` nhận `loginLimiter` để test dùng đồng hồ giả.
- **Config:** `ALLOWED_ORIGINS` (origin http(s) không path), `TRUST_PROXY`, `COOKIE_SECURE` — bool chỉ nhận `true|false|1|0`. `buildApp` nhận `db` và `http` (`allowedOrigins`, `cookieSecure`, `trustProxy`).
- **`set-password`:** `npm run set-password -w server`; TTY → nhập ẩn (raw mode), không phải TTY → đọc từng dòng stdin (dùng trong test). Không có `DATABASE_URL` và không phải production → dùng Postgres nhúng của `npm run dev` (import động vì `embedded-postgres` là devDependency). Chạy migration trước khi lưu. Lỗi DB chỉ in mã lỗi, không in lỗi thô (có thể chứa URL kèm mật khẩu Postgres).
- **web:** `lib/api.ts` (`apiFetch`, `ApiError`, `createQueryClient` — 401 `UNAUTHENTICATED` ở bất kỳ query/mutation nào đặt `['auth','me']` = null nên `RequireAuth` chuyển về đăng nhập); `lib/error-messages.ts` (`Record<ErrorCode,string>`, `errorMessage`, `errorMessageOf`); `lib/session.ts` (hook `useMe/useLogin/useLogout`, `safeNext`, `loginUrl` — tách khỏi `lib/auth.tsx` để oxlint `only-export-components` sạch); `lib/auth.tsx` (`RequireAuth`); `components/Skeleton.tsx` (`Skeleton`, `ScreenSkeleton` thay `Loading` cũ). `safeNext` chỉ nhận đường dẫn bắt đầu bằng một `/`, chặn `//`, `/\`, ký tự điều khiển và vòng về `/dang-nhap`.
- **Dev proxy:** `web/vite.config.ts` proxy `/api`, `/healthz` → `API_TARGET` (mặc định `http://localhost:3000`).
- **`COOKIE_SECURE` khi dev:** mặc định true; Chrome/Firefox nhận cookie Secure trên `http://localhost` (đã thử qua proxy Vite). Trình duyệt không nhận thì đặt `COOKIE_SECURE=false` trong `server/.env` (ghi ở `.env.example`).
- **Sau review:** lần thử đăng nhập được ghi vào `LoginLimiter.recordAttempt` TRƯỚC khi await verify (đúng thì `reset`), nên request song song cùng IP không vượt 5 lần; log `warn` cho đăng nhập sai (`ip`, `failures`), bị khoá (`ip`) và Origin bị chặn (`ip`, `origin`), không bao giờ log mật khẩu. Mật khẩu chuẩn hoá NFC trước khi hash/verify (và trong CLI). `OWNER_PASSWORD_MAX_LENGTH = 1024` ở shared, `LoginRequest` và CLI cùng dùng. Nhập ẩn TTY dùng `StringDecoder` và bỏ trọn chuỗi escape (`HiddenInput`, có test). Production: `ALLOWED_ORIGINS` bắt buộc và chỉ https, `COOKIE_SECURE=false` bị từ chối; dev mặc định `DEV_ALLOWED_ORIGINS` (một nguồn, `app.ts` dùng lại). `TRUST_PROXY` = chỉ tin một hop (hàm `hop < 1`, vì kiểu Fastify không nhận số). Bỏ hằng `PUBLIC` không dùng. Web: mã `NETWORK_ERROR` (chỉ web dùng) cho fetch thất bại; 2xx không phải JSON / sai schema → `ApiError INTERNAL` giữ status 2xx, chỉ retry status 0 và 5xx; `RequireAuth` chỉ hiện màn lỗi khi chưa có dữ liệu cache; web có vitest 5.0.5 (`session.test.ts`, `api.test.ts`).

- **Kiểm thử trên trình duyệt (sau review):** khi chạy qua công cụ preview, biến `PORT=5173` kế thừa làm api lắng nghe nhầm cổng 5173, proxy Vite không tới api. Sửa `server/scripts/dev.ts`: cổng api lấy từ `server/.env` (mặc định 3000), không lấy `PORT` kế thừa; truyền `API_TARGET` tương ứng cho Vite. Đã chạy lại AC1 trên trình duyệt (chuyển hướng, sai mật khẩu, đúng mật khẩu, tải lại giữ phiên, đăng xuất) và AC3 (log không chứa mật khẩu/cookie).

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind, edge | Đăng nhập song song đều qua `isBlocked` trước khi đếm sai | high | `isBlocked` trước `await verify`, `recordFailure` sau; patch |
| 2 | blind, edge | Mật khẩu không chuẩn hoá NFC (người dùng tiếng Việt) | medium | hash/verify dùng chuỗi thô; patch |
| 3 | blind, edge | CLI nhận mật khẩu >1024 ký tự không đăng nhập được | low | `LoginRequest` max 1024, CLI chỉ kiểm min; sửa trực tiếp; patch |
| 4 | blind, edge | Nhập ẩn TTY tách ký tự nhiều byte, giữ phần dư phím mũi tên | medium | `buf.toString('utf8')` theo chunk; patch |
| 5 | blind, edge | Production rơi về Origin localhost, nhận COOKIE_SECURE=false | medium | `OriginList.default([...localhost])`; patch |
| 6 | blind, edge | `trustProxy: true` tin mọi X-Forwarded-For | medium | `app.ts:37`; đổi sang 1 hop; patch |
| 7 | vgap | Đường TRUST_PROXY → req.ip chưa có test | medium | vgap đã xác minh; patch |
| 8 | blind | Không log đăng nhập sai, khoá, Origin bị từ chối | medium | chỉ log đăng nhập đúng; patch |
| 9 | blind, edge (claim) | `PUBLIC` export không dùng; comment logout sai | low | guard không đọc `PUBLIC`; sửa trực tiếp; patch |
| 10 | edge | Refetch /auth/me lỗi khi đã có cache → cả app thành màn lỗi | medium | `auth.tsx` kiểm `isError` không xét `data`; patch |
| 11 | blind, edge (claim) | 2xx không phải JSON/ZodError thoát khỏi ApiError; mất mạng hiện câu chung | low | `api.ts` không bọc `res.json()`/`parse`; patch |
| 12 | vgap, blind | `safeNext` (chặn open redirect) không có test; web chưa có test runner | medium | vgap đã xác minh; patch |
| 13 | vgap | Xử lý 401 toàn cục ở web chưa có test | medium | vgap đề defer; gộp vào patch vì cùng lúc thêm vitest |
| 14 | blind | Gợi ý đặt lại mật khẩu thiếu lệnh đầy đủ | low | sửa chữ; patch |
| 15 | blind | Mặc định origin lặp ở app.ts và config | low | `DEFAULT_ALLOWED_ORIGINS` trùng config; gộp vào patch trustProxy |
| 16 | edge | dummyHash bị reject sẽ bị cache | low | `hash` chỉ reject khi tham số sai; khó gặp; reject |
| 17 | blind, edge | Ngưỡng gia hạn dùng `Date.now()` lệch đồng hồ DB | low | lệch vài phút chỉ đổi lúc gia hạn; reject |
| 18 | edge (claim) | Rate-limit 60/phút không đếm request ghi bị guard từ chối | low | request bị từ chối rẻ, chưa có phiên; reject |
| 19 | blind | 429 khoá đăng nhập không có Retry-After | low | UX nhỏ; reject |
| 20 | blind, edge | Sweep bậc hai, Map không giới hạn khi nhiều IP | low | cần >1000 IP tấn công app 1 người dùng; sửa thêm giới hạn; reject |
| 21 | blind, edge | Không có trần sai toàn tài khoản, IPv6 /64 | low | argon2 + mật khẩu ≥12 ký tự; reject |
| 22 | blind | 401 toàn cục giữ cache phiên cũ; không đồng bộ đăng xuất giữa tab | low | một chủ sở hữu duy nhất; reject |
| 23 | edge | set-password crash khi production thiếu DATABASE_URL | low | production luôn có DATABASE_URL; reject |
| 25 | kiểm thử tay | api nhận `PORT` kế thừa của công cụ chạy, tranh cổng với Vite | medium | tái hiện qua preview: api nghe 5173, proxy 502; patch trong `dev.ts` |
| 24 | blind | `deleteAllSessions` không dùng; tiền tố `__Host-`; tên `last_seen_at` | low | không có hại thực tế; reject |

## Design Notes

Bộ đếm thử sai để trong bộ nhớ vì chỉ có một bản api (Structural Seed); khởi động lại sẽ xoá bộ đếm, chấp nhận được. Gia hạn phiên chỉ ghi DB khi `expires_at - now() < 29 ngày` để không ghi mỗi request.

```ts
// guard: route công khai so khớp tiền tố, còn lại cần phiên
const PUBLIC = ['/healthz', '/webhooks/', '/media/', '/privacy/', '/oauth/', '/api/v1/auth/login']
```

## Verification

**Commands:**
- `npm run check` -- expected: exit 0
- `npm run dev`, rồi `curl -s -o /dev/null -w '%{http_code}' localhost:3000/api/v1/auth/me` -- expected: 401
- Manual: mở trình duyệt theo AC thứ nhất.
