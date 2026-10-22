---
title: 'Story 1.1 — Khung monorepo, server hai tiến trình và hợp đồng chung'
type: 'chore'
created: '2026-10-20'
status: 'done'
baseline_commit: 'NO_VCS' # snapshot ở scratchpad/baseline (rsync, bỏ node_modules)
route: 'dispatch'
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-1-context.md'
  - '{project-root}/_bmad-output/planning-artifacts/architecture/architecture-OnTheTopMoney-2026-10-20/ARCHITECTURE-SPINE.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Repo chỉ có `web/` chạy dữ liệu mẫu; chưa có backend, chưa có kiểu dùng chung, chưa có chỗ đặt nghiệp vụ cho các story sau.

**Approach:** Dựng npm workspaces (`web`, `server`, `packages/shared`), server Fastify (`api`) + pg-boss (`worker`) trên Postgres 18, `/healthz`, khai báo queue tập trung, kiểm ranh giới module bằng dependency-cruiser, và một lệnh `npm run check` gom typecheck + lint + ranh giới + test.

## Boundaries & Constraints

**Always:** Theo AD-1 (module chỉ gọi nhau qua `index.ts`, mũi tên theo spine), AD-24 (queue chỉ khai báo ở `server/src/platform/jobs/queues.ts`, cron `tz: 'Asia/Ho_Chi_Minh'`, `singletonKey` chỉ với `stately`), Consistency Conventions (UUIDv7, `timestamptz`, env đọc qua zod một lần). Server chạy bằng type stripping của Node 24, code chỉ dùng cú pháp xoá được (`erasableSyntaxOnly`), import tương đối có đuôi `.ts`. DB local: dùng `DATABASE_URL` nếu có; nếu không, `npm run db:dev` khởi động Postgres 18 bằng gói `embedded-postgres` (máy dev không có Docker) [ASSUMPTION].

**Never:** Không viết nghiệp vụ của story khác (auth, realtime, OpenAI…). Không đổi giao diện hay hành vi của `web/`; chỉ đưa nó vào workspace và thêm một file import kiểu từ shared. Không tạo bảng ngoài `worker_heartbeats`. Không thêm Redis/Docker làm yêu cầu bắt buộc.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Healthz OK | DB lên, heartbeat ≤2 phút | `GET /healthz` → 200 `{ok:true, db:'ok', worker:'ok'}` | N/A |
| Worker chết | heartbeat cũ >2 phút hoặc chưa có | 503 `{ok:false, worker:'stale'}` | không ném lỗi |
| DB lỗi | không kết nối được Postgres | 503 `{ok:false, db:'down'}` | timeout truy vấn ≤2 giây |
| Thiếu env | thiếu `DATABASE_URL` | tiến trình không khởi động, log tên biến | exit code ≠ 0 |
| Vi phạm ranh giới | `modules/inbox` import `modules/campaigns` | dependency-cruiser báo lỗi, `npm run check` đỏ | N/A |
| Queue lạ | code gọi `send` tới tên không có trong `queues.ts` | ném lỗi `UNKNOWN_QUEUE` | N/A |

</frozen-after-approval>

## Code Map

- `web/package.json`, `web/package-lock.json` -- web hiện độc lập; lockfile sẽ thay bằng lockfile gốc. Giữ nguyên scripts `dev/build/lint`.
- `web/tsconfig.app.json` -- đã bật `erasableSyntaxOnly`, `verbatimModuleSyntax`, `moduleResolution: bundler`; dùng làm mẫu cho tsconfig của shared/server.
- `web/.oxlintrc.json` -- oxlint đã dùng ở web; dùng chung cấu hình cho server.
- `web/src/data/mock.ts` -- KHÔNG sửa ở story này (thay dần ở story sau).
- `_bmad-output/planning-artifacts/architecture/.../ARCHITECTURE-SPINE.md` -- bảng mũi tên AD-1 (nguồn sinh luật dependency-cruiser), bảng queue AD-24, danh sách enum Conventions.

