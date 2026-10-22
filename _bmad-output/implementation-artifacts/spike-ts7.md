# Spike — công cụ chạy với TypeScript 7.0.2 (Story 1.1)

Ngày: 2026-10-20 · Node v24.18.0 · npm 11.16.0 · macOS arm64

`typescript@7.0.2` là bản biên dịch native: gói npm chỉ có binary `tsc` + `lib/version.cjs`
(`import('typescript')` trả về `{ version, versionMajorMinor }`), API JS chỉ nằm dưới
`typescript/unstable/*`. Công cụ nào cần `ts.createSourceFile` & co. sẽ không dùng được nó.

| Công cụ | Phiên bản | Kết quả | Ghi chú |
|---|---|---|---|
| `tsc --noEmit` | 7.0.2 | Chạy được | `npm run typecheck` qua ở `packages/shared` (bundler), `server` (nodenext + `allowImportingTsExtensions` + `erasableSyntaxOnly`), `web` (`tsc -b`). Web resolve `@ottm/shared` qua `exports` → `src/index.ts`. |
| drizzle-kit | 0.31.11 | Chạy được | `drizzle-kit generate` sinh `server/drizzle/0000_init.sql`; `check` sạch. Không dùng API TypeScript (nạp config/schema bằng esbuild). Import `.ts` trong schema không gây lỗi. |
| vitest | 5.0.5 | Chạy được | Tự transform TS, không gọi `tsc`. 24 test qua, gồm test tích hợp Postgres 18 và pg-boss. |
| dependency-cruiser | 18.7.0 | Chạy được **với parser `swc`** | `depcruise --info`: hỗ trợ `typescript >=2 <7` → TS 7 bị coi là không có, `.ts` không được đọc. Cài `@swc/core@1.16.18` + `options.parser: 'swc'` thì `.ts` được đọc đầy đủ, kể cả `import type`. Không bật `tsPreCompilationDeps` (option này đòi API tsc và in cảnh báo `missing-tsc-transpiler`); với swc, phụ thuộc chỉ-kiểu vẫn được tính nên luật AD-1 áp cho cả chúng. |
| Node type stripping | 24.18 | Chạy được | `node src/app/main.ts`, `node src/worker/main.ts` chạy thẳng TS. `@ottm/shared` là symlink workspace → Node resolve về đường dẫn thật ngoài `node_modules`, nên type stripping áp được cho nguồn shared. |
| oxlint | 1.89 | Chạy được | Không phụ thuộc TS. Server/shared `extends` `web/.oxlintrc.json`. |

## Kết luận

Không cần phương án dự phòng của AD-1 (oxlint `no-restricted-imports`). AD-1 thực thi bằng
dependency-cruiser + swc — đúng tinh thần "parser không cần API của TypeScript" của spine.
Khi dependency-cruiser hỗ trợ TS ≥7 có thể bỏ `@swc/core` và đổi `parser`.

## Điều cần biết thêm (không thuộc TS 7)

- pg-boss 12.38: lịch cron có độ phân giải 1 phút (`OCCURRENCE_WINDOW_SECONDS = 60`, cron 6 trường
  vẫn chỉ gửi 1 job/phút). Worker vì vậy ghi heartbeat bằng `setInterval` 30 giây trong tiến trình (cùng cron 1 phút
  của pg-boss). Đo trước khi thêm interval: dừng worker → 503 sau ~111 giây.
- pg-boss tự tạo queue nội bộ `__pgboss__send-it` (dùng để phát job cron). Đây là máy móc của
  pg-boss, không phải queue nghiệp vụ; kiểm tra "chỉ queue trong registry" bỏ qua tiền tố `__pgboss__`.
- npm 11.16 in cảnh báo `allow-scripts` cho `esbuild`, `@swc/core`, `@embedded-postgres/*`, `fsevents`
  (chế độ khuyến nghị, script vẫn chạy). Chưa ghi `allowScripts` vào `package.json`.
- `embedded-postgres@18.4.0-beta.17` mang PostgreSQL 18.4; `initdb` + start ~2–3 giây.
