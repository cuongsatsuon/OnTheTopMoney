---
title: 'Story 5.1 — Cấu hình AI trả lời theo nhóm và trang'
type: 'feature'
created: '2026-10-24'
status: 'done'
route: 'dispatch'
review_loop_iteration: 0
baseline_commit: 'fc3861bb8879fe1b5c8ae6589600af7a2ea66641'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-5-context.md'
  - '{project-root}/_bmad-output/implementation-artifacts/spec-3-2-3-3-ke-thua-ho-so.md'
---

<frozen-after-approval reason="ACs lấy từ epics.md Story 5.1; chủ dự án cho phép tự duyệt spec">

## Intent

**Problem:** Màn AI trả lời (`/ai-tra-loi`, tab "AI trả lời" của Chi tiết trang/nhóm) và nút Bật/Tắt AI ở Trang & Nhóm đang chạy trên dữ liệu mẫu. Server chưa có `autoreply_configs`, nên chưa lưu được cấu hình và Epic 5 chưa có gì để giải "trang dùng cấu hình AI nào".

**Approach:** Đăng ký `autoreply` là loại cấu hình thứ hai trong registry kế thừa của `profiles` (cùng `resolveEffective`, `setUseOwn`, xử lý đổi nhóm của Story 3.2/3.3). Thêm bảng `autoreply_configs`, các route REST đọc/lưu/hiệu lực/dùng riêng/template kịch bản/tổng quan/bật-tắt hàng loạt. Nối FE vào API cho nhóm/trang thật, giữ dữ liệu mẫu cho id mẫu như BrandProfileForm.

## Boundaries & Constraints

**Always:**
- Cấu hình gồm:
  - `enabled`
  - `schedule ∈ always|offhours|custom` + `hours` đúng 7 ngày (T2→CN, `{on, from, to}` dạng `HH:MM`, `from≠to` khi `on`; `from>to` = qua nửa đêm)
  - `script`
  - `handoffKeywords`, `handoffOnCustomerAsk`, `handoffOnUncertain`
  - `handoffMessage` (mặc định "Shop sẽ kiểm tra và phản hồi ngay ạ")
  - `channels: AutoreplyChannel[]`
- Schema zod ở `packages/shared` là nguồn duy nhất của luật hợp lệ, dùng cho cả BE và FE.
- Khi `enabled=true` thì phải có kịch bản không rỗng, ≥1 kênh, và `custom` phải có ≥1 ngày bật. Sai → `VALIDATION_FAILED`, `details[].path` trỏ đúng ô (`script` / `channels` / `hours`) để FE báo dưới ô. Lưu ở trạng thái tắt thì không bắt các điều kiện này.
- Kế thừa chỉ giải qua `profiles.resolveEffective(pageId,'autoreply')`. Đổi/xoá nhóm và "trang đang chờ nhóm" chạy bằng đúng code của Story 3.3 (registry + `REGISTERED_KINDS`).
- Lưu cấu hình NHÓM gọi `onGroupProfileSaved(tx, groupId, 'autoreply')` trong cùng transaction.
- Lưu cấu hình TRANG đang theo nhóm thì trong cùng transaction: `setUseOwn(true)` (sao chép cấu hình nhóm làm điểm xuất phát) rồi ghi đè bằng body. Tắt "Dùng cấu hình AI riêng" + Lưu → `setUseOwn(false)` (xoá cấu hình riêng).
- "Lấy từ Hồ sơ thương hiệu" và "Mẫu theo ngành" dựng kịch bản bằng template xác định phía server, không gọi AI. Hồ sơ dùng là hồ sơ hiệu lực: nhóm → hồ sơ của nhóm; trang → `resolveEffective(pageId,'brand')`.
- Bật/Tắt hàng loạt xử lý từng trang trong transaction riêng, trang lỗi không chặn trang khác:
  - Trang theo nhóm mà trạng thái hiệu lực khác đích → `setUseOwn(true)` (sao chép) rồi đổi `enabled`.
  - Bật khi cấu hình không đủ điều kiện → lỗi `VALIDATION_FAILED` cho trang đó, không chuyển sang riêng.
- `Page.autoReply` là dẫn xuất (từ `resolveEffective`), không thêm cột ở `pages`.
- Ranh giới AD-1: chỉ `profiles` chạm `autoreply_configs`; route ở `app/`; depcruise sạch.