## Tasks & Acceptance

**Execution:**
- [x] `package.json` (gốc) -- workspaces `web`, `server`, `packages/shared`; scripts `dev` (concurrently: db nếu cần, web, api, worker), `typecheck`, `lint`, `depcruise`, `test`, `check` -- một lệnh cho mọi kiểm tra.
- [x] `packages/shared/` -- package `@ottm/shared` export nguồn TS: `enums.ts` (enum của Conventions dạng `as const` + zod), `errors.ts` (`ErrorCode` khởi điểm + schema `{error:{code,message,details?}}`), `events.ts` (khung danh mục sự kiện có zod payload + cờ `realtime`), `index.ts`.
- [x] `server/src/platform/config/` -- zod env (`DATABASE_URL`, `PORT`, `NODE_ENV`, `LOG_LEVEL`), đọc một lần, thiếu thì exit.
- [x] `server/src/platform/log/` -- pino với redact theo AD-12.
- [x] `server/src/platform/db/` -- client `postgres` + Drizzle, schema `worker_heartbeats`, `drizzle.config.ts`, migration đầu trong `server/drizzle/`.
- [x] `server/src/platform/jobs/queues.ts` -- registry queue (tên, policy, retry, concurrency, cron tz) + wrapper `send()` từ chối tên lạ; chỉ khai báo cron `platform.heartbeat` ở story này.
- [x] `server/src/app/main.ts` + `server/src/app/healthz.ts` -- Fastify, `GET /healthz` theo ma trận.
- [x] `server/src/worker/main.ts` -- khởi động pg-boss, tạo queue từ registry, cron heartbeat mỗi 30 giây ghi `worker_heartbeats`.
- [x] `server/src/modules/{pages,settings}/index.ts` -- module nền rỗng để luật ranh giới có đối tượng.
- [x] `server/scripts/db-dev.ts` -- khởi động `embedded-postgres` 18 (cổng 5433, dữ liệu `.data/pg`), tạo DB `ottm`.
- [x] `server/.dependency-cruiser.cjs` + `server/dependency-rules.cjs` -- bảng mũi tên AD-1 làm nguồn duy nhất, sinh luật cho phép, `no-circular`, cấm import ruột module.
- [x] `server/test/` -- test healthz (3 trạng thái), config thiếu env, `send()` từ chối queue lạ, và test chạy dependency-cruiser trên fixture vi phạm.
- [x] `web/src/lib/shared-types.ts` + `web/package.json` -- thêm phụ thuộc `@ottm/shared`, re-export kiểu `ErrorCode` để chứng minh web dùng chung hợp đồng.
- [x] `.github/workflows/ci.yml` -- chạy `npm ci && npm run check` (có Postgres service).
- [x] `_bmad-output/implementation-artifacts/spike-ts7.md` -- ghi kết quả drizzle-kit, vitest, dependency-cruiser với TS 7.0.2.

**Acceptance Criteria:**
- Given repo sạch, when `npm install` rồi `npm run dev` ở gốc, then web (Vite), api và worker cùng chạy với Postgres 18 và `/healthz` trả 200 sau ≤1 phút.
- Given shared export một zod schema, when web và server cùng import, then `npm run typecheck` (TS 7.0.2) qua ở cả ba workspace.
- Given worker khởi động, when liệt kê queue của pg-boss, then chỉ có queue trong registry.
- Given `npm run check`, when mọi thứ hợp lệ, then thoát 0; when có import vi phạm AD-1, then thoát ≠ 0.

## Implementation Notes

- **Heartbeat 30 giây:** pg-boss 12.38 gửi tối đa một job cron mỗi phút (`OCCURRENCE_WINDOW_SECONDS = 60`), nên worker ghi heartbeat bằng `setInterval` 30 giây trong tiến trình (dọn khi dừng) + một lần lúc khởi động; cron `platform.heartbeat` (`* * * * *`, tz VN) vẫn giữ trong registry và cũng ghi heartbeat.
- **Queue nội bộ pg-boss:** pg-boss tự tạo `__pgboss__send-it` để phát job cron. Kiểm tra "chỉ queue trong registry" (log cảnh báo ở worker và test tích hợp) bỏ qua tiền tố `__pgboss__`. Worker không xoá queue lạ, chỉ log cảnh báo.
- **dependency-cruiser + TS 7:** dùng parser `swc` (`@swc/core` devDep của server) vì dependency-cruiser 18.7 chỉ nhận `typescript <7`. Chi tiết ở `spike-ts7.md`. Ngoài luật mũi tên/`no-circular`/ruột module, có thêm `ad1-unknown-module` (module chưa khai báo trong bảng), cấm module/adapter/platform import entrypoint, cấm adapter/platform import module.
- **`/healthz`:** so tuổi heartbeat bằng `now()` của DB; timeout 2 giây bằng `Promise.race` + `query.cancel()`. Body DB lỗi là `{ok:false, db:'down', worker:'unknown'}`. Chưa kiểm đĩa >85% (không có trong ma trận story này).
- **`npm run dev`:** `server/scripts/dev.ts` dựng lệnh `concurrently`; chỉ bật `db` (Postgres nhúng 5433, dữ liệu `.data/pg` ở gốc repo) khi `DATABASE_URL` chưa có trong env hay `server/.env`. api và worker chạy `db:migrate --wait` (khoá advisory) trước khi khởi động.
- **Test DB:** `server/test/global-setup.ts` dùng `TEST_DATABASE_URL` nếu có (CI: service `postgres:18`), ngược lại bật Postgres nhúng trên cổng trống với dữ liệu tạm.
- **`drizzle.config.ts`** đặt ở `server/` (vị trí mặc định của drizzle-kit), schema glob `src/platform/db/schema.ts` + `src/modules/*/schema.ts`.
- **web:** chỉ thêm script `typecheck` (`tsc -b`), phụ thuộc `@ottm/shared` và `src/lib/shared-types.ts` (re-export kiểu). `web/package-lock.json` bị thay bằng lockfile gốc.

## Spec Change Log

## Review Triage Log