**Never:**
- Không gọi AI ở story này.
- Không làm kho kiến thức (5.2), không làm "Thử AI" thật (5.3), không đổi `autoreply.triage` (vẫn `AI_OFF` tới 5.4).
- Không chặn lưu ở server vì thiếu khoá OpenAI. Khoá công tắc là việc của FE; cổng thời gian chạy ở 5.4 lo phần còn lại.
- Không log nội dung kịch bản hay từ khoá.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Lưu nhóm, bật | PUT group config hợp lệ, `enabled=true` | Lưu. Tổng quan: nhóm `enabled`; trang con `mode=group`, `enabled=true` ("Theo nhóm") | |
| Bật khi kịch bản trống | `enabled=true`, `script=''` | Không lưu | 400 `VALIDATION_FAILED`, path `script` |
| Bật khi không có kênh | `enabled=true`, `channels=[]` | Không lưu | 400, path `channels` |
| Bật `custom` không ngày nào | `schedule=custom`, mọi `on=false` | Không lưu | 400, path `hours` |
| Lưu nháp đang tắt | `enabled=false`, kịch bản trống | Lưu được | |
| Template từ hồ sơ | `{source:'brand', owner}`, hồ sơ hiệu lực có | `script` chứa tên, xưng hô, sản phẩm + giá, từ cấm. Không gọi AI | |
| Template khi thiếu hồ sơ | không có hồ sơ hiệu lực | | 422 `CONFIG_MISSING`; FE báo "chưa có hồ sơ" |
| Mẫu theo ngành | `{source:'industry', industry}` | Kịch bản mẫu cố định của ngành đó | id ngành lạ → 400 |
| Trang dùng riêng + Lưu | trang theo nhóm, PUT page config (tắt kênh bình luận) | `use_own=true`; hiệu lực `source=page` mang cấu hình mới; cấu hình nhóm giữ nguyên | |
| Bật dùng riêng chưa sửa | PUT use-own `true` | Sao chép cấu hình nhóm sang trang (điểm xuất phát) | nhóm chưa có cấu hình → riêng trống, hiệu lực null |
| Tắt dùng riêng | PUT use-own `false` | Xoá cấu hình riêng, về nhóm | trang không nhóm → 400 |
| Hiệu lực khi thiếu | trang không nhóm và không cấu hình, hoặc nhóm chưa cấu hình | `{effective:null, useOwn}` | |
| Hàng loạt: tắt trang theo nhóm | nhóm bật, `enabled=false` cho 2 trang | Mỗi trang `use_own=true`, cấu hình = bản sao nhóm với `enabled=false` | |
| Hàng loạt: đã đúng trạng thái | trang theo nhóm đang bật, `enabled=true` | Không đổi, vẫn "Theo nhóm" | |
| Hàng loạt: thiếu cấu hình | bật trang không có cấu hình hiệu lực | Trang khác vẫn xử lý | `failed[{pageId, code:'CONFIG_MISSING'}]` |
| Hàng loạt: không đủ điều kiện | bật trang riêng có kịch bản trống | Không đổi | `failed[{code:'VALIDATION_FAILED'}]` |
| Rời nhóm / xoá nhóm | `page.group_changed {A,null}` / `group.deleted` | Cấu hình AI của A được sao chép thành riêng (như brand) | idempotent |
| Vào nhóm chưa có cấu hình AI | `{null,B}` | Giữ riêng, `awaiting`. B lưu lần đầu → trang về "Theo nhóm" | |
| Chủ không tồn tại | GET/PUT owner lạ | | 404 `NOT_FOUND` |

</frozen-after-approval>

## Code Map

- `packages/shared/src/enums.ts` -- `CONFIG_KINDS` thêm `'autoreply'`
- `packages/shared/src/autoreply.ts` (mới) -- schema cấu hình, `autoreplyEnableIssues`, DTO/response, template, tổng quan, hàng loạt
- `server/src/modules/profiles/schema.ts` -- bảng `autoreply_configs`; CHECK `page_config_state.kind` sinh lại
- `server/src/modules/profiles/autoreply.ts` (mới) -- row↔DTO, ops registry, get/upsert, tổng quan, hàng loạt
- `server/src/modules/profiles/autoreply-template.ts` (mới) -- template kịch bản từ hồ sơ / theo ngành
- `server/src/modules/profiles/inheritance.ts` -- `REGISTRY.autoreply`
- `server/src/app/autoreply-configs.ts` (mới) + `app.ts` -- route REST
- `server/drizzle/00xx_*.sql` -- migration sinh bằng `drizzle-kit generate`
- `web/src/lib/autoreply.ts` (mới) -- map DTO↔form, lỗi theo ô, hook React Query, chép trạng thái AI vào kho mẫu
- `web/src/screens/AutoReply.tsx` -- form + cây nối API cho chủ thật, thêm ô `handoffMessage`
- `web/src/screens/PagesGroups.tsx`, `web/src/screens/GroupDetail.tsx` -- Bật/Tắt hàng loạt có xác nhận, cột AI dẫn xuất

## Tasks & Acceptance