| # | Nguồn | Phát hiện | Verdict | Bằng chứng / route |
|---|---|---|---|---|
| 1 | blind, edge, vgap | `app.ts` ánh xạ mọi 4xx ≠400 thành INTERNAL, 503→500, ZodError→500 | medium | `app.ts:22-27` xác nhận; patch |
| 2 | vgap | Hợp đồng lỗi API không có test | medium | vgap đã xác minh; patch |
| 3 | blind | `query.cancel()` trong healthz không bắt rejection | medium | `healthz.ts` gọi `query.cancel()` không await/catch; patch |
| 4 | blind, edge | stately thiếu singletonKey qua được validate; khoá rỗng | low | `validateRegistry` không kiểm; sửa trực tiếp; patch |
| 5 | blind | Regex tên queue cho `-` ở segment đầu, không ở segment sau | low | regex `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_]*)+$`; sửa trực tiếp; patch |
| 6 | blind, edge | Redact thiếu token trong query string và nhiều khoá bí mật | medium | `REDACT_PATHS` chỉ có 17 đường, không serializer url; AD-12; patch |
| 7 | edge | Unlock trong finally che lỗi migration | low | `migrate.ts:16`; sửa trực tiếp; patch |
| 8 | edge (claim) | Heartbeat 1 phút thay vì 30 giây như spec | low | pg-boss cron tối thiểu 1 phút; sửa bằng interval trong worker; patch |
| 9 | vgap | `writeHeartbeat`/`startWorkers` không có test | medium | vgap đã xác minh; patch |
| 10 | vgap | Nhánh đối soát `ensureQueues` không có test | medium | vgap đã xác minh; patch |
| 11 | blind, vgap | Fixture depcruise không phủ 3 luật | medium | vgap đã xác minh; patch |
| 12 | blind, edge (claim) | Thư mục module không import gì / file lẻ dưới `src/modules/` lọt luật | medium | luật `ad1-unknown-module` dùng `to: {}` chỉ bắt khi có import; patch |
| 13 | blind, edge | events.ts khai lại enum (scope, product) | low | `events.ts` dùng `z.enum([...])` trùng `DeletionScope`; sửa trực tiếp; patch |
| 14 | blind | Cổng/URL Postgres nhúng lặp 3 chỗ | low | dev.ts, db-dev.ts, drizzle.config.ts; sửa trực tiếp; patch |
| 15 | blind | CI thiếu build web, kiểm drift migration, permissions | low | `ci.yml` chỉ chạy `check`; patch |
| 16 | blind | Lint web không `--deny-warnings` | low | cảnh báo có sẵn từ trước trong web/; reject (không do story này, sửa phải đụng UI) |
| 17 | blind | Kiểu payload queue bị mất (`never`, `Job<unknown>`) | low | chỉ ảnh hưởng kiểu, chưa có consumer; reject |
| 18 | blind | api không enqueue được trước khi worker tạo queue | false | story này api không enqueue; ghi chú cho story đầu tiên có api enqueue |
| 19 | blind | Chưa có bước migration production | false | thuộc Story 1.3 (service `migrate`) |
| 20 | blind | Version caret, embedded-postgres beta | low | không gây lỗi thực tế; reject |
| 21 | blind | Test trên DB dùng lại dễ vỡ | low | CI dùng DB mới; local dùng DB nhúng tạm; reject |
| 22 | blind | depcruise test chạy CLI hai lần | low | chậm nhẹ; reject |
| 23 | blind | packages/shared chưa có test | low | chưa có consumer; reject |
| 24 | blind | Idempotency dựa vào `version` tuỳ chọn, thiếu event id | maybe-false | id job pg-boss có thể dùng để chống trùng; chốt ở Story 1.4 khi có consumer; reject |
| 25 | edge | boss.ts không gỡ schedule key lạ của queue có cron | low | pg-boss dùng key mặc định; khó gặp; reject |
| 26 | edge | dev.ts: DATABASE_URL rỗng; cổng 5433 đã dùng | low | chỉ dev, khó gặp, sửa phải thêm nhánh; reject |
| 27 | edge | embedded-pg / global-setup để lại tiến trình khi lỗi giữa chừng | low | chỉ dev/test, sửa thêm guard; reject |
| 28 | edge | Tín hiệu thứ hai không ép thoát; thiếu log fatal unhandledRejection | low | Node vẫn in stack và thoát; reject |
| 29 | edge | waitForDatabase retry cả lỗi vĩnh viễn; khoá advisory có thể treo | low | dev-only / khó gặp; reject |
| 30 | edge | uuidv7() cần PG ≥18 | low | stack pin PG 18; reject |
| 31 | edge | healthz báo db down khi bảng thiếu | low | migration chạy trước khởi động; reject |
| 32 | edge | `expiresAt` không nhận offset | false | Conventions bắt buộc ISO có `Z` |

## Design Notes

Luật ranh giới sinh từ một bảng để khớp spine:

```js
// dependency-rules.cjs
module.exports = { arrows: { webhooks: ['inbox','connections'], autoreply: ['inbox','profiles','ai'], /* … theo AD-1 */ }, base: ['pages','settings'] }
```

`.dependency-cruiser.cjs` duyệt `arrows` để tạo một luật `forbidden` cho mỗi module: `from modules/X/` tới `modules/Y/` khi Y ∉ arrows[X] ∪ base ∪ {X}.

## Verification

**Commands:**
- `npm run check` -- expected: exit 0
- `npm run dev` rồi `curl -s localhost:3000/healthz` -- expected: `{"ok":true,...}`
- dừng worker, chờ 2 phút, `curl -s -o /dev/null -w '%{http_code}' localhost:3000/healthz` -- expected: 503