**Execution:**
- [x] `packages/shared/src/{enums,autoreply,index}.ts` -- hợp đồng chung + luật bật -- BE/FE dùng một luật
- [x] `server/src/modules/profiles/*` + migration -- bảng, registry, service, template, tổng quan, hàng loạt -- AD-8
- [x] `server/src/app/autoreply-configs.ts`, `app.ts` -- route `/api/v1/autoreply-configs/*` -- AD-18
- [x] `server/test/autoreply-configs.test.ts` -- phủ mọi dòng I/O matrix (Postgres thật)
- [x] `web/src/lib/autoreply.ts` + test -- helper thuần + hook
- [x] `web/src/screens/{AutoReply,PagesGroups,GroupDetail}.tsx` -- nối API, xác nhận hàng loạt, khoá khi thiếu khoá OpenAI

**Acceptance Criteria:**
- Given nhóm "Gia dụng" vừa lưu cấu hình đang bật, when mở `/ai-tra-loi`, then cây hiện "Bật" cho nhóm và "Theo nhóm" cho các trang con.
- Given chưa có khoá OpenAI, when mở form, then công tắc AI khoá kèm banner "Thêm khoá OpenAI ở Cài đặt", và nút "Bật AI trả lời" hàng loạt cũng bị khoá.
- Given chọn nhiều trang ở Trang & Nhóm, when bấm Bật/Tắt AI trả lời, then FE hỏi xác nhận (nêu số trang đang theo nhóm sẽ chuyển sang cấu hình riêng) rồi gọi server; cột AI và thẻ nhóm vẽ lại theo trạng thái dẫn xuất.

## Implementation Notes

- Migration `server/drizzle/0022_sad_miss_america.sql` (sinh bằng `drizzle-kit generate`): tạo `autoreply_configs` (CHECK owner_type/schedule/channels) và sinh lại CHECK `page_config_state.kind` thành `('brand','autoreply')`.
- `profiles`:
  - `autoreply-row.ts` giữ ops registry, tách riêng để `inheritance.ts` không tạo vòng với `autoreply.ts`.
  - `autoreply.ts` lo service: lưu (trang theo nhóm thì `setUseOwn(true)` trong cùng transaction), hiệu lực, dùng riêng, template, tổng quan, hàng loạt.
  - `autoreply-template.ts` là hàm thuần dựng kịch bản.
  - `assertOwnerExists` của `service.ts` được export để dùng lại.
  - Đổi nhóm không thêm code: `REGISTERED_KINDS` tự gồm `autoreply`.
- Quyết định:
  - Hàng loạt bỏ qua trang đã đúng trạng thái (`unchanged`): trang theo nhóm không bị tách khỏi nhóm khi không cần.
  - `PUT` cấu hình trang đang theo nhóm tự chuyển sang riêng (một request thay cho hai, khác brand).
  - Hiệu lực trả thêm `useOwn` để FE phân biệt "theo nhóm nhưng nhóm chưa cấu hình" với "riêng nhưng chưa lưu".
  - Server không chặn bật AI khi thiếu khoá OpenAI. FE khoá công tắc và nút "Bật AI trả lời" hàng loạt.
- FE:
  - `lib/autoreply.ts` chứa helper và hook. Khoá React Query có tiền tố `['autoreply']`. Tổng quan được chép `autoReply` vào kho mẫu.
  - `AutoReply.tsx` (form, cây, Thử AI), `PagesGroups.tsx` (xác nhận rồi gọi API) và `GroupDetail.tsx` (cột AI dẫn xuất) dùng API cho chủ thật. Id mẫu chạy như cũ.
  - Với chủ thật: Kho kiến thức hiện "chưa mở" (Story 5.2). "Thử AI" chỉ kiểm luật chuyển người (Story 5.3 làm phần LLM).
- Test:
  - `server/test/autoreply-configs.test.ts`: 24 ca, phủ mọi dòng ma trận.
  - `web/src/lib/autoreply.test.ts`: 12 ca.
  - `npm run check` xanh: server 1069 test, web 220 test.
- Chưa kiểm bằng trình duyệt (cần phiên chủ shop + nhóm/trang thật); đã ghi vào `deferred-work.md`.

## Verification

**Commands:**
- `npm run db:generate -w server` -- sinh migration cho `autoreply_configs` + CHECK mới
- `npm run check` (gốc repo) -- typecheck, lint, depcruise, test đều xanh

## Review Triage Log

### Lượt 1 (review gọn)

| Phát hiện | Verdict | Route |
|-----------|---------|-------|
| Form trang thật đang dùng cấu hình riêng: tắt "Dùng cấu hình AI riêng" thì phần xem trước lấy cấu hình nhóm từ hiệu lực (lúc này là cấu hình TRANG) → hiện form trống và báo sai "Nhóm chưa có cấu hình AI nên AI chưa trả lời cho trang này" dù nhóm đã cấu hình. Sửa: `AutoReply.tsx` đọc thẳng `GET /autoreply-configs/group/:id` của nhóm (rơi về hiệu lực khi chưa tải) | medium | patch |
